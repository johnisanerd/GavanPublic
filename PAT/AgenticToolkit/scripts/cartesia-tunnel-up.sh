#!/usr/bin/env bash
# Bring the Cartesia ↔ local voice-transport tunnel up.
#
# Cloudflare quick tunnels are ephemeral: when the underlying control stream
# drops (laptop sleep, network change, server-side reset), the cloudflared
# process keeps running but its public hostname is reaped from DNS. Future
# Cartesia calls then route to nowhere even though `pgrep cloudflared`
# reports a live process. This script handles that by reaping any existing
# tunnel before starting a fresh one, then patches the Cartesia staging
# agent to use the new URL via `cartesia connect`.
#
# What it does:
#   1. Reap any tracked cloudflared (PID file) AND any orphan cloudflared
#      processes that came from a previous run.
#   2. Start a fresh cloudflared quick tunnel, detached from this shell so
#      the tunnel survives after the script exits.
#   3. Wait for the public hostname to appear in cloudflared's log.
#   4. Run `cartesia connect --agent-id <staging> --url <tunnel>` so the
#      staging agent immediately routes to local voice-transport.
#   5. Write the PID + URL to a state file for the next invocation.
#
# Usage:
#   scripts/cartesia-tunnel-up.sh [--port 8000] [--restart] [--stop] [--status]
#
# Defaults to port 8000 (matches the local voice-transport `python main.py`
# on $PORT=8000). The earlier 8080 default was for Cartesia Line CLI's
# `cartesia run` mode.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=8000
MODE="up"
# Resolve secrets relative to the script location so the script works from
# any cwd. Override via SECRETS_FILE env if your secrets live elsewhere.
SECRETS_FILE="${SECRETS_FILE:-$SCRIPT_DIR/../.env.agent}"
CARTESIA_BIN="${CARTESIA_BIN:-$HOME/.cartesia/bin/cartesia}"
STATE_DIR="${STATE_DIR:-/tmp}"
PID_FILE="${STATE_DIR}/cartesia-tunnel.pid"
URL_FILE="${STATE_DIR}/cartesia-tunnel.url"
LOG_FILE="${STATE_DIR}/cartesia-tunnel.log"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)    PORT="$2"; shift 2 ;;
    --port=*)  PORT="${1#--port=}"; shift ;;
    --restart) MODE="restart"; shift ;;
    --stop)    MODE="stop"; shift ;;
    --status)  MODE="status"; shift ;;
    --help|-h)
      sed -n '2,32p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      # Backwards-compat: bare positional arg = port (matches old usage).
      if [[ "$1" =~ ^[0-9]+$ ]]; then PORT="$1"; shift; else
        echo "[tunnel] unknown arg: $1" >&2
        exit 2
      fi
      ;;
  esac
done

# ─────────────────────────── helpers ──────────────────────────────────────

reap_existing() {
  # Kill any tracked tunnel from a previous run, then sweep orphans. We hit
  # the orphan case after a laptop sleep: cloudflared's exit handlers don't
  # always run, so the process lingers without an active tunnel.
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "[tunnel] reaping tracked cloudflared pid $pid"
      kill "$pid" 2>/dev/null || true
      sleep 0.5
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi
  # Sweep orphans by name. Quick tunnels are identified by the
  # `--url http://127.0.0.1:` flag, which is unique to this use case on a
  # dev machine — pkill -f targets only those.
  if pgrep -af 'cloudflared tunnel --url http://127.0.0.1:' >/dev/null 2>&1; then
    echo "[tunnel] sweeping orphan cloudflared tunnels"
    pkill -f 'cloudflared tunnel --url http://127.0.0.1:' 2>/dev/null || true
    sleep 0.5
    pkill -9 -f 'cloudflared tunnel --url http://127.0.0.1:' 2>/dev/null || true
  fi
  rm -f "$URL_FILE"
}

read_staging_agent_id() {
  if [[ ! -f "$SECRETS_FILE" ]]; then
    echo "[tunnel] secrets file not found: $SECRETS_FILE" >&2
    exit 1
  fi
  # Extract the value directly. We avoid `. <(grep ...)` because process
  # substitution inside a $() command-substitution subshell behaves
  # inconsistently (the variable assignment from the sourced fragment
  # isn't reliably visible by the time the next command runs in the same
  # subshell). Direct sed extraction sidesteps the timing entirely.
  local id
  id="$(sed -nE 's/^CARTESIA_AGENT_ID_STAGING=([^[:space:]#]+).*/\1/p' "$SECRETS_FILE" | head -n1)"
  if [[ -z "$id" ]]; then
    echo "[tunnel] CARTESIA_AGENT_ID_STAGING not set in $SECRETS_FILE" >&2
    exit 1
  fi
  printf '%s' "$id"
}

start_tunnel() {
  # All status messages go to stderr so callers using `URL=$(start_tunnel)`
  # capture only the URL itself on stdout. Detached so the tunnel survives
  # after this script exits.
  : > "$LOG_FILE"
  echo "[tunnel] starting cloudflared → http://127.0.0.1:$PORT" >&2
  nohup cloudflared tunnel --url "http://127.0.0.1:$PORT" --no-autoupdate \
    >"$LOG_FILE" 2>&1 &
  local pid=$!
  disown "$pid" 2>/dev/null || true
  echo "$pid" > "$PID_FILE"
  echo "[tunnel] cloudflared pid $pid (log: $LOG_FILE)" >&2

  # Wait for the URL to appear. cloudflared prints it usually within a
  # second or two; we give it 30s.
  local url=""
  for _ in {1..30}; do
    url="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG_FILE" | head -n1 || true)"
    if [[ -n "$url" ]]; then break; fi
    sleep 1
  done
  if [[ -z "$url" ]]; then
    echo "[tunnel] cloudflared did not announce a URL in 30s; see $LOG_FILE" >&2
    return 1
  fi
  echo "$url" > "$URL_FILE"
  echo "[tunnel] URL: $url" >&2
  printf '%s\n' "$url"
}

run_cartesia_connect() {
  local agent_id="$1"
  local tunnel_url="$2"
  if [[ ! -x "$CARTESIA_BIN" ]]; then
    echo "[tunnel] cartesia CLI not found at $CARTESIA_BIN; skipping connect" >&2
    echo "[tunnel] manual: $CARTESIA_BIN connect --agent-id $agent_id --url $tunnel_url" >&2
    return 0
  fi
  echo "[tunnel] cartesia connect --agent-id $agent_id --url $tunnel_url"
  if ! "$CARTESIA_BIN" connect --agent-id "$agent_id" --url "$tunnel_url"; then
    echo "[tunnel] cartesia connect failed; the staging agent may still point at the old URL" >&2
    return 1
  fi
  echo "[tunnel] staging agent repointed"
}

# ───────────────────────────── modes ──────────────────────────────────────

case "$MODE" in
  status)
    if [[ -f "$PID_FILE" ]]; then
      pid="$(cat "$PID_FILE")"
      if kill -0 "$pid" 2>/dev/null; then
        echo "[tunnel] running (pid $pid)"
        [[ -f "$URL_FILE" ]] && echo "[tunnel] URL: $(cat "$URL_FILE")"
        # Liveness probe: tail the log for recent failures so we catch the
        # "process running but tunnel dead" case quick-tunnels are prone to.
        if tail -20 "$LOG_FILE" 2>/dev/null | grep -qE 'failed to serve tunnel connection|control stream encountered'; then
          echo "[tunnel] WARNING: recent errors in $LOG_FILE — tunnel may be dead, re-run with --restart"
          tail -5 "$LOG_FILE"
        fi
        exit 0
      fi
    fi
    if pgrep -f 'cloudflared tunnel --url http://127.0.0.1:' >/dev/null 2>&1; then
      echo "[tunnel] orphan cloudflared running (no PID file); use --restart to clean"
      exit 0
    fi
    echo "[tunnel] not running"
    exit 1
    ;;

  stop)
    reap_existing
    echo "[tunnel] stopped"
    ;;

  up|restart)
    reap_existing
    AGENT_ID="$(read_staging_agent_id)"
    URL="$(start_tunnel)"
    run_cartesia_connect "$AGENT_ID" "$URL" || true
    echo
    echo "[tunnel] up. To verify:  scripts/cartesia-tunnel-up.sh --status"
    echo "[tunnel] To tear down:   scripts/cartesia-tunnel-up.sh --stop"
    ;;
esac
