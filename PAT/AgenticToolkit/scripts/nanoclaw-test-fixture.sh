#!/usr/bin/env bash
# Bring up (or verify) a NanoClaw host suitable for the smoke harness.
#
# Two modes:
#   1. By default, just verify a host is already running on :8765 with a
#      healthy /health response. Print the base URL and exit 0.
#   2. With --boot, start one in the background via nanoclaw-dev.sh, wait
#      for /health, then print PID + base URL. Caller is responsible for
#      stopping it (the PID is written to TOOLKIT_DIR/.smoketest-nanoclaw.pid).
#
# Examples:
#   scripts/nanoclaw-test-fixture.sh           # verify existing
#   scripts/nanoclaw-test-fixture.sh --boot    # start one if missing
#   scripts/nanoclaw-test-fixture.sh --stop    # stop one we previously started
#
# REALTIME_PORT (default 8765) is honored throughout.
set -euo pipefail

TOOLKIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${REALTIME_PORT:-8765}"
BASE_URL="http://127.0.0.1:${PORT}"
PID_FILE="${TOOLKIT_DIR}/.smoketest-nanoclaw.pid"
LOG_FILE="${TOOLKIT_DIR}/.smoketest-nanoclaw.log"
DEV_SCRIPT="${TOOLKIT_DIR}/scripts/nanoclaw-dev.sh"

mode="verify"
case "${1:-}" in
  --boot) mode="boot" ;;
  --stop) mode="stop" ;;
  --verify|"") mode="verify" ;;
  *) echo "[fixture] unknown arg: $1 (expected --boot, --stop, --verify)" >&2; exit 2 ;;
esac

is_healthy() {
  curl -fsS --max-time 1 "${BASE_URL}/health" >/dev/null 2>&1
}

wait_for_health() {
  local timeout=${1:-60}
  local start=$SECONDS
  while ! is_healthy; do
    if (( SECONDS - start > timeout )); then
      return 1
    fi
    sleep 1
  done
  return 0
}

case "$mode" in
  verify)
    if is_healthy; then
      echo "[fixture] healthy at ${BASE_URL}"
      echo "REALTIME_BASE_URL=${BASE_URL}"
      exit 0
    fi
    echo "[fixture] NOT healthy at ${BASE_URL}" >&2
    echo "[fixture] start one with: scripts/nanoclaw-test-fixture.sh --boot" >&2
    exit 1
    ;;

  boot)
    if is_healthy; then
      echo "[fixture] already healthy at ${BASE_URL} (no boot needed)"
      echo "REALTIME_BASE_URL=${BASE_URL}"
      exit 0
    fi
    if [[ ! -x "$DEV_SCRIPT" ]]; then
      echo "[fixture] dev script not executable: $DEV_SCRIPT" >&2
      exit 1
    fi
    echo "[fixture] booting nanoclaw via ${DEV_SCRIPT}; logs: ${LOG_FILE}"
    : > "$LOG_FILE"
    nohup "$DEV_SCRIPT" >>"$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    echo "[fixture] PID $(cat "$PID_FILE"); waiting for /health (60s budget)…"
    if ! wait_for_health 60; then
      echo "[fixture] /health never came up; check ${LOG_FILE}" >&2
      exit 1
    fi
    echo "[fixture] healthy at ${BASE_URL}"
    echo "REALTIME_BASE_URL=${BASE_URL}"
    ;;

  stop)
    if [[ -f "$PID_FILE" ]]; then
      pid=$(cat "$PID_FILE")
      if kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        sleep 1
        kill -9 "$pid" 2>/dev/null || true
        echo "[fixture] stopped pid $pid"
      else
        echo "[fixture] pid $pid already dead"
      fi
      rm -f "$PID_FILE"
    else
      echo "[fixture] no PID file; nothing to stop"
    fi
    ;;
esac
