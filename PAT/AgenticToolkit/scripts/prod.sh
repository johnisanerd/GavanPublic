#!/usr/bin/env bash
# PAT monorepo prod runner.
#
# Builds every workspace once and serves the result from dist/. No Vite, no
# HMR. Same teardown semantics as scripts/dev.sh (trap 'kill 0' on Ctrl-C).
#
# What it does, in order:
#   1. Reap anything listening on our ports (same set as dev.sh).
#   2. Build, in dep order: realtime → scenarios → nanoclaw → pat-web →
#      pat-frontend. Fail fast on any error.
#   3. Pin TMPDIR + source nanoclaw/.env (same as dev).
#   4. Start the three apps from dist/. pat-web prod = Bun on :8788
#      (Hono auto-detects dist/index.html and serves the built SPA).
#      pat-frontend prod = Bun on :8787, with NANOCLAW_INTERNAL_HOST pointed
#      at localhost so it reaches the local nanoclaw instead of Fly internal.
#      nanoclaw uses `node --env-file=.env dist/index.js` because the
#      package.json `start` script does NOT load .env on its own.
#
# Logs land in /tmp/pat-prod-*.log.
#
# Usage:
#   pnpm run prod
#   # or: bash scripts/prod.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMPDIR_OVERRIDE="${TMPDIR_OVERRIDE:-$HOME/.cache/onecli-tmp}"

cd "$REPO_ROOT"

# ── 1. Reap stale processes ──────────────────────────────────────────────
DEV_PORTS=(5174 5173 8788 8787 8765 8766)
if command -v lsof >/dev/null 2>&1; then
  for port in "${DEV_PORTS[@]}"; do
    PIDS=$(lsof -nP -i :"$port" -sTCP:LISTEN -t 2>/dev/null | sort -u || true)
    if [[ -n "$PIDS" ]]; then
      echo "[pat-prod] reaping pids holding :$port — $PIDS"
      # shellcheck disable=SC2086
      kill -9 $PIDS 2>/dev/null || true
    fi
  done
  sleep 0.5
fi

pkill -9 -f "tsx --env-file-if-exists=.env src/index.ts" 2>/dev/null || true
pkill -9 -f "tsx src/index.ts" 2>/dev/null || true
pkill -9 -f "bun run --hot server/index.ts" 2>/dev/null || true
pkill -9 -f "node .*node_modules/vite/bin/vite.js" 2>/dev/null || true
pkill -9 -f "node --env-file=.env dist/index.js" 2>/dev/null || true
sleep 0.3

# ── 2. Build everything (in dep order) ───────────────────────────────────
# realtime + scenarios are workspace libs consumed via dist/. They MUST
# build before the apps that import them, otherwise nanoclaw/pat-web pick
# up stale dist/ (or no dist/ at all on a clean checkout).
echo "[pat-prod] building workspaces..."
pnpm -C realtime     run build
pnpm -C scenarios    run build
pnpm -C nanoclaw     run build
pnpm -C pat-web      run build
pnpm -C pat-frontend run build

# Nanoclaw agent container image. Per-session containers are spawned from
# this image; source edits under nanoclaw/container/ don't take effect
# until it's rebuilt. Unconditional in prod — the demo command should
# leave NO stale artifact anywhere. Also kill running agent containers so
# subsequent sessions spawn from the fresh image. The stamp file is
# kept in sync with dev.sh's freshness check.
if command -v docker >/dev/null 2>&1; then
  echo "[pat-prod] building nanoclaw-agent container image..."
  (cd "$REPO_ROOT/nanoclaw" && ./container/build.sh)
  touch "$REPO_ROOT/nanoclaw/.image-built-at"
  running=$(docker ps -q --filter 'name=nanoclaw-v2-' 2>/dev/null || true)
  if [[ -n "$running" ]]; then
    echo "[pat-prod] killing running agent containers so new sessions use the fresh image"
    # shellcheck disable=SC2086
    docker kill $running >/dev/null 2>&1 || true
  fi
else
  echo "[pat-prod] WARNING: docker not on PATH — agent container NOT rebuilt" >&2
fi

echo "[pat-prod] builds complete"

# ── 3. Reset nanoclaw circuit-breaker + TMPDIR + .env ────────────────────
mkdir -p nanoclaw/data
rm -f nanoclaw/data/circuit-breaker.json

mkdir -p "$TMPDIR_OVERRIDE"
export TMPDIR="$TMPDIR_OVERRIDE"

if [[ -f nanoclaw/.env ]]; then
  set -o allexport
  # shellcheck disable=SC1091
  . ./nanoclaw/.env
  set +o allexport
  echo "[pat-prod] sourced nanoclaw/.env"
else
  echo "[pat-prod] WARNING: no nanoclaw/.env — relying on inherited env" >&2
fi

# ── 4. Start the prod stack ──────────────────────────────────────────────
echo "[pat-prod] starting prod stack from $REPO_ROOT (TMPDIR=$TMPDIR)"

# nanoclaw: `pnpm run start` is `node dist/index.js` which does NOT load
# .env. Use `node --env-file=.env` so we get the same env tsx does in dev.
(cd nanoclaw && exec node --env-file=.env dist/index.js) > /tmp/pat-prod-nanoclaw.log 2>&1 &

# pat-web prod: Bun serves the built SPA from dist/index.html on :8788.
(cd pat-web && exec pnpm run start) > /tmp/pat-prod-web.log 2>&1 &

# pat-frontend prod: override NANOCLAW_INTERNAL_HOST so the dashboard's
# `/api/logs.jsonl` proxy reaches the local nanoclaw admin port. The
# default in code is `pat-nanoclaw.internal:8767` (Fly internal); locally
# nanoclaw listens on :8765 (realtime), :8766 (anam-web), and :8767
# (ADMIN — the logs endpoint). The dashboard needs the admin port.
(cd pat-frontend \
  && NANOCLAW_INTERNAL_HOST=127.0.0.1:8767 \
     NANOCLAW_INTERNAL_SCHEME=http \
     exec pnpm run start) > /tmp/pat-prod-frontend.log 2>&1 &

trap 'echo; echo "[pat-prod] shutting down..."; kill 0 2>/dev/null || true' INT TERM EXIT

cat <<EOF

────────────────────────────────────────────────────────────────────────────
  PAT prod stack — running (from dist/, no HMR)
────────────────────────────────────────────────────────────────────────────
  pat-web      bun      http://localhost:8788   (log: /tmp/pat-prod-web.log)
  pat-frontend bun      http://localhost:8787   (log: /tmp/pat-prod-frontend.log)
                          → NANOCLAW_INTERNAL_HOST=127.0.0.1:8765
  nanoclaw     realtime http://localhost:8765   (log: /tmp/pat-prod-nanoclaw.log)
  nanoclaw     anam-web http://localhost:8766

  tail -f /tmp/pat-prod-*.log    # follow all
  Ctrl-C                          # stops everything
────────────────────────────────────────────────────────────────────────────
EOF

wait
