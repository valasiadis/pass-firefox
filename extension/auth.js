/*
 * HTTP authentication (Basic, Digest): answers the server's (or proxy's) challenge from pass
 * before Firefox shows its own login dialog.
 *
 * Needs the optional permissions webRequest, webRequestBlocking and <all_urls>, which the
 * settings page asks for; without them nothing here runs.
 *
 *  1. An entry remembered for this host and realm, or the single entry named after the host,
 *     is used without asking.
 *  2. Otherwise the picker opens in a small window; closing it leaves the login to Firefox.
 *  3. Credentials that are refused: the entry is forgotten for the realm and the picker opens;
 *     refused again, Firefox's dialog takes over. It never loops.
 */
"use strict";

const AUTH_PERMISSIONS = { permissions: ["webRequest", "webRequestBlocking"], origins: ["<all_urls>"] };
const AUTH_SCHEMES = /^(basic|digest)$/i;
const MAX_ATTEMPTS = 2;

const authAttempts = new Map(); // requestId -> {n, path}
const authShared = new Map(); // challenge key -> Promise of the listener's answer
const authPickers = new Map(); // token -> {ctx, resolve, windowId}

function authContext(details) {
  const c = details.challenger || {};
  const host = PassMatch.normalizeHost(c.host || new URL(details.url).hostname);
  const defaultPort = details.isProxy ? "" : new URL(details.url).protocol === "https:" ? 443 : 80;
  const port = c.port && c.port !== defaultPort ? String(c.port) : "";
  const realm = details.realm || "";
  return {
    host,
    port,
    site: PassMatch.siteOf(host),
    label: PassMatch.siteLabel(host),
    realm,
    isProxy: !!details.isProxy,
    incognito: !!details.incognito,
    url: details.url,
    // The realm stands in for the form: what you used for it comes first next time.
    formKey: `${host}${port ? ":" + port : ""}|${details.isProxy ? "proxy" : "http"}|${realm}`,
  };
}

/** Removes [path] from what was remembered for this realm, after the server refused it. */
async function forgetForRealm(ctx, path) {
  const history = await getHistory();
  const forms = history.form || {};
  if (forms[ctx.formKey] && forms[ctx.formKey][path]) {
    delete forms[ctx.formKey][path];
    if (!Object.keys(forms[ctx.formKey]).length) delete forms[ctx.formKey];
    await browser.storage.local.set({ history });
  }
}

async function credentialsFor(ctx, path) {
  const entry = await native({ action: "show", path });
  const dm = PassMatch.domainMatch(path, ctx.host, ctx.port);
  const username = PassMatch.chooseUsername(entry.logins, "text", path, dm.index);
  if (!entry.password) throw new Error(`${path} has no password`);
  if (!ctx.incognito) await recordHistory(ctx, path);
  return { username, password: entry.password };
}

/** Opens the picker in a window and resolves with the chosen path, or null when it is closed. */
function askUser(ctx) {
  return new Promise(async (resolve) => {
    const token = crypto.randomUUID();
    authPickers.set(token, { ctx, resolve, windowId: null });
    try {
      const win = await browser.windows.create({
        type: "popup",
        url: browser.runtime.getURL(`popup/popup.html?auth=${token}`),
        width: 440,
        height: 560,
        incognito: ctx.incognito || undefined,
      });
      const p = authPickers.get(token);
      if (p) p.windowId = win.id;
    } catch (e) {
      authPickers.delete(token);
      resolve(null);
    }
  });
}

browser.windows.onRemoved.addListener((windowId) => {
  for (const [token, p] of authPickers) {
    if (p.windowId === windowId) {
      authPickers.delete(token);
      p.resolve(null);
    }
  }
});

async function answerChallenge(details, attempt) {
  const ctx = authContext(details);
  let path = null;
  if (attempt.n === 1) {
    const ranked = PassMatch.rank(await listEntries(), ctx, "", await getHistory());
    const remembered = ranked.find((r) => r.uses.form > 0);
    const unique = PassMatch.uniqueMatch(ranked);
    path = remembered ? remembered.path : unique ? unique.path : null;
  } else if (attempt.path) {
    await forgetForRealm(ctx, attempt.path);
  }
  if (!path) path = await askUser(ctx);
  if (!path) return {}; // Firefox asks instead
  attempt.path = path;
  return { authCredentials: await credentialsFor(ctx, path) };
}

function onAuthRequired(details) {
  if (details.scheme && !AUTH_SCHEMES.test(details.scheme)) return {};
  const attempt = authAttempts.get(details.requestId) || { n: 0, path: null };
  attempt.n++;
  authAttempts.set(details.requestId, attempt);
  setTimeout(() => authAttempts.delete(details.requestId), 120000);
  if (attempt.n > MAX_ATTEMPTS) return {};

  // A page's many requests hit the same challenge at once: answer them with one decryption.
  // A retry belongs to its own request only.
  const sharedKey = attempt.n === 1 ? authContext(details).formKey : `${details.requestId}|${attempt.n}`;
  if (authShared.has(sharedKey)) return authShared.get(sharedKey);
  const answer = answerChallenge(details, attempt)
    .catch((e) => {
      notifyError("Could not log in from pass", e);
      return {};
    })
    .finally(() => setTimeout(() => authShared.delete(sharedKey), 1000));
  authShared.set(sharedKey, answer);
  return answer;
}

async function enableAuthListener() {
  const granted = await browser.permissions.contains(AUTH_PERMISSIONS);
  const has = browser.webRequest && browser.webRequest.onAuthRequired.hasListener(onAuthRequired);
  if (granted && !has) {
    browser.webRequest.onAuthRequired.addListener(onAuthRequired, { urls: ["<all_urls>"] }, ["blocking"]);
  }
}

browser.permissions.onAdded.addListener(enableAuthListener);
browser.permissions.onRemoved.addListener(() => {
  if (browser.webRequest && browser.webRequest.onAuthRequired.hasListener(onAuthRequired)) {
    browser.webRequest.onAuthRequired.removeListener(onAuthRequired);
  }
});
enableAuthListener();

/** Messages from the picker window (popup.html?auth=…) and the settings page. */
async function authMessage(msg) {
  switch (msg.type) {
    case "auth-context": {
      const p = authPickers.get(msg.token);
      return p ? p.ctx : null;
    }
    case "auth-choose": {
      const p = authPickers.get(msg.token);
      if (!p) return { ok: false, error: "This login request is gone" };
      authPickers.delete(msg.token);
      p.resolve(msg.path);
      if (p.windowId != null) browser.windows.remove(p.windowId).catch(() => {});
      return { ok: true };
    }
    case "auth-status":
      return { enabled: await browser.permissions.contains(AUTH_PERMISSIONS) };
    default:
      return undefined;
  }
}
