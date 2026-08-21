# @agentic-toolkit/realtime

Front-mind / back-mind realtime library — the fast conversational layer that
rides on top of a NanoClaw back-mind. Implements the spec at
`../docs/front-mind-design.md`. Fully implemented and live in prod (PSTN phone
calls + anam-web avatar); the two channel adapters (`nanoclaw/src/channels/`)
are thin transports around the pieces here.

## Architecture

Two cognitive layers over one NanoClaw session:

- **Front-mind (fast tier)** — responds to every user message in the moment.
  `banter.ts` always speaks (personality + voice, no waiting for a routing
  decision); `request-layer.ts` runs *after* banter and decides whether the
  user crossed from chit-chat into an actionable request that needs the
  back-mind woken. The request layer never speaks to the user directly — any
  clarifying speech is cued back through the banter layer.
- **Back-mind (NanoClaw container)** — does the real work. The realtime library
  never runs it; it reads the back-mind's `outbound.db` detail rows and folds
  them into state / narration.

### Front-mind

- `banter.ts` — the always-on banter layer. Wraps the `banter-ack` /
  `banter-render` / `banter-narration` prompts and the shared per-thread
  conversation history. Fails soft: after `MAX_CONSECUTIVE_FAILURES` it goes
  silent rather than emitting garbage.
- `request-layer.ts` — the "is this a request?" classifier. Outcomes: `noop`
  (still banter) or `forward` (write a chat row, wake the back-mind); emits a
  `clarifyHint` for the orchestrator to re-invoke banter when banter's answer
  was inadequate.
- `llm-provider.ts` — fast-tier provider abstraction sitting between the four
  front-mind call sites and the model API. Slug-prefix routing selects the
  impl: `anthropic/*` → Anthropic SDK, `cerebras/*` → Cerebras SDK,
  everything else → OpenRouter (Groq backend). Per-layer overrides
  (`BANTER_ACK_MODEL`, `NARRATION_MODEL`, …) fall back to global `FAST_MODEL`.
  **Prod fast-tier = Cerebras `zai-glm-4.7` via the official SDK with
  `reasoning_effort='none'`.**
- `fast-llm-keepalive.ts` — 1-token throwaway completion every ~3s while a
  session is active, to keep the TLS socket warm across the 8-15s inter-turn
  gap (Node's undici closes idle keep-alive sockets after ~4s, so without this
  most turns pay a fresh handshake).
- `conversation-history.ts` — per-thread unified history shared across the
  banter call sites.
- `prompts/` — one file per call site (`banter-ack`, `banter-render`,
  `banter-narration`, `request-layer`, `error-surfacing`) plus composable
  `_`-prefixed partials (identity, voice, architecture, capability/scenario
  context, voice-tags, example transcript).

### Channel orchestration

- `channel-orchestrator.ts` — owns the state carriers and the inbound loop
  invariant across channels. `handleUserMessage` = push user text → banter-ack
  → push pat text → request-layer decide → forward (host callback) or
  buffer-banter. It owns per-thread `TtsBusyTracker`, `StreamingControllers`,
  `ConversationHistory`, `BanterBroadcast`, the back-mind processing flag, and
  the buffered-banter ring.
- `host-adapter.ts` — the minimal `HostAdapter` interface the orchestrator asks
  of its host (structured-log emit, etc.). The orchestrator never imports
  `nanoclaw/*`; everything host-side goes through this interface.
- `banter-dispatch.ts` — per-`<say>` Pat-voice rewrite for `<timeline>`
  scenarios: each authored spoken beat is re-voiced (with inline emotion/pause
  tags) before TTS, preserving meaning and every precise claim.
- `banter-broadcast.ts` — in-memory SSE fanout for streaming channels. Emits
  `utterance.stream-{started,delta,ended,cancelled}` to a session-scoped
  subscriber set with a bounded backlog for reconnect-replay (Last-Event-Id).
- `tts-busy.ts` — per-thread TTS-busy tracker fed by transport "agent finished
  speaking" signals. The narrator gates on `isBusy()` / cadences off
  `getLastEndedAt()` instead of a `len(text)/chars-per-sec` projection.
- `streaming-controllers.ts` — per-thread abort/streaming plumbing.

### Back-mind observation & narration

- `nanoclaw-client.ts` — the **only** file that knows NanoClaw's storage layout,
  schemas, and row conventions (`data/v2-sessions/<agent_group>/<session>/`,
  `NANOCLAW_DATA_ROOT` override). Everything else imports from here.
- `state.ts` — deterministic, idempotent fold of the detail-row stream
  (tool-pre / tool-post / tool-failed / token-delta / compact) into a
  `BackMindState` snapshot of what the back-mind is doing.
- `narration.ts` / `narration-manager.ts` — the Narrator brain that turns
  back-mind detail rows into spoken utterances. `NarrationManager` is a
  per-channel poll loop (one `Narrator` per session), applies cadence rules,
  emits `detail.row-received` for the dashboard timeline, flips the processing
  flag on `query-end`, synthesizes `apify.run-completed`, and surfaces tool
  failures.
- `error-surfacing.ts` — decides whether/how a tool failure gets spoken.

### Presenter / scenario tag stream

- `tag-stream-parser.ts` — streaming XML-ish tag parser over back-mind chat
  text (open/close/text/selfClose events).
- `scenario-action-stream.ts` — interprets that tag stream into digested
  `ScenarioAction` events (prose coalescing, `tool_*` tags, Cartesia native
  tags passed through, timeline action-domain registry lookup, unknown-tag
  passthrough). See `plans/presenter-tag-stream.md`.
- `timeline/` — the action-domain registry, sequencer, queue, and events that
  back the scenario/presenter runtime. See `../realtime/TIMELINE.md`.

### Instrumentation

- `log-events.ts` — **schema source of truth** for the structured JSONL emitted
  across all PAT processes (mirrored in `transports/log_events.py` and
  `pat-frontend/src/types/log-events.ts`; drift test enforced).
- `llm-http-instrumentation.ts` — wraps fast-LLM HTTP calls for timing /
  connection-reuse / `llm.call` traces.
- `bash-parse.ts` — parses Bash tool-call detail rows for the timeline.

## Running

```
pnpm install
pnpm dev         # tsx src/index.ts
pnpm typecheck
pnpm test        # vitest, excludes *.live.test.ts
pnpm test:live   # narration + request-layer live-model tests (hit real APIs)
pnpm test:all
```

## Notes

- `nanoclaw-client.ts` knows where session DBs live (the
  `data/v2-sessions/<agent_group>/<session>/` path under the NanoClaw install).
  All schema details and `query.push` semantics live there. Other files import
  only from `nanoclaw-client`, never from NanoClaw internals directly.
- Front-mind utterances are written to NanoClaw's `inbound.db` as `kind='banter'`
  rows with `sender='realtime-agent'` (per design doc §"Single input path"). The
  library never writes to `outbound.db` — single-writer-per-file invariant, the
  container owns it.
