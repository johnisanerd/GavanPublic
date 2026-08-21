# transports

External-provider bridges for the `pat-transports` Fly app:

- **cartesia** — Cartesia hosted-agent WS forwarder (this directory's `main.py`)
- **signal** — signal-cli JSON-RPC daemon (this directory's `signal-cli/`)

Both run as Fly process groups sharing one polyglot image (`Dockerfile`).

## Cartesia bridge — how it fits

```
caller (PSTN / browser WebRTC)
  │
  ▼
Cartesia Calls API ─────────► main.py (this package)
                                 │
                                 │  POST /inbound  (user utterance → NanoClaw)
                                 │  SSE /outbound  (NanoClaw → utterances to TTS)
                                 ▼
                 NanoClaw realtime channel (port 8765)
```

The bridge does no LLM work itself — it's a thin pass-through. All cognition is in NanoClaw + the realtime library. Implements `plans/streaming-banter-pipeline.md` Stage 3: utterance-delta SSE events from NanoClaw → one `MessageOutput` WS frame per delta, all tagged with the same `responding_to` for Cartesia-side cancel correlation and TTS prosody continuity.

The cartesia process is Python because the Cartesia Line SDK we depend on for the WS protocol shapes is Python-only. Everything else in PAT is TypeScript.

## Run

```bash
uv sync
uv run python main.py            # local dev: serves /v1/calls/ws on PORT (default 8000)
```

## Env

| Var | Default | Notes |
|-----|---------|-------|
| `REALTIME_BASE_URL` | `http://127.0.0.1:8765` | NanoClaw realtime channel HTTP endpoint |
| `ANTHROPIC_API_KEY` | — | Not used here — we don't call Claude |
| `VOICE_TRANSPORT_WS_PATH` | `/v1/calls/ws` | WebSocket path Cartesia connects to |
| `PORT` | `8000` | FastAPI listen port |

Path A semantics (one WS frame per Haiku token delta) require NanoClaw running with `PAT_STREAMING_BANTER=1`. Without the flag, NanoClaw emits legacy `realtime-utterance`/`chat` events and `main.py` routes those to a single `MessageOutput` per turn.

See `plans/streaming-banter-pipeline.md` Section 4 for the wire protocol.

## Cartesia / Line SDK gotchas

Empirical, non-obvious things that bit us. This bridge is a raw WS forwarder — it does **not** use the Line SDK's `AgentClass` / `process()` / `run_filter` / tool-decorator turn abstraction, so SDK-turn gotchas (`loopback_tool` vs `passthrough_tool`, `run_filter` event filtering, the back-mind turn-drain / `BACK_MIND_TIMEOUT` off-by-one) no longer apply here.

- **Self-hosted agents don't appear in Cartesia's call ledger.** `cartesia calls ls` and `GET /agents/calls` return empty for any agent with a `self_hosted_deployment_url`. Diagnose calls via `patobs` / this bridge's own structured events — never Cartesia's API.
- **Point the agent at self-hosted code with `cartesia connect --agent-id X --url Y`** — there is no `cartesia agents update`. PATCHing `self_hosted_deployment_url` alone leaves `is_live` unreliable (verify by actually opening the WS). Cartesia stores the URL scheme-stripped (`host/path`, no `https://`) — that's expected.
- **`httpx_sse` has no `aiter_sse`.** Use `aconnect_sse(client, "GET", url)` then `event_source.aiter_sse()` (see `_outbound_loop`).
- **Cartesia doesn't auto-greet.** The bridge speaks an immediate greeting on call start, else the caller hits silence while the SSE subscription warms up.
- **Browser → managed-agent WS auth** (pat-web's concern, not this bridge, but the same `cartesia_version` the `/chats` handshake returns): browsers can't set WS headers, so pass BOTH `?access_token=<jwt>&cartesia_version=<ver>` as query params. It's snake_case `cartesia_version`; the `Cartesia-Version` header name fails as a query param. Missing version → WS close code 1006 (looks like a plain network error).
- **Access-token grant key is `agent` (singular)**, not `agents` — the wrong key fails silently with "must be logged in".
- **Sonic 3 TTS reads ALL-CAPS letter-by-letter** ("PAT" → "P-A-T"): use mixed case ("Pat") for anything spoken. Inline SSML for prosody: `<break time="500ms"/>`, `<emotion value="…"/>`, `<speed ratio="…"/>`, `<volume ratio="…"/>`, `[laughter]`. No SFX/beep tokens — the agent can only emit spoken text or DTMF, never raw audio, so cues must be inline markup.

## Signal daemon

`signal-cli/entrypoint.sh` runs `signal-cli` as a JSON-RPC daemon bound to `0.0.0.0:7583` for the `signal` process group. Only sibling Fly apps in the org reach it via 6PN (`signal.process.pat-transports.internal:7583`). State lives on the `pat_signal_state` volume. See `reference_pat_signal_deploy.md` for the deploy sequence.
