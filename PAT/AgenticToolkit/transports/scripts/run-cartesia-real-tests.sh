#!/usr/bin/env bash
# Opt-in runner for the real-Cartesia integration tests under
# tests/real_cartesia/. Spends real money — see tests/README.md.
#
# Usage:
#   ./scripts/run-cartesia-real-tests.sh           # all tests
#   ./scripts/run-cartesia-real-tests.sh -k tts    # filter
#
# Required env: CARTESIA_API_KEY
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -z "${CARTESIA_API_KEY:-}" ]]; then
  echo "ERROR: CARTESIA_API_KEY not set" >&2
  echo "" >&2
  echo "  These tests hit api.cartesia.ai and spend real money (~\$0.01/run)." >&2
  echo "  Export your key and re-run:" >&2
  echo "" >&2
  echo "    export CARTESIA_API_KEY=sk-..." >&2
  echo "    $0" >&2
  echo "" >&2
  exit 2
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "WARNING: ffmpeg not on PATH — Ink STT test will skip." >&2
  echo "         brew install ffmpeg" >&2
fi

cat <<EOF
================================================================================
 voice-transport: real-Cartesia integration tests
================================================================================
 Cost estimate: ~\$0.01 (first run) / ~\$0.006 (cached fixture runs)
 Endpoints: api.cartesia.ai (TTS WS, /tts/bytes, /audio/transcriptions, /voices)
 Skip with: -k <substring> to filter, or pytest -m "not real_cartesia"
================================================================================

EOF

exec uv run pytest tests/real_cartesia -v -s "$@"
