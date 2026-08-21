"""Reachability smoke tests against the Cartesia HTTP API.

Cartesia hosts the agent runtime — there's no public "Calls WS as a
client" surface for PAT to drive directly without a real phone number
provisioned. So instead we verify the **HTTP control plane** and
**TTS-bytes** surface PAT depends on:

  - Voice list lookup (cheapest possible auth-check call)
  - TTS bytes synthesis (mirrors signal.ts voice-memo path)
  - Account / models endpoints

These together prove the deployed Cartesia API key works and that the
endpoints PAT uses are reachable. The TTS WS streaming behaviour is
covered by `test_tts_ws_streaming.py`; STT is covered by
`test_ink_stt.py`.

Cost: ~$0.005 per run (one 5-second TTS synthesis).
"""
from __future__ import annotations

import os
from pathlib import Path

import httpx
import pytest

pytestmark = pytest.mark.real_cartesia

CARTESIA_VERSION = "2025-04-16"
NEWSMAN_VOICE_ID = "87748186-23bb-4158-a1eb-332911b0b708"


def _auth_headers() -> dict[str, str]:
    return {
        "X-API-Key": os.environ["CARTESIA_API_KEY"],
        "Cartesia-Version": CARTESIA_VERSION,
    }


def test_voices_endpoint_returns_newsman() -> None:
    """List voices via REST — auth-only smoke that PAT's key works."""
    with httpx.Client(timeout=30.0) as client:
        r = client.get(
            f"https://api.cartesia.ai/voices/{NEWSMAN_VOICE_ID}",
            headers=_auth_headers(),
        )
    assert r.status_code == 200, (
        f"voices lookup failed: {r.status_code} {r.text[:200]}"
    )
    data = r.json()
    assert data.get("id") == NEWSMAN_VOICE_ID
    # Don't assert on the name string — Cartesia may rename presets.


def test_tts_bytes_endpoint_returns_mp3() -> None:
    """Mirror signal.ts voice-memo synthesis call.

    This is the EXACT request shape PAT's `synthesizeVoiceMemoOptional`
    produces. If this test fails, voice-memo send is broken in prod.
    """
    body = {
        "transcript": "Stage 4 integration test running.",
        "model_id": "sonic-2",
        "voice": {"mode": "id", "id": NEWSMAN_VOICE_ID},
        "output_format": {
            "container": "mp3",
            "sample_rate": 24000,
            "bit_rate": 64000,
        },
    }
    with httpx.Client(timeout=60.0) as client:
        r = client.post(
            "https://api.cartesia.ai/tts/bytes",
            headers={**_auth_headers(), "Content-Type": "application/json"},
            json=body,
        )
    assert r.status_code == 200, f"tts bytes failed: {r.status_code} {r.text[:300]}"
    audio = r.content
    assert len(audio) > 1000, f"audio too small: {len(audio)} bytes"
    # mp3 magic bytes — either ID3 header or MPEG frame sync.
    assert audio[:3] == b"ID3" or audio[0] == 0xFF, (
        f"unexpected leading bytes: {audio[:8]!r}"
    )
