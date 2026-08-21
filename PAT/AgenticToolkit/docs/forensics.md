# Forensics — Pipeline Map & "Where Do I Look When X Breaks"

PAT (Palisade Agentic Toolkit) is a real-time voice/chat interface layered on
NanoClaw v2. This file is the "where do I look when X breaks" cheat-sheet.

For mission and conventions see `../AGENTS.md`. For the structured-log wire
format see `log-schema.md`. For NanoClaw v2 internals see
`../nanoclaw/CLAUDE.md` and `../nanoclaw/docs/`.

## Where to look, in order

For **any** "what happened on that call / turn", "why did Pat say X", "is this
happening right now" question, follow this tiered order — the `/pat-logs` skill
encodes the full procedure:

1. **`patobs` — the canonical, aggregated store (FIRST).** Centralized
   OpenObserve; SQL over structured events from **both prod and staging**
   (`env` column), including full debug and `llm.call` prompt/response traces.
   See "Canonical query surface" below.
2. **`scripts/pat-trace.py` — the rendered timeline of ONE call (SECOND).** An
   interrupt-aware ASCII picture of a single thread. A presentation layer, not
   the source of truth.
3. **`/admin/logs.*` + `flyctl logs` — local-dev / last resort (LAST).** The
   underlying host log surface and the raw rolling Fly buffer. See "Local-dev /
   last-resort surfaces" near the bottom. Reach for these only when `patobs` is
   unreachable, or for a non-PAT process whose stdout isn't shipped to `pat_raw`.

## Pipeline shape

```
                                                                   prod realtime channel
                                                                   ───────────────────────
phone     Cartesia              cloudflared        voice-transport          nanoclaw host                 per-session container
caller →  Line agent       →    quick tunnel  →    main.py            →    src/index.ts           →      docker run nanoclaw-agent
          (PSTN/SIP/WS)         :8000              :8000                   :8765                          (back-mind)
                                                       │                       │                              │
                                                       │  POST /inbound        │                              │
                                                       │ ─────────────────►    │                              │
                                                       │                       │  banter (front-mind) →       │
                                                       │                       │  request layer →             │
                                                       │                       │    forward decision     ─►  inbound.db
                                                       │                       │                              │ container polls
                                                       │                       │                              │ back-mind generates
                                                       │                       │   outbound.db  ◄─────────────┘
                                                       │                       │   ▲ poll
                                                       │                       │   │ chat row
                                                       │ ◄── SSE /outbound ────┤   │ → render through banter
                                                       │   realtime-utterance  │   │ → broadcast SSE
                                                       │   chat                ◄───┘
                                                       │   trace
                                                       │
                                                       └─ AgentSendText into Cartesia → TTS → caller
```

The two cognitive layers (banter "front-mind" + back-mind) and the chat→banter
rendition step run **on the host**, not in the container. Container only does
back-mind work.

## Canonical query surface — `patobs`

`patobs` is the **canonical, aggregated** forensics store. It runs SQL over
OpenObserve and holds structured events from **both prod AND staging** (`env`
column) with **full debug incl. `llm.call` prompt/response traces** — so it
answers agent-reasoning questions the per-instance host log can't, in one query
across envs.

Two ways in:

- **`patobs` MCP** — tools `query` / `schema` / `resolve_person`.
- **CLI** — `../pat-observability/scripts/patobs` (sibling repo).

Two streams:

- **`pat_events`** — structured nanoclaw events (prod+staging).
- **`pat_raw`** — raw stdout/stderr of the `pat-*` apps.

```sql
-- Everything on one thread, chronological
SELECT ts, kind, source, level FROM pat_events
  WHERE env='staging' AND thread_id='<id>' ORDER BY _timestamp

-- The agent's actual prompt/response for a session
SELECT * FROM pat_events WHERE kind='llm.call' AND session_id='<sess>'

-- Raw app stdout by substring
SELECT ts, app, message FROM pat_raw
  WHERE app='pat-transports' AND message LIKE '%...%'
```

Use the `schema` tool if unsure of columns; nested `data.*` is flattened to
`data_*`. `resolve_person` maps an inbound sender to the canonical Person.

## Tracing one call — `scripts/pat-trace.py`

`scripts/pat-trace.py` is the **rendered-timeline** view of ONE call — an
interrupt-aware ASCII timeline (overlap/orphan/gap markers, source-coded
utterances, latency, tool/narration interleave). Reach for it when you want
that picture of a specific thread.

```bash
# Prod:
uv run scripts/pat-trace.py <thread-id>

# Staging (point it at the staging proxy):
PAT_FRONTEND=https://pat-frontend-staging.fly.dev uv run scripts/pat-trace.py <thread-id>
```

It reads pat-frontend's proxy — a presentation layer, not the source of truth.
`patobs` is authoritative; use pat-trace for the picture.

## Log files — what's where (underlying sources)

These are the raw sources `patobs` and pat-frontend aggregate. Read them
directly only when you're on the host, or debugging the pipeline itself.

| File | Source | Format | What it shows |
|---|---|---|---|
| `/private/tmp/nanoclaw-boot.log` | nanoclaw host (`pnpm run dev`) | `[ISO_UTC] LEVEL message k=v ...` | inbound POSTs, banter/request-layer decisions, narration brain calls, chat→banter rendition (full text), SSE client connect/disconnect, deliver, narration broadcasts. **Primary host log.** |
| `/private/tmp/voice-transport.log` | voice-transport (Python) | `ISO_UTC LEVEL name message` (stdlib logging) and `ISO_UTC LEVEL line.voice_agent_app:func:line message` (Loguru) | Cartesia events (Call started/ended, user/agent speaking, word-by-word), SSE connect/event-received, consumer awaiting/yielding. **Primary bridge log.** |
| `nanoclaw/data/v2-sessions/<ag>/<sess>/inbound.db` | host (writer) → container (reader) | SQLite, `messages_in.timestamp` UTC | Routed inbound rows: kind=banter\|chat, content (JSON with text + sender). |
| `nanoclaw/data/v2-sessions/<ag>/<sess>/outbound.db` | container (writer) → host (reader) | SQLite, `messages_out.timestamp` UTC | Back-mind output rows: kind=detail (token deltas, tool-pre/post, tool-failed) and kind=chat (final reply). **Authoritative source for back-mind raw text.** |
| `docker logs <container>` | per-session container | bun-run, no timestamps | Agent-runner poll loop, raw provider events. **Ephemeral** — gone when container exits (`--rm`). Capture during the call if you need it. |
| `nanoclaw/logs/setup.log`, `nanoclaw/logs/setup-steps/*.log` | setup wrapper | per-step | Only relevant during `nanoclaw.sh` setup. |

All four primary sources use **UTC ISO 8601 timestamps** (post May 5 2026
stamping pass). Lex sort works.

Every nanoclaw emit also appends to a durable JSONL file on the volume:

| File | Format | What it shows |
|---|---|---|
| `/data/nanoclaw/data/logs/host-YYYY-MM-DD.jsonl` (Fly) or `nanoclaw/data/logs/host-YYYY-MM-DD.jsonl` (local) | structured JSONL — `{ts, source, kind, level, thread_id?, session_id?, platform_id?, data}` | Every host log line, durable forever. Schema in `realtime/src/log-events.ts`. |
| `<session-dir>/host-log.jsonl` | same structured JSONL | Per-call slice, written when `/call-ended` fires. Just that call's lines. |

## Where to look for what

| Question | Look here |
|---|---|
| "Did the user's audio reach voice-transport?" | vt log `🧑🗣️ User said: "..."` |
| "Did voice-transport POST to nanoclaw?" | vt log `User turn ended → POST /inbound: 'X'`, also nano log `inbound POST text="X"` |
| "What did the banter (front-mind) layer decide?" | nano log `inbound: banter layer text="..." silent=...` |
| "What did the request layer decide?" | nano log `inbound: request layer decision decision=... reason="..."` |
| "Did a session/container exist or was one spawned?" | nano log `Spawning container ...` or `agent-runner Resuming agent session ...` (in `docker logs`) |
| "What did the back-mind actually produce?" | `outbound.db.messages_out` rows where kind='chat'. **Raw, unrendered.** Full text. |
| "What did banter rendition turn the back-mind chat into?" | nano log `chat → banter rendition` — logs full `userText`, `rawText`, `renderedText`. (Not yet persisted to DB; in-memory only after delivery.) |
| "Did SSE deliver the rendition to voice-transport?" | nano log `Message delivered ... channelType=realtime`; vt log `SSE event: kind=chat text='...'` |
| "Did Cartesia speak it?" | vt log `<- 🤖🗣️ Agent said: "..."` then `🤖🔊 Agent started speaking` and per-word `🤖🗣️ Agent said: "word"` |
| "Was an SSE client connected when something broadcast?" | nano log `SSE client connected`, `SSE client disconnected`, `SSE drop: no clients for ...` warnings |
| "Was the narration brain firing?" | nano log `narration[sess-...]: model call: start events=[...]` and `model call: result utterance=...` |
| "Did the front-mind fail (banter or request layer fallback)?" | nano log `inbound: banter layer text="hmm, my front-mind isn't quite there..." silent=true` and/or `request layer decision decision="silent" reason="no API key"` (real failure mode = `.env` not loaded) |

## Front-mind / back-mind responsibilities (quick reference)

Roles, not vendors — models are chosen in config, not hardcoded here. Prod's
fast tier (banter + request + narration) runs on **Cerebras `zai-glm-4.7`** via
the official SDK (`realtime/src/llm-provider.ts`, `reasoning_effort='none'`);
the back-mind runs the container agent's own model.

| Layer | Role | Where |
|---|---|---|
| Banter (front-mind voice) | Reflexive ack of user turn ("yeah, lemme pull that up"), and **re-renders back-mind chat into Pat's voice** before TTS | `realtime/src/banter.ts` |
| Request layer | Decides `forward / noop / silent` — whether the back-mind needs to act | `realtime/src/request-layer.ts` |
| Narration brain | Watches detail rows during back-mind work, emits filler ("running diagnostic now") | `realtime/src/narration.ts` |
| Back-mind | Actual work / answers — runs in per-session Docker container | `nanoclaw/container/agent-runner/` |

Banter is the **only voice the user hears** — every back-mind chat goes
through `bantererRenderBackMindResult` first. If rendition fails, raw
back-mind text is delivered as a fallback (clunkier but never silent).

## Session model — how DBs map to calls

NanoClaw sessions are keyed by `(agent_group_id, messaging_group_id, thread_id)`.
For prod realtime today voice-transport sends `threadId=null`, so **every
phone call shares one session** and `outbound.db` accumulates all calls'
chat/detail rows. Per-call thread isolation is in the backlog — when wired,
each call will get its own `sess-<id>/` folder.

## Local-dev / last-resort surfaces

The host exposes the raw JSONL over HTTP (token-protected on Fly, internal-only)
and `scripts/fly-call-log.py` wraps it. These are the **underlying host
surface** — `patobs` aggregates the same data across envs, so prefer it. Reach
here only when `patobs` is unreachable, or when you're on the host and want the
raw slice.

**HTTP endpoints:**
- `GET /admin/logs.jsonl?date=YYYY-MM-DD&since=<ms>&until=<ms>` — slice of the day file
- `GET /admin/logs.tail` — Server-Sent Events stream, sub-second lag
- `GET /admin/sessions/<id>/host-log.jsonl` — per-call slice
- `POST /admin/log-event` — peer transports (voice-transport, future) post structured events here

**Ad-hoc CLI (after `flyctl proxy -a pat-nanoclaw 8765:8765`):**

```bash
TOKEN="$(grep ^PAT_ADMIN_TOKEN= .env.agent | cut -d= -f2-)"

# Whole day, all sources, chronological:
curl -sH "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:8765/admin/logs.jsonl" | jq -c '.' | less

# Last 10 minutes:
SINCE=$(($(date +%s%3N) - 600000))
curl -sH "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:8765/admin/logs.jsonl?since=$SINCE" | jq -c '.' | less

# One specific call (thread_id):
curl -sH "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:8765/admin/logs.jsonl" \
  | jq -c 'select(.thread_id == "call-7af3b2")'

# Live tail (SSE):
curl -sH "Authorization: Bearer $TOKEN" -N \
  http://127.0.0.1:8765/admin/logs.tail | sed -nE 's/^data: //p' | jq -c '.'
```

`scripts/fly-call-log.py` wraps this with sensible defaults and writes a
`transcript.json` consumable by `test-viewer`. Source identifiers stay stable
across the wire (`nanoclaw-host`, `voice-transport`, `agent-runner`); filter
with `jq 'select(.source == "voice-transport")'`.

`flyctl logs --no-tail` is the final fallback — a rolling buffer with hours/days
of unrelated history (has caused false "user is on a call now" claims), past-
retention drops, and hand-grepping. Use only for a non-PAT process whose stdout
isn't shipped to `pat_raw`.

## Known forensic gaps (open backlog items)

- Rendered chat text isn't persisted in `outbound.db` (only in the host log
  line). If host process is restarted between rendition and post-mortem,
  the rendered text is gone. *Workaround:* read recent nano log directly.
- No correlation ID linking inbound row → request-layer decision → back-mind
  chat row → rendition. Today you join by timestamp + session. Backlog:
  `in_reply_to` correlation.
- Container stdout (`docker logs`) is lost when the container exits. To keep
  it, attach `docker logs -f <name>` during the call.
- Per-call thread isolation not yet wired (see backlog) → all phone calls
  share one session DB.
