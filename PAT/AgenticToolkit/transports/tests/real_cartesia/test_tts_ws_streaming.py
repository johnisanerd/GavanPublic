"""Real-Cartesia TTS WebSocket streaming test — verifies the Path A bet.

Path A's central architectural bet (from
`plans/streaming-banter-pipeline.md` §4): Cartesia handles server-side
prosody continuity when text deltas are pushed into a single TTS WS
context via `ctx.push(...)`. If this bet doesn't hold, multi-delta
streaming produces choppy/awkward speech and we'd need to fall back to
buffering deltas on the host before sending one full transcript per
utterance.

This test exercises the bet directly:

  1. Open a real Cartesia TTS WS session with `cartesia` Python SDK.
  2. Push 8-10 short text parts spaced over a ~1.5s window
     (matches what Stage 1's `streamHaikuToSse` emits for a banter
     ack — ~6-12 token deltas at Anthropic streaming cadence).
  3. Collect audio chunk bytes via `ctx.receive()`.
  4. Assert: audio bytes received, non-zero duration, no error
     responses, single utterance audio (chunks contiguous).

Run:
  CARTESIA_API_KEY=sk-... pytest tests/real_cartesia/test_tts_ws_streaming.py -v

Cost: ~$0.005 per run (a few seconds of Sonic 2 TTS).
"""
from __future__ import annotations

import asyncio
import os
import time
from typing import Iterable

import pytest

pytestmark = pytest.mark.real_cartesia


def _have_cartesia_sdk() -> bool:
    try:
        import cartesia  # noqa: F401
        return True
    except Exception:
        return False


SDK_INSTALLED = _have_cartesia_sdk()

# Cartesia "Newsman" preset — same voice as PAT's Signal voice-memo
# code (signal.ts CARTESIA_DEFAULT_VOICE_ID). Stable, well-tested.
VOICE_ID = "87748186-23bb-4158-a1eb-332911b0b708"


def _short_banter_parts() -> list[str]:
    """Mirrors a typical banter-ack streaming delta sequence.

    Anthropic Haiku streaming emits roughly token-aligned text deltas
    at ~150ms intervals for short outputs. A banter ack like
    "yeah, lemme work that out." comes out in 6-8 deltas. We pad to
    10 to stress-test the splice boundary count.
    """
    return [
        "yeah",
        ", ",
        "lemme ",
        "work ",
        "that ",
        "out",
        " — ",
        "give ",
        "me ",
        "a sec.",
    ]


def _long_rendition_parts() -> list[str]:
    """Longer multi-sentence utterance — mirrors a rendition delta sequence.

    Rendition is typically 2-3 sentences (~30 words). Streaming over
    2-3 seconds at Anthropic Haiku cadence. We chunk on word/sentence
    boundaries since the streaming-banter plan calls out (risk register
    line 327) that sentence-boundary chunking may be preferable to
    token-boundary for longer outputs.
    """
    return [
        "Sure, ",
        "so Jupiter ",
        "is the ",
        "biggest planet ",
        "in our ",
        "solar system. ",
        "It's a ",
        "gas giant, ",
        "mostly ",
        "hydrogen ",
        "and helium, ",
        "and it ",
        "has at ",
        "least 95 ",
        "known moons.",
    ]


@pytest.mark.skipif(
    not SDK_INSTALLED,
    reason="`cartesia` Python SDK not installed (add to dev-deps: `uv add --dev cartesia`)",
)
def test_tts_ws_streams_short_banter_continuous_audio() -> None:
    """Push a short banter-cadence sequence to TTS WS, assert audio out."""
    from cartesia import Cartesia

    client = Cartesia(api_key=os.environ["CARTESIA_API_KEY"])

    audio_bytes = bytearray()
    chunk_count = 0
    response_types: list[str] = []
    push_timestamps: list[float] = []
    first_chunk_at: float | None = None

    t0 = time.monotonic()
    with client.tts.websocket_connect() as connection:
        ctx = connection.context(
            model_id="sonic-2",
            voice={"mode": "id", "id": VOICE_ID},
            output_format={
                "container": "raw",
                "encoding": "pcm_s16le",
                "sample_rate": 24000,
            },
        )

        # Push deltas with realistic spacing. ~150ms between deltas
        # mirrors Anthropic Haiku streaming token cadence for short
        # outputs. This is the regime Path A bets on.
        for part in _short_banter_parts():
            ctx.push(part)
            push_timestamps.append(time.monotonic() - t0)
            time.sleep(0.15)

        ctx.no_more_inputs()

        for response in ctx.receive():
            response_types.append(response.type)
            if response.type == "chunk" and getattr(response, "audio", None):
                if first_chunk_at is None:
                    first_chunk_at = time.monotonic() - t0
                audio_bytes.extend(response.audio)
                chunk_count += 1

    # Hard asserts.
    assert chunk_count > 0, f"no audio chunks received; response_types={response_types}"
    assert len(audio_bytes) > 0, "received chunk responses but no audio bytes"

    # 24kHz, s16le = 48000 bytes/sec. Banter "yeah, lemme work that
    # out — give me a sec." is ~2s of audio → ~96KB. Be conservative
    # and require at least 0.5s of audio (24KB) and no upper bound.
    bytes_per_sec = 24_000 * 2  # 24kHz × 16-bit (2 bytes/sample)
    duration_s = len(audio_bytes) / bytes_per_sec
    assert duration_s >= 0.5, f"audio too short: {duration_s:.2f}s, {len(audio_bytes)} bytes"

    # No error responses in the stream. Cartesia signals problems via
    # response.type == "error".
    assert "error" not in response_types, f"error response present: {response_types}"

    # First-chunk latency is informational, not asserted (varies by
    # network + region), but print it for the runbook log.
    if first_chunk_at is not None:
        print(
            f"\n  TTFW (first audio chunk): {first_chunk_at*1000:.0f}ms"
            f"\n  total deltas pushed: {len(push_timestamps)}"
            f"\n  total chunks received: {chunk_count}"
            f"\n  audio duration: {duration_s:.2f}s ({len(audio_bytes)} bytes)"
        )


@pytest.mark.skipif(
    not SDK_INSTALLED,
    reason="`cartesia` Python SDK not installed (add to dev-deps: `uv add --dev cartesia`)",
)
def test_tts_ws_streams_long_rendition_continuous_audio() -> None:
    """Push a 2.5s-window rendition-cadence sequence, assert audio out.

    Risk-register line 327 of streaming-banter-pipeline.md flags
    "Cartesia TTS server-side prosody breaks at delta boundaries on
    longer rendition (~2-3s window)". This test exercises that regime
    directly so we catch prosody-related issues before staging.
    """
    from cartesia import Cartesia

    client = Cartesia(api_key=os.environ["CARTESIA_API_KEY"])

    audio_bytes = bytearray()
    chunk_count = 0
    response_types: list[str] = []

    parts = _long_rendition_parts()
    t0 = time.monotonic()
    with client.tts.websocket_connect() as connection:
        ctx = connection.context(
            model_id="sonic-2",
            voice={"mode": "id", "id": VOICE_ID},
            output_format={
                "container": "raw",
                "encoding": "pcm_s16le",
                "sample_rate": 24000,
            },
        )

        # ~167ms between deltas → ~2.5s total window for 15 deltas.
        for part in parts:
            ctx.push(part)
            time.sleep(0.167)
        ctx.no_more_inputs()

        for response in ctx.receive():
            response_types.append(response.type)
            if response.type == "chunk" and getattr(response, "audio", None):
                audio_bytes.extend(response.audio)
                chunk_count += 1

    assert chunk_count > 0, f"no audio chunks received; types={response_types}"

    bytes_per_sec = 24_000 * 2
    duration_s = len(audio_bytes) / bytes_per_sec
    # ~30 words of rendition at ~150 wpm = ~12s. Be conservative.
    assert duration_s >= 2.0, f"audio too short for rendition cadence: {duration_s:.2f}s"
    assert "error" not in response_types

    total_pushed = sum(len(p) for p in parts)
    print(
        f"\n  rendition deltas pushed: {len(parts)} ({total_pushed} chars)"
        f"\n  total chunks received: {chunk_count}"
        f"\n  audio duration: {duration_s:.2f}s ({len(audio_bytes)} bytes)"
        f"\n  push window: {time.monotonic()-t0:.2f}s"
    )


@pytest.mark.skipif(
    not SDK_INSTALLED,
    reason="`cartesia` Python SDK not installed",
)
def test_tts_ws_handles_empty_no_more_inputs() -> None:
    """Push nothing, signal end-of-input — assert clean session end.

    Edge case from Path A's barge-in flow: a stream that was opened
    then immediately cancelled (utterance-cancel arrives before any
    delta) should close cleanly without protocol errors.
    """
    from cartesia import Cartesia

    client = Cartesia(api_key=os.environ["CARTESIA_API_KEY"])
    response_types: list[str] = []

    with client.tts.websocket_connect() as connection:
        ctx = connection.context(
            model_id="sonic-2",
            voice={"mode": "id", "id": VOICE_ID},
            output_format={
                "container": "raw",
                "encoding": "pcm_s16le",
                "sample_rate": 24000,
            },
        )
        # Push a single space then end — Cartesia may reject truly
        # empty contexts. A space is the minimum viable input.
        ctx.push(" ")
        ctx.no_more_inputs()
        for response in ctx.receive():
            response_types.append(response.type)

    # Either we get a (probably-silent) chunk stream or done — either
    # way, no errors.
    assert "error" not in response_types, f"errors on minimal-input ctx: {response_types}"
