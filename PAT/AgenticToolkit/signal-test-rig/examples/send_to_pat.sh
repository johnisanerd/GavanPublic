#!/usr/bin/env bash
# Send a message from the burner to a PAT-owned Signal handle.
#
# Usage:
#   examples/send_to_pat.sh +1XXX "your message here"
#
# Env:
#   SIGNAL_TEST_RIG_URL    default http://127.0.0.1:7585
#   SIGNAL_TEST_RIG_TOKEN  required (must match the rig)

set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <E164-recipient> <message>" >&2
  exit 64
fi

RECIPIENT="$1"
shift
MESSAGE="$*"

URL="${SIGNAL_TEST_RIG_URL:-http://127.0.0.1:7585}"
TOKEN="${SIGNAL_TEST_RIG_TOKEN:?SIGNAL_TEST_RIG_TOKEN env var required}"

# jq for safe JSON encoding (handles quotes, newlines, etc.).
PAYLOAD="$(jq -nc --arg r "$RECIPIENT" --arg t "$MESSAGE" '{recipient:$r, text:$t}')"

curl -sS -X POST "$URL/send" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" | jq .
