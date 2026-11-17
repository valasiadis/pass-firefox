/*
 * Background page. Everything that waits on decryption runs here, not in the popup: a pinentry
 * window or a YubiKey prompt takes focus, which closes the popup and would cancel the fill.
 */
"use strict";

const HOST = "firefox_pass";
const LIST_TTL_MS = 15000;
const LAST_FILL_TTL_MS = 5 * 60 * 1000;
const DEFAULT_SETTINGS = { autoFillSingle: true, autoFillOtp: true, clipboardSeconds: 45 };

let listCache = null;
const lastFill = new Map(); // tabId -> {path, site, hasOtp, t}
const pending = new Map(); // tabId -> {path, label}
let historyQueue = Promise.resolve();
let clipboardToken = 0;

// ------------------------------------------------------------------ native host

async function native(msg) {
  let res;
  try {
    res = await browser.runtime.sendNativeMessage(HOST, msg);
  } catch (e) {
    throw new Error(`Native host unavailable (${e.message}). Did you run install.sh?`);
  }
  if (!res || !res.ok) throw new Error((res && res.error) || "No answer from the native host");
  return res;
}

async function listEntries(force) {
  if (!force && listCache && Date.now() - listCache.t < LIST_TTL_MS) return listCache.entries;
  const { entries } = await native({ action: "list" });
  listCache = { t: Date.now(), entries };
  return entries;
}

// ------------------------------------------------------------------ storage

async function getSettings() {
  const { settings } = await browser.storage.local.get("settings");
  return Object.assign({}, DEFAULT_SETTINGS, settings);
}

async function getHistory() {
  const { history } = await browser.storage.local.get("history");
  return history || {};
}

function recordHistory(ctx, path) {
  historyQueue = historyQueue.then(async () => {
    const history = PassMatch.recordUse(await getHistory(), ctx, path);
    await browser.storage.local.set({ history });
  }).catch((e) => console.error("history", e));
  return historyQueue;
}

// ------------------------------------------------------------------ page

/** Injects the content script into every frame it may run in and picks the frame to fill. */
async function pageContext(tabId) {
  const tab = await browser.tabs.get(tabId);
  let url;
  try {
    url = new URL(tab.url);
  } catch (e) {
    url = null;
  }
  const host = url && /^https?:$/.test(url.protocol) ? url.hostname : "";
  const ctx = {
    tabId,
    incognito: tab.incognito,
    url: tab.url,
    host: PassMatch.normalizeHost(host),
    port: url ? url.port : "",
    site: PassMatch.siteOf(host),
    label: PassMatch.siteLabel(host),
    insecure: !!url && url.protocol === "http:" && !/^(localhost|127\.|\[::1\])/.test(url.hostname),
    target: null,
    formKey: null,
    lastFill: null,
    pending: pending.get(tabId) || null,
  };
  if (!host) return ctx;

  let frames = [];
  try {
    frames = await browser.tabs.executeScript(tabId, { file: "/content.js", allFrames: true });
  } catch (e) {
    try {
      frames = await browser.tabs.executeScript(tabId, { file: "/content.js" });
    } catch (e2) {
      console.warn("inject failed", e2);
    }
  }
  const modeRank = { login: 3, otp: 2, username: 1, none: 0 };
  const usable = (frames || []).filter((f) => f && f.mode && f.mode !== "none");
  usable.sort((a, b) =>
    modeRank[b.mode] - modeRank[a.mode] || b.focused - a.focused || b.isTop - a.isTop);
  ctx.target = usable[0] || null;
  ctx.formKey = ctx.target ? ctx.target.formKey : null;

  const lf = lastFill.get(tabId);
  if (lf && lf.site === ctx.site && Date.now() - lf.t < LAST_FILL_TTL_MS) ctx.lastFill = lf;
  return ctx;
}

// ------------------------------------------------------------------ actions

function entryContext(ctx) {
  return { host: ctx.host, site: ctx.site, formKey: ctx.formKey };
}

async function fill(ctx, path) {
  const target = ctx.target;
  if (!target) throw new Error("No login form found on this page");
  pending.set(ctx.tabId, { path });
  try {
    const entry = await native({ action: "show", path });
    const dm = PassMatch.domainMatch(path, ctx.host, ctx.port);
    const username = PassMatch.chooseUsername(entry.logins, target.usernameKind, path, dm.index);
    const otp = entry.otp ? entry.otp.code : "";
    const msg = {
      type: "pass-fill",
      token: target.token,
      host: target.host,
      username: target.mode === "otp" ? "" : username,
      password: target.mode === "login" ? entry.password || "" : "",
      otp: target.hasOtp ? otp : "",
    };
    if (target.mode === "otp" && !otp) {
      throw new Error(entry.otpError || `${path} has no OTP`);
    }
    if (target.mode === "login" && !msg.password) throw new Error(`${path} has no password`);
    const res = await browser.tabs.sendMessage(ctx.tabId, msg);
    if (!res || !res.ok) throw new Error((res && res.error) || "The page did not take the fill");

    lastFill.set(ctx.tabId, { path, site: ctx.site, hasOtp: !!entry.otp, t: Date.now() });
    if (!ctx.incognito) await recordHistory(entryContext(ctx), path);
    return { ok: true, filled: res.filled, hasOtp: !!entry.otp };
  } finally {
    pending.delete(ctx.tabId);
  }
}

async function copy(ctx, path, what) {
  const entry = await native({ action: "show", path });
  let value = "";
  if (what === "password") value = entry.password || "";
  else if (what === "otp") value = entry.otp ? entry.otp.code : "";
  else if (what === "username") {
    const dm = PassMatch.domainMatch(path, ctx.host, ctx.port);
    value = PassMatch.chooseUsername(entry.logins, ctx.target ? ctx.target.usernameKind : "text", path, dm.index);
  }
  if (!value) {
    throw new Error(what === "otp" && entry.otpError ? entry.otpError : `${path} has no ${what}`);
  }
  await navigator.clipboard.writeText(value);
  const token = ++clipboardToken;
  const { clipboardSeconds } = await getSettings();
  if (clipboardSeconds > 0) {
    setTimeout(() => {
      // Only clear what we put there, not something copied since.
      if (token === clipboardToken) navigator.clipboard.writeText("").catch(() => {});
    }, clipboardSeconds * 1000);
  }
  if (ctx.host && !ctx.incognito) await recordHistory(entryContext(ctx), path);
  return { ok: true, seconds: clipboardSeconds, remaining: entry.otp ? entry.otp.remaining : null };
}

function popupOpen() {
  return browser.extension.getViews({ type: "popup" }).length > 0;
}

function notifyError(title, err) {
  browser.notifications.create({
    type: "basic",
    iconUrl: browser.runtime.getURL("icons/icon-tile.svg"),
    title,
    message: String(err && err.message ? err.message : err),
  });
}

// ------------------------------------------------------------------ messages

browser.runtime.onMessage.addListener((msg, sender) => {
  // Only the popup and the options page, never a content script.
  if (sender.id !== browser.runtime.id || !String(sender.url).startsWith(browser.runtime.getURL(""))) {
    return undefined;
  }
  const run = async () => {
    switch (msg.type) {
      case "context":
        return pageContext(msg.tabId);
      case "list":
        return { entries: await listEntries(msg.force) };
      case "fill":
        try {
          return await fill(msg.ctx, msg.path);
        } catch (e) {
          // The popup may be gone by now (pinentry took focus): tell the user another way.
          if (!popupOpen()) notifyError("Could not fill from pass", e);
          return { ok: false, error: e.message };
        }
      case "copy":
        try {
          return await copy(msg.ctx, msg.path, msg.what);
        } catch (e) {
          if (!popupOpen()) notifyError("Could not copy from pass", e);
          return { ok: false, error: e.message };
        }
      case "history-prune": {
        const entries = await listEntries(true);
        const history = PassMatch.pruneHistory(await getHistory(), entries);
        await browser.storage.local.set({ history });
        return { ok: true };
      }
      case "version":
        return native({ action: "version" });
      default:
        return authMessage(msg); // auth.js: the HTTP authentication picker

    }
  };
  return run();
});

browser.tabs.onRemoved.addListener((tabId) => {
  lastFill.delete(tabId);
  pending.delete(tabId);
});

browser.contextMenus.create({
  id: "pass-fill",
  title: "Fill from pass…",
  contexts: ["editable", "page"],
});

browser.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === "pass-fill") browser.browserAction.openPopup();
});

// ------------------------------------------------------------------ toolbar icon

/*
 * theme_icons in the manifest picks the dark or light glyph from each window's toolbar
 * brightness (default, light, dark and private-window themes). A theme that names its own
 * toolbar-icon colour gets the glyph in exactly that colour, per window, like Firefox's icons.
 */
let glyphSvg = null;

function cssColor(c) {
  if (c == null) return null;
  return Array.isArray(c) ? (c.length === 4 ? `rgba(${c.join(",")})` : `rgb(${c.join(",")})`) : String(c);
}

async function glyphImageData(color) {
  if (!glyphSvg) glyphSvg = await (await fetch("/icons/toolbar-dark.svg")).text();
  const svg = glyphSvg.replace(/fill="[^"]*"/, `fill="${color.replace(/"/g, "")}"`);
  const img = new Image();
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  await img.decode();
  const out = {};
  for (const size of [16, 32, 48, 64]) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const g = canvas.getContext("2d");
    g.drawImage(img, 0, 0, size, size);
    out[size] = g.getImageData(0, 0, size, size);
  }
  return out;
}

async function themeToolbarIcon(windowId) {
  try {
    const theme = await browser.theme.getCurrent(windowId);
    const c = theme && theme.colors ? theme.colors : {};
    const color = cssColor(c.icons) || cssColor(c.toolbar_text) || cssColor(c.bookmark_text);
    if (color) await browser.browserAction.setIcon({ windowId, imageData: await glyphImageData(color) });
    else await browser.browserAction.setIcon({ windowId }); // back to theme_icons
  } catch (e) {
    console.warn("toolbar icon", e);
  }
}

async function themeAllWindows() {
  for (const w of await browser.windows.getAll({ windowTypes: ["normal"] })) themeToolbarIcon(w.id);
}

browser.theme.onUpdated.addListener(({ windowId }) =>
  windowId ? themeToolbarIcon(windowId) : themeAllWindows());
browser.windows.onCreated.addListener((w) => themeToolbarIcon(w.id));
themeAllWindows();
