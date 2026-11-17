#!/usr/bin/env python3
"""End-to-end test in a real (headless) Firefox, with a throwaway HOME, key and store.

Installs a copy of the extension as a temporary add-on over Marionette, registers the native
host in the throwaway HOME, serves login pages from 127.0.0.1, then drives the background page
from the options page (the toolbar popup cannot be clicked headless). The copy additionally gets
<all_urls>/tabs, standing in for the activeTab grant a click on the toolbar button gives.
"""
import base64
import http.server
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
UUID = "0e3c5f7a-2b1d-4c6e-9f00-7a1b2c3d4e5f"

PAGES = {
    "/login": """<form action="/session" method="post">
      <input name="email" type="email" autocomplete="username">
      <input name="pw" type="password"><button>Sign in</button></form>""",
    "/otp": """<form><label>Verification code <input name="code" inputmode="numeric" maxlength="6"></label></form>""",
    "/boxes": """<form>""" + "".join(f'<input maxlength="1" name="d{i}">' for i in range(6)) + "</form>",
    "/react": """<input id="u" name="username"><input id="p" type="password">
      <script>
      // What React does: shadow the value property, compare on 'input'.
      window.seen = [];
      for (const el of document.querySelectorAll('input')) {
        const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        let tracked = '';
        Object.defineProperty(el, 'value', { get() { return proto.get.call(this); },
          set(v) { tracked = v; proto.set.call(this, v); }, configurable: true });
        el.addEventListener('input', () => { if (el.value !== tracked) { tracked = el.value; seen.push(el.id); } });
      }
      </script>""",
}


# path -> (realm, username, password) the server accepts
# Each in its own directory: Firefox resends credentials unasked to paths under one that took them.
BASIC = {"/r1/basic": ("Intranet", "alice@example.org", "s3cret!"), "/r2/basic2": ("Other", "bob", "pw2"),
         "/r3/swap": ("Swap", "bob", "pw2"), "/r4/closed": ("Closed", "nobody", "x")}


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?")[0]
        if path in BASIC:
            realm, user, pw = BASIC[path]
            want = "Basic " + base64.b64encode(f"{user}:{pw}".encode()).decode()
            if self.headers.get("Authorization") != want:
                self.send_response(401)
                self.send_header("WWW-Authenticate", f'Basic realm="{realm}"')
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(b"<!doctype html><title>401</title>denied")
                return
            body = f"<title>ok</title>hello {user}".encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(b"<!doctype html><meta charset=utf-8>" + body)
            return
        body = PAGES.get(self.path.split("?")[0], "nothing").encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(b"<!doctype html><meta charset=utf-8>" + body)

    def log_message(self, *a):
        pass


class Marionette:
    def __init__(self, port):
        for _ in range(100):
            try:
                self.s = socket.create_connection(("127.0.0.1", port))
                break
            except OSError:
                time.sleep(0.2)
        self.buf = b""
        self.id = 0
        self._read()

    def _read(self):
        while b":" not in self.buf:
            self.buf += self.s.recv(65536)
        n, rest = self.buf.split(b":", 1)
        n = int(n)
        while len(rest) < n:
            rest += self.s.recv(65536)
        self.buf = rest[n:]
        return json.loads(rest[:n])

    def __call__(self, name, params=None):
        self.id += 1
        data = json.dumps([0, self.id, name, params or {}]).encode()
        self.s.sendall(str(len(data)).encode() + b":" + data)
        _, _, err, result = self._read()
        if err:
            raise RuntimeError(f"{name}: {err}")
        return result.get("value") if isinstance(result, dict) and "value" in result else result

    def js(self, script, *args):
        return self("WebDriver:ExecuteAsyncScript", {"script": script, "args": list(args), "scriptTimeout": 30000})


def main():
    tmp = Path(tempfile.mkdtemp(prefix="pass-e2e-"))
    home = tmp / "home"
    gnupg = home / ".gnupg"
    gnupg.mkdir(parents=True, mode=0o700)
    # Chrome-context Marionette: newer Firefox takes the flag, some builds only the variable.
    env = dict(os.environ, HOME=str(home), GNUPGHOME=str(gnupg), XDG_CONFIG_HOME=str(home / ".config"),
               MOZ_REMOTE_ALLOW_SYSTEM_ACCESS="1")
    env.pop("PASSWORD_STORE_DIR", None)
    ff = srv = None
    try:
        run = lambda *c, **kw: subprocess.run(c, env=env, check=True, capture_output=True, **kw)
        run("gpg", "--batch", "--passphrase", "", "--quick-gen-key", "t <t@invalid>", "default", "default", "never")
        run("pass", "init", "t@invalid")
        run("pass", "insert", "-m", "Work/127.0.0.1/alice",
            input=b"s3cret!\nemail: alice@example.org\notpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ\n")
        run(str(REPO / "install.sh"))

        ext = tmp / "ext"
        shutil.copytree(REPO / "extension", ext)
        manifest = json.loads((ext / "manifest.json").read_text())
        manifest["permissions"] += ["<all_urls>", "tabs", "webRequest", "webRequestBlocking"]
        (ext / "manifest.json").write_text(json.dumps(manifest))

        profile = tmp / "profile"
        profile.mkdir()
        (profile / "user.js").write_text(
            'user_pref("extensions.webextensions.uuids", "{\\"firefox-pass@localhost\\": \\"%s\\"}");\n'
            'user_pref("marionette.port", 2829);\n' % UUID
            + ('user_pref("ui.systemUsesDarkTheme", 1);\n' if os.environ.get("E2E_DARK") else ""))

        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{srv.server_address[1]}"

        ff = subprocess.Popen(["firefox", "--headless", "--marionette", "-remote-allow-system-access", "--no-remote", "--profile", str(profile)],
                              env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        m = Marionette(2829)
        m("WebDriver:NewSession", {})
        m("Addon:Install", {"path": str(ext), "temporary": True})
        time.sleep(1)

        fails = 0

        def check(name, got, want):
            nonlocal fails
            ok = got == want
            fails += not ok
            print(("ok   " if ok else "FAIL ") + name + ("" if ok else f": got {got!r}, want {want!r}"))

        before = set(m("WebDriver:GetWindowHandles"))
        m("Marionette:SetContext", {"value": "chrome"})
        m("WebDriver:ExecuteScript", {"script": """
          const w = Services.wm.getMostRecentWindow('navigator:browser');
          w.gBrowser.selectedTab = w.gBrowser.addTab(arguments[0],
            { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });""",
          "args": [f"moz-extension://{UUID}/options/options.html"]})
        m("Marionette:SetContext", {"value": "content"})
        time.sleep(1.5)
        opts = (set(m("WebDriver:GetWindowHandles")) - before).pop()
        m("WebDriver:SwitchToWindow", {"handle": opts})
        status = m("WebDriver:ExecuteScript", {"script": "return document.getElementById('hostStatus').textContent"})
        check("options page reaches native host", "1 entries" in status, True)

        page = m("WebDriver:NewWindow", {"type": "tab"})["handle"]

        def on_page(path):
            m("WebDriver:SwitchToWindow", {"handle": page})
            m("WebDriver:Navigate", {"url": base + path})

        def bg(script):
            m("WebDriver:SwitchToWindow", {"handle": opts})
            return m.js("""
              const done = arguments[arguments.length - 1];
              const browser = (window.wrappedJSObject || window).browser;
              (async () => { %s })().then((r) => done(JSON.parse(JSON.stringify(r))), (e) => done({ thrown: String(e) }));
            """ % script)

        def page_value(script):
            m("WebDriver:SwitchToWindow", {"handle": page})
            return m("WebDriver:ExecuteScript", {"script": script})

        tab_of = "const [tab] = await browser.tabs.query({ url: 'http://127.0.0.1/*' });"

        on_page("/login")
        ctx = bg(tab_of + "return browser.runtime.sendMessage({ type: 'context', tabId: tab.id });")
        check("detects login form", (ctx["target"]["mode"], ctx["target"]["usernameKind"]), ("login", "email"))
        check("form key", ctx["formKey"].startswith("127.0.0.1/session|login|"), True)
        ranked = bg(tab_of + """
          const ctx = await browser.runtime.sendMessage({ type: 'context', tabId: tab.id });
          const { entries } = await browser.runtime.sendMessage({ type: 'list' });
          const r = (window.wrappedJSObject || window).PassMatch.rank(entries, ctx, '', {});
          return (window.wrappedJSObject || window).PassMatch.uniqueMatch(r);""")
        check("unique domain match by folder", ranked and ranked["path"], "Work/127.0.0.1/alice")
        res = bg(tab_of + """
          const ctx = await browser.runtime.sendMessage({ type: 'context', tabId: tab.id });
          return browser.runtime.sendMessage({ type: 'fill', ctx, path: 'Work/127.0.0.1/alice' });""")
        check("fill ok", (res.get("ok"), res.get("filled")), (True, ["username", "password"]))
        check("filled values", page_value("return [document.querySelector('[name=email]').value, document.querySelector('[name=pw]').value]"),
              ["alice@example.org", "s3cret!"])
        hist = bg("return (await browser.storage.local.get('history')).history;")
        check("history recorded for host", list(hist["host"]["127.0.0.1"].keys()), ["Work/127.0.0.1/alice"])
        check("history recorded for form", any(k.startswith("127.0.0.1/session") for k in hist["form"]), True)

        on_page("/otp")
        ctx = bg(tab_of + "return browser.runtime.sendMessage({ type: 'context', tabId: tab.id });")
        check("detects OTP step and remembers last fill", (ctx["target"]["mode"], ctx["lastFill"]["path"], ctx["lastFill"]["hasOtp"]),
              ("otp", "Work/127.0.0.1/alice", True))
        res = bg(tab_of + """
          const ctx = await browser.runtime.sendMessage({ type: 'context', tabId: tab.id });
          return browser.runtime.sendMessage({ type: 'fill', ctx, path: ctx.lastFill.path });""")
        code = page_value("return document.querySelector('[name=code]').value")
        check("OTP filled", (res.get("filled"), len(code), code.isdigit()), (["otp"], 6, True))

        on_page("/boxes")
        res = bg(tab_of + """
          const ctx = await browser.runtime.sendMessage({ type: 'context', tabId: tab.id });
          return browser.runtime.sendMessage({ type: 'fill', ctx, path: 'Work/127.0.0.1/alice' });""")
        boxes = page_value("return [...document.querySelectorAll('input')].map(i => i.value).join('')")
        check("OTP split boxes", (res.get("filled"), len(boxes)), (["otp"], 6))

        on_page("/react")
        bg(tab_of + """
          const ctx = await browser.runtime.sendMessage({ type: 'context', tabId: tab.id });
          return browser.runtime.sendMessage({ type: 'fill', ctx, path: 'Work/127.0.0.1/alice' });""")
        check("framework sees the change", page_value("return (window.wrappedJSObject || window).seen.slice().sort()"), ["p", "u"])

        res = bg("return browser.runtime.sendMessage({ type: 'fill', ctx: { tabId: 1, target: null }, path: 'x' });")
        check("no form -> error, not throw", res.get("ok"), False)

        # ---------------------------------------------------------- HTTP authentication
        def go(path):
            m("WebDriver:SwitchToWindow", {"handle": page})
            m("WebDriver:ExecuteScript", {"script": "setTimeout(() => { location.href = arguments[0]; }, 0)", "args": [base + path]})

        def wait_for(fn, timeout=20):
            end = time.time() + timeout
            while time.time() < end:
                try:
                    v = fn()
                    if v:
                        return v
                except RuntimeError:
                    pass
                time.sleep(0.3)
            return None

        def body_text(path):
            return wait_for(lambda: page_value(
                "return location.pathname === arguments[0] && document.readyState === 'complete' && document.body"
                " ? document.body.textContent : ''".replace("arguments[0]", repr(path))))

        def picker():
            def find():
                for h in m("WebDriver:GetWindowHandles"):
                    m("WebDriver:SwitchToWindow", {"handle": h})
                    if "popup.html?auth=" in m("WebDriver:GetCurrentURL"):
                        return h
                return None
            return wait_for(find)

        def choose(handle, query):
            m("WebDriver:SwitchToWindow", {"handle": handle})
            wait_for(lambda: m("WebDriver:ExecuteScript", {"script": "return document.querySelectorAll('.row').length"}))
            m("WebDriver:ExecuteScript", {"script": """
              const q = document.getElementById('query');
              q.value = arguments[0]; q.dispatchEvent(new Event('input'));
              document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));""", "args": [query]})

        def realm_history(realm):
            h = bg("return (await browser.storage.local.get('history')).history;")
            port = srv.server_address[1]
            return sorted((h.get("form") or {}).get(f"127.0.0.1:{port}|http|{realm}", {}).keys())

        go("/r1/basic")
        check("basic auth: unique entry answers without asking", "hello alice@example.org" in (body_text("/r1/basic") or ""), True)
        check("basic auth: remembered for the realm", realm_history("Intranet"), ["Work/127.0.0.1/alice"])

        run("pass", "insert", "-m", "Work/127.0.0.1/bob", input=b"pw2\n")
        bg("return browser.runtime.sendMessage({ type: 'list', force: true });")
        go("/r2/basic2")
        h = picker()
        check("basic auth: two entries -> picker window", bool(h), True)
        if h:
            check("picker shows the realm", m("WebDriver:ExecuteScript", {"script": "return document.getElementById('formInfo').textContent"}),
                  "HTTP login · “Other”")
            choose(h, "bob")
        check("basic auth: picked entry logs in (username from file name)", "hello bob" in (body_text("/r2/basic2") or ""), True)

        go("/r3/swap")
        h = picker()
        if h:
            choose(h, "alice")  # wrong for this realm
        h2 = picker()
        check("refused entry -> picker again", bool(h2), True)
        if h2:
            choose(h2, "bob")
        check("second choice logs in", "hello bob" in (body_text("/r3/swap") or ""), True)
        check("refused entry forgotten for the realm", realm_history("Swap"), ["Work/127.0.0.1/bob"])

        go("/r4/closed")
        h = picker()
        if h:
            m("WebDriver:SwitchToWindow", {"handle": h})
            m("WebDriver:ExecuteScript", {"script": "window.close()"})
        check("closing the picker leaves the login to Firefox", wait_for(lambda: realm_history("Closed") == [] and "x"), "x")

        shot = os.environ.get("E2E_SCREENSHOT")
        if shot:
            for name in ["Work/127.0.0.1/bob", "Private/Commerce/Amazon", "Acme/erp.acme.de"]:
                run("pass", "insert", "-m", name, input=b"x\nuser: u\n")
            on_page("/login")
            bg("return browser.runtime.sendMessage({ type: 'list', force: true });")
            tab_id = bg(tab_of + "return tab.id;")
            known = set(m("WebDriver:GetWindowHandles"))
            m("Marionette:SetContext", {"value": "chrome"})
            m("WebDriver:ExecuteScript", {"script": """
              const w = Services.wm.getMostRecentWindow('navigator:browser');
              w.gBrowser.selectedTab = w.gBrowser.addTab(arguments[0],
                { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });""",
              "args": [f"moz-extension://{UUID}/popup/popup.html?tab={tab_id}"]})
            m("Marionette:SetContext", {"value": "content"})
            time.sleep(2)
            m("WebDriver:SwitchToWindow", {"handle": (set(m("WebDriver:GetWindowHandles")) - known).pop()})
            import base64
            body = m("WebDriver:FindElement", {"using": "css selector", "value": "body"})
            el = body.get("element-6066-11e4-a52e-4f735466cecc") or next(iter(body.values()))
            png = m("WebDriver:TakeScreenshot", {"id": el})
            Path(shot).write_bytes(base64.b64decode(png))
            check("search box focused", m("WebDriver:ExecuteScript", {"script": "return document.activeElement.id"}), "query")
            popup = m("WebDriver:GetWindowHandle")
            bg("browser.theme.update({ colors: { popup: '#ffeedd', popup_text: '#331100', focus_outline: '#ff0000' } }); return 1;")
            m("WebDriver:SwitchToWindow", {"handle": popup})
            time.sleep(0.5)
            check("follows theme live", m("WebDriver:ExecuteScript", {"script":
                "const s = getComputedStyle(document.body); return [s.backgroundColor, s.color, getComputedStyle(document.documentElement).getPropertyValue('--accent')]"}),
                ["rgb(255, 238, 221)", "rgb(51, 17, 0)", "#ff0000"])
            print("screenshot", shot)

        sys.exit(1 if fails else 0)
    finally:
        if ff:
            ff.kill()
        if srv:
            srv.shutdown()
        subprocess.run(["gpgconf", "--kill", "gpg-agent"], env=env, capture_output=True)
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
