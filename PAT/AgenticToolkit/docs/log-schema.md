# Structured logs — schema, endpoints, recipes

Every PAT process emits structured JSONL via `log.event(...)` (TypeScript)
or `_emit_structured(...)` (Python). All emits land in nanoclaw's
persistent host log under `data/logs/host-YYYY-MM-DD.jsonl` (one file per
UTC day, rotated daily).

Schema source of truth: `realtime/src/log-events.ts`. Mirrors live in
`transports/log_events.py` (drift test enforced) and
`pat-frontend/src/types/log-events.ts` (no automated drift, but the
exhaustive renderer switch fails loud at compile time).

## Canonical query surface

To *find and read* these events, don't hit the host endpoints directly. Use, in
order:

1. **`patobs` (canonical, aggregated).** The centralized OpenObserve store — the
   `patobs` MCP (`query` / `schema` / `resolve_person`) or the CLI
   `../pat-observability/scripts/patobs` (sibling repo) — runs SQL over two
   streams and holds **both prod AND staging** (`env` column), with full debug
   including `llm.call` prompt/response traces the per-instance proxy can't
   answer. Nested `data.*` is flattened to `data_*`; use the `schema` tool if
   unsure of columns.

   ```sql
   -- pat_events: structured nanoclaw events (this schema), prod+staging
   SELECT ts, kind, source, level FROM pat_events
     WHERE env='staging' AND thread_id='<id>' ORDER BY _timestamp
   -- the agent's actual prompt/response for a session
   SELECT * FROM pat_events WHERE kind='llm.call' AND session_id='<sess>'
   -- pat_raw: raw stdout/stderr of pat-* apps
   SELECT ts, app, message FROM pat_raw WHERE app='pat-transports' AND message LIKE '%...%'
   ```

2. **`scripts/pat-trace.py` (single-call timeline).** The rendered, interrupt-aware
   ASCII timeline of ONE thread (overlap/orphan/gap markers, latency, tool +
   narration interleave). A presentation layer over pat-frontend's proxy — not the
   source of truth. Set `PAT_FRONTEND=https://pat-frontend-staging.fly.dev` for staging.

3. **The `/pat-logs` skill** encodes this full tiered procedure — invoke it for any
   "what happened on that call / turn" forensics question.

The `/admin/logs.*` endpoints below are the **underlying host API** that pat-frontend
and the observability forwarder read from — reach for them only for local-dev against
a single nanoclaw instance, or as a last resort when `patobs` is unreachable.

## Wire format

Every entry has the same top-level shape:

```json
{
  "ts": "2026-05-08T20:24:29.213Z",
  "source": "nanoclaw-host" | "agent-runner" | "voice-transport" | "host" | "pat-web-browser",
  "kind": "<area>.<event>",
  "level": "debug" | "info" | "warn" | "error" | "fatal",
  "id": "<src-prefix>-<process-start-ms>-<counter>",
  "thread_id": "...",
  "session_id": "...",
  "data": { /* kind-specific payload */ }
}
```

`source` values (`LogSource` in `realtime/src/log-events.ts`): `nanoclaw-host`
(realtime channel adapter + realtime library), `agent-runner` (container-side
back-mind tool calls), `voice-transport` (Cartesia bridge), `host` (host-process
machinery), `pat-web-browser` (in-browser RTT signals forwarded through pat-web's
Hono server to nanoclaw `/admin/log-event`). `level` values: `debug` (excluded by
default from `/admin/logs.jsonl` reads — e.g. `capability.*`, `deliver-chat.step`),
then `info` (default) / `warn` / `error` / `fatal`.

Required fields: `ts`, `source`, `kind`. `level` defaults to `info`.
`thread_id` / `session_id` (and other ids the system has standardized on)
are top-level so consumers can filter without diving into `data`. Per-kind
payload schemas live alongside the kind declarations in
`realtime/src/log-events.ts`.

### Vendor namespace

Kinds triggered by an **external SDK / hosted service** we observe use
`<vendor>.<event>` (`VENDORS = ['cartesia', 'apify']`; `vendorOf(kind)` in
`log-events.ts`). This is **orthogonal to `source`**: `source` = which of *our*
processes emitted; `vendor` = whether the trigger came from an external SDK.
Our own decisions keep flat names (`call.started`, `tts.agent-said`,
`stt.user-said`). `transports/main.py` is a thin Cartesia-WS forwarder that tees
each inbound Cartesia wire message into a `cartesia.*` event inline (e.g.
`cartesia.user-text-sent`, `cartesia.agent-turn-boundary`,
`cartesia.task-cancelled`). (It no longer monkey-patches the Line SDK's
`ConversationRunner` — that mechanism was replaced by the direct forwarder.)

### Server-stamped event id

`id` = `<src-prefix>-<process-start-ms>-<counter>` (e.g. `nch-…-948`,
`vtA-…-3`). The `(process-start-ms, counter)` pair is globally unique across
process restarts (start-ms differs), threads/sessions (counter is process-wide),
and sources (prefix differs). Preserved end-to-end: the `/admin/log-event`
forwarder passes `payload.id` through rather than re-stamping (`log.ts` `id`
override), and pat-frontend dedupes on `rec.id` directly (`use-event-buffer.ts`),
falling back to a JSON-content key for pre-id legacy rows.

## Underlying host API (local-dev / last-resort)

The `/admin/logs.*` endpoints are the host surface that `patobs`'s forwarder and
pat-frontend read from. Prefer the canonical query surface above; hit these
directly only for local-dev against a single nanoclaw instance or when `patobs`
is down. Two endpoints, both served by the nanoclaw host process on port 8765:

| Endpoint | Method | Purpose | Notes |
|----------|--------|---------|-------|
| `/admin/logs.jsonl` | GET | One-shot slice of the on-disk day file | Streams `application/x-ndjson`. Defaults to today UTC. |
| `/admin/logs.tail` | GET | Server-Sent Events live stream | New events as they're emitted; no backlog by default. |

Query params:

- `/admin/logs.jsonl`:
  - `date=YYYY-MM-DD` — UTC day to read. Defaults to today. 404 if no file.
  - `since=<ms>` — filter `ts >= since` (ms since epoch).
  - `until=<ms>` — filter `ts <= until`.
- `/admin/logs.tail`:
  - `since=<ms>` — replay backlog from this wall-clock-ms forward, then live-tail.

Per-call slice (written when `/call-ended` fires):

- `GET /admin/sessions/<id>/host-log.jsonl` — just that call's lines.

Peer-process ingress:

- `POST /admin/log-event` — voice-transport (and future sibling processes)
  post structured events here so they land in the same JSONL file.

## Auth

`Authorization: Bearer $PAT_ADMIN_TOKEN` for direct access. If
`PAT_ADMIN_TOKEN` is unset on the server, endpoints are open (assumes
private network). Token lives in `.env.agent`.

The pat-frontend Hono app also proxies `/api/logs.tail` (only — no jsonl
proxy) using `?token=$PAT_VIEWER_TOKEN`. Use this when accessing from
outside Fly's private network. JSONL slicing has no proxy and must be hit
directly.

## How to reach nanoclaw

| Where you're calling from | How to reach it |
|---------------------------|-----------------|
| Inside Fly org (sibling apps, voice-transport) | `http://pat-nanoclaw.internal:8765` (6PN direct; `.flycast` doesn't work — pat-nanoclaw has no `[[services.ports]]` block) |
| Local dev box, talking to staging | `flyctl ssh console -a pat-nanoclaw -C "curl …"` or open a flyctl proxy: `flyctl proxy -a pat-nanoclaw 8765:8765` then hit `http://127.0.0.1:8765` |
| Local dev box, local nanoclaw | `http://127.0.0.1:8765` directly |

## Recipes

**One-shot today's logs, today only, this thread**:

```bash
TOKEN="$(grep ^PAT_ADMIN_TOKEN= .env.agent | cut -d= -f2-)"
flyctl proxy -a pat-nanoclaw 8765:8765 &        # or curl from a sibling app
curl -sH "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:8765/admin/logs.jsonl" \
  | jq -c 'select(.thread_id == "call-7af3b2")'
```

**Slice the last 5 minutes**:

```bash
SINCE=$(($(date +%s%3N) - 300000))
curl -sH "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:8765/admin/logs.jsonl?since=$SINCE"
```

**Filter by kind via jq** (the universal slicer — never regex `data` strings):

```bash
# All tool calls (back-mind detail rows)
... | jq -c 'select(.kind == "detail.row-received" and (.data.type | startswith("tool-")))'

# Just the Bash commands
... | jq -c 'select(.kind == "detail.row-received" and .data.type == "tool-pre" and .data.tool == "Bash") | {ts, cmd: .data.input.command}'

# TTS state transitions in order
... | jq -c 'select(.kind == "tts.busy-marked" or .kind == "tts.turn-ended") | {ts, kind, thread: .thread_id}'

# Errors and warnings only
... | jq -c 'select(.level == "warn" or .level == "error" or .level == "fatal")'

# All forward decisions today
jq 'select(.kind == "request-layer.decided" and .data.decision == "forward")' host-2026-05-07.jsonl

# What a specific call did
jq 'select(.thread_id == "call-c5a3561d5c51")' host-2026-05-07.jsonl

# Just narrator firings, with timestamps and utterances
jq 'select(.kind == "narrator.fired") | {ts, text: .data.utterance}' host-2026-05-07.jsonl
```

**Live tail with kind filter**:

```bash
curl -sH "Authorization: Bearer $TOKEN" \
  -N "http://127.0.0.1:8765/admin/logs.tail" \
  | sed -nE 's/^data: //p' \
  | jq -c 'select(.kind == "chat.row-received")'
```

The `sed` strips SSE framing (`data: ` prefix); each remaining line is one
JSON event.

## Existing tools that already do this

- `scripts/fly-call-log.py` — pulls a slice via `/admin/logs.jsonl` and
  renders per-call analyses.
- `pat-frontend` (Fly app) — full dashboard view; click any event for raw
  JSON.
- Ad-hoc: `curl /admin/logs.tail | sed -nE 's/^data: //p' | jq` for live
  tail; `curl /admin/logs.jsonl?since=…` for slices.

## Don'ts

- Don't grep the `msg` string to find an event kind. Dispatch on `.kind`.
- Don't introduce a new `kind` without adding it to
  `realtime/src/log-events.ts` AND the Python mirror. The drift test will
  fail otherwise.
- Don't read `data.field` without first checking `.kind` — the schema is
  per-kind and a field that exists on `tool-post` will be undefined on
  `tool-pre`.
- Don't truncate fields at emit time. JSON gzips well; truncation kills
  forensic value. Truncate at *display* time in human-facing tools.
- Don't put queryable data in the message string (`"banter took 850ms"`).
  Put it in `data` (`{latency_ms: 850}`).
