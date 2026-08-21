#!/usr/bin/env bash
# Idempotent NanoClaw dev runner.
#
# `pnpm run dev` spawns tsx + esbuild + node children; killing the parent
# doesn't always cascade, so the realtime channel's port (8765) stays held
# and the next launch crashes with EADDRINUSE. This wrapper cleans up first.
#
# What it does, in order:
#   1. Find anything listening on 8765 and SIGKILL it.
#   2. Sweep any tsx/esbuild children that look like nanoclaw.
#   3. Reset circuit-breaker.json so we don't backoff after a clean kill.
#   4. Set TMPDIR=$HOME/.cache/onecli-tmp so OneCLI's CA writes land in a
#      path Colima's VM can see (Colima only mounts $HOME from macOS).
#   5. exec pnpm run dev (so signals propagate cleanly).
#
# Usage:
#   scripts/nanoclaw-dev.sh                 # fresh start, foreground
#   scripts/nanoclaw-dev.sh > nano.log &    # background with log redirect
#
# Run from agentic_toolkit/ root, OR set NANOCLAW_DIR.
set -euo pipefail

NANOCLAW_DIR="${NANOCLAW_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/nanoclaw}"
PORT="${REALTIME_PORT:-8765}"
TMPDIR_OVERRIDE="${TMPDIR_OVERRIDE:-$HOME/.cache/onecli-tmp}"

if [[ ! -d "$NANOCLAW_DIR" ]]; then
  echo "[nanoclaw-dev] NANOCLAW_DIR not found: $NANOCLAW_DIR" >&2
  exit 1
fi

cd "$NANOCLAW_DIR"

# ── 1. Reap anything on the realtime channel port ─────────────────────────
if command -v lsof >/dev/null 2>&1; then
  PIDS=$(lsof -nP -i :"$PORT" -sTCP:LISTEN -t 2>/dev/null | sort -u || true)
  if [[ -n "$PIDS" ]]; then
    echo "[nanoclaw-dev] reaping pids holding :$PORT — $PIDS"
    # shellcheck disable=SC2086
    kill -9 $PIDS 2>/dev/null || true
    sleep 0.5
  fi
fi

# ── 2. Sweep any orphaned dev children ────────────────────────────────────
# pnpm run dev → tsx → node. SIGKILL anything that obviously came from us.
pkill -9 -f "tsx src/index.ts" 2>/dev/null || true
pkill -9 -f "esbuild --service.*nanoclaw" 2>/dev/null || true
sleep 0.3

# ── 3. Reset circuit-breaker (we just clean-killed; don't punish startup) ─
mkdir -p data
rm -f data/circuit-breaker.json

# ── 4. Pin TMPDIR so OneCLI's CA writes land in a Colima-visible path ────
mkdir -p "$TMPDIR_OVERRIDE"
export TMPDIR="$TMPDIR_OVERRIDE"

# ── 5. Source .env (tsx doesn't auto-load it) ────────────────────────────
# nanoclaw's `pnpm run dev` is just `tsx src/index.ts`, which inherits the
# parent shell's env but does NOT read .env. Things like ANTHROPIC_API_KEY
# (used by the host-side front-mind Haiku) live in .env, so silently failing
# to load it makes the front-mind classifier fall through to "silent" on
# every turn — audibly broken. Fail loudly here if .env exists but doesn't
# parse cleanly; just warn if it's missing entirely (some operators set
# everything via systemd/launchd at the service level).
if [[ -f .env ]]; then
  set -o allexport
  # shellcheck disable=SC1091
  . ./.env
  set +o allexport
  echo "[nanoclaw-dev] sourced .env"
else
  echo "[nanoclaw-dev] WARNING: no .env in $NANOCLAW_DIR — relying on inherited env" >&2
fi

# ── 6. Hand off to pnpm run dev ──────────────────────────────────────────
echo "[nanoclaw-dev] starting from $NANOCLAW_DIR (TMPDIR=$TMPDIR, PORT=$PORT)"
exec pnpm run dev
