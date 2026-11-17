"use strict";

const DEFAULTS = { autoFillSingle: true, autoFillOtp: true, clipboardSeconds: 45 };
const $ = (id) => document.getElementById(id);

async function loadSettings() {
  const { settings } = await browser.storage.local.get("settings");
  const s = Object.assign({}, DEFAULTS, settings);
  $("autoFillSingle").checked = s.autoFillSingle;
  $("autoFillOtp").checked = s.autoFillOtp;
  $("clipboardSeconds").value = s.clipboardSeconds;
}

async function saveSettings() {
  const seconds = Math.max(0, Math.min(600, parseInt($("clipboardSeconds").value, 10) || 0));
  await browser.storage.local.set({
    settings: {
      autoFillSingle: $("autoFillSingle").checked,
      autoFillOtp: $("autoFillOtp").checked,
      clipboardSeconds: seconds,
    },
  });
}

async function checkHost() {
  const el = $("hostStatus");
  try {
    const v = await browser.runtime.sendMessage({ type: "version" });
    const { entries } = await browser.runtime.sendMessage({ type: "list", force: true });
    el.className = "host-status";
    el.textContent = `Native host ${v.version} · ${entries.length} entries in ${v.store}`;
  } catch (e) {
    el.className = "host-status error";
    el.textContent = e.message;
  }
}

function ago(t) {
  const d = (Date.now() - t) / 1000;
  if (d < 3600) return `${Math.max(1, Math.round(d / 60))} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}

async function renderHistory() {
  const { history = {} } = await browser.storage.local.get("history");
  const q = $("filter").value.trim().toLowerCase();
  const rows = [];
  for (const [host, map] of Object.entries(history.host || {})) {
    for (const [path, rec] of Object.entries(map)) rows.push({ host, path, rec });
  }
  rows.sort((a, b) => a.host.localeCompare(b.host) || b.rec.t - a.rec.t);
  const tbody = $("rows");
  tbody.textContent = "";
  for (const r of rows) {
    if (q && !r.host.includes(q) && !r.path.toLowerCase().includes(q)) continue;
    const tr = document.createElement("tr");
    const cells = [r.host, r.path, String(Math.round(r.rec.n * 10) / 10), ago(r.rec.t)];
    cells.forEach((text, i) => {
      const td = document.createElement("td");
      td.textContent = text;
      if (i >= 2) td.className = "n";
      tr.append(td);
    });
    const td = document.createElement("td");
    const b = document.createElement("button");
    b.className = "x";
    b.textContent = "×";
    b.title = "Forget this entry for this site";
    b.addEventListener("click", () => forget(r.host, r.path));
    td.append(b);
    tr.append(td);
    tbody.append(tr);
  }
  if (!tbody.children.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    td.className = "n";
    td.textContent = rows.length ? "Nothing matches." : "Nothing remembered yet.";
    tr.append(td);
    tbody.append(tr);
  }
}

/** Forgets [path] for [host], including the forms on it and, if no other host of the site uses it, the site. */
async function forget(host, path) {
  const { history = {} } = await browser.storage.local.get("history");
  const del = (scope, key) => {
    const m = history[scope] && history[scope][key];
    if (!m) return;
    delete m[path];
    if (!Object.keys(m).length) delete history[scope][key];
  };
  del("host", host);
  for (const key of Object.keys(history.form || {})) if (key.startsWith(host + "/") || key.startsWith(host + "|")) del("form", key);
  const site = PassMatch.siteOf(host);
  const stillOnSite = Object.entries(history.host || {}).some(([h, m]) => PassMatch.siteOf(h) === site && m[path]);
  if (!stillOnSite) del("site", site);
  await browser.storage.local.set({ history });
  renderHistory();
}

$("filter").addEventListener("input", renderHistory);
$("prune").addEventListener("click", async () => {
  await browser.runtime.sendMessage({ type: "history-prune" });
  renderHistory();
});
$("clearAll").addEventListener("click", async () => {
  if (!confirm("Forget which entries you used on every site?")) return;
  await browser.storage.local.remove("history");
  renderHistory();
});
for (const id of ["autoFillSingle", "autoFillOtp", "clipboardSeconds"]) $(id).addEventListener("change", saveSettings);

const AUTH_PERMISSIONS = { permissions: ["webRequest", "webRequestBlocking"], origins: ["<all_urls>"] };

async function loadAuth() {
  $("httpAuth").checked = await browser.permissions.contains(AUTH_PERMISSIONS);
}

$("httpAuth").addEventListener("change", async (e) => {
  // Must be asked from this click, so no await before it.
  const enabling = e.target.checked;
  const done = enabling
    ? browser.permissions.request(AUTH_PERMISSIONS)
    : browser.permissions.remove(AUTH_PERMISSIONS);
  const note = $("httpAuthNote");
  note.textContent = "";
  try {
    const ok = await done;
    if (enabling && !ok) note.textContent = "Firefox's permission prompt was declined, so HTTP logins stay with Firefox.";
    if (enabling && ok) note.textContent = "On. Reload a page whose login dialog is already open.";
  } catch (err) {
    note.textContent = `Firefox refused: ${err.message}`;
  } finally {
    loadAuth();
  }
});

loadAuth();
loadSettings();
checkHost();
renderHistory();
