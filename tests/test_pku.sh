#!/usr/bin/env bash
# pku must dial exactly the target the driver used: this pins the relay
# address and port, the direct-mode host, and the stale-socket cleanup, using
# synthetic session files and a fake ssh (no cluster, no network).
#
# Run with: bash tests/test_pku.sh
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/sessions"

if ! python3 -c 'import socket; socket.AF_UNIX' >/dev/null 2>&1; then
  echo "pku: skipped (this python has no AF_UNIX sockets)"
  exit 0
fi

# Any -O check fails, so every case lands on the "not connected" path where the
# computed socket name is printed.
cat > "$work/bin/ssh" <<'SH'
#!/bin/sh
exit 1
SH
chmod +x "$work/bin/ssh"

export PATH="$work/bin:$PATH"
export PKU_CLUSTER_DIR="$work"
pku="$root/resources/pku"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

expect() { # text, needle
  case "$1" in
    *"$2"*) ;;
    *) fail "expected '$2' in: $1" ;;
  esac
}

run() { # key, command...
  local key=$1
  shift
  set +e
  out=$(bash "$pku" -c "$key" "$@" 2>&1)
  set -e
  printf '%s' "$out"
}

socket_at() { # absolute path
  mkdir -p "$(dirname "$1")"
  python3 - "$1" <<'PY'
import socket, sys
socket.socket(socket.AF_UNIX, socket.SOCK_STREAM).bind(sys.argv[1])
PY
}

# 1. relay mode dials relayHost:relayPort, not the WSL default gateway.
cat > "$work/sessions/wm1-login.json" <<'JSON'
{ "key": "wm1:login", "host": "endpoint.example", "port": 22, "user": "alice",
  "mode": "relay", "relayHost": "127.0.0.1", "relayPort": 2345, "controlPath": "" }
JSON
expect "$(run wm1:login status)" "alice@127.0.0.1-2345"

# 2. A missing relayPort falls back to 2222, exactly like login.py does.
cat > "$work/sessions/wm1-login.json" <<'JSON'
{ "key": "wm1:login", "host": "endpoint.example", "port": 22, "user": "alice",
  "mode": "relay", "relayHost": "127.0.0.1", "controlPath": "" }
JSON
expect "$(run wm1:login status)" "alice@127.0.0.1-2222"

# 3. Direct mode dials loginHost, the field the driver uses, when both exist.
cat > "$work/sessions/wm1-login.json" <<'JSON'
{ "key": "wm1:login", "host": "endpoint.example", "loginHost": "login.example",
  "loginPort": 22, "user": "alice", "mode": "direct", "controlPath": "" }
JSON
expect "$(run wm1:login status)" "alice@login.example-22"

# 4. A stale socket is removed and named instead of being timed out on.
cat > "$work/sessions/wm1-login.json" <<'JSON'
{ "key": "wm1:login", "host": "endpoint.example", "port": 22, "user": "alice",
  "mode": "relay", "relayHost": "127.0.0.1", "relayPort": 2345, "controlPath": "" }
JSON
sock="$work/cm/wm1-login/alice@127.0.0.1-2345"
socket_at "$sock"
expect "$(run wm1:login status)" "removed a stale socket at $sock"
test -e "$sock" && fail "stale socket was not removed"

# 5. down cleans one up too.
socket_at "$sock"
expect "$(run wm1:login down)" "removed a stale socket for wm1:login"
test -e "$sock" && fail "down left the stale socket behind"

# 6. The session list reads the same host the dial would.
expect "$(bash "$pku" sessions 2>&1)" "wm1:login"

echo "pku: target resolution and stale sockets OK"
