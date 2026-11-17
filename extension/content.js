/*
 * Injected on demand (activeTab) into every frame of the tab the popup was opened on.
 * Evaluates to a description of the frame's fillable fields; fills them when the background
 * page sends a "pass-fill" message carrying this frame's token.
 */
(() => {
  "use strict";

  const USERNAME_HINT = /user|login|logon|e-?mail|account|identifier|benutzer|anmelde|kennung|nutzer/i;
  const EMAIL_HINT = /e-?mail|mail/i;
  const OTP_HINT =
    /one.?time|otp|totp|2fa|mfa|two.?factor|second.?factor|verification.?code|verify|auth(entication|enticator)?.?code|security.?code|token|einmal|bestätigung|sicherheitscode|tan\b/i;
  const NOT_USERNAME = /search|query|captcha|coupon|promo|newsletter/i;

  function visible(el) {
    if (el.disabled || el.readOnly || el.type === "hidden") return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && parseFloat(cs.opacity || "1") > 0.05;
  }

  function hints(el) {
    const label = el.labels && el.labels.length ? [...el.labels].map((l) => l.textContent).join(" ") : "";
    return [el.name, el.id, el.className, el.placeholder, el.getAttribute("aria-label"), label]
      .filter(Boolean).join(" ");
  }

  function ac(el) {
    return (el.getAttribute("autocomplete") || "").toLowerCase();
  }

  const TEXTLIKE = new Set(["text", "email", "tel", "", "username"]);

  function isOtp(el) {
    if (ac(el).includes("one-time-code")) return true;
    if (!(TEXTLIKE.has(el.type) || el.type === "number" || el.type === "password")) return false;
    const max = el.maxLength;
    const shortish = max < 0 || (max >= 4 && max <= 10) || el.inputMode === "numeric";
    return shortish && OTP_HINT.test(hints(el)) && !USERNAME_HINT.test(ac(el));
  }

  /** Six (or 4–8) one-character boxes side by side, as some sites ask for a code. */
  function otpBoxes(inputs) {
    const singles = inputs.filter((i) => i.maxLength === 1 && (TEXTLIKE.has(i.type) || i.type === "number"));
    for (let i = 0; i < singles.length; i++) {
      const group = [singles[i]];
      for (let j = i + 1; j < singles.length; j++) {
        if (singles[j].form !== singles[i].form) break;
        group.push(singles[j]);
      }
      if (group.length >= 4 && group.length <= 8) return group;
    }
    return null;
  }

  function isUsername(el) {
    if (!TEXTLIKE.has(el.type)) return false;
    const a = ac(el);
    if (a.includes("username") || a.includes("email")) return true;
    if (el.type === "email") return true;
    const h = hints(el);
    return USERNAME_HINT.test(h) && !NOT_USERNAME.test(h) && !isOtp(el);
  }

  function before(a, b) {
    return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  function pathKey(form) {
    let p = location.pathname;
    try {
      if (form && form.getAttribute("action")) p = new URL(form.action, location.href).pathname;
    } catch (e) { /* keep page path */ }
    // Ids and hashes in the path would make every visit a new form.
    return p.replace(/\/[0-9a-f-]{8,}(?=\/|$)/gi, "/*").replace(/\/\d+(?=\/|$)/g, "/#");
  }

  function detect() {
    const inputs = [...document.querySelectorAll("input")].filter(visible);
    const passwords = inputs.filter((i) => i.type === "password" && !isOtp(i));
    let password = null;
    let username = null;
    let otp = null;

    if (passwords.length) {
      password =
        passwords.find((p) => ac(p).includes("current-password")) ||
        passwords.find((p) => !ac(p).includes("new-password")) ||
        passwords[0];
      const scope = password.form ? inputs.filter((i) => i.form === password.form) : inputs;
      const candidates = scope.filter((i) => TEXTLIKE.has(i.type) && before(i, password) && !isOtp(i));
      username =
        candidates.find((i) => /username|email/.test(ac(i))) ||
        candidates.filter((i) => isUsername(i)).pop() ||
        candidates.pop() ||
        null;
    } else {
      username = inputs.find((i) => /username|email/.test(ac(i))) || inputs.find(isUsername) || null;
    }

    const otpSingle = inputs.find((i) => i !== password && i !== username && isOtp(i));
    const boxes = otpSingle ? null : otpBoxes(inputs);
    if (otpSingle || boxes) otp = otpSingle ? [otpSingle] : boxes;

    const mode = password ? "login" : otp ? "otp" : username ? "username" : "none";
    const form = (password || (otp && otp[0]) || username || {}).form || null;
    const usernameKind = username &&
      (username.type === "email" || ac(username).includes("email") || EMAIL_HINT.test(hints(username)))
      ? "email" : "text";
    const names = [username, password].filter(Boolean).map((e) => e.name || e.id || e.type).join(",");

    state = {
      token: crypto.randomUUID(),
      fields: { username, password, otp },
    };
    return {
      token: state.token,
      host: location.hostname,
      port: location.port,
      mode,
      usernameKind,
      hasUsername: !!username,
      hasPassword: !!password,
      hasOtp: !!otp,
      focused: document.hasFocus(),
      isTop: window === window.top,
      formKey: `${location.hostname.toLowerCase().replace(/^www\d*\./, "")}${pathKey(form)}|${mode}|${names}`,
    };
  }

  function setValue(el, value) {
    el.focus();
    // Through the prototype's setter, so frameworks that track the value (React) see a change.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(el, value);
    for (const type of ["input", "change"]) el.dispatchEvent(new Event(type, { bubbles: true }));
    el.blur();
  }

  function fill(msg) {
    if (location.hostname !== msg.host) return { ok: false, error: "The page changed before filling" };
    const { username, password, otp } = state.fields;
    const filled = [];
    if (username && msg.username && username.isConnected) {
      setValue(username, msg.username);
      filled.push("username");
    }
    if (password && msg.password && password.isConnected) {
      setValue(password, msg.password);
      filled.push("password");
    }
    if (otp && msg.otp) {
      if (otp.length === 1) setValue(otp[0], msg.otp);
      else otp.forEach((box, i) => setValue(box, msg.otp[i] || ""));
      filled.push("otp");
    }
    const last = otp ? otp[otp.length - 1] : password || username;
    if (last && last.isConnected) last.focus();
    return { ok: filled.length > 0, filled, error: filled.length ? undefined : "Nothing to fill on this page" };
  }

  let state = window.__passFillState || { token: null, fields: {} };
  if (!window.__passFillListening) {
    window.__passFillListening = true;
    browser.runtime.onMessage.addListener((msg) => {
      if (!msg || msg.type !== "pass-fill" || msg.token !== window.__passFillState.token) return undefined;
      state = window.__passFillState;
      return Promise.resolve(fill(msg));
    });
  }
  const result = detect();
  window.__passFillState = state;
  return result;
})();
