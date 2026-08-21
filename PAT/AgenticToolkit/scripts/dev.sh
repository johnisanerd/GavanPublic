#!/usr/bin/env bash
# PAT monorepo dev runner.
#
# One command to start everything in dev mode (Vite HMR + Bun --hot + tsx).
# Patterned after scripts/nanoclaw-dev.sh — plain bash, no concurrently/turbo,
# trap 'kill 0' to tear down the whole process group on Ctrl-C.
#
# What it does, in order:
#   1. Reap anything listening on the dev ports (5174, 5173, 8788, 8787,
#      8765, 8766) and any leftover tsx/bun/vite children.
#   2. Reset nanoclaw circuit-breaker.json so we don't backoff on startup.
#   3. Pin TMPDIR to a Colima-visible path for OneCLI's CA writes.
#   4. Source nanoclaw/.env (tsx --env-file-if-exists handles this for
#      nanoclaw itself; sourcing here so the Bun servers and vite see the
#      same shared keys).
#   5. Pre-flight: build realtime/ and scenarios/ if their dist/ is missing
#      or older than their src/. NOT watched — re-run the script after
#      editing those libs.
#   6. Fan out: nanoclaw + pat-web (vite + bun) + pat-frontend (vite + bun)
#      all in background; trap propagates SIGINT/SIGTERM to the group.
#
# Logs land in /tmp/pat-dev-*.log so you can tail them in another window.
#
# Usage:
#   pnpm run dev
#   # or: bash scripts/dev.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMPDIR_OVERRIDE="${TMPDIR_OVERRIDE:-$HOME/.cache/onecli-tmp}"

cd "$REPO_ROOT"

# ── 1. Teardown ──────────────────────────────────────────────────────────
# Ports + orphan processes + stale agent containers. Extracted to
# scripts/teardown.sh so manual teardown is just `pnpm run teardown`.
bash "$REPO_ROOT/scripts/teardown.sh"

# ── 2. Reset nanoclaw circuit-breaker ─────────────────────────────────────
mkdir -p nanoclaw/data
rm -f nanoclaw/data/circuit-breaker.json

# ── 3. Pin TMPDIR for OneCLI/Colima visibility ───────────────────────────
mkdir -p "$TMPDIR_OVERRIDE"
export TMPDIR="$TMPDIR_OVERRIDE"

# ── 4. Source nanoclaw/.env so child processes inherit shared keys ───────
if [[ -f nanoclaw/.env ]]; then
  set -o allexport
  # shellcheck disable=SC1091
  . ./nanoclaw/.env
  set +o allexport
  echo "[pat-dev] sourced nanoclaw/.env"
else
  echo "[pat-dev] WARNING: no nanoclaw/.env — relying on inherited env" >&2
fi

# ── 5. Pre-flight build of stale artifacts ───────────────────────────────
# The dev stack has FOUR build artifacts that don't get watched in dev:
#   • realtime/dist        consumed by nanoclaw + pat-web via workspace link
#   • scenarios/dist       consumed by nanoclaw + pat-web
#   • pat-frontend/dist    served by pat-frontend's Bun on :8787 (the iframe
#                          inside pat-web loads from THIS port, not Vite's)
#   • nanoclaw-agent docker image   what nanoclaw spawns per-session as the
#                                   container. Source edits to
#                                   nanoclaw/container/agent-runner/src/* do
#                                   NOT take effect until this image is
#                                   rebuilt AND running containers are killed.
# Each one missed has bitten us at least once. mtime checks below rebuild
# only when source has changed since the artifact.
needs_build() {
  local dir="$1"
  local entry="${2:-$dir/dist/index.js}"
  if [[ ! -f "$entry" ]]; then
    return 0
  fi
  # Any src file newer than the artifact means we're stale.
  if find "$dir/src" -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' \) \
       -newer "$entry" -print -quit 2>/dev/null | grep -q .; then
    return 0
  fi
  return 1
}

# Workspace libs (consumed via dist/).
for lib in realtime scenarios; do
  if needs_build "$lib"; then
    echo "[pat-dev] building $lib (dist/ stale or missing)"
    pnpm -C "$lib" run build
  else
    echo "[pat-dev] $lib dist/ up-to-date"
  fi
done

# pat-frontend dist (Bun on :8787 serves the built SPA; Vite HMR on :5173
# doesn't reach the iframe that pat-web embeds).
if needs_build "pat-frontend" "pat-frontend/dist/index.html"; then
  echo "[pat-dev] building pat-frontend (dist/ stale or missing)"
  pnpm -C pat-frontend run build
else
  echo "[pat-dev] pat-frontend dist/ up-to-date"
fi

# Nanoclaw agent container image. Per-session containers are spawned from
# this image; source edits under nanoclaw/container/ don't take effect
# until it's rebuilt AND running containers are killed (so next session
# uses the new image).
#
# We can't use `docker inspect --format='{{.Created}}'` reliably — for a
# cached-layer rebuild that timestamp refers to the oldest cached layer,
# not the actual build run. So we maintain our own stamp file at
# nanoclaw/.image-built-at and compare against that. The stamp is touched
# both here (after build.sh succeeds) and by anyone running build.sh
# directly via the wrapper below (touch_image_stamp is exported so
# users can `touch_image_stamp` if they bypass these scripts).
IMAGE_STAMP="$REPO_ROOT/nanoclaw/.image-built-at"
touch_image_stamp() {
  touch "$IMAGE_STAMP"
}

container_image_stale() {
  # No stamp at all → rebuild (first run on this checkout).
  if [[ ! -f "$IMAGE_STAMP" ]]; then
    return 0
  fi
  # Any container source newer than the stamp → rebuild.
  if find "$REPO_ROOT/nanoclaw/container" -type f \
       \( -name '*.ts' -o -name '*.sh' -o -name '*.json' -o -name '*.lock' -o -name 'Dockerfile' \) \
       -newer "$IMAGE_STAMP" -print -quit 2>/dev/null | grep -q .; then
    return 0
  fi
  return 1
}

if command -v docker >/dev/null 2>&1; then
  if container_image_stale; then
    echo "[pat-dev] container image stale — rebuilding (./container/build.sh)"
    (cd "$REPO_ROOT/nanoclaw" && ./container/build.sh)
    touch_image_stamp
    # Note: container reap already happened in step 1 (teardown.sh).
  else
    echo "[pat-dev] container image up-to-date"
  fi
else
  echo "[pat-dev] WARNING: docker not on PATH — skipping container image check" >&2
fi

# ── 6. Start everything ──────────────────────────────────────────────────
echo "[pat-dev] starting dev stack from $REPO_ROOT (TMPDIR=$TMPDIR)"
echo "[pat-dev]   logs: /tmp/pat-dev-*.log"

# Tee each process's stdout+stderr to a per-app log file. Use `exec` inside
# the subshell so signals propagate to the actual pnpm process, not a shell
# in between. `kill 0` in the trap signals the entire process group.
(cd nanoclaw      && exec pnpm run dev)        > /tmp/pat-dev-nanoclaw.log        2>&1 &
(cd pat-web       && exec pnpm run dev)        > /tmp/pat-dev-web-vite.log        2>&1 &
(cd pat-web       && exec pnpm run dev:server) > /tmp/pat-dev-web-server.log      2>&1 &
(cd pat-frontend  && exec pnpm run dev)        > /tmp/pat-dev-frontend-vite.log   2>&1 &
(cd pat-frontend  && exec pnpm run dev:server) > /tmp/pat-dev-frontend-server.log 2>&1 &

trap 'echo; echo "[pat-dev] shutting down..."; kill 0 2>/dev/null || true' INT TERM EXIT

cat <<EOF

────────────────────────────────────────────────────────────────────────────
  PAT dev stack — running
────────────────────────────────────────────────────────────────────────────
  pat-web      vite     http://localhost:5174   (log: /tmp/pat-dev-web-vite.log)
  pat-web      bun      http://localhost:8788   (log: /tmp/pat-dev-web-server.log)
  pat-frontend vite     http://localhost:5173   (log: /tmp/pat-dev-frontend-vite.log)
  pat-frontend bun      http://localhost:8787   (log: /tmp/pat-dev-frontend-server.log)
  nanoclaw     realtime http://localhost:8765   (log: /tmp/pat-dev-nanoclaw.log)
  nanoclaw     anam-web http://localhost:8766

  tail -f /tmp/pat-dev-*.log     # follow all
  Ctrl-C                          # stops everything
────────────────────────────────────────────────────────────────────────────
EOF

wait
