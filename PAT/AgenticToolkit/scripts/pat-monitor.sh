#!/usr/bin/env bash
# Open the live web monitor for pat-nanoclaw.
#
# - Locally:   opens http://localhost:8765/admin/monitor (assumes nanoclaw
#              is already running on 127.0.0.1:8765 — `pnpm run dev` etc.)
# - Staging:   opens a `fly proxy 8765:8765` tunnel into pat-nanoclaw
#              (which is internal-only on Fly, no public IP), then opens
#              the monitor URL. The tunnel stays alive until you hit
#              Ctrl-C on this script.
#
# Usage:
#   scripts/pat-monitor.sh                # staging via fly proxy (default)
#   scripts/pat-monitor.sh --local        # localhost direct, no proxy
#   scripts/pat-monitor.sh --port 9999    # use a different local port
#
set -euo pipefail

PORT=8765
APP=pat-nanoclaw
MODE=staging

while [[ $# -gt 0 ]]; do
  case "$1" in
    --local)   MODE=local; shift ;;
    --port)    PORT="$2"; shift 2 ;;
    --app)     APP="$2"; shift 2 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *)         echo "unknown arg: $1"; exit 2 ;;
  esac
done

URL="http://localhost:${PORT}/admin/monitor"

if [[ "$MODE" == "local" ]]; then
  echo "[pat-monitor] opening $URL (assumes local nanoclaw on :$PORT)"
  open "$URL" 2>/dev/null || python3 -m webbrowser "$URL"
  exit 0
fi

# Staging: open the fly proxy, wait briefly for it to bind, then open
# the URL. The proxy process stays in foreground so the user can Ctrl-C
# to tear it down.
SECRETS_FILE="$(dirname "$0")/../.env.agent"
if [[ -f "$SECRETS_FILE" ]]; then
  TOKEN="$(grep '^FLY_DEPLOY_TOKEN_NANOCLAW=' "$SECRETS_FILE" | cut -d= -f2-)"
fi
if [[ -z "${TOKEN:-}" ]]; then
  TOKEN="${FLY_API_TOKEN:-}"
fi
if [[ -z "${TOKEN:-}" ]]; then
  echo "no FLY_DEPLOY_TOKEN_NANOCLAW in secrets and FLY_API_TOKEN unset"
  exit 1
fi

echo "[pat-monitor] starting fly proxy ${PORT}:${PORT} -> ${APP} (Ctrl-C to stop)"
FLY_API_TOKEN="$TOKEN" flyctl proxy "${PORT}:${PORT}" --app "$APP" &
PROXY_PID=$!
trap "kill $PROXY_PID 2>/dev/null || true" EXIT INT TERM

# Give the proxy a moment to bind.
for _ in {1..20}; do
  if curl -fsS --max-time 0.3 "http://localhost:${PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

echo "[pat-monitor] opening $URL"
open "$URL" 2>/dev/null || python3 -m webbrowser "$URL"

wait $PROXY_PID
