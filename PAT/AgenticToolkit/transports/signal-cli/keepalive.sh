#!/bin/sh
# signal-cli account keep-alive.
#
# WHY THIS EXISTS
# ---------------
# A Signal account that goes inactive long enough is RECLAIMED by Signal's
# servers — the registration lapses and the linked identity stops receiving.
# PAT's bot account (+15550100003) lapsed once after ~a month, almost
# certainly because the signal-cli daemon was DOWN that whole month (no
# connection → Signal counted it as inactive).
#
# The 24/7 daemon connection (entrypoint.sh keeps signal-cli running, the
# watchdog keeps its receive loop alive) is the primary defense. This
# keep-alive is BELT-AND-SUSPENDERS: on a slow interval it issues an explicit
# "this account is active" round-trip to Signal's servers — a self-send (Note
# to Self) over the running daemon's JSON-RPC socket. A self-send produces
# real Signal-Service traffic keyed to our account, is invisible to any human
# (it lands only in our own Note-to-Self), and rides the daemon that's already
# up, so it costs nothing extra to run.
#
# This is intentionally distinct from the watchdog: the watchdog detects a
# WEDGED receive loop and forces a restart; this proves the account is still
# REGISTERED and that outbound to Signal's servers works. The two together
# cover "daemon deaf" (watchdog) and "account lapsing" (keep-alive).
#
# Pure POSIX sh + python3 (already required by watchdog.sh). Talks to the
# daemon's JSON-RPC TCP socket directly — no extra signal-cli process spawn
# (a second `signal-cli send` invocation would contend on the account state
# lock with the running daemon).
#
# Env (all optional):
#   SIGNAL_ACCOUNT            E164 of the linked identity (required to self-send)
#   SIGNAL_KEEPALIVE          set to "false" to disable (default: enabled)
#   SIGNAL_KEEPALIVE_INTERVAL seconds between self-sends (default 604800 = 7d)
#   SIGNAL_KEEPALIVE_GRACE    seconds to wait after boot before first send
#                             (default 120 — let the daemon open its relay)
#   SIGNAL_TCP_BIND           daemon bind (default 0.0.0.0:7583) — we connect
#                             to 127.0.0.1 on the bound port from inside the
#                             same machine.

set -u

KA_ENABLED="${SIGNAL_KEEPALIVE:-true}"
KA_INTERVAL="${SIGNAL_KEEPALIVE_INTERVAL:-604800}"
KA_GRACE="${SIGNAL_KEEPALIVE_GRACE:-120}"
ACCOUNT="${SIGNAL_ACCOUNT:-}"
BIND="${SIGNAL_TCP_BIND:-0.0.0.0:7583}"
# Derive the port the daemon bound; connect over loopback on the same machine.
PORT="${BIND##*:}"
HOST="127.0.0.1"

log() { echo "[signal-keepalive] $*"; }

# Issue one self-send over the daemon's JSON-RPC socket. Returns 0 on a
# successful RPC result (Signal Service accepted the message → account is
# active + outbound works), non-zero on any failure (socket refused, RPC
# error, timeout). Best-effort; the caller logs the outcome.
self_send() {
  python3 - "$HOST" "$PORT" "$ACCOUNT" <<'PY' 2>/dev/null
import json, socket, sys, time

host, port, account = sys.argv[1], int(sys.argv[2]), sys.argv[3]
# Self-send (Note to Self): recipient is our own account. signal-cli accepts
# this and it produces real Signal-Service traffic without spamming a human.
msg = (
    "[automated keep-alive] account-active probe "
    + time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
)
req = {
    "jsonrpc": "2.0",
    "method": "send",
    "params": {"account": account, "recipient": [account], "message": msg},
    "id": "keepalive-%d" % int(time.time()),
}
try:
    with socket.create_connection((host, port), timeout=20) as s:
        s.sendall((json.dumps(req) + "\n").encode())
        s.settimeout(20)
        buf = b""
        # JSON-RPC over the daemon's --tcp socket is newline-delimited; the
        # daemon also pushes async `receive` notifications, so skip any line
        # that isn't our response id.
        deadline = time.time() + 20
        while time.time() < deadline:
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                line = line.strip()
                if not line:
                    continue
                try:
                    parsed = json.loads(line)
                except Exception:
                    continue
                if parsed.get("id") != req["id"]:
                    continue
                if parsed.get("error"):
                    print("error: %s" % parsed["error"].get("message", "unknown"))
                    sys.exit(1)
                sys.exit(0)
    sys.exit(2)  # connected but no matching response before deadline
except Exception as e:
    print("exc: %s" % e)
    sys.exit(3)
PY
}

run() {
  if [ "$KA_ENABLED" = "false" ]; then
    log "disabled via SIGNAL_KEEPALIVE=false"
    return 0
  fi
  if [ -z "$ACCOUNT" ]; then
    log "SIGNAL_ACCOUNT unset; keep-alive cannot self-send — disabling"
    return 0
  fi
  log "enabled (interval=${KA_INTERVAL}s grace=${KA_GRACE}s account=${ACCOUNT} port=${PORT})"
  sleep "$KA_GRACE"

  while :; do
    if out=$(self_send); then
      log "self-send ok (account active, outbound working)"
    else
      # A failure here does NOT force a restart — the watchdog owns liveness
      # remediation. We only log; the nanoclaw-side health probe is the
      # external observer that alerts admins on sustained failure.
      log "self-send FAILED${out:+ — $out}"
    fi
    sleep "$KA_INTERVAL"
  done
}

run
