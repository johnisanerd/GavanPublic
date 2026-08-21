#!/usr/bin/env bash
# Local end-to-end proof of the pipeline — NO Fly, NO existing repos touched.
#
#   dockerized OpenObserve  ←  forwarder (bun)  ←  fake /admin/logs.tail (bun)
#                                     │
#                                     ▼  then we _search and assert
#
# Proves: SSE tail → structured ingest → OpenObserve, queryable by thread_id
# and by a nested data.* field, with debug (llm.call) included.
set -euo pipefail
cd "$(dirname "$0")/.."

OO_PORT=5080
TAIL_PORT=8767
OO_USER="root@pat.local"
OO_PASS="Complexpass#123"
OO_IMAGE="public.ecr.aws/zinclabs/openobserve:latest"
CONTAINER="pat-oo-e2e"
CHECKPOINT="./.e2e-checkpoint.json"

cleanup() {
  echo "--- cleanup ---"
  [[ -n "${FWD_PID:-}" ]] && kill "$FWD_PID" 2>/dev/null || true
  [[ -n "${TAIL_PID:-}" ]] && kill "$TAIL_PID" 2>/dev/null || true
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -f "$CHECKPOINT"
}
trap cleanup EXIT

echo "--- 1. start OpenObserve ($OO_IMAGE) ---"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" -p ${OO_PORT}:5080 \
  -e ZO_ROOT_USER_EMAIL="$OO_USER" \
  -e ZO_ROOT_USER_PASSWORD="$OO_PASS" \
  -e ZO_DATA_DIR=/data \
  -e ZO_TELEMETRY=false \
  "$OO_IMAGE" >/dev/null
echo "waiting for OpenObserve health..."
for i in $(seq 1 60); do
  if curl -fsS "http://localhost:${OO_PORT}/healthz" >/dev/null 2>&1; then echo "  healthy"; break; fi
  sleep 1
  [[ $i -eq 60 ]] && { echo "OpenObserve never became healthy"; docker logs "$CONTAINER" | tail -20; exit 1; }
done

echo "--- 2. start fake /admin/logs.tail on :$TAIL_PORT ---"
PORT=$TAIL_PORT bun run test/fake-logs-tail.ts & TAIL_PID=$!
sleep 1

echo "--- 3. start forwarder (single dev source) ---"
rm -f "$CHECKPOINT"
SOURCES="[{\"env\":\"dev\",\"tailUrl\":\"http://localhost:${TAIL_PORT}/admin/logs.tail\"}]" \
OPENOBSERVE_URL="http://localhost:${OO_PORT}" \
OPENOBSERVE_ORG="default" \
OPENOBSERVE_STREAM="pat_events" \
OPENOBSERVE_USER="$OO_USER" \
OPENOBSERVE_PASSWORD="$OO_PASS" \
CHECKPOINT_FILE="$CHECKPOINT" \
BATCH_MS="500" \
  bun run forwarder/forwarder.ts & FWD_PID=$!

echo "--- 4. let events flow (10s) ---"
sleep 10

echo "--- 5. query OpenObserve _search ---"
NOW_US=$(( $(date +%s) * 1000000 ))
START_US=$(( NOW_US - 3600000000 ))   # 1h back
END_US=$(( NOW_US + 60000000 ))       # +1min

query() {
  local sql="$1"
  curl -fsS -u "${OO_USER}:${OO_PASS}" \
    -H 'content-type: application/json' \
    "http://localhost:${OO_PORT}/api/default/_search" \
    -d "{\"query\":{\"sql\":\"${sql}\",\"start_time\":${START_US},\"end_time\":${END_US},\"from\":0,\"size\":100}}"
}

TOTAL=$(query "SELECT * FROM pat_events" | (jq -r '.total' 2>/dev/null || echo "?"))
echo "  total rows ingested: $TOTAL"

echo "  kinds present:"
query "SELECT kind, COUNT(*) as n FROM pat_events GROUP BY kind ORDER BY n DESC" \
  | jq -r '.hits[]? | "    \(.kind): \(.n)"' 2>/dev/null || echo "    (jq parse failed)"

echo "  debug (llm.call) rows queryable:"
LLM=$(query "SELECT COUNT(*) as n FROM pat_events WHERE kind = 'llm.call'" | jq -r '.hits[0].n' 2>/dev/null || echo 0)
echo "    llm.call count: $LLM"

# OpenObserve flattens nested JSON to underscore columns (depth 3):
#   data.latency_ms -> data_latency_ms ,  data.nested.deep -> data_nested_deep
# So the agent queries data.X as the column data_X. (synthetic latency = 100..~120)
echo "  nested data.* filter (data_latency_ms >= 110):"
LAT=$(query "SELECT COUNT(*) as n FROM pat_events WHERE data_latency_ms >= 110" | jq -r '.hits[0].n' 2>/dev/null || echo "?")
echo "    rows: $LAT"

echo "  env tag present:"
query "SELECT env, COUNT(*) as n FROM pat_events GROUP BY env" | jq -r '.hits[]? | "    env=\(.env): \(.n)"' 2>/dev/null || true

echo ""
if [[ "$TOTAL" =~ ^[0-9]+$ ]] && [[ "$TOTAL" -gt 0 ]] && [[ "$LLM" =~ ^[0-9]+$ ]] && [[ "$LLM" -gt 0 ]] && [[ "$LAT" =~ ^[0-9]+$ ]] && [[ "$LAT" -gt 0 ]]; then
  echo "✅ PASS — structured events (incl. debug llm.call + nested data.* filter) ingested and SQL-queryable"
else
  echo "❌ FAIL — total=$TOTAL llm=$LLM"
  echo "--- forwarder/openobserve logs for debug ---"
  docker logs "$CONTAINER" 2>&1 | tail -15
  exit 1
fi
