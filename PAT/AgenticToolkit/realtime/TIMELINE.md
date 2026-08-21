# Timeline runtime

The timeline runtime is the realtime layer's primitive for sequencing
audience-perceptible actions. One queue per thread, one sequencer
draining it, awaiting each action's completion signal before consuming
the next.

It's domain-agnostic. Scenario delivery (the first big consumer) lives
in `@agentic-toolkit/scenarios`. Plain back-mind chat rendition will
migrate next. Future domains — robotics, drone sequences, multi-step
demos — plug in via the same registry.

This doc is the entry point for the runtime. The end-to-end design,
including pieces still being implemented, is `plans/timeline-runtime-and-scenarios.md`.

## Concepts at a glance

- **Timeline** — an ordered XML sequence of typed actions. Authored
  inside `<aside class="notes">` on a slide, or emitted by the back-mind
  in a `send_message`.
- **Action** — one entry in a timeline. A `<say>`, `<pause>`, `<tool>`,
  fragment / slide-nav directive, or terminator. Base actions are
  defined in `src/timeline/types.ts`; domain actions are contributed
  by extensions.
- **TimelineQueue** — per-thread FIFO. Filled by the parser, drained
  by the sequencer.
- **Sequencer** — the loop that consumes the queue. Awaits each
  action's completion signal before consuming the next.
- **Linear contract** — N+1 doesn't start until N's completion signal
  fires. Tied to the audience-perceived playback, not the parser's
  stream rate.
- **Banter dispatch** — per-`<say>` Haiku rewrite that adds emotion /
  pause / cartesia tags while preserving the authored meaning. See
  `src/banter-dispatch.ts`.
- **Action domain extension** — a package that contributes new action
  variants plus their parse-hook and dispatch-hook. Registered at
  module load via `registerActionDomain()`. See
  `src/timeline/registry.ts`.

## Wire form

The back-mind (and authors writing speaker notes) emit timelines as XML
inside a top-level `<timeline>...</timeline>` wrapper:

```xml
<timeline>
  <next_fragment/>
  <say target="single_agent">A single AI agent. One written instruction.</say>
  <pause ms="200"/>
  <next_fragment/>
  <say>Two hours, forty-one minutes later, working copies were running...</say>
  <next_slide/>
</timeline>
```

The parser tokenizes the stream. The interpreter hands tag-by-tag
events to the registry. The queue accumulates parsed actions. The
sequencer drains them.

## Vocabulary

| Tag | Lane | Notes |
|---|---|---|
| `<timeline>...</timeline>` | wrapper | One per `send_message`. Required in delivery mode. |
| `<say>text</say>` | say | Spoken prose. Runs through banter dispatch. |
| `<say target="ID">text</say>` | say | Same, with element ref for Q&A re-explanation lookup. |
| `<pause ms="N"/>` | pause | Non-blocking visual beat. |
| `<next_fragment/>` | fragment | Reveal next fragment positionally. |
| `<prev_fragment/>` | fragment | Un-reveal positionally. |
| `<next_slide/>` | slide | Terminator. `Reveal.next()` — handles h+v. |
| `<prev_slide/>` | slide | Terminator. `Reveal.prev()`. |
| `<nav_slide_up/>` | slide | Terminator. Explicit vertical ascent. |
| `<nav_slide_down/>` | slide | Terminator. Explicit vertical descent. |
| `<nav_slide_left/>` | slide | Terminator. Explicit horizontal back. |
| `<nav_slide_right/>` | slide | Terminator. Explicit horizontal forward. |
| `<goto_slide n="N" v="V"?/>` | slide | Terminator. Jump to slide N (optional vertical V). |
| `<ask_for_questions/>` | qa | Terminator. Pause for audience input. |
| `<tool_NAME ...args/>` | tool | Sync tool. Sequencer blocks until tool-post round-trips. |
| `<async_tool_NAME ...args/>` | tool | Fire-and-forget tool. Sequencer doesn't block. |
| `<wait-for-cue cue="X"/>` | wait | Block until external cue fires. |
| `<timeline_span from="N" to="M"/>` | (parser-level) | Hydrates inline from the authored timeline N..M. |

Legacy aliases (`slide_next` → `next_slide`, `frag_next` →
`next_fragment`, `slide_go_to` → `goto_slide`, etc.) are recognized for
backward compat with existing packets.

## Completion signals

The sequencer awaits each action's completion signal before consuming
the next.

| Action | Completion |
|---|---|
| `say` | TTS-end-of-speech for this utterance. |
| `pause` | `setTimeout(ms)` fires. |
| `next_fragment` / `prev_fragment` | Slide-bus POST 200-response. |
| `slide-nav` terminators | Slide-bus POST 200-response. |
| `tool` | `tool-post` detail row arrives for this `tool_use_id`. |
| `async_tool_*` | Instant — sequencer doesn't block. |
| `wait-for-cue` | External cue event matching `cue` name. |
| `terminator` | Immediate — fires `timeline.finished`, exits loop. |

Cancellation: barge-in → `abortTimelineSequence(threadKey, 'interrupted')`
→ in-flight action's await throws AbortError → sequencer breaks loop →
emits `timeline.finished` with `reason='interrupted'`. The partial text
of an interrupted `<say>` is captured for the completed-actions block.

## State machine

Per-thread mode: `delivering` | `conversing`.

- `delivering` ↔ at least one `<timeline>` is active for the thread.
- The narrator gate (`isDelivering(threadKey)`) suppresses filler
  narration during scripted delivery.
- Terminator consumed OR `flush('interrupted')` flips back to
  `conversing`.

## Action domain extensions

`src/timeline/registry.ts` exposes:

```ts
export interface ActionDomainExtension {
  /** Unique name. Re-registering the same name replaces in place. */
  name: string;
  /** Tag predicate. */
  matches(tag: string): boolean;
  /** Convert a parsed XML tag into a TimelineAction variant. */
  parseAction(
    tag: string,
    attrs: Record<string, string | number | boolean>,
  ): TimelineAction | null;
  /** Fire the side effect. Promise resolves when audience-perceived
   *  completion lands. */
  dispatch(action: TimelineAction, ctx: DispatchContext): Promise<void>;
}

export function registerActionDomain(ext: ActionDomainExtension): void;
```

Scenarios contributes `scenarios.presentation` at module load. Future
packages register the same way.

## Logging

Every action emits structured log events. Consumers (TUI, timeline
dashboard, pat-trace.py) dispatch on `.kind`:

- `timeline.started` — wrapper opens. `data.timeline_id`,
  `data.scenario_slug?`.
- `timeline.finished` — wrapper closes.  `data.reason: 'completed' |
  'interrupted'`, `data.duration_ms`.
- `timeline.action-enqueued` — every action enqueued. `data.kind`,
  `data.seq`, `data.timeline_id`, plus the action's salient fields
  (text preview / direction / tool name / ms).
- `timeline.action-completed` — completion signal fired.
  `data.duration_ms`.
- `timeline.action-cancelled` — flushed by abort. `data.reason`,
  `data.partial?` (captured partial text).
- `banter-dispatch.called` — per-say Haiku rewrite call.
  `data.input_text`, `data.output_text`, `data.latency_ms`, `data.ok`.

Schema source of truth: `src/log-events.ts`. Mirrored in
`transports/log_events.py` and `pat-frontend/src/types/log-events.ts`.
The drift test enforces alignment.

## Completed-actions in the back-mind inbox

When the back-mind is invoked on a follow-up turn and there was prior
timeline activity in the same thread, the host stamps a
`<completed_actions>` block into the inbound message. The agent sees
what actually played, including partial-text on interrupted actions.

```xml
<inbox now="01:36:12Z">
  <user>Wait, what did you mean by Finland?</user>
  <completed_actions reason="interrupted">
    <next_fragment ts_start="01:35:40Z" ts_end="01:35:40Z"/>
    <say ts_start="01:35:40Z" ts_end="01:35:43Z">A single AI agent...</say>
    <next_fragment ts_start="01:35:43Z" ts_end="01:35:43Z"/>
    <say ts_start="01:35:43Z" ts_end="01:35:47Z">Two hours, forty-one minutes later...</say>
    <say ts_start="01:35:47Z" partial="true">Self-replication has been—</say>
  </completed_actions>
</inbox>
```

`now` is host-stamped, so the agent never has to infer "what time is
it." `ts_start` / `ts_end` are intrinsic playback facts, never
re-stamped per invocation. The block is rendered by
`src/timeline/completed-actions.ts`.

## Files

- `src/timeline/types.ts` — base TimelineAction union, DispatchContext,
  ActionDomainExtension interface.
- `src/timeline/parser.ts` — re-export of `tag-stream-parser.ts`.
- `src/timeline/queue.ts` — TimelineQueue (FIFO).
- `src/timeline/sequencer.ts` — Sequencer loop + abort.
- `src/timeline/registry.ts` — extension registration + lookup.
- `src/timeline/events.ts` — log-event helpers.
- `src/timeline/completed-actions.ts` — inbox block renderer.
- `src/timeline/index.ts` — public API.
- `src/banter-dispatch.ts` — per-say Haiku rewrite.
- `src/prompts/banter-dispatch.ts` — system / user prompt for above.
- `src/channel-orchestrator.ts` — `runTimelineSequence`,
  `abortTimelineSequence`, `getCompletedActionsBlock`, `wrapInbox`.

## See also

- `plans/timeline-runtime-and-scenarios.md` — the original design doc,
  including in-progress + deferred phases.
- `@agentic-toolkit/scenarios` `SCENARIOS.md` — how the presentation
  domain extension uses the runtime.
