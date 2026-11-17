# pass fill

A Firefox extension that fills logins from a [pass](https://www.passwordstore.org/) store. It
decrypts through `pass show` itself, so gpg-agent, a YubiKey and your pinentry work as they do in
the terminal.

## How it picks an entry

The approach follows Android-Password-Store's autofill (`AutofillMatcher`, strict-domain search,
sublimefuzzy):

1. **Named after the page.** Each path component of each entry is compared with the page's host:
   - the host itself: `Work/erp.example.de`, or `…/host42.example.net:8443/…` with the port,
   - a parent domain: `example.com/alice` for `login.example.com`,
   - another host of the same site: `shop.example.com` for `login.example.com`.

   If the best of these levels holds **exactly one** entry, and you haven't used a different
   entry on this page before, that entry is filled straight away.
2. **Otherwise a picker opens**, with fuzzy search (Sublime-style, and space-separated words all
   have to match). Without a query, the entries are ordered by:
   1. used on **this form** (host + form action + field names),
   2. used on **this host**,
   3. used on **this site** (e.g. `amazon.de`),
   4. named after the host, then named after the site's brand (`Commerce/Amazon` on
      `www.amazon.de`),
   5. used recently anywhere.

   When you type a query, the same signals are added to the fuzzy score, so a remembered entry
   beats an equally good match. Use counts decay with a 45-day half-life, so a new habit
   overtakes an old one. Only uses are remembered: which entry on which host or form, how often,
   and when. They are kept in the extension's local storage, and you can view or forget them on
   the settings page.
3. **One-time codes.** If the next page asks for a code (`autocomplete="one-time-code"`, OTP-like
   field names, or 4–8 one-character boxes), the entry you just filled on that site is decrypted
   again and its TOTP is filled.

### Entry format

The format is the one Android-Password-Store reads:

- **Password:** the first line, unless the first line is a `key:` field. In that case the
  `password:`, `pass:` or `secret:` field is used.
- **Username:** `login:`, `username:`, `usernames:` (a comma-separated list), `user:`,
  `account:`, `email:`, `e-mail:` or `mail:`. An e-mail field (`type=email`) gets an e-mail
  value first; any other field gets a username first.
- **No username field:** the file name is used if it is an e-mail address, or if a folder above
  it is the domain (`example.com/alice`).
- **OTP:** an `otpauth://totp/…` line (also after `otp:`), or `totp: <base32>`. SHA1, SHA256 and
  SHA512, custom digits and period, and Steam codes all work.

Only the password, the username fields and the current code reach the browser. Notes and the OTP
secret stay in the native host.

## Install

```sh
./install.sh   # registers the native host in ~/.mozilla/native-messaging-hosts
```

Then install the signed `pass_fill-<version>.xpi` from the latest GitHub release: open it in
Firefox, or drag it onto a window. It updates itself from GitHub releases after that.

For development, load the unsigned folder instead: open `about:debugging#/runtime/this-firefox`,
choose *Load Temporary Add-on…*, and pick `extension/manifest.json`. It is removed when Firefox
restarts.

## Releasing

Releases are built by `.github/workflows/release.yml`. Every push runs the tests. A tag signs the
add-on and publishes it:

```sh
git tag v1.0.1 && git push origin v1.0.1
```

The workflow then does the following:

1. Signs the extension on addons.mozilla.org as an **unlisted** add-on: Mozilla checks and signs
   it, but it is not listed in their catalogue. The version comes from the tag, not from
   `manifest.json`.
2. Points the signed manifest's `update_url` at this repository's latest `updates.json`.
3. Publishes a GitHub release containing the `.xpi`, `updates.json` and a native-host tarball.

Installed copies then update on their own.

For this to work, the repository needs:

- the secrets `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`, from
  <https://addons.mozilla.org/developers/addon/api/key/>;
- to be **public**, so that Firefox can download `updates.json` and the `.xpi` without logging in.

Each version can be signed only once, so never reuse a tag.

To sign locally instead, put the same keys in `~/.config/firefox-pass/amo.json` as
`{"issuer": "…", "secret": "…"}` and run `tools/sign.py`. The signed file goes to `dist/`.

If `pass` or your store live somewhere Firefox doesn't see (Firefox doesn't read `~/.bashrc`),
create `~/.config/firefox-pass/config.json`:

```json
{ "store_dir": "~/.password-store", "pass": "/usr/bin/pass", "env": { "GNUPGHOME": "~/.gnupg" } }
```

gpg-agent needs a graphical pinentry (`pinentry-qt`, `pinentry-gnome3`), because there is no
terminal to ask in.

## Use

Press **Ctrl+Shift+L**, click the toolbar key, or right-click and choose *Fill from pass…*.

| Key | Action |
| --- | --- |
| `↵` / click | fill (copy the password if the page has no form) |
| `↑` `↓`, `Ctrl+N`/`Ctrl+P` | move |
| `Alt+P` / `Alt+U` / `Alt+O` | copy password / username / OTP (cleared after 45 s by default) |

Decryption runs in the background page. A PIN prompt or a YubiKey waiting for a touch can take
focus and close the popup, and the fill still goes through. Errors then show up as a desktop
notification.

### HTTP authentication

Some sites ask for a login through Firefox's own dialog instead of a form on the page (HTTP Basic
or Digest authentication, also proxies). The extension can answer these too. Turn on *Answer HTTP
logins* in the settings. Firefox then asks you to let the extension see your requests on all
sites, which it needs in order to answer the login.

- **Matching:** entries are matched against the host asking for the login. Each realm is
  remembered the way a form is.
- **Without asking:** an entry you used for that host and realm before, or the only entry named
  after the host, is decrypted and sent straight away.
- **Otherwise** the picker opens in a small window. Closing it with `Esc` leaves the login to
  Firefox's dialog.
- **Wrong credentials:** if the server refuses an entry, it is forgotten for that realm and the
  picker opens again. If that choice is refused too, Firefox's dialog takes over.

**Private windows:** Firefox doesn't run add-ons in private windows unless you allow it. Turn on
*Run in Private Windows* on the add-on's page in `about:addons`. Logins filled in private windows
are not remembered.

The toolbar icon follows the theme. On the default, light and dark themes, and in private
windows, it uses the dark or light glyph. A theme that sets its own icon colour gets the key in
that colour.

The extension only has `activeTab`. It can read a page only after you open the popup on it, and
it never reads pages in the background. Login forms inside cross-origin iframes are therefore
not reached.

## Layout and tests

```text
extension/      the WebExtension (MV2, so decryption can outlive the popup)
  lib/match.js    domain matching, fuzzy search, ranking, history
  background.js   native messaging, filling, clipboard, history
  content.js      field detection and filling, injected on demand
  popup/          the picker
  options/        settings and remembered entries
host/pass_host.py native messaging host (Python 3, standard library only)
tools/sign.py     AMO signing (unlisted), used by the release workflow
tests/
  match_test.js   gjs -m tests/match_test.js
  host_test.sh    throwaway key + store, real `pass`, RFC 6238 vectors
  e2e_firefox.py  headless Firefox over Marionette, throwaway HOME: fills real forms
  icon_check.py   screenshots the toolbar button on light/dark/custom/private-window themes
design/         logo concepts and the final mark (final/)
```
