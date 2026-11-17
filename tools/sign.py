#!/usr/bin/env python3
"""Signs the extension as an unlisted (self-distributed) add-on on addons.mozilla.org.

What `web-ext sign --channel=unlisted` does, with the standard library only. Unlisted add-ons
are not listed on AMO; they pass the automatic review and come back signed, usually in minutes.

Credentials (from https://addons.mozilla.org/developers/addon/api/key/), either in
  ~/.config/firefox-pass/amo.json   {"issuer": "user:12345:67", "secret": "..."}   (chmod 600)
or in the environment as AMO_JWT_ISSUER and AMO_JWT_SECRET.

Each upload needs a new version number: the manifest's, or --version.
Usage:
  tools/sign.py                                   -> dist/pass_fill-<version>.xpi
  tools/sign.py --version 1.2.0 \
      --update-url https://github.com/OWNER/REPO/releases/latest/download/updates.json \
      --update-link https://github.com/OWNER/REPO/releases/download/v1.2.0/pass_fill-1.2.0.xpi
                                                  -> also dist/updates.json, for Firefox's auto-update
"""
import argparse
import base64
import hashlib
import hmac
import io
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

API = "https://addons.mozilla.org/api/v5"
REPO = Path(__file__).resolve().parent.parent
EXT = REPO / "extension"
DIST = REPO / "dist"
CREDS = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "firefox-pass" / "amo.json"


def credentials():
    issuer, secret = os.environ.get("AMO_JWT_ISSUER"), os.environ.get("AMO_JWT_SECRET")
    if not (issuer and secret) and CREDS.is_file():
        data = json.loads(CREDS.read_text())
        issuer, secret = data.get("issuer"), data.get("secret")
    if not (issuer and secret):
        sys.exit(f"No AMO API credentials: put them in {CREDS} or AMO_JWT_ISSUER/AMO_JWT_SECRET.")
    return issuer, secret


def b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=")


def jwt(issuer, secret):
    now = int(time.time())
    header = b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    payload = b64(json.dumps({"iss": issuer, "jti": secrets.token_hex(16), "iat": now, "exp": now + 60}).encode())
    sig = b64(hmac.new(secret.encode(), header + b"." + payload, hashlib.sha256).digest())
    return (header + b"." + payload + b"." + sig).decode()


class Amo:
    def __init__(self, issuer, secret):
        self.issuer, self.secret = issuer, secret

    def request(self, method, url, body=None, content_type=None, raw=False):
        if not url.startswith("http"):
            url = API + url
        req = urllib.request.Request(url, data=body, method=method)
        req.add_header("Authorization", "JWT " + jwt(self.issuer, self.secret))
        req.add_header("Accept", "application/json")
        if content_type:
            req.add_header("Content-Type", content_type)
        try:
            with urllib.request.urlopen(req, timeout=120) as res:
                data = res.read()
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")
            raise SystemExit(f"{method} {url} -> {e.code}: {detail}")
        return data if raw else json.loads(data or b"{}")

    def json(self, method, url, obj):
        return self.request(method, url, json.dumps(obj).encode(), "application/json")


def build_zip(manifest):
    """The extension folder, with [manifest] in place of manifest.json."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for path in sorted(EXT.rglob("*")):
            rel = path.relative_to(EXT).as_posix()
            if path.is_file() and not any(p.startswith(".") for p in rel.split("/")) and rel != "manifest.json":
                z.write(path, rel)
        z.writestr("manifest.json", json.dumps(manifest, indent=2) + "\n")
    return buf.getvalue()


def multipart(fields, file_field, filename, content):
    boundary = "----pass-fill-" + secrets.token_hex(12)
    out = io.BytesIO()
    for k, v in fields.items():
        out.write(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    out.write(f'--{boundary}\r\nContent-Disposition: form-data; name="{file_field}"; filename="{filename}"\r\n'
              f"Content-Type: application/zip\r\n\r\n".encode())
    out.write(content)
    out.write(f"\r\n--{boundary}--\r\n".encode())
    return out.getvalue(), f"multipart/form-data; boundary={boundary}"


def wait(what, fetch, done, timeout=900, every=5):
    start = time.time()
    while True:
        result = fetch()
        if done(result):
            return result
        if time.time() - start > timeout:
            raise SystemExit(f"Gave up waiting for {what} after {timeout} s")
        print(f"  waiting for {what}…", flush=True)
        time.sleep(every)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--version", help="version to sign as, instead of the manifest's")
    ap.add_argument("--update-url", help="where Firefox looks for updates (put into the manifest)")
    ap.add_argument("--update-link", help="where this version's .xpi will be downloadable (for updates.json)")
    args = ap.parse_args()

    manifest = json.loads((EXT / "manifest.json").read_text())
    gecko = manifest["browser_specific_settings"]["gecko"]
    guid = gecko["id"]
    if args.version:
        manifest["version"] = args.version
    if args.update_url:
        gecko["update_url"] = args.update_url
    version = manifest["version"]
    amo = Amo(*credentials())

    print(f"Uploading {guid} {version} (unlisted)…")
    body, ctype = multipart({"channel": "unlisted"}, "upload", "pass-fill.zip", build_zip(manifest))
    upload = amo.request("POST", "/addons/upload/", body, ctype)
    upload = wait("validation", lambda: amo.request("GET", f"/addons/upload/{upload['uuid']}/"),
                  lambda u: u.get("processed"))
    validation = upload.get("validation") or {}
    for msg in validation.get("messages", []):
        if msg.get("type") in ("error", "warning"):
            print(f"  {msg['type']}: {msg.get('message')} {msg.get('file') or ''}")
    if not upload.get("valid"):
        raise SystemExit("Validation failed, see above.")

    # Creates the add-on on the first run, adds a version on later ones.
    exists = True
    try:
        amo.request("GET", f"/addons/addon/{guid}/")
    except SystemExit:
        exists = False
    if exists:
        ver = amo.json("POST", f"/addons/addon/{guid}/versions/", {"upload": upload["uuid"]})
    else:
        addon = amo.json("PUT", f"/addons/addon/{guid}/", {"version": {"upload": upload["uuid"]}})
        ver = addon["version"]
    print(f"Version {ver['version']} submitted, waiting for signing…")

    ver = wait("signing", lambda: amo.request("GET", f"/addons/addon/{guid}/versions/{ver['id']}/"),
               lambda v: (v.get("file") or {}).get("status") in ("public", "disabled"), every=10)
    file = ver["file"]
    if file["status"] != "public":
        raise SystemExit(f"Not signed (status {file['status']}). Check the add-on on AMO.")
    DIST.mkdir(exist_ok=True)
    out = DIST / f"pass_fill-{version}.xpi"
    out.write_bytes(amo.request("GET", file["url"], raw=True))
    print(f"Signed: {out}")
    if args.update_link:
        updates = {"addons": {guid: {"updates": [{"version": version, "update_link": args.update_link}]}}}
        (DIST / "updates.json").write_text(json.dumps(updates, indent=2) + "\n")
        print(f"Wrote {DIST / 'updates.json'}")


if __name__ == "__main__":
    main()
