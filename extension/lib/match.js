/*
 * Matching and ranking of pass entries against the page being filled.
 *
 * Mirrors what Android-Password-Store does for autofill:
 *  - "strict domain" matching on path components (AutofillMatcher / generateStrictDomainRegex),
 *  - a Sublime-Text style fuzzy matcher (sublimefuzzy, after Forrest Smith's fts_fuzzy_match),
 *  - remembered matches per origin put first (AutofillMatcher.addMatchFor's MRU list),
 *    extended here with a per-form scope and a frecency score instead of plain MRU order.
 *
 * Plain script (no modules) so the background page, the popup and gjs tests can all load it.
 */
(function (root) {
  "use strict";

  // ---------------------------------------------------------------- domains

  // Second-level suffixes under which a registrable domain has three labels. Not the whole
  // Public Suffix List, just the ones a person is likely to log in under.
  const MULTI_LABEL_SUFFIXES = new Set([
    "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk",
    "com.au", "net.au", "org.au", "edu.au", "gov.au",
    "co.nz", "org.nz", "co.jp", "ne.jp", "or.jp", "co.kr", "co.za", "co.in",
    "com.br", "com.cn", "com.tr", "com.mx", "com.ar", "com.gr", "com.cy", "com.pl",
    "co.at", "or.at", "gv.at", "co.il", "com.sg", "com.hk", "com.tw",
  ]);

  const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$|^\[?[0-9a-f:]+\]?$/i;
  // A path component that looks like a host name, optionally with a port.
  const DOMAINISH_RE = /^[\p{L}\p{N}_-]+(\.[\p{L}\p{N}_-]+)+(:\d{1,5})?$/u;

  function normalizeHost(host) {
    return String(host || "").toLowerCase().replace(/\.$/, "").replace(/^www\d*\./, "");
  }

  /** "login.example.co.uk" -> "example.co.uk"; IPs and single labels are returned unchanged. */
  function siteOf(host) {
    host = normalizeHost(host);
    if (!host || IP_RE.test(host)) return host;
    const labels = host.split(".");
    if (labels.length <= 2) return host;
    const last2 = labels.slice(-2).join(".");
    return MULTI_LABEL_SUFFIXES.has(last2) ? labels.slice(-3).join(".") : last2;
  }

  /** "login.amazon.de" -> "amazon": what a brand-named entry ("Commerce/Amazon") would contain. */
  function siteLabel(host) {
    const site = siteOf(host);
    if (!site || IP_RE.test(site)) return "";
    return site.split(".")[0];
  }

  function splitPort(s) {
    const m = /^(.*?)(?::(\d{1,5}))?$/.exec(s);
    return { host: m[1], port: m[2] || "" };
  }

  /**
   * How well [path]'s components name the page's host:
   *   3 – a component is the host itself (login.example.com, or login.example.com:8443),
   *   2 – a component is a parent domain of it (example.com for login.example.com),
   *   1 – a component is another host on the same site (shop.example.com),
   *   0 – none.
   * Also says which component matched, so a username can be taken from the file name
   * when the domain is the folder ("example.com/jane@doe.org").
   */
  function domainMatch(path, pageHost, pagePort) {
    const host = normalizeHost(pageHost);
    if (!host) return { tier: 0, index: -1 };
    const site = siteOf(host);
    const parts = path.split("/");
    let best = { tier: 0, index: -1 };
    parts.forEach((raw, index) => {
      const comp = normalizeHost(raw.trim());
      if (!DOMAINISH_RE.test(comp)) return;
      const { host: h, port } = splitPort(comp);
      let tier = 0;
      if (h === host) tier = !port || !pagePort || port === String(pagePort) ? 3 : 2;
      else if (host.endsWith("." + h) && h.includes(".") && h !== siteSuffixOnly(h)) tier = 2;
      else if (siteOf(h) === site && site.includes(".")) tier = 1;
      if (tier > best.tier || (tier === best.tier && tier > 0 && index > best.index)) {
        best = { tier, index };
      }
    });
    return best;
  }

  // Guards against "co.uk" counting as a parent domain of "example.co.uk".
  function siteSuffixOnly(h) {
    return MULTI_LABEL_SUFFIXES.has(h) ? h : "";
  }

  // ---------------------------------------------------------------- fuzzy

  const SEQUENTIAL_BONUS = 15;
  const SEPARATOR_BONUS = 30;
  const CAMEL_BONUS = 30;
  const FIRST_LETTER_BONUS = 15;
  const LEADING_LETTER_PENALTY = -5;
  const MAX_LEADING_LETTER_PENALTY = -15;
  const UNMATCHED_LETTER_PENALTY = -1;
  const RECURSION_LIMIT = 10;
  const MAX_MATCHES = 256;
  const SEPARATORS = "/ _-.@:";

  /**
   * fts_fuzzy_match (the algorithm behind Android-Password-Store's sublimefuzzy): every pattern
   * character must appear in order; consecutive runs and matches at word starts score higher.
   * Returns { score, matches } or null when the pattern does not match.
   */
  function fuzzyMatchToken(pattern, str) {
    let recursionCount = 0;
    const pat = pattern.toLowerCase();
    const low = str.toLowerCase();

    function rec(pIdx, sIdx, srcMatches, nextMatch) {
      if (++recursionCount >= RECURSION_LIMIT * 100) return null;
      if (pIdx === pat.length || sIdx === str.length) return null;

      let matches = srcMatches.slice();
      let bestRecursive = null;

      while (pIdx < pat.length && sIdx < str.length) {
        if (pat[pIdx] === low[sIdx]) {
          if (nextMatch >= MAX_MATCHES) return null;
          // Try skipping this character: a later occurrence may score better.
          const sub = rec(pIdx, sIdx + 1, matches.slice(0, nextMatch), nextMatch);
          if (sub && (!bestRecursive || sub.score > bestRecursive.score)) bestRecursive = sub;
          matches[nextMatch++] = sIdx;
          pIdx++;
        }
        sIdx++;
      }

      const matched = pIdx === pat.length;
      let score = 0;
      if (matched) {
        matches = matches.slice(0, nextMatch);
        score = 100;
        score += Math.max(LEADING_LETTER_PENALTY * matches[0], MAX_LEADING_LETTER_PENALTY);
        score += UNMATCHED_LETTER_PENALTY * (str.length - nextMatch);
        for (let i = 0; i < nextMatch; i++) {
          const cur = matches[i];
          if (i > 0 && cur === matches[i - 1] + 1) score += SEQUENTIAL_BONUS;
          if (cur > 0) {
            const prev = str[cur - 1];
            const ch = str[cur];
            if (prev === prev.toLowerCase() && prev !== prev.toUpperCase() &&
                ch === ch.toUpperCase() && ch !== ch.toLowerCase()) score += CAMEL_BONUS;
            if (SEPARATORS.includes(prev)) score += SEPARATOR_BONUS;
          } else {
            score += FIRST_LETTER_BONUS;
          }
        }
      }
      if (bestRecursive && (!matched || bestRecursive.score > score)) return bestRecursive;
      return matched ? { score, matches } : null;
    }

    return rec(0, 0, [], 0);
  }

  /** Whitespace-separated tokens each have to match; their scores add up. */
  function fuzzyMatch(query, str) {
    const tokens = String(query || "").trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return { score: 0, matches: [] };
    let score = 0;
    const all = new Set();
    for (const t of tokens) {
      const r = fuzzyMatchToken(t, str);
      if (!r) return null;
      score += r.score;
      r.matches.forEach((m) => all.add(m));
    }
    return { score, matches: [...all].sort((a, b) => a - b) };
  }

  // ---------------------------------------------------------------- history

  const HALF_LIFE_MS = 45 * 24 * 3600 * 1000;

  /** Use count, decayed by how long ago the entry was last used. */
  function frecency(rec, now) {
    if (!rec) return 0;
    return rec.n * Math.pow(0.5, Math.max(0, now - rec.t) / HALF_LIFE_MS);
  }

  /**
   * History is { form: {key: {path: {n, t}}}, host: {...}, site: {...}, global: {path: {n, t}} }.
   * Returns what it knows about [path] for the page in [ctx].
   */
  function historyFor(history, ctx, path, now) {
    const h = history || {};
    const pick = (scope, key) => (key && h[scope] && h[scope][key] ? h[scope][key][path] : null);
    return {
      form: pick("form", ctx.formKey),
      host: pick("host", ctx.host),
      site: pick("site", ctx.site),
      global: h.global ? h.global[path] : null,
      now,
    };
  }

  // ---------------------------------------------------------------- ranking

  /**
   * Ranks [entries] (store-relative paths without .gpg) for the page described by [ctx]
   * ({host, port, site, label, formKey, lastFillPath}).
   *
   * Without a query every entry is listed, ordered: used on this form > used on this host >
   * used on this site > named after the host > named after the site's brand > recently used
   * anywhere > alphabetical. With a query only fuzzy matches are listed, and the same signals
   * are added to the fuzzy score, so a remembered entry wins over an equally good match.
   */
  function rank(entries, ctx, query, history, now) {
    now = now || Date.now();
    const q = String(query || "").trim();
    const label = ctx.label && ctx.label.length >= 3 ? ctx.label.toLowerCase() : "";
    const out = [];
    for (const path of entries) {
      const fz = q ? fuzzyMatch(q, path) : { score: 0, matches: [] };
      if (!fz) continue;
      const dm = domainMatch(path, ctx.host, ctx.port);
      const hist = historyFor(history, ctx, path, now);
      const fForm = frecency(hist.form, now);
      const fHost = frecency(hist.host, now);
      const fSite = frecency(hist.site, now);
      const fGlobal = frecency(hist.global, now);
      const labelHit = !!label && path.toLowerCase().includes(label);
      const justUsed = ctx.lastFillPath === path;

      let relevance = 0;
      if (justUsed) relevance += 40000;
      if (hist.form) relevance += 20000 + Math.min(5000, 500 * fForm);
      if (hist.host) relevance += 10000 + Math.min(5000, 250 * fHost);
      if (hist.site) relevance += 4000 + Math.min(2000, 100 * fSite);
      relevance += [0, 1200, 1600, 2000][dm.tier];
      if (labelHit) relevance += 600;
      relevance += Math.min(300, 30 * fGlobal);

      // With a query, keep fuzzy quality in charge but let remembered/matching entries
      // overtake roughly equivalent hits.
      const score = q ? fz.score + relevance / 100 : relevance;
      out.push({
        path,
        score,
        fuzzy: fz,
        tier: dm.tier,
        tierIndex: dm.index,
        labelHit,
        uses: {
          form: hist.form ? hist.form.n : 0,
          host: hist.host ? hist.host.n : 0,
          site: hist.site ? hist.site.n : 0,
        },
        justUsed,
      });
    }
    out.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return out;
  }

  /**
   * The entry to fill without asking, or null. As the user asked: fill straight away only when
   * the entries named after the page leave no choice – one entry in the best domain tier – and
   * nothing remembered for this page points elsewhere.
   */
  function uniqueMatch(ranked) {
    const best = Math.max(0, ...ranked.map((r) => r.tier));
    if (best < 1) return null;
    const inTier = ranked.filter((r) => r.tier === best);
    if (inTier.length !== 1) return null;
    const remembered = ranked.find((r) => r.uses.form || r.uses.host);
    if (remembered && remembered.path !== inTier[0].path) return null;
    return inTier[0];
  }

  /** Records that [path] was used for the page in [ctx]; returns the new history object. */
  function recordUse(history, ctx, path, now, limits) {
    now = now || Date.now();
    const lim = Object.assign({ perKey: 25, keys: 3000, global: 500 }, limits || {});
    const h = history ? JSON.parse(JSON.stringify(history)) : {};
    const bump = (map) => {
      const rec = map[path] || { n: 0, t: 0 };
      // Decay the old count so a long-unused entry can be overtaken by a new habit.
      rec.n = frecency(rec, now) + 1;
      rec.t = now;
      map[path] = rec;
      const keys = Object.keys(map);
      if (keys.length > lim.perKey) {
        keys.sort((a, b) => map[a].t - map[b].t)
          .slice(0, keys.length - lim.perKey)
          .forEach((k) => delete map[k]);
      }
    };
    const scoped = (scope, key) => {
      if (!key) return;
      h[scope] = h[scope] || {};
      h[scope][key] = h[scope][key] || {};
      bump(h[scope][key]);
      const keys = Object.keys(h[scope]);
      if (keys.length > lim.keys) {
        const newest = (k) => Math.max(...Object.values(h[scope][k]).map((r) => r.t));
        keys.sort((a, b) => newest(a) - newest(b))
          .slice(0, keys.length - lim.keys)
          .forEach((k) => delete h[scope][k]);
      }
    };
    scoped("form", ctx.formKey);
    scoped("host", ctx.host);
    scoped("site", ctx.site);
    h.global = h.global || {};
    const g = h.global;
    bump(g);
    const gk = Object.keys(g);
    if (gk.length > lim.global) {
      gk.sort((a, b) => g[a].t - g[b].t).slice(0, gk.length - lim.global).forEach((k) => delete g[k]);
    }
    return h;
  }

  /** Drops remembered entries that no longer exist in the store. */
  function pruneHistory(history, existing) {
    const set = new Set(existing);
    const h = JSON.parse(JSON.stringify(history || {}));
    for (const scope of ["form", "host", "site"]) {
      for (const key of Object.keys(h[scope] || {})) {
        for (const p of Object.keys(h[scope][key])) if (!set.has(p)) delete h[scope][key][p];
        if (!Object.keys(h[scope][key]).length) delete h[scope][key];
      }
    }
    for (const p of Object.keys(h.global || {})) if (!set.has(p)) delete h.global[p];
    return h;
  }

  // ---------------------------------------------------------------- usernames

  const EMAIL_KEYS = ["email", "e-mail", "mail"];
  const USER_KEYS = ["login", "username", "usernames", "user", "account"];

  /**
   * Picks the username to put into a field. [logins] are {key, value} pairs from the entry;
   * [kind] is "email" when the field asks for an e-mail address. When the entry has none, the
   * file name stands in if it is an e-mail address or if the domain is the folder it is in
   * (Android's directory-based structure: "example.com/jane.doe.gpg").
   */
  function chooseUsername(logins, kind, path, domainIndex) {
    logins = logins || [];
    const isMail = (l) => EMAIL_KEYS.includes(l.key) || /@/.test(l.value);
    const keyRank = (l) => {
      const order = kind === "email" ? EMAIL_KEYS.concat(USER_KEYS) : USER_KEYS.concat(EMAIL_KEYS);
      const i = order.indexOf(l.key);
      return i < 0 ? order.length : i;
    };
    if (logins.length) {
      const sorted = logins.slice().sort((a, b) => {
        if (kind === "email" && isMail(a) !== isMail(b)) return isMail(a) ? -1 : 1;
        return keyRank(a) - keyRank(b);
      });
      return sorted[0].value;
    }
    const parts = path.split("/");
    const base = parts[parts.length - 1].replace(/\.+$/, "");
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(base)) return base;
    if (domainIndex >= 0 && domainIndex < parts.length - 1 && !DOMAINISH_RE.test(base.toLowerCase())) {
      return base;
    }
    return "";
  }

  root.PassMatch = {
    normalizeHost, siteOf, siteLabel, domainMatch,
    fuzzyMatch, frecency, rank, uniqueMatch, recordUse, pruneHistory, chooseUsername,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
