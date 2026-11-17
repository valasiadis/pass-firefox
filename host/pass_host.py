#!/usr/bin/env python3
"""Native messaging host for the firefox-pass extension.

Lists the entries of a password store and decrypts one through `pass show`, so whatever
gpg setup pass uses (gpg-agent, a YubiKey/OpenPGP card, its pinentry) is used here too.
Only the password, the username-like fields and a current TOTP code leave this process;
the rest of an entry (notes, the OTP secret) never reaches the browser.

Optional config: ~/.config/firefox-pass/config.json
  {"store_dir": "~/.password-store", "pass": "pass", "env": {"GNUPGHOME": "..."}}
Firefox does not start hosts from a login shell, so variables such as PASSWORD_STORE_DIR
set in ~/.bashrc have to go there.
"""

import base64
import hashlib
import hmac
import json
import os
import struct
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path, PurePosixPath

VERSION = "1.0.0"
CONFIG_FILE = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "firefox-pass" / "config.json"
DECRYPT_TIMEOUT = 300  # long enough to find the YubiKey, type the PIN and touch it

# Field names as Android-Password-Store's PasswordEntry knows them, plus "usernames" and "e-mail".
USERNAME_KEYS = ["login", "username", "usernames", "user", "account", "email", "e-mail", "mail"]
PASSWORD_KEYS = ["password", "pass", "secret"]
TOTP_KEYS = ["otpauth://", "totp:"]


def load_config():
    try:
        with open(CONFIG_FILE, encoding="utf-8") as f:
            cfg = json.load(f)
        return cfg if isinstance(cfg, dict) else {}
    except FileNotFoundError:
        return {}


CONFIG = load_config()


def environment():
    env = dict(os.environ)
    for k, v in (CONFIG.get("env") or {}).items():
        env[str(k)] = os.path.expanduser(str(v))
    if CONFIG.get("store_dir"):
        env["PASSWORD_STORE_DIR"] = os.path.expanduser(CONFIG["store_dir"])
    # No terminal to ask on: let gpg-agent use its graphical pinentry.
    env.pop("GPG_TTY", None)
    return env


ENV = environment()
STORE = Path(ENV.get("PASSWORD_STORE_DIR") or Path.home() / ".password-store").expanduser()


# ------------------------------------------------------------------ messaging

def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    (length,) = struct.unpack("@I", raw)
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))


def send_message(obj):
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("@I", len(data)) + data)
    sys.stdout.buffer.flush()


# ------------------------------------------------------------------ store

def list_entries():
    if not STORE.is_dir():
        raise RuntimeError(f"Password store not found at {STORE}")
    entries = []
    for dirpath, dirnames, filenames in os.walk(STORE, followlinks=True):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        rel = Path(dirpath).relative_to(STORE)
        for name in filenames:
            if name.endswith(".gpg") and not name.startswith("."):
                entries.append((rel / name[:-4]).as_posix())
    entries.sort(key=str.lower)
    return entries


def checked_path(path):
    if not isinstance(path, str) or not path or "\0" in path or "\n" in path:
        raise ValueError("Invalid entry name")
    p = PurePosixPath(path)
    if p.is_absolute() or any(part in ("..", ".", "") for part in p.parts) or path.startswith("-"):
        raise ValueError("Invalid entry name")
    if not (STORE / (path + ".gpg")).is_file():
        raise ValueError(f"No such entry: {path}")
    return path


def decrypt(path):
    cmd = [CONFIG.get("pass") or "pass", "show", "--", checked_path(path)]
    try:
        proc = subprocess.run(
            cmd, env=ENV, stdin=subprocess.DEVNULL, capture_output=True, timeout=DECRYPT_TIMEOUT
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError("Timed out waiting for decryption (PIN entry or key touch)")
    except FileNotFoundError:
        raise RuntimeError(f"'{cmd[0]}' not found; set \"pass\" in {CONFIG_FILE}")
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", "replace").strip().splitlines()
        raise RuntimeError(err[-1] if err else f"pass exited with {proc.returncode}")
    return proc.stdout.decode("utf-8", "replace")


# ------------------------------------------------------------------ parsing

def field(line, keys):
    """('key', 'value') when line is 'key: value' for one of keys (case-insensitive)."""
    if ":" not in line:
        return None
    key, value = line.split(":", 1)
    key = key.strip().lower()
    return (key, value.strip()) if key in keys else None


def parse_entry(text):
    lines = [l.rstrip("\r") for l in text.split("\n")]
    password = None
    first = lines[0] if lines else ""
    first_is_field = field(first, USERNAME_KEYS + PASSWORD_KEYS) or any(
        first.lower().startswith(k) for k in TOTP_KEYS
    )
    if first.strip() and not first_is_field:
        password = first
        rest = lines[1:]
    else:
        rest = lines

    logins, otp_line, seen = [], None, set()
    for line in rest:
        stripped = line.strip()
        low = stripped.lower()
        if low.startswith("otpauth://") or low.startswith("totp:"):
            otp_line = stripped  # last one wins, as in Android-Password-Store
            continue
        if field(stripped, ["otp"]) and "otpauth://" in low:
            otp_line = stripped.split(":", 1)[1].strip()
            continue
        f = field(stripped, PASSWORD_KEYS)
        if f and password is None:
            password = f[1]
            continue
        f = field(stripped, USERNAME_KEYS)
        if f and f[1]:
            key, value = f
            values = [v.strip() for v in value.replace(";", ",").split(",")] if key == "usernames" else [value]
            for v in values:
                if v and (key, v) not in seen:
                    seen.add((key, v))
                    logins.append({"key": key, "value": v})

    otp, otp_error = None, None
    if otp_line:
        try:
            otp = totp_from_line(otp_line)
        except Exception as e:  # noqa: BLE001 - reported to the user, not fatal
            otp_error = f"Could not compute OTP: {e}"
    return {"password": password, "logins": logins, "otp": otp, "otpError": otp_error}


# ------------------------------------------------------------------ TOTP

STEAM_ALPHABET = "23456789BCDFGHJKMNPQRTVWXY"


def b32decode(secret):
    s = secret.replace(" ", "").replace("-", "").upper()
    s += "=" * (-len(s) % 8)
    return base64.b32decode(s)


def totp_from_line(line, now=None):
    if line.lower().startswith("totp:"):
        params = {"secret": line.split(":", 1)[1].strip()}
        otp_type, issuer = "totp", ""
    else:
        u = urllib.parse.urlparse(line)
        otp_type = u.netloc.lower()
        params = {k.lower(): v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        issuer = params.get("issuer", "")
    if otp_type != "totp":
        raise ValueError(f"{otp_type or 'this'} OTP is not supported, only TOTP")
    if "secret" not in params:
        raise ValueError("no secret")
    period = int(params.get("period", 30)) or 30
    digits = int(params.get("digits", 6))
    algo = params.get("algorithm", "SHA1").upper().replace("-", "")
    digest = {"SHA1": hashlib.sha1, "SHA256": hashlib.sha256, "SHA512": hashlib.sha512}.get(algo)
    if digest is None:
        raise ValueError(f"unsupported algorithm {algo}")
    steam = params.get("encoder", "").lower() == "steam" or issuer.lower() == "steam"
    now = time.time() if now is None else now
    counter = int(now // period)
    mac = hmac.new(b32decode(params["secret"]), struct.pack(">Q", counter), digest).digest()
    offset = mac[-1] & 0x0F
    value = struct.unpack(">I", mac[offset:offset + 4])[0] & 0x7FFFFFFF
    if steam:
        code = ""
        for _ in range(5):
            code += STEAM_ALPHABET[value % len(STEAM_ALPHABET)]
            value //= len(STEAM_ALPHABET)
    else:
        code = str(value % (10 ** digits)).zfill(digits)
    return {"code": code, "period": period, "remaining": period - int(now) % period}


# ------------------------------------------------------------------ main

def handle(msg):
    action = msg.get("action")
    if action == "version":
        return {"ok": True, "version": VERSION, "store": str(STORE)}
    if action == "list":
        return {"ok": True, "entries": list_entries()}
    if action == "show":
        return {"ok": True, **parse_entry(decrypt(msg.get("path")))}
    raise ValueError(f"Unknown action {action!r}")


def main():
    while True:
        msg = read_message()
        if msg is None:
            return
        try:
            send_message(handle(msg))
        except Exception as e:  # noqa: BLE001 - every failure goes back as a message
            send_message({"ok": False, "error": str(e)})


if __name__ == "__main__":
    main()
