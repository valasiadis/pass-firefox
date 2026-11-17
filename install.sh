#!/bin/sh
# Registers the native messaging host with Firefox (and LibreWolf, if present) for this user.
set -eu
dir=$(cd "$(dirname "$0")" && pwd)
host="$dir/host/pass_host.py"
chmod +x "$host"

write_manifest() {
  mkdir -p "$1"
  cat > "$1/firefox_pass.json" <<JSON
{
  "name": "firefox_pass",
  "description": "pass (passwordstore.org) bridge for the pass fill extension",
  "path": "$host",
  "type": "stdio",
  "allowed_extensions": ["firefox-pass@localhost"]
}
JSON
  echo "Installed $1/firefox_pass.json"
}

write_manifest "$HOME/.mozilla/native-messaging-hosts"
[ -d "$HOME/.librewolf" ] && write_manifest "$HOME/.librewolf/native-messaging-hosts"

command -v pass >/dev/null || echo "Warning: 'pass' is not on PATH" >&2
echo "Now load $dir/extension in Firefox (see README.md)."
