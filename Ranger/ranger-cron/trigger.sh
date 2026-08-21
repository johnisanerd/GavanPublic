#!/bin/sh
set -e

echo "Triggering Ranger run at $(date)"

curl -X POST \
  -H "Authorization: Bearer $TRAILHEAD_SECRET" \
  -H "Content-Type: application/json" \
  --fail \
  --silent \
  --show-error \
  "$TRAILHEAD_URL/ranger/run"

echo "Ranger run triggered successfully"
