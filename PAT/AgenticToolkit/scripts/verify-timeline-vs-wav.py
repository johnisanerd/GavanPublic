#!/usr/bin/env python3
"""
Cross-check the TTS_CHARS_PER_SEC=11 constant (used by host TTS-busy
projection AND by Narrator's max-silence cadence) against actual
.wav file durations from a smoketest --audio run.

Usage:
    scripts/verify-timeline-vs-wav.py <smoketest-dir>

    e.g.
    scripts/verify-timeline-vs-wav.py \
        nanoclaw/data/v2-sessions/_smoketest/baseline-2026-05-07T18-12-41-934Z

Reads transcript.json for the user-turn text, and audio/turn-NNN.wav
for the actual TTS-rendered audio. Prints a one-line report per turn:

    turn-000  text=18ch  wav=1.74s  chars/sec=10.3  (target 11.0, off by  6%)
    turn-001  text=42ch  wav=4.10s  chars/sec=10.2  (target 11.0, off by  7%)
    ─────────
    mean chars/sec=10.25 (target 11.0, off by 6.8%) → consider lowering constant

If the observed mean chars/sec is consistently below 11, the constant
is too aggressive — projected utterance ends sooner than actual, and
the Narrator may speak over the agent's tail. If above, the projection
is too generous and silences feel longer than necessary.
"""
from __future__ import annotations

import json
import sys
import wave
from pathlib import Path


TARGET_CHARS_PER_SEC = 11.0


def wav_duration_secs(wav_path: Path) -> float:
    """Cartesia's TTS streams emit wavs with an INT_MAX-framed header
    (the data-chunk size field is left as a placeholder for streaming).
    Trust the rate / sampwidth / channels from the header but compute
    frames from the actual file size minus a fixed 44-byte RIFF header.
    Falls back to header-reported frames when the value looks plausible."""
    with wave.open(str(wav_path), "rb") as w:
        rate = w.getframerate()
        sampwidth = w.getsampwidth()
        channels = w.getnchannels()
        frames = w.getnframes()
    if not rate or not sampwidth or not channels:
        return 0.0
    file_bytes = wav_path.stat().st_size
    HEADER_BYTES = 44
    audio_bytes = max(0, file_bytes - HEADER_BYTES)
    frames_from_size = audio_bytes // (sampwidth * channels)
    # Plausibility check on the header frame count: assume nothing > 10
    # minutes (rate * 600). If header says more than that, it's a streamed
    # placeholder — use file-size derivation instead.
    plausible = frames > 0 and frames < rate * 600
    use_frames = frames if plausible else frames_from_size
    return use_frames / rate


def main() -> int:
    if len(sys.argv) != 2:
        sys.exit("usage: verify-timeline-vs-wav.py <smoketest-dir>")
    root = Path(sys.argv[1])
    transcript = root / "transcript.json"
    audio_dir = root / "audio"
    if not transcript.exists():
        sys.exit(f"no transcript.json at {transcript}")
    if not audio_dir.is_dir():
        sys.exit(f"no audio/ dir at {audio_dir}")

    data = json.loads(transcript.read_text())
    # User turns appear in transcript with source='user'. Pair them in
    # order with turn-NNN.wav files.
    user_turns = [e for e in data["entries"] if e.get("source") == "user"]
    wavs = sorted(audio_dir.glob("turn-*.wav"))
    if not user_turns:
        sys.exit("no user turns found in transcript.json")
    if not wavs:
        sys.exit("no turn-*.wav files in audio/")

    # If the count differs, walk pair-wise as far as both have entries.
    pairs = list(zip(user_turns, wavs))
    if len(user_turns) != len(wavs):
        print(
            f"[warn] count mismatch: {len(user_turns)} user turns vs {len(wavs)} wavs "
            f"— pairing first {len(pairs)}",
            file=sys.stderr,
        )

    print(f"# verify-timeline-vs-wav  ({root.name})")
    print(f"# target TTS_CHARS_PER_SEC = {TARGET_CHARS_PER_SEC}")
    print()
    ratios: list[float] = []
    for entry, wav in pairs:
        text: str = entry.get("text", "")
        text_chars = len(text)
        if text_chars == 0:
            continue
        dur = wav_duration_secs(wav)
        if dur <= 0:
            print(f"{wav.name}  text={text_chars}ch  wav={dur:.2f}s  (skipped: zero-duration wav)")
            continue
        cps = text_chars / dur
        ratios.append(cps)
        deviation_pct = abs(cps - TARGET_CHARS_PER_SEC) / TARGET_CHARS_PER_SEC * 100
        direction = "under" if cps < TARGET_CHARS_PER_SEC else "over"
        print(
            f"{wav.name}  text={text_chars:3d}ch  wav={dur:5.2f}s  "
            f"chars/sec={cps:5.2f}  ({direction} target by {deviation_pct:4.1f}%)"
        )
        if text_chars < 40:
            preview = text
        else:
            preview = text[:30] + "…" + text[-8:]
        print(f"           text: {preview!r}")

    if ratios:
        mean = sum(ratios) / len(ratios)
        mean_dev = abs(mean - TARGET_CHARS_PER_SEC) / TARGET_CHARS_PER_SEC * 100
        print()
        print(f"  mean chars/sec = {mean:.2f}  (target {TARGET_CHARS_PER_SEC}, off by {mean_dev:.1f}%)")
        if mean_dev > 15:
            verdict = (
                f"  → constant is meaningfully off; consider tuning to ~{round(mean):.0f}"
            )
        elif mean_dev > 5:
            verdict = "  → close enough but worth re-checking on a longer run"
        else:
            verdict = "  → constant is well-calibrated"
        print(verdict)
    return 0


if __name__ == "__main__":
    sys.exit(main())
