# voice-transport tests

Two tiers:

| Tier | Path | Real API? | Cost | When |
|---|---|---|---|---|
| Unit | `tests/unit/` | No | — | Every `pytest` run, every CI |
| Real-Cartesia | `tests/real_cartesia/` | Yes | ~$0.01 / run | Opt-in only |

The drift test (`../test_log_events_match.py`) lives at the package
root and runs alongside unit tests.

## Unit tests

Standard:

```
cd transports
uv run pytest tests/unit -v
```

Covers the Path A WS protocol contract (`test_path_a_protocol.py`)
without touching Cartesia. Uses an in-process FastAPI fake nanoclaw +
the FastAPI WebSocket TestClient to verify wire shapes and side
effects (POST /inbound, POST /barge-in, SSE forwarding, log-event
emission).

## Real-Cartesia integration tests

These spend real money. They verify:

1. **TTS WS streaming continuity** (`test_tts_ws_streaming.py`) —
   the central Path A bet: multi-chunk `ctx.push(...)` calls at
   Anthropic-Haiku delta cadence produce continuous audio out, with
   no protocol errors. Covers short (banter-ack) and long (rendition)
   delta windows.
2. **HTTP API reachability** (`test_api_reachability.py`) — `/voices`
   lookup + `/tts/bytes` synthesis. Mirrors signal.ts voice-memo
   shape exactly; failing this means voice-memo send is broken in
   prod.
3. **Ink STT round-trip** (`test_ink_stt.py`) — generates an AAC/ADTS
   fixture matching Signal voice-note format, remuxes via ffmpeg,
   POSTs to `/audio/transcriptions`. Mirrors `signal.ts`
   `transcribeAudioOptional` end-to-end.

### Setup

The `cartesia` Python SDK is needed for TTS WS + SDK-side STT tests.
It's not in the production deps (voice-transport uses `cartesia-line`
only). Install it transiently for tests:

```
cd transports
uv add --dev cartesia
```

(If your `uv.lock` is frozen for prod parity, instead use
`uv pip install cartesia` inside the `.venv`. The cartesia SDK is
only used in `tests/real_cartesia/` and not imported by `main.py`
or `log_events.py`.)

ffmpeg is required for the Ink STT test; install via Homebrew:
`brew install ffmpeg`.

### Running

The dedicated script handles env-var checks and prints a cost banner:

```
cd transports
./scripts/run-cartesia-real-tests.sh
```

Or directly:

```
cd transports
CARTESIA_API_KEY=sk-... uv run pytest tests/real_cartesia -v -s
```

### Cost breakdown

Per full real-Cartesia run, end-to-end:

| Test | Cartesia spend |
|---|---|
| `test_tts_ws_streaming.py::test_tts_ws_streams_short_banter_continuous_audio` | ~$0.001 |
| `test_tts_ws_streaming.py::test_tts_ws_streams_long_rendition_continuous_audio` | ~$0.002 |
| `test_tts_ws_streaming.py::test_tts_ws_handles_empty_no_more_inputs` | <$0.001 |
| `test_api_reachability.py::test_voices_endpoint_returns_newsman` | $0 (read endpoint) |
| `test_api_reachability.py::test_tts_bytes_endpoint_returns_mp3` | ~$0.001 |
| `test_ink_stt.py::test_ink_transcribes_aac_voice_note` (first run) | ~$0.003 (TTS for fixture + Ink) |
| `test_ink_stt.py::test_ink_transcribes_aac_voice_note` (subsequent) | ~$0.001 (Ink only — fixture cached) |
| `test_ink_stt.py::test_ink_via_sdk` | ~$0.001 |

**Total first run: ~$0.01. Cached subsequent runs: ~$0.006.**

These are rough estimates — Cartesia bills on character counts (TTS)
and audio duration (Ink/STT). Newsman voice + sonic-2 at the
shortest transcripts each test uses.

### Fixture cache

`test_ink_stt.py` generates a 2-second AAC/ADTS voice-note fixture
into `tests/fixtures/voicenote-2s.aac` on first run. Subsequent
runs reuse it (saves the per-run TTS spend). The fixture is
gitignored — see `tests/fixtures/.gitignore` — to avoid
committing synthesized audio.

If you need to regenerate, just delete the file.

### What these tests do NOT cover

- **Real phone-call end-to-end.** No test here makes Cartesia connect
  back to voice-transport over its hosted-agent harness. That's
  verified by a manual call to `+15550100000` after Stage 5 deploy.
- **TTS WS audio → Calls WS audio splice.** The original Stage 0
  spike's "splice spike" was authorized to skip because `main.py`
  does NOT use the TTS WS context at all — it relies on Cartesia's
  hosted agent harness for TTS via `MessageOutput` frames. The
  splice path would only be needed if we went the "voice-transport
  opens its own Cartesia Calls WS" route from `cartesia-rethink.md`,
  which we didn't.
- **Barge-in audio cancellation timing.** Requires real audio
  pipeline; verify with a phone call.

### Re-running just one test

```
CARTESIA_API_KEY=sk-... uv run pytest tests/real_cartesia/test_tts_ws_streaming.py::test_tts_ws_streams_short_banter_continuous_audio -v -s
```

The `-s` flag is important — informational latency numbers print to
stdout, useful for runbook tuning.
