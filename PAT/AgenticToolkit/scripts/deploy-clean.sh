#!/usr/bin/env bash
# deploy-clean — deploy nanoclaw from a pristine worktree of the COMMITTED SHA,
# immune to whatever is happening in the working tree (other agents' WIP,
# uncommitted edits, wrong branch). The deploy is fully determined by one
# parent SHA + its nanoclaw submodule pin. (plans/deployment-and-credentials.md
# Pillar A — the lightweight clean-SHA deploy; NOT the deferred stateful
# deploy-CLI in plans/deploy-cli.md.)
#
#   bash scripts/deploy-clean.sh staging          # deploy parent HEAD
#   bash scripts/deploy-clean.sh prod --sha <sha> # deploy a specific commit
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

ENV="${1:-}"; shift || true
SHA="HEAD"
[ "${1:-}" = "--sha" ] && SHA="${2:?--sha needs a value}"
case "$ENV" in
  staging) APP=pat-nanoclaw-staging; TOML=fly.nanoclaw.staging.toml ;;
  prod)    APP=pat-nanoclaw;         TOML=fly.nanoclaw.toml ;;
  *) echo "usage: deploy-clean.sh staging|prod [--sha <commit>]" >&2; exit 1 ;;
esac

SHA="$(git rev-parse --verify "$SHA^{commit}")"
PIN="$(git rev-parse --verify "$SHA:nanoclaw")"
WT="$(mktemp -d /tmp/pat-deploy-XXXXXX)"
cleanup() { cd "$ROOT"; git worktree remove --force "$WT" 2>/dev/null || rm -rf "$WT"; }
trap cleanup EXIT

echo "Deploying $ENV from committed SHA $SHA (nanoclaw pin ${PIN:0:12}) via pristine worktree"
# Advisory: warn when the SHA isn't the branch tip (deploying stale on purpose is fine — just say so).
TIP="$(git rev-parse --verify -q origin/staging || true)"
[ -n "$TIP" ] && [ "$SHA" != "$TIP" ] && echo "  note: $SHA != origin/staging tip (${TIP:0:12})"

git worktree add --detach "$WT" "$SHA" >/dev/null
git -C "$WT" submodule update --init --depth 1 nanoclaw >/dev/null 2>&1 || git -C "$WT" submodule update --init nanoclaw >/dev/null
ACTUAL="$(git -C "$WT/nanoclaw" rev-parse HEAD)"
[ "$ACTUAL" = "$PIN" ] || { echo "error: submodule checkout ($ACTUAL) != pin ($PIN)" >&2; exit 1; }

# Build the sibling deps the image only COPYs. Dockerfile.nanoclaw ships
# scenarios as a PREBUILT dist ("expected to be fresh on every deploy" from
# dev.sh) — a pristine worktree has none, so build it here from the committed
# source; the artifact stays SHA-determined. realtime is built first so
# scenarios' typecheck sees its types (symlinked — the "*" peer isn't on npm).
# Direct tsc binaries: `pnpm run` trips verify-deps-before-run in fresh trees.
echo "Building realtime + scenarios from committed source…"
# pnpm 11 hard-exits 1 on the ignored-builds notice (better-sqlite3/esbuild —
# neither needed for a types-only tsc build) even though the install completes;
# tolerate it and let tsc be the real gate.
(cd "$WT/realtime" && { pnpm install --frozen-lockfile >/dev/null 2>&1 || true; } && ./node_modules/.bin/tsc)
(cd "$WT/scenarios" && bun install --frozen-lockfile >/dev/null 2>&1 \
  && mkdir -p node_modules/@agentic-toolkit \
  && ln -sfn ../../../realtime node_modules/@agentic-toolkit/realtime \
  && ./node_modules/.bin/tsc)

cd "$WT"
env -u FLY_API_TOKEN -u FLY_ACCESS_TOKEN flyctl deploy -c "$TOML" --remote-only -a "$APP"
echo "✓ deployed $APP from $SHA"
