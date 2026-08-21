#!/usr/bin/env bash
# secrets-push — ship .env.remote.<env> to the nanoclaw Fly app as secrets.
# (plans/deployment-and-credentials.md Pillar B: .env.remote is the gitignored
# local record of remote values; Fly secrets are the storage; the boot
# reconcile derives the OneCLI vault from AGENT_* values + the DB routing table.)
#
#   bash scripts/secrets-push.sh staging            # show names, confirm, import
#   bash scripts/secrets-push.sh prod --yes         # skip confirmation
#
# One `flyctl secrets import` = one machine restart for all values. Values
# never echo to the terminal — names only.
set -euo pipefail
cd "$(dirname "$0")/.."

ENV="${1:-}"; shift || true
YES="${1:-}"
case "$ENV" in
  staging) APP=pat-nanoclaw-staging ;;
  prod)    APP=pat-nanoclaw ;;
  *) echo "usage: secrets-push.sh staging|prod [--yes]" >&2; exit 1 ;;
esac
FILE=".env.remote.$ENV"
[ -f "$FILE" ] || { echo "error: $FILE not found" >&2; exit 1; }

# Validate + collect KEY names (skip blanks/comments); never print values.
# (No case-in-$() — macOS bash 3.2 mis-parses case patterns inside command
# substitution unless parenthesized.)
BAD=$(grep -vE '^[[:space:]]*(#|$)' "$FILE" | grep -vE '^[A-Za-z_][A-Za-z0-9_]*=' | cut -d= -f1 || true)
[ -z "$BAD" ] || { printf 'error: malformed line(s) in %s:\n%s\n' "$FILE" "$BAD" >&2; exit 1; }
KEYS=$(grep -vE '^[[:space:]]*(#|$)' "$FILE" | cut -d= -f1)
[ -n "$KEYS" ] || { echo "error: no KEY=VALUE lines in $FILE" >&2; exit 1; }

# Phase 4: every key must declare its trust tier via prefix — HOST_ (host
# process), AGENT_ (OneCLI vault egress), PUBLIC_ (browser). An unprefixed
# key would recreate the pre-router duplication this scheme retired; config
# (non-secret) belongs in fly.toml [env], not here.
UNPREFIXED=$(printf '%s\n' $KEYS | grep -vE '^(HOST_|AGENT_|PUBLIC_)' || true)
[ -z "$UNPREFIXED" ] || {
  printf 'error: unprefixed key(s) in %s (must start with HOST_/AGENT_/PUBLIC_):\n%s\n' "$FILE" "$UNPREFIXED" >&2
  exit 1
}

echo "Will set on $APP (machine restarts once):"
printf '  %s\n' $KEYS
if [ "$YES" != "--yes" ]; then
  printf 'Proceed? [y/N] '; read -r ans
  [ "$ans" = "y" ] || { echo "aborted"; exit 1; }
fi

grep -vE '^\s*(#|$)' "$FILE" | env -u FLY_API_TOKEN -u FLY_ACCESS_TOKEN flyctl secrets import -a "$APP"
echo "✓ secrets imported to $APP"
