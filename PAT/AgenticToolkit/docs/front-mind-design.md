# Front-Mind Design

A two-layer cognitive architecture for high-responsiveness conversational interfaces. Models the agent as a single entity with two cognitive modes — a default conversational mode that's always available, and a thinking mode regularly invoked whenever cognition or action is required.

The pattern is conceptually similar to frontend/backend separation in web development. The front-mind handles immediate interaction the way a frontend handles optimistic UI updates and reflexive feedback — it makes the experience feel responsive even when nothing has been confirmed yet. The back-mind does the actual work the way a backend does — the database write, the API call, the deliberate operation that has to happen for anything to really get done. Both layers belong to the same system; the user's experience of "the app" or "the agent" is the integrated whole.

## Problem

A capable model takes seconds-to-minutes per turn. A user-facing channel (voice, avatar, real-time chat) needs sub-second responsiveness across a wider behavior surface than just "say something while we wait." The user expects to interject, ask status, change direction, or simply hear an acknowledgment with the cadence of a normal conversation — not the cadence of an LLM round-trip.

Routing every utterance to the capable model breaks responsiveness. Treating the fast layer as pure filler is also wrong — it leaves the slow brain handling questions like "how far are we?" and "what'd you find so far?" that should be answered immediately from accumulated awareness.

The right shape is one entity that can talk in real time without thinking too hard, and that thinks when the input demands it.

## The mental model

There is one agent. The user is always talking to the same entity. The agent has two cognitive layers:

- **Front-mind** — the agent's default conversational layer. Fast, lightweight model. Operates from working memory and conversational reflex. Always available; never blocked.
- **Back-mind** — the agent's deliberate cognitive layer. A more capable model, invoked when reflexive response isn't enough. Slower. Used for reasoning, computation, factual recall, novel synthesis, action, and complex summarization or analysis over long conversational state.

The front-mind is the agent's surface. The back-mind is the agent's depth. Both belong to the same agent. There is no handoff narrative, no colleague — when the agent needs to think, it pauses, thinks, and continues, the same way a person pauses before answering.

Architecturally, **the front-mind invokes the back-mind via a "thinking" tool**. Calling the thinking tool engages the back-mind to produce reasoning, work, or output. From the user's perspective, the agent is thinking; from the implementation's perspective, the front-mind has called its thinking tool.

## Working memory

The front-mind continuously updates a structured running model derived from the back-mind's detail events. State the front-mind tracks includes:

- Recent conversation history
- What the user asked the agent to work on
- What the back-mind is doing right now
- What completed back-mind steps have surfaced so far
- Things the agent has said it would check or do

The front-mind reasons over this model in real time to answer status and reference questions without re-invoking the back-mind.

## State as a derived view

Front-mind state is a deterministic function of the persistent event log (detail events + conversation history). It is not authoritative — the event log is.

This means:

- On process restart or crash, the front-mind rebuilds its state by replaying events from the log. No checkpointing required.
- Updates from the event stream must be idempotent — replaying the same events yields the same state.
- State can in principle be parallelized: multiple front-mind instances derive the same state from the same event log.

The in-memory working memory is a cache over the persistent log, not a separate source of truth.

## Behaviors (technical user stories)

### When the user finishes speaking, the agent acknowledges immediately, before any thinking begins.

The agent responds within ~100ms of input completion. The acknowledgment is contextually appropriate to what was asked. If the question can be answered from working memory, the agent answers directly without invoking the thinking tool.

### While the agent is thinking, it narrates progress appropriate to what's happening.

The agent surfaces interesting back-mind detail ambiently — long-running steps, surprising results. Routine intermediate steps are filtered. Narration uses working memory ("I'm checking the config files now"), not raw events.

Cadence is bounded on both ends, but the bounds are asymmetric:

- **Silence ceiling (max interval)** — a fixed timer (a few seconds). If nothing new has been said for that long, the front-mind asks itself whether to speak even without a new event, so the user doesn't experience extended silence.
- **Output-busy floor (min spacing)** — *not* a fixed interval. Don't yield a new utterance while the prior utterance is still being delivered. For voice that's "don't start speaking the next line while TTS is still saying the last one"; the wait is computed dynamically from the line's length and the TTS speech rate plus a small pad. Short fillers unblock fast; long lines space themselves naturally.

Plus a **bounded pending queue** with auto-eviction. The brain keeps producing utterances from incoming events; we hold the most recent N (small — 2 is plenty). When the queue is full and a new utterance arrives, the oldest is dropped on the floor. This means during a busy event burst we always speak the most-recent narration content, never a stale backlog.

If the narration brain fails to produce a usable utterance (model error, JSON corruption, repeated failures), the front-mind stays silent for that tick. There is no canned-filler fallback — silence is preferred to robotic templated phrases.

### While the agent is thinking, the user can ask "how's it going" or "what'd you find" and get an immediate answer.

The agent answers status and accumulated-findings questions from working memory. Thinking is not re-invoked. Response latency stays at conversational cadence.

### The user can interrupt the agent's current thinking with a directive.

The agent acknowledges immediately, signals abort to the in-flight thinking, and starts thinking on the new directive.

### Factual or computational questions trigger thinking.

The front-mind does not answer these from its own knowledge — too unreliable. Anything factual, mathematical, or requiring fresh information triggers thinking, even if thinking is currently busy with another task. The agent acknowledges and engages thinking; the user is told this is happening.

### The agent's confidence tracks its actual reliability.

The agent only commits to answers it can support from working memory. If unsure, it says so and thinks. If working memory might be stale relative to the answer, it hedges.

### Continuity across the conversation is preserved even when thinking takes a long time.

The agent tracks what it has said it will do, and follows through. References to prior findings ("that second file you mentioned") resolve from working memory.

### The back-mind can correct the front-mind.

Because the back-mind sees the full banter history, it sees what the front-mind has been saying to the user. If the front-mind committed to something the back-mind determines is wrong — a misstated fact, a wrong number, a misremembered finding — the back-mind's next response can correct it explicitly. This is the safety net against the front-mind's reflexive answers being wrong: the slow brain reads what the fast brain said and gets the chance to say "actually, that's not right — here's the real answer."

## Routing rules

The front-mind decides on every inbound utterance: respond from working memory, or invoke the thinking tool?

**Respond from working memory** — the answer is something the front-mind genuinely knows, and being wrong has only conversational consequences.

- Status questions ("how far are we?", "what's the status?")
- Accumulated-findings questions ("what have you found so far?")
- Current-activity questions ("what are you doing right now?")
- References to prior findings ("which file was that?")
- Acknowledgment-only inputs ("ok", "got it")

**Invoke thinking** — the answer requires capability the front-mind lacks, or being wrong has consequences beyond the conversation.

- Anything factual
- Anything computational ("what's 47×23")
- Anything requiring tool use
- Novel reasoning
- Complex summarization or analysis over long conversational state (the front-mind could in theory, but the back-mind is meaningfully better)
- Directives that change the task
- Anything the user could act on

When in doubt, think. Front-mind silence about its own limits is worse than a small extra latency.

## Banter and chat

Two row kinds carry information into the back-mind:

- **Banter** — informational. The back-mind sees it but does not act on it. Includes the user's chatter, the front-mind's own utterances, and anything else the front-mind heard but handled locally. Accumulates as context; never wakes the back-mind from idle on its own.
- **Chat** — actionable. The back-mind treats this as a directive and acts on it. Wakes the back-mind from idle.

The front-mind's classification is binary: *is this actionable?* If yes, write a chat row. If not, write a banter row. Actionable banter becomes chat — the front-mind elevates it, the user's words don't need to be re-spoken.

All banter — incoming user chatter and outgoing front-mind utterances — flows through the same input path. There is no separate channel for the front-mind to "talk to" the back-mind. The back-mind reads its conversational context from the same log everything else uses, with the agent's own utterances tagged as such.

Banter is delimited in the back-mind's context so the model can self-filter. Within a turn's input, banter rows are wrapped in a clearly-named container; actionable rows are wrapped in a separate container. Banter rows are tagged with a sender that visibly marks them as realtime-layer messages — distinct from the platform-real-name attribution used for actionable chat. The model reads the conversation background and the active directive as visibly distinct.

## Voice and pronouns

The agent's outward voice is consistent across all outputs to the user — first-person agent ("I'm checking the config files now," "let me think about that"). The front-mind speaks for the agent.

When the front-mind forwards a user input to the back-mind via the thinking tool, it preserves the user's voice. Two valid framings:

1. **User's literal words** — pass verbatim (best)
2. **First-person user-voice paraphrase** — "I would like to check the config files" (said as if the user is speaking; use when the literal input needs disfluency stripped, summarization, or irrelevant chatter dropped)

What to avoid:

- **Third-person paraphrase** ("the user wants me to check the config files") — reads as meta-commentary about the user rather than as the user speaking, and underweights the ask
- **First-person agent-voice** ("I'll check the config files") — looks like a self-directive coming from the agent rather than a request from the user, conflicts with how the back-mind reasons about who's asking, and historically tripped prompt-injection guards

The back-mind is expected to be tolerant of mild variation around the two valid framings — sometimes literal, sometimes user-voice paraphrase — and treat both as user input.

This aligns with the banter sender attribution: `realtime-user` for user-said things (literal or user-voice rephrased), `realtime-agent` for the front-mind's utterances back to the user (in the agent's natural first-person voice).

## Output modes

The front-mind has one underlying cognition, but its output threads into several modes:

- Immediate filler / acknowledgment, fired on user-turn-end
- Ambient progress feedback, triggered by interesting detail events. In voice modality this is *narration* ("I'm checking the config files now"); in Slack it's a status update; in avatar it's facial state and idle behavior. Same input stream, modality-specific rendering.
- Direct response from working memory, on user query
- Thinking-derived final answers, surfaced through the same channel and voice
- Self-correction when state shifts during an in-flight response

These are output channels, not separate components. Same agent, same state, same voice, different triggers and different modality renderings.

## Reusability across modalities

The front-mind is modality-agnostic. The same component drives:

- **Voice** — outputs flow to TTS; demand is highest here
- **Avatar / video** — outputs include facial state and idle behavior, not just spoken text
- **Real-time chat** (Slack assistant API, Discord) — outputs flow to status messages and progress updates
- **Web UI** — outputs flow as a streamed event channel

Different transports, same agent.

---

## Appendix: NanoClaw mapping

This design fits cleanly on top of NanoClaw's two-DB session model:

- The persistent event log is `outbound.db` (detail events written by hooks) plus `inbound.db` (user messages and banter). Both are durable.
- The front-mind lives in the channel adapter (host-side process), not in the container.
- State rebuild on restart is just re-reading these DBs from the start of the current session.
- "Thinking" maps to writing a wake event to `inbound.db` and consuming the resulting detail + final result from `outbound.db`.

### Row kinds and trigger flag

Banter and chat ride NanoClaw's existing inbound row schema. The mapping is one-to-one:

- `kind='chat'` ⟺ `trigger=1` — wakes the container if idle; pushed into the running query if active.
- `kind='banter'` ⟺ `trigger=0` — never wakes the container; rides along into the running query when one exists.

NanoClaw's existing follow-up poller (`container/agent-runner/src/poll-loop.ts:270-330`) pushes pending rows into the active SDK query at each poll tick, regardless of trigger. The trigger flag only matters at idle. Once running, both kinds flow into the SDK conversation transcript via `query.push()`, which the SDK persists for resume.

Outbound rows the back-mind produces use `kind='detail'` for any progress event and `kind='chat'` for the final answer. The front-mind consumes detail rows to maintain working memory and to drive ambient progress feedback (narration in voice modality, status updates in chat modalities, etc.).

Detail rows share one row kind but multiple content shapes, discriminated by an inner `type` field:

```
{ type: 'tool-pre',     tool: 'Bash',  input: {...} }              # PreToolUse hook
{ type: 'tool-post',    tool: 'Bash',  result: {...}, status: ... } # PostToolUse hook
{ type: 'tool-failed',  tool: 'Read',  error: '...' }               # PostToolUseFailure
{ type: 'token-delta',  text: '...' }                               # chunked partial message
{ type: 'compact',      ... }                                       # PreCompact, when relevant
```

Front-mind consumers dispatch on the inner `type`. Working-memory synthesis cares most about `tool-post` results (what's been found, what files were read, what commands ran). Narration cares about both — `tool-pre` to know what's starting, `token-delta` to see content the back-mind is articulating before its final answer lands. Same row pipeline, different attention by consumer.

### Streaming token deltas

The Claude Agent SDK exposes partial-message events when configured with `includePartialMessages: true`. The hook fork enables this option and buffers token deltas, emitting one `kind='detail'` row (with `content.type='token-delta'`) per chunk.

Cadence rules:

- **Chunk timer**: ~half the active poll interval. So if the follow-up poller runs at ~250ms, the delta-chunk timer fires every ~125ms. This guarantees most polls see fresh delta content; worst-case end-to-end latency from token-generated to front-mind-sees-it is roughly one poll interval plus one chunk interval (~375ms), and average latency is much lower.
- **Minimum chunk size**: a character floor (default ~30 chars) suppresses pathologically tiny chunks at the start of generation. If the timer fires with fewer than the minimum buffered, keep buffering and wait for the next tick.
- **End-of-generation flush**: when the model completes, emit whatever's in the buffer regardless of size. Otherwise the tail of the response could be lost.

This gives the front-mind near-real-time visibility into what the back-mind is producing, not just when tools start and finish — useful for narrations like "looks like Debian" that key off content the back-mind has begun to articulate.

### Delimitation in the model's prompt

The container's formatter (`container/agent-runner/src/formatter.ts:129-155`) groups inbound rows by kind and wraps each group in a tag. Chat rows go into `<messages>...</messages>` and use the platform sender's real name (e.g., `sender="gavan"`). Banter rows go into a parallel `<banter>...</banter>` group and use a layer-prefixed sender:

- `sender="realtime-user"` — user utterances on the realtime layer (chatter, asides, status questions handled by the front-mind)
- `sender="realtime-agent"` — the agent's own utterances on the realtime layer (filler, narration, real-time replies the front-mind produced)

The prefix carries the discriminator: any sender starting with `realtime-` is a realtime-layer message, not a platform chat message. Even without the wrapper, the sender shape alone tells the model "this is the realtime layer, not the action layer." The wrapper reinforces it.

Example formatted prompt:

```xml
<context timezone="America/Los_Angeles" />

<banter>
  <message sender="realtime-agent" time="10:23 AM">checking the config files now</message>
  <message sender="realtime-user" time="10:24 AM">cool</message>
  <message sender="realtime-agent" time="10:25 AM">found 3 of them</message>
</banter>

<messages>
  <message id="11" sender="gavan" time="10:27 AM">actually try the json approach instead</message>
</messages>
```

The wrapper is added at format time, after the row's JSON content is parsed; XML escaping handles special characters in bodies and attributes.

### Telling the agent what banter is

The agent needs to know what `<banter>` blocks mean and that they are not directives. This is delivered via NanoClaw's existing container-skill mechanism — a small markdown file under `container/skills/` (parallel to existing skills like `slack-formatting`) that ships with any banter-producing channel install. When a channel skill that uses banter is installed (e.g. a voice or real-time channel), it includes the banter skill in its install set; sessions that don't have a banter-producing channel never see the explainer.

The explainer is short, e.g.:

> `<banter>...</banter>` blocks contain realtime-layer background — things you said via your realtime conversational layer (`sender="realtime-agent"`) and asides the user said while you were working (`sender="realtime-user"`). Treat banter as informational context, not as directives. The actionable input for this turn is in `<messages>...</messages>`. Banter exists because real-time channels need a fast conversational layer alongside your main work — what you see in banter is what was said on that layer while you were thinking.

No fork to NanoClaw is needed for this — the container-skill pattern already supports per-channel content drops.

### Why not `additionalContext`

The Claude Agent SDK's hook outputs (`PreToolUse`, `UserPromptSubmit`, `Notification`, others) expose an `additionalContext: string` field that injects text into the model's working context for one response cycle. We do not use this. Banter delivered via `additionalContext` would be ephemeral — not part of the conversation transcript, not visible after the cycle, not present after a container restart. Delivering banter as `query.push()` rows puts it in the persistent SDK transcript, surviving resume and matching the state-rebuild requirement above.

---

## Appendix: Non-obvious decisions & gotchas

Cross-cutting rules that don't fall out of the architecture above. Each is a real bug or an explicit correction, not a preference.

**Gate completion claims on tool-result events, never on intent.** Banter and narration speak from the back-mind's *stated* intent ("I'll send it"), which arrives before the work is done. Any "done" / "sent it" / "finished" claim must key off an actual tool-result detail event, not intent — otherwise the front-mind narrates a future it can't observe and lies to the user (observed: voice said "sent it!" three times during a ~5-min send that only landed at the end). The front-mind has no real completion signal unless one is wired from back-mind tool-completion into its working memory.

**Back-mind report verbosity: proportionate, not terse.** The back-mind's answer is re-rendered through the fast layer downstream, which compresses for the channel — so feed the back-mind reasonable context and let it compress, don't pre-strip. Casual question → a sentence or two; a real piece of work → a paragraph, up to ~half a page when findings genuinely call for it. "Default to one or two sentences" is an overcorrection; the original problem was 1500-line dumps, not prose.

**Narration-brain robustness** (beyond the cadence/queue rules in Behaviors):
- Run the brain's JSON output through a json-repair pass — models wrap it in ` ```json ` fences and add stray prose.
- Don't drain the event queue each tick — take one event per loop iteration so a burst yields per-event narration triggers instead of collapsing to a single utterance.
- Soft dedup, not hard: "if the next line is word-for-word a prior one, vary it; otherwise speak." A strict "never repeat or stay silent" rule tips the model into ~95% silence — the worst regression mode.

**Per-turn working-memory injection is non-persistent.** The derived working-memory block handed to each front-mind invocation is scoped to that call only — never written back into conversation history. Rebuild it fresh each turn from the event log (reinforces *State as a derived view*); persisting it would bloat history and defeat the rebuild.

**Channel-context inference — no explicit "current channel" marker.** For rules that branch on channel (e.g. cross-channel pre-warn): the *deliverable* channel is explicit in the user's ask ("send to my Signal"); the *current* channel is implicit from each inbound message's `sender`/`from`. The back-mind's system-prompt addendum is built once at startup, so it can't carry a live "you are on channel X" marker — lean on the implicit inference rather than adding a per-turn marker (which would mean touching the per-turn formatter).

**What reaches the back-mind vs. the front-mind.** Front-mind-only inputs — caller context, capability descriptions, scenario/session state — never reach the back-mind container, which is channel-agnostic and reads only banter + chat + its composed system prompt. Also: `<message to=...>` output blocks are honored end-of-response only; a mid-response side-channel must use the `send_message` MCP tool (this is the load-bearing reason behind the cross-channel pre-warn rule).

**Tool-return strings and `notifyAgent` text leak to the user.** The back-mind treats an MCP tool's return string as content to relay, so pipeline vocabulary ("queued", "delivered", "sending") gets echoed to the user as status bubbles ("Queued.", "Delivered ✓"). Every MCP tool description needs an explicit DO-NOT-ECHO clause naming the phrases; return strings should be terse and tagged `[internal]`; on success, prefer `notifyAgent` silence over a confirmation the agent will parrot.

**Front-mind prompt-file convention.** One file per LLM call site (`realtime/src/prompts/`), each exporting a typed `Context`, a `SYSTEM` template, a `buildUser(ctx)`, and a `render(ctx) → {system, user}`. XML-tagged sections (`<role>`, `<rules>`, …), DO/DON'T inside `<rules>`, shared fragments in `_*.ts` partials. Opening one file shows the literal payload sent to the API — no chasing slot-builders across the runtime.
