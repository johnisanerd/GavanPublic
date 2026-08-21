#!/bin/sh
# signal-cli sidecar entrypoint for pat-transports (process group `signal`).
#
# Runs signal-cli as a JSON-RPC daemon listening on 0.0.0.0:7583 (IPv6
# wildcard at the bind layer — signal-cli's SocketHandler binds to `[::]:7583`
# which covers both 6PN and loopback). The adapter on pat-nanoclaw connects
# via `signal.process.pat-transports.internal:7583` over 6PN. The Signal
# identity (+15550100003, primary device — re-registered 2026-05-11) lives
# in /root/.local/share/signal-cli/ which is a Fly volume (pat_signal_state).
#
# Process exit means the Fly machine restarts; signal-cli reattaches to the
# same identity on boot since state is on the volume. No QR / link flow.
#
# Env:
#   SIGNAL_ACCOUNT   — E164 of the primary identity (required)
#   SIGNAL_TCP_BIND  — bind address (default: 0.0.0.0:7583)
#
# PAT: bind default was `fly-local-6pn:7583` originally. signal-cli's
# SocketHandler can't bind to a hostname — it needs an IP literal or wildcard.
# 0.0.0.0 resolves to [::]:7583 (IPv6 wildcard) which covers all interfaces
# including 6PN. See reference_pat_signal_deploy.md for the long story.

set -eu

ACCOUNT="${SIGNAL_ACCOUNT:?SIGNAL_ACCOUNT must be set}"
BIND="${SIGNAL_TCP_BIND:-0.0.0.0:7583}"
STAGING_PORT="${SIGNAL_STAGING_PORT:-7584}"

# PAT 2026-05-13: launch the signal-staging sidecar (small FastAPI app
# exposing POST /stage) in the background BEFORE signal-cli foreground.
# Needed because pat-nanoclaw lives on a different Fly machine — for
# attachment send + voice-note rendering, the bytes need to land in
# THIS machine's /tmp so signal-cli's `send` JSON-RPC can give Signal
# Service a real local path (preserves the VOICE_MESSAGE flag and
# avoids signal-cli's data-URL parsing edge cases).
#
# signal_staging.py reads from /app (the container WORKDIR). It uses
# the same venv as the cartesia process (FastAPI + uvicorn already
# installed via uv sync).
echo "[signal sidecar] starting signal-staging on port $STAGING_PORT"
python /app/signal_staging.py &
STAGING_PID=$!

# Forward SIGTERM to all children so Fly's shutdown sequence is clean.
trap 'kill -TERM "$STAGING_PID" 2>/dev/null; kill -TERM "$WATCHDOG_PID" 2>/dev/null; kill -TERM "$KEEPALIVE_PID" 2>/dev/null; kill -TERM "$SIGNAL_PID" 2>/dev/null' TERM INT

echo "[signal-cli sidecar] starting daemon for $ACCOUNT, binding $BIND"

# --receive-mode on-start: open the receive stream on daemon boot so push
# notifications start flowing immediately (vs on-demand which waits for the
# first subscriber).
#
# PAT 2026-06-25 (observability): dropped `--no-receive-stdout` and added `-v`.
# Rationale (see plans/signal-debugging-infra.md P1 + plans/log-centralization.md
# Path B): the daemon's inbound + decrypt-error visibility was the single biggest
# gap in past Signal outages — decrypt failures "never appeared in our tooling"
# because they only live in the daemon's own stdout/stderr, which we suppressed.
# Now: received envelopes echo to stdout, and `-v` (INFO) surfaces libsignal
# warnings/exceptions on stderr. Both go to the Fly machine log stream → captured
# by the pat-observability NATS shipper into `pat_raw`. This is ADDITIVE — the
# JSON-RPC channel still delivers messages to the nanoclaw adapter unchanged; we
# just no longer throw away the diagnostic copy. (PII is a non-issue: internal
# tool.) NOTE: some decrypt NPEs may still be swallowed by signal-cli's
# continuous-receive loop even at -v; once Path B is live we observe what the
# daemon actually emits and, if needed, add a stderr→/admin/log-event JSONifier
# (P1a) to turn the NPE lines into structured signal.decrypt-failed events.
signal-cli \
  -v \
  -a "$ACCOUNT" \
  daemon \
  --tcp "$BIND" \
  --receive-mode on-start &
SIGNAL_PID=$!

# PAT 2026-06-25: receive-liveness watchdog. signal-cli 0.14.3's continuous
# receive loop dies (without taking the daemon down) on a null-content inbound
# envelope, and re-wedges across restarts because the poison envelope is
# persisted in msg-cache on the volume. The watchdog polls /proc for a live
# receive thread + a relay-443 connection and forces a clean restart (clearing
# the poison first) when the loop is confirmed dead. See watchdog.sh.
SCRIPT_DIR=$(dirname "$0")
sh "$SCRIPT_DIR/watchdog.sh" &
WATCHDOG_PID=$!

# PAT 2026-06-25: account keep-alive. A Signal account that goes inactive long
# enough is reclaimed by Signal's servers (PAT's account lapsed once after ~a
# month of a downed daemon). On a weekly interval this issues a self-send
# (Note to Self) over the running daemon to keep the registration warm — belt-
# and-suspenders on top of the 24/7 connection. See keepalive.sh.
sh "$SCRIPT_DIR/keepalive.sh" &
KEEPALIVE_PID=$!

# Wait on signal-cli (the load-bearing process). When it exits — whether it
# crashed or the watchdog killed a wedged daemon — the entrypoint returns and
# Fly restarts the machine. Stop the watchdog + keep-alive on the way out so
# they don't linger against a dead pid.
wait "$SIGNAL_PID"
kill -TERM "$WATCHDOG_PID" 2>/dev/null
kill -TERM "$KEEPALIVE_PID" 2>/dev/null
