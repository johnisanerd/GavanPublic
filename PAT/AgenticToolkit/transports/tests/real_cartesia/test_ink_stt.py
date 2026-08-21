"""Real-Cartesia Ink STT test — verifies the Signal voice-memo
inbound path (task #10).

The flow under test (mirrors `signal.ts` `transcribeAudioOptional`):

  Signal voice-note attachment (raw AAC/ADTS)
    → ffmpeg `-c:a copy` remux to .m4a container
    → POST multipart/form-data to api.cartesia.ai/audio/transcriptions
    → response.text

This test generates a 2-second AAC fixture on-demand (via Cartesia
TTS + ffmpeg AAC encode) and runs it through the same remux + Ink
call. Generated fixtures are cached under tests/fixtures/ — first run
costs an extra ~$0.005 for TTS; subsequent runs reuse the cached AAC.

Cost: ~$0.01 first run (TTS + Ink), ~$0.005 thereafter (Ink only).

Skipped if ffmpeg not on PATH.
"""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import httpx
import pytest

pytestmark = pytest.mark.real_cartesia

CARTESIA_VERSION = "2025-04-16"
NEWSMAN_VOICE_ID = "87748186-23bb-4158-a1eb-332911b0b708"
FIXTURE_DIR = Path(__file__).resolve().parent.parent / "fixtures"
AAC_FIXTURE = FIXTURE_DIR / "voicenote-2s.aac"
TRANSCRIPT_TEXT = "Hey Pat, can you check the weather in Tokyo for me."


def _have_ffmpeg() -> bool:
    return shutil.which("ffmpeg") is not None


@pytest.fixture(scope="module")
def aac_fixture(tmp_path_factory) -> Path:
    """Produce a 2-second AAC/ADTS fixture matching Signal voice-note
    encoding. Generates once, caches under tests/fixtures/."""
    if not _have_ffmpeg():
        pytest.skip("ffmpeg not on PATH; needed for AAC fixture generation")

    FIXTURE_DIR.mkdir(exist_ok=True)
    if AAC_FIXTURE.exists() and AAC_FIXTURE.stat().st_size > 1000:
        return AAC_FIXTURE

    # Synthesize via Cartesia TTS in mp3 form, then encode to AAC/ADTS.
    body = {
        "transcript": TRANSCRIPT_TEXT,
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
            headers={
                "X-API-Key": os.environ["CARTESIA_API_KEY"],
                "Cartesia-Version": CARTESIA_VERSION,
                "Content-Type": "application/json",
            },
            json=body,
        )
    assert r.status_code == 200, f"TTS for fixture failed: {r.status_code} {r.text[:200]}"

    tmp = tmp_path_factory.mktemp("ink-fixture")
    mp3 = tmp / "src.mp3"
    mp3.write_bytes(r.content)

    # AAC/ADTS — Signal's voice-note format. `-f adts` forces the
    # raw-AAC container Signal uses.
    subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "error",
            "-i", str(mp3),
            "-c:a", "aac", "-b:a", "32k",
            "-f", "adts",
            str(AAC_FIXTURE),
        ],
        check=True,
    )
    assert AAC_FIXTURE.exists() and AAC_FIXTURE.stat().st_size > 1000
    return AAC_FIXTURE


def test_ink_transcribes_aac_voice_note(aac_fixture, tmp_path) -> None:
    """Full Signal voice-memo path: AAC → remux to m4a → Ink → text."""
    if not _have_ffmpeg():
        pytest.skip("ffmpeg required")

    m4a = tmp_path / "remuxed.m4a"
    subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "error",
            "-i", str(aac_fixture),
            "-c:a", "copy",
            str(m4a),
        ],
        check=True,
    )
    assert m4a.exists()

    # Mirror signal.ts multipart upload exactly. Note: Cartesia Ink's
    # audio/transcriptions endpoint is OpenAI-compatible; signal.ts
    # uses raw fetch + manual multipart construction. httpx does it
    # for us via `files=`.
    with httpx.Client(timeout=60.0) as client:
        files = {"file": ("audio.m4a", m4a.read_bytes(), "audio/mp4")}
        data = {"model": "ink-whisper", "language": "en"}
        r = client.post(
            "https://api.cartesia.ai/audio/transcriptions",
            headers={"X-API-Key": os.environ["CARTESIA_API_KEY"]},
            data=data,
            files=files,
        )

    assert r.status_code == 200, f"Ink failed: {r.status_code} {r.text[:300]}"
    payload = r.json()
    assert "text" in payload, f"missing text in response: {payload}"
    transcribed = payload["text"].strip().lower()
    # Tolerant assertion — Whisper-class STT may differ in punctuation
    # and capitalization, and may add/elide articles. Check for key
    # tokens.
    for token in ("pat", "weather", "tokyo"):
        assert token in transcribed, (
            f"missing expected token '{token}' in: {transcribed!r}"
        )


def test_ink_via_sdk(tmp_path, aac_fixture) -> None:
    """Same call via the cartesia Python SDK to verify SDK + REST agree.

    Skipped if `cartesia` SDK isn't installed; only the REST path
    above is load-bearing for prod (nanoclaw side uses raw fetch).
    """
    try:
        from cartesia import Cartesia
    except Exception:
        pytest.skip("`cartesia` SDK not installed")

    if not _have_ffmpeg():
        pytest.skip("ffmpeg required")

    m4a = tmp_path / "remuxed.m4a"
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(aac_fixture), "-c:a", "copy", str(m4a)],
        check=True,
    )

    client = Cartesia(api_key=os.environ["CARTESIA_API_KEY"])
    with open(m4a, "rb") as f:
        response = client.stt.transcribe(file=f, model="ink-whisper", language="en")
    transcribed = (response.text or "").strip().lower()
    for token in ("pat", "weather", "tokyo"):
        assert token in transcribed, f"SDK transcription missing '{token}': {transcribed!r}"
