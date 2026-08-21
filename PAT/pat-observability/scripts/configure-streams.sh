#!/usr/bin/env bash
# Config-as-code for OpenObserve stream settings — idempotent, re-run any time
# (e.g. after a volume rebuild or a fresh OpenObserve install).
#
# Currently applied:
#   pat_raw: full_text_search_keys = message, error_message
#     Without FTS keys, match_all('term') returns HTTP 400 ("should only apply
#     to the stream that have full text search fields"). tui/tail.py's bare-term
#     filter compiles to match_all, so pat_raw needs this. Applies retroactively
#     to already-ingested data (verified 2026-07-07 on v0.91.0).
#
# Deliberately NOT applied:
#   pat_events: left without FTS keys. Its text lives in ~28 sparse data_*
#     columns; indexing a subset would make bare-term search *silently partial*
#     ("0 rows ≠ not there"). A loud 400 steering you to structured WHERE
#     clauses is safer than a quiet miss. Revisit if a stable canonical text
#     column emerges.
#
# Needs the proxy up (scripts/proxy.sh) and .observability-secrets at repo root.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SECRETS="$REPO/.observability-secrets"

U=$(grep -E '^OPENOBSERVE_USER=' "$SECRETS" | cut -d= -f2-)
P=$(grep -E '^OPENOBSERVE_PASSWORD=' "$SECRETS" | cut -d= -f2-)
ORG=$(grep -E '^OPENOBSERVE_ORG=' "$SECRETS" | cut -d= -f2- || true)
ORG=${ORG:-default}
BASE="http://127.0.0.1:5080/api/$ORG"

curl -fsS -o /dev/null "http://127.0.0.1:5080/healthz" || {
  echo "proxy not up — run scripts/proxy.sh first" >&2; exit 1; }

echo "pat_raw: setting full_text_search_keys (message, error_message)"
curl -fsS -u "$U:$P" -X PUT -H 'content-type: application/json' \
  "$BASE/streams/pat_raw/settings?type=logs" \
  -d '{"full_text_search_keys":{"add":["message","error_message"],"remove":[]}}'
echo

echo "verify:"
curl -fsS -u "$U:$P" "$BASE/streams?fetchSchema=false" |
  jq -c '.list[] | {name, fts: .settings.full_text_search_keys}'
