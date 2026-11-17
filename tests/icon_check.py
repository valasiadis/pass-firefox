#!/usr/bin/env python3
"""Screenshots the toolbar button in headless Firefox under several themes.

Usage: tests/icon_check.py OUT_DIR [--dark]
Writes one PNG per case: default theme, a custom theme that sets its own icon colour, the theme
reset again, and a private window.
"""
import base64
import json
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from e2e_firefox import Marionette  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
ADDON_ID = "firefox-pass@localhost"
UUID = "0e3c5f7a-2b1d-4c6e-9f00-7a1b2c3d4e5f"


def main():
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    dark = "--dark" in sys.argv
    tmp = Path(tempfile.mkdtemp(prefix="pass-icon-"))
    ff = None
    try:
        profile = tmp / "profile"
        profile.mkdir()
        (profile / "user.js").write_text(
            'user_pref("marionette.port", 2830);\n'
            + 'user_pref("extensions.webextensions.uuids", "{\\"%s\\": \\"%s\\"}");\n' % (ADDON_ID, UUID)
            + 'user_pref("browser.toolbars.bookmarks.visibility", "never");\n'
            + ('user_pref("ui.systemUsesDarkTheme", 1);\n' if dark else ""))
        ff = subprocess.Popen(["firefox", "--headless", "--marionette", "-remote-allow-system-access", "--no-remote",
                               "--profile", str(profile), "--window-size", "1000,300"],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        m = Marionette(2830)
        m("WebDriver:NewSession", {})
        m("Addon:Install", {"path": str(REPO / "extension"), "temporary": True, "allowPrivateBrowsing": True})
        m("Marionette:SetContext", {"value": "chrome"})
        time.sleep(1.5)

        def chrome(script, *args):
            return m("WebDriver:ExecuteScript", {"script": script, "args": list(args)})

        # An extension page in a background tab, to call the theme API from.
        chrome("""const w = Services.wm.getMostRecentWindow('navigator:browser');
                  w.gBrowser.addTab(arguments[0], { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });""",
               f"moz-extension://{UUID}/options/options.html")
        time.sleep(1)
        m("Marionette:SetContext", {"value": "content"})
        ext_tab = next(h for h in m("WebDriver:GetWindowHandles")
                       if (m("WebDriver:SwitchToWindow", {"handle": h}) or True)
                       and m("WebDriver:GetCurrentURL").startswith("moz-extension:"))
        m("Marionette:SetContext", {"value": "chrome"})

        def bg(script):
            m("Marionette:SetContext", {"value": "content"})
            m("WebDriver:SwitchToWindow", {"handle": ext_tab})
            r = m("WebDriver:ExecuteAsyncScript", {"script": "const done = arguments[arguments.length - 1];"
                  " Promise.resolve((window.wrappedJSObject || window)." + script + ").then((v) => done(JSON.parse(JSON.stringify(v ?? null))), (e) => done(String(e)));"})
            m("Marionette:SetContext", {"value": "chrome"})
            return r

        widget = chrome("return CustomizableUI.getWidget(arguments[0]).id",
                        "firefox-pass_localhost-browser-action")

        def shot(name, window=None):
            m("WebDriver:SwitchToWindow", {"handle": window or main_win})
            time.sleep(1.2)
            nav = m("WebDriver:FindElement", {"using": "css selector", "value": "#nav-bar"})
            png = m("WebDriver:TakeScreenshot", {"id": next(iter(nav.values()))})
            (out / f"{name}.png").write_bytes(base64.b64decode(png))
            print("wrote", out / f"{name}.png")

        mode = "dark" if dark else "light"
        print("theme colors:", bg("browser.theme.getCurrent()"))
        main_win = m("WebDriver:GetWindowHandle")
        shot(f"{mode}-default")
        bg("browser.theme.update({ colors: { frame: '#3b1d5c', tab_background_text: '#fff', toolbar: '#5a2d8a',"
           " toolbar_text: '#ffe6a8', icons: '#ffd23f', toolbar_field: '#2a1440', toolbar_field_text: '#fff' } })")
        shot(f"{mode}-custom-theme")
        bg("browser.theme.reset()")
        shot(f"{mode}-theme-reset")

        before = set(m("WebDriver:GetWindowHandles"))
        chrome("OpenBrowserWindow({ private: true })")
        time.sleep(2)
        private = (set(m("WebDriver:GetWindowHandles")) - before).pop()
        shot(f"{mode}-private-window", private)
        m("WebDriver:SwitchToWindow", {"handle": main_win})
    finally:
        if ff:
            ff.kill()
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
