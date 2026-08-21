#!/usr/bin/env bash
# Pre-deploy nanoclaw submodule hygiene check (plans/deployment-and-credentials.md, Pillar A).
#
# A deploy should be fully determined by one parent SHA. The submodule pins the
# exact nanoclaw commit — but submodules don't auto-follow, so the parent can lag
# the nanoclaw branch tip. This warns (never blocks — advisory) when what you're
# about to ship isn't what you probably mean:
#   1. nanoclaw working tree is dirty (deploy reads disk → uncommitted bits ship untracked)
#   2. nanoclaw working tree != the parent's committed pin (you forgot the "bump")
#   3. nanoclaw is behind/ahead of its origin branch tip
#
# Run before `flyctl deploy`. See the memory: check-submodule-status-on-deploy.
set -uo pipefail
cd "$(dirname "$0")/.."

BRANCH="$(git config -f .gitmodules submodule.nanoclaw.branch 2>/dev/null || echo staging)"
PIN="$(git rev-parse --verify -q HEAD:nanoclaw 2>/dev/null || echo none)"   # committed gitlink
ACTUAL="$(git -C nanoclaw rev-parse HEAD 2>/dev/null || echo none)"    # on-disk HEAD
git -C nanoclaw fetch -q origin 2>/dev/null || true
TIP="$(git -C nanoclaw rev-parse "origin/$BRANCH" 2>/dev/null || echo '')"

warn=0
if [ -n "$(git -C nanoclaw status --porcelain 2>/dev/null)" ]; then
  echo "⚠️  nanoclaw has UNCOMMITTED changes — the Fly build reads disk, so commit them first or they ship untracked."
  warn=1
fi
if [ "$ACTUAL" != "$PIN" ]; then
  echo "⚠️  nanoclaw on-disk HEAD ($ACTUAL) != parent's committed pin ($PIN)."
  echo "    → bump the pin:  git add nanoclaw && git commit -m 'bump nanoclaw'"
  warn=1
fi
if [ -n "$TIP" ] && [ "$ACTUAL" != "$TIP" ]; then
  behind="$(git -C nanoclaw rev-list --count "HEAD..origin/$BRANCH" 2>/dev/null || echo '?')"
  ahead="$(git -C nanoclaw rev-list --count "origin/$BRANCH..HEAD" 2>/dev/null || echo '?')"
  echo "⚠️  nanoclaw HEAD vs origin/$BRANCH — behind $behind, ahead $ahead (take latest: git submodule update --remote nanoclaw, then bump)."
  warn=1
fi

if [ "$warn" = 0 ]; then
  echo "✓ nanoclaw submodule clean: pin == on-disk == origin/$BRANCH ($ACTUAL)"
fi
exit 0  # advisory only — never blocks a deploy
