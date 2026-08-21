#!/usr/bin/env bash
# PAT dev teardown — reaps everything the dev stack might have left around.
#
# Called automatically at the top of scripts/dev.sh (so every `pnpm run dev`
# starts from a known-clean state), and runnable on its own via
# `bash scripts/teardown.sh` or `pnpm run teardown` for manual cleanup
# (without restarting the stack).
#
# What it kills:
#   1. Anything listening on dev ports (5173, 5174, 8765-8767, 8787, 8788)
#   2. Orphan dev-stack child processes (tsx/bun/vite/pnpm-run-dev) by pattern
#   3. ALL nanoclaw-v2-* docker containers (palisade-internal AND
#      nanoclaw-v2-test-agent-* runs). The host process boots fresh
#      containers per-session, so stale ones just hog resources and can
#      mismatch source if they were spawned from older code.
#
# What it does NOT touch:
#   - onecli / onecli-postgres-1 (long-running infra; survives dev cycles)
#   - circuit-breaker.json (cleared separately in dev.sh)
#   - The pnpm virtual store / node_modules / dist (use pnpm install/build
#     for those)
set -euo pipefail

# ── 1. Port reap ─────────────────────────────────────────────────────────
# Same port list as dev.sh; adding 8767 (nanoclaw admin) which dev.sh
# doesn't enumerate but the host listens on.
DEV_PORTS=(5174 5173 8788 8787 8765 8766 8767)
if command -v lsof >/dev/null 2>&1; then
  for port in "${DEV_PORTS[@]}"; do
    PIDS=$(lsof -nP -i :"$port" -sTCP:LISTEN -t 2>/dev/null | sort -u || true)
    if [[ -n "$PIDS" ]]; then
      echo "[teardown] reaping pids holding :$port — $PIDS"
      # shellcheck disable=SC2086
      kill -9 $PIDS 2>/dev/null || true
    fi
  done
  sleep 0.5
fi

# ── 2. Orphan process reap ───────────────────────────────────────────────
pkill -9 -f "tsx --env-file-if-exists=.env src/index.ts" 2>/dev/null || true
pkill -9 -f "tsx src/index.ts" 2>/dev/null || true
pkill -9 -f "bun run --hot server/index.ts" 2>/dev/null || true
pkill -9 -f "node .*node_modules/vite/bin/vite.js" 2>/dev/null || true
pkill -9 -f "pnpm run dev" 2>/dev/null || true
sleep 0.3

# ── 3. Container reap ────────────────────────────────────────────────────
# Per-session agent containers + any stale test-agent containers. Always
# unconditional: dev.sh used to only kill containers on image rebuild,
# but stale containers from prior sessions (different source, different
# sessions) silently hung around and caused mis-routing.
if command -v docker >/dev/null 2>&1; then
  STALE_CONTAINERS=$(docker ps -q --filter 'name=nanoclaw-v2-' 2>/dev/null || true)
  if [[ -n "$STALE_CONTAINERS" ]]; then
    COUNT=$(echo "$STALE_CONTAINERS" | wc -l | tr -d ' ')
    echo "[teardown] removing $COUNT nanoclaw-v2-* container(s)"
    # shellcheck disable=SC2086
    docker rm -f $STALE_CONTAINERS >/dev/null 2>&1 || true
  fi
else
  echo "[teardown] docker not on PATH — skipping container reap"
fi

echo "[teardown] done"
