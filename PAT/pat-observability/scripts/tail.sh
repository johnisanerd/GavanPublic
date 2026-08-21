#!/usr/bin/env bash
# One-shot live tail: opens the proxy to the (6PN-only) store, runs the TUI,
# and tears the proxy down on exit. Passes args through (e.g. --stream pat_raw).
#   pat-observability/scripts/tail.sh
#   pat-observability/scripts/tail.sh --stream pat_raw
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"

env -u FLY_API_TOKEN -u FLY_ACCESS_TOKEN flyctl proxy 5080:5080 -a pat-observability >/tmp/pat-oo-proxy.log 2>&1 &
PROXY=$!
trap 'kill $PROXY 2>/dev/null || true' EXIT

# wait for the tunnel to accept connections
for _ in $(seq 1 20); do
  curl -fsS -o /dev/null "http://127.0.0.1:5080/healthz" 2>/dev/null && break
  sleep 0.5
done

exec uv run "$REPO/tui/tail.py" "$@"
