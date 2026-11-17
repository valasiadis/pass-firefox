/*
 * Takes the colours of the current Firefox theme (browser.theme.getCurrent) and sets them as the
 * CSS variables popup.css uses, and again whenever the theme changes. Colours the theme leaves
 * out keep the defaults in popup.css, which follow Firefox's own light and dark panels.
 */
(function () {
  "use strict";

  // CSS variable <- theme colour keys, first one set wins.
  const MAP = {
    "--bg": ["popup"],
    "--text": ["popup_text"],
    "--line": ["popup_border"],
    "--sel": ["popup_highlight"],
    "--sel-text": ["popup_highlight_text"],
    "--field": ["toolbar_field"],
    "--field-text": ["toolbar_field_text"],
    "--field-border": ["toolbar_field_border"],
    "--accent": ["focus_outline", "toolbar_field_border_focus", "tab_line", "icons_attention"],
    "--button": ["button_background_hover", "toolbar_field"],
  };

  function css(c) {
    if (c == null) return null;
    if (Array.isArray(c)) return c.length === 4 ? `rgba(${c.join(",")})` : `rgb(${c.join(",")})`;
    return String(c);
  }

  async function apply() {
    let colors = {};
    try {
      const win = await browser.windows.getCurrent();
      const theme = await browser.theme.getCurrent(win.id);
      colors = (theme && theme.colors) || {};
    } catch (e) {
      // No theme API here (or no window): keep the defaults.
    }
    const style = document.documentElement.style;
    for (const [name, keys] of Object.entries(MAP)) {
      const value = keys.map((k) => css(colors[k])).find(Boolean);
      if (value) style.setProperty(name, value);
      else style.removeProperty(name);
    }
  }

  apply();
  if (browser.theme && browser.theme.onUpdated) browser.theme.onUpdated.addListener(apply);
})();
