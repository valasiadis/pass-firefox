"use strict";

const $ = (id) => document.getElementById(id);
const els = {
  host: $("host"), formInfo: $("formInfo"), query: $("query"), list: $("list"), empty: $("empty"),
  status: $("status"), statusTitle: $("statusTitle"), statusDetail: $("statusDetail"),
};
const MAX_ROWS = 300;
// Set when this page is the picker window for an HTTP login (see auth.js).
const authToken = new URLSearchParams(location.search).get("auth");

let ctx = null;
let entries = [];
let history = {};
let settings = {};
let ranked = [];
let selected = 0;
let busy = false;

function bg(msg) {
  return browser.runtime.sendMessage(msg);
}

function rankContext() {
  return {
    host: ctx.host, port: ctx.port, site: ctx.site, label: ctx.label, formKey: ctx.formKey,
    lastFillPath: ctx.lastFill ? ctx.lastFill.path : null,
  };
}

// ------------------------------------------------------------------ status

function showStatus(kind, title, detail) {
  els.status.hidden = false;
  els.status.className = `status ${kind}`;
  els.statusTitle.textContent = title;
  els.statusDetail.textContent = detail || "";
}

function hideStatus() {
  els.status.hidden = true;
}

// ------------------------------------------------------------------ list

function highlighted(text, offset, matches) {
  const frag = document.createDocumentFragment();
  const set = new Set(matches.filter((m) => m >= offset && m < offset + text.length).map((m) => m - offset));
  let run = "";
  let runMarked = false;
  const flush = () => {
    if (!run) return;
    if (runMarked) {
      const m = document.createElement("mark");
      m.textContent = run;
      frag.append(m);
    } else frag.append(run);
    run = "";
  };
  [...text].forEach((ch, i) => {
    const marked = set.has(i);
    if (marked !== runMarked) {
      flush();
      runMarked = marked;
    }
    run += ch;
  });
  flush();
  return frag;
}

function badgesFor(r) {
  const out = [];
  const times = (n) => (n >= 1.5 ? ` ×${Math.round(n)}` : "");
  if (r.justUsed) out.push(["just used", ""]);
  if (r.uses.form) out.push([`used on this form${times(r.uses.form)}`, ""]);
  else if (r.uses.host) out.push([`used here${times(r.uses.host)}`, ""]);
  else if (r.uses.site) out.push(["used on this site", ""]);
  if (!out.length) {
    if (r.tier === 3) out.push(["this host", "plain"]);
    else if (r.tier === 2) out.push(["this domain", "plain"]);
    else if (r.tier === 1) out.push(["same site", "plain"]);
    else if (r.labelHit) out.push(["name match", "plain"]);
  }
  return out.slice(0, 1);
}

function button(label, title, action, primary) {
  const b = document.createElement("button");
  b.textContent = label;
  b.title = title;
  if (primary) b.className = "primary";
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    action();
  });
  return b;
}

function render() {
  els.list.textContent = "";
  const rows = ranked.slice(0, MAX_ROWS);
  rows.forEach((r, i) => {
    const li = document.createElement("li");
    li.className = "row";
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", String(i === selected));

    const slash = r.path.lastIndexOf("/");
    const name = r.path.slice(slash + 1);
    const dir = slash >= 0 ? r.path.slice(0, slash) : "";
    const text = document.createElement("div");
    text.style.minWidth = "0";
    const n = document.createElement("div");
    n.className = "name";
    n.append(highlighted(name, slash + 1, r.fuzzy.matches));
    text.append(n);
    if (dir) {
      const d = document.createElement("div");
      d.className = "dir";
      d.append(highlighted(dir, 0, r.fuzzy.matches));
      text.append(d);
    }

    const badges = document.createElement("div");
    badges.className = "badges";
    for (const [label, cls] of badgesFor(r)) {
      const b = document.createElement("span");
      b.className = `badge ${cls}`;
      b.textContent = label;
      badges.append(b);
    }

    const actions = document.createElement("div");
    actions.className = "actions";
    if (ctx.target) actions.append(button("Fill", "Fill (Enter)", () => doFill(r.path), true));
    actions.append(
      button("Pass", "Copy password (Alt+P)", () => doCopy(r.path, "password")),
      button("User", "Copy username (Alt+U)", () => doCopy(r.path, "username")),
      button("OTP", "Copy OTP (Alt+O)", () => doCopy(r.path, "otp")),
    );

    const side = document.createElement("div");
    side.append(badges, actions);
    li.append(text, side);
    li.addEventListener("click", () => (ctx.target ? doFill(r.path) : doCopy(r.path, "password")));
    li.addEventListener("mousemove", () => select(i, false));
    els.list.append(li);
  });

  els.empty.hidden = rows.length > 0;
  els.empty.className = "empty";
  if (!rows.length) els.empty.textContent = entries.length ? "No entry matches." : "The store is empty.";
}

function select(i, scroll = true) {
  if (!ranked.length) return;
  const max = Math.min(ranked.length, MAX_ROWS) - 1;
  const next = Math.max(0, Math.min(max, i));
  if (next === selected && els.list.children[next]) return;
  const prev = els.list.children[selected];
  if (prev) prev.setAttribute("aria-selected", "false");
  selected = next;
  const cur = els.list.children[selected];
  if (cur) {
    cur.setAttribute("aria-selected", "true");
    if (scroll) cur.scrollIntoView({ block: "nearest" });
  }
}

function update() {
  ranked = PassMatch.rank(entries, rankContext(), els.query.value, history);
  selected = 0;
  render();
}

// ------------------------------------------------------------------ actions

function shortName(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}

async function doFill(path) {
  if (busy) return;
  if (!ctx.target) return doCopy(path, "password");
  if (authToken) {
    busy = true;
    showStatus("busy", `Logging in with ${shortName(path)}…`, "Enter your PIN or touch your security key if it asks.");
    const res = await bg({ type: "auth-choose", token: authToken, path });
    if (!res || !res.ok) showStatus("error", "Could not log in", res ? res.error : "");
    return; // the background page closes this window
  }
  busy = true;
  showStatus("busy", `Decrypting ${shortName(path)}…`,
    "Enter your PIN or touch your security key if it asks. You can close this.");
  const res = await bg({ type: "fill", ctx, path });
  busy = false;
  if (res && res.ok) {
    window.close();
    return;
  }
  showStatus("error", "Could not fill", res ? res.error : "No answer from the extension");
}

async function doCopy(path, what) {
  if (busy) return;
  busy = true;
  const label = { password: "password", username: "username", otp: "OTP" }[what];
  showStatus("busy", `Decrypting ${shortName(path)}…`, "Enter your PIN or touch your security key if it asks.");
  const res = await bg({ type: "copy", ctx, path, what });
  busy = false;
  if (res && res.ok) {
    const parts = [res.seconds > 0 ? `Clipboard clears in ${res.seconds} s.` : ""];
    if (what === "otp" && res.remaining) parts.push(`Code valid for ${res.remaining} s.`);
    showStatus("done", `Copied ${label}`, parts.filter(Boolean).join(" "));
    setTimeout(() => window.close(), 900);
    return;
  }
  showStatus("error", `Could not copy ${label}`, res ? res.error : "");
}

// ------------------------------------------------------------------ keys

els.query.addEventListener("input", update);
document.addEventListener("keydown", (e) => {
  const cur = ranked[selected];
  if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) select(selected + 1);
  else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) select(selected - 1);
  else if (e.key === "PageDown") select(selected + 8);
  else if (e.key === "PageUp") select(selected - 8);
  else if (e.key === "Escape" && authToken) window.close(); // a window, not a popup: close it ourselves
  else if (e.key === "Enter" && cur) (ctx.target ? doFill(cur.path) : doCopy(cur.path, "password"));
  else if (e.altKey && cur && ["p", "u", "o"].includes(e.key.toLowerCase())) {
    doCopy(cur.path, { p: "password", u: "username", o: "otp" }[e.key.toLowerCase()]);
  } else return;
  e.preventDefault();
});

$("options").addEventListener("click", (e) => {
  e.preventDefault();
  browser.runtime.openOptionsPage();
  window.close();
});

// ------------------------------------------------------------------ start

function describeTarget() {
  if (!ctx.host) return ["no web page: copy only", ""];
  if (!ctx.target) return ["no login form: copy only", ""];
  const t = ctx.target;
  const what = { login: "login form", username: "username field", otp: "one-time code field" }[t.mode];
  return [ctx.insecure ? `${what} · not HTTPS` : what, ctx.insecure ? "warn" : ""];
}

/** The picker as a window for an HTTP login challenge: no page to fill, a realm to answer. */
async function startAuth() {
  document.body.classList.add("in-window");
  let listRes;
  [ctx, listRes, { history = {} } = {}] = await Promise.all([
    bg({ type: "auth-context", token: authToken }),
    bg({ type: "list" }),
    browser.storage.local.get(["history"]),
  ]);
  if (!ctx) {
    showStatus("error", "This login request is gone", "The page may have stopped loading.");
    return;
  }
  ctx.target = { mode: "auth" };
  entries = listRes.entries;
  document.title = `Log in to ${ctx.host}`;
  els.host.textContent = ctx.host + (ctx.port ? `:${ctx.port}` : "");
  const realm = ctx.realm ? ` · “${ctx.realm}”` : "";
  els.formInfo.textContent = (ctx.isProxy ? "proxy login" : "HTTP login") + realm;
  els.formInfo.title = ctx.url;
  update();
}

async function start() {
  if (authToken) return startAuth();
  // ?tab=<id> opens the picker for another tab (used by the tests, which cannot click the button).
  const forced = parseInt(new URLSearchParams(location.search).get("tab"), 10);
  const [tab] = forced ? [await browser.tabs.get(forced)] : await browser.tabs.query({ active: true, currentWindow: true });
  let listRes;
  try {
    [ctx, listRes, { history = {}, settings = {} } = {}] = await Promise.all([
      bg({ type: "context", tabId: tab.id }),
      bg({ type: "list" }),
      browser.storage.local.get(["history", "settings"]),
    ]);
  } catch (e) {
    els.empty.hidden = false;
    els.empty.className = "empty error";
    els.empty.textContent = e.message;
    return;
  }
  settings = Object.assign({ autoFillSingle: true, autoFillOtp: true }, settings);
  entries = listRes.entries;

  els.host.textContent = ctx.host || (tab.url || "").split("/")[0] || "—";
  const [info, cls] = describeTarget();
  els.formInfo.textContent = info;
  els.formInfo.className = `form-info ${cls}`;
  update();

  if (ctx.pending) {
    showStatus("busy", `Decrypting ${shortName(ctx.pending.path)}…`,
      "Waiting for your PIN or security key from an earlier request.");
    busy = true;
    return;
  }
  if (!ctx.target) return;

  // Second step of a login (one-time code), right after filling the first step: same entry.
  if (ctx.target.mode === "otp" && settings.autoFillOtp && ctx.lastFill && ctx.lastFill.hasOtp) {
    doFill(ctx.lastFill.path);
    return;
  }
  // Exactly one entry named after this page, and nothing remembered pointing elsewhere.
  const unique = settings.autoFillSingle ? PassMatch.uniqueMatch(ranked) : null;
  if (unique) doFill(unique.path);
}

// Firefox ignores autofocus while the popup is still being opened, so focus the search box once
// it is shown, and again whenever the popup gets focus back.
function focusSearch() {
  if (document.activeElement !== els.query) els.query.focus({ preventScroll: true });
}
focusSearch();
requestAnimationFrame(focusSearch);
for (const ms of [50, 150, 300]) setTimeout(focusSearch, ms);
window.addEventListener("focus", focusSearch);

start().finally(focusSearch);
