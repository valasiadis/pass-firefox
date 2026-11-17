#!/bin/sh
# End-to-end test of the native host with a throwaway key and store (never touches yours).
set -eu
repo=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'gpgconf --homedir "$tmp/gnupg" --kill gpg-agent 2>/dev/null; rm -rf "$tmp"' EXIT
export GNUPGHOME="$tmp/gnupg" PASSWORD_STORE_DIR="$tmp/store" XDG_CONFIG_HOME="$tmp/config"
mkdir -m 700 "$GNUPGHOME"
gpg --batch --quiet --passphrase '' --quick-gen-key "test <test@invalid>" ed25519 encr never 2>/dev/null \
  || gpg --batch --quiet --passphrase '' --quick-gen-key "test <test@invalid>" default default never
pass init test@invalid >/dev/null
printf 'hunter2\nusername: jdoe\nemail: jdoe@example.org\nusernames: a1, a2\notpauth://totp/X?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8\n\nnotes: secret stuff\n' \
  | pass insert -m "Work/login.example.com" >/dev/null
printf 'user: bob\npassword: pw:with:colons\n' | pass insert -m "Private/Commerce/Amazon" >/dev/null
mkdir -p "$PASSWORD_STORE_DIR/.hidden" && touch "$PASSWORD_STORE_DIR/.hidden/x.gpg"

python3 -I - "$repo/host/pass_host.py" <<'PY'
import json, struct, subprocess, sys, importlib.util
host = sys.argv[1]
def call(msg):
    data = json.dumps(msg).encode()
    out = subprocess.run([host], input=struct.pack("@I", len(data)) + data, capture_output=True, check=True).stdout
    (n,) = struct.unpack("@I", out[:4]); return json.loads(out[4:4 + n])
fails = 0
def eq(name, a, b):
    global fails
    ok = a == b; fails += not ok
    print(("ok   " if ok else "FAIL ") + name + ("" if ok else f": got {a!r}, want {b!r}"))
eq("version", call({"action": "version"})["ok"], True)
eq("list", call({"action": "list"})["entries"], ["Private/Commerce/Amazon", "Work/login.example.com"])
r = call({"action": "show", "path": "Work/login.example.com"})
eq("password", r["password"], "hunter2")
eq("logins", [l["value"] for l in r["logins"]], ["jdoe", "jdoe@example.org", "a1", "a2"])
eq("otp present", len(r["otp"]["code"]), 8)
eq("notes not sent", "secret stuff" in json.dumps(r), False)
eq("otp secret not sent", "GEZDGNBV" in json.dumps(r), False)
r = call({"action": "show", "path": "Private/Commerce/Amazon"})
eq("password: field", (r["password"], r["logins"], r["otp"]), ("pw:with:colons", [{"key": "user", "value": "bob"}], None))
for bad in ["../etc/passwd", "/etc/passwd", "--help", "Work/../Work/login.example.com", "nope", ""]:
    eq(f"rejects {bad!r}", call({"action": "show", "path": bad})["ok"], False)

spec = importlib.util.spec_from_file_location("h", host); h = importlib.util.module_from_spec(spec); spec.loader.exec_module(h)
# RFC 6238 test vectors (8 digits).
seeds = {"SHA1": b"12345678901234567890", "SHA256": b"12345678901234567890123456789012",
         "SHA512": b"1234567890123456789012345678901234567890123456789012345678901234"}
import base64
for t, want in [(59, {"SHA1": "94287082", "SHA256": "46119246", "SHA512": "90693936"}),
                (1111111109, {"SHA1": "07081804", "SHA256": "68084774", "SHA512": "25091201"}),
                (20000000000, {"SHA1": "65353130", "SHA256": "77737706", "SHA512": "47863826"})]:
    for algo, code in want.items():
        line = f"otpauth://totp/x?secret={base64.b32encode(seeds[algo]).decode()}&digits=8&algorithm={algo}"
        eq(f"rfc6238 {algo} t={t}", h.totp_from_line(line, now=t)["code"], code)
eq("totp: key form", h.totp_from_line("totp: GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ", now=59)["code"], "287082")
eq("first line field", h.parse_entry("login: x\npassword: y\n")["password"], "y")
sys.exit(1 if fails else 0)
PY
