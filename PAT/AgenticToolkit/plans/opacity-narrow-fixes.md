# Front↔back-mind opacity narrow fixes

**Status:** planned 2026-05-18. Not started. Demo-deferred (not
demo-blocking).

## Context

Audit (2026-05-18) of front↔back-mind context flow concluded:

- **Back-mind IS opaque to front-mind's state.** Non-scenario forwards
  carry NO context bridge — the back-mind sees just the user text +
  `bufferedBanterByThread` prefix. The rich `<session_state>` block that
  bridges in scenario mode is gated behind `scenario.tag_stream_enabled`.
  In conversing mode and non-scenario flows, the back-mind has no idea
  what banter said this turn, what narration emitted, what's in the
  unified history.
- **Front-mind is NOT opaque to back-mind.** It already has near-realtime
  back-mind awareness via `processingByThread`, narrator event buffer,
  detail.row-received events, history-stamping on chat rows. The user's
  intuition that "front-mind doesn't know what back-mind is doing" was
  mostly wrong — except in one place.
- **The one genuine asymmetry: forward-ACK.** `nanoclaw/src/index.ts:81-97`
  defines `onInbound` as a synchronous wrapper that calls
  `routeInbound(...).catch(...)` and returns void. The orchestrator's
  `await config.onInbound(...)` resolves the moment the row is enqueued —
  there's no signal whether the row was written to history, whether the
  container was successfully woken, or whether `wakeContainer` returned
  false (silently, per `container-runner.ts:84-103`). Container spawn
  failure or mid-query crash is detected only by:
  - 5-min idle-timeout (`NarrationManager.forceCloseIdleSession`)
  - Absence of chat rows (silent — orchestrator hangs waiting)
  - User barge-in (POST → kills container, orchestrator finds out)

This plan addresses both gaps with narrow, surgical changes.

## Architecture

### Fix 1 — Generalize `<session_state>` block

Today in `realtime/src/channel-orchestrator.ts` `handleUserMessage` (lines
913-961 per audit), the session_state block is constructed only inside
`if (scenario?.tag_stream_enabled)`. Drop the gate. Fire on every forward.
Payload composition becomes mode-aware:

- **Always include:**
  - `front_mind_already_said: "<banterText>"` if banter ran this turn
  - `back_mind_recently_did: "..."` summary of last N back-mind events
    (from narrator's recent buffer or detail.row tail)
  - `current_thread_summary` (one-line)
- **Scenario mode adds:** `scenario_slug`, `slide_count`, `cursor_now`,
  `last_delivered_slide`, `last_spoken_anchor`, `last_delivered_prose`
- **Non-scenario mode skips** the scenario-specific fields

The block is purely additive to `invokeText`. The back-mind sees the
context, ignores fields it doesn't care about. Risk: bloats invokeText.
Mitigation: cap each field to ~200 chars; cap total block to ~2000 chars.

### Fix 2 — Forward-ACK via `Promise<{written, woken}>`

Change `ChannelSetup.onInbound` signature from
`(...) => Promise<void>` to
`(...) => Promise<ForwardResult>` where:

```ts
type ForwardResult = {
  written: boolean;        // row landed in history
  woken: boolean;          // container spawn returned true
  container_status: 'spawned' | 'reused' | 'spawn-failed' | 'queue-full';
  error?: string;
};
```

Propagation:

- `nanoclaw/src/index.ts` `onInbound` wrapper: actually return the
  `routeInbound` promise. Today it's `.catch()`-only fire-and-forget;
  becomes `await routeInbound(...)` returning the result.
- `nanoclaw/src/container-runner.ts` `wakeContainer`: already returns
  bool; surface that into `routeInbound`'s result.
- `nanoclaw/src/channels/anam-web.ts` + `phone-call.ts`: pass through
  the result.

Orchestrator emits new structured log events on result:

```ts
| { kind: 'forward.acked'; data: { written: boolean; woken: boolean; container_status: string } }
| { kind: 'forward.failed'; data: { reason: string; container_status: string } }
```

State machine impact: if `forward.failed` fires, orchestrator can
short-circuit — emit a `forward-failed` banter prompt to the user
("hmm, something went wrong on my end, give me a sec") rather than
silently waiting 5 minutes for the idle-timeout.

## Phases

**Phase 1 — Generalize session_state (~30 LOC, 1.5h)**
- Drop the `tag_stream_enabled` gate; refactor block builder for
  mode-awareness.
- Add length caps per field.
- Update existing unit test for tag-stream mode; add unit test for
  non-scenario forward.

**Phase 2 — Forward-ACK return + log events (~70 LOC, 3h)**
- `ForwardResult` type in shared types module.
- Change `ChannelSetup.onInbound` signature.
- Threading: `nanoclaw/src/index.ts` → `routeInbound` returns
  `Promise<ForwardResult>`. Update both channel setup sites
  (anam-web, phone-call) to propagate.
- `wakeContainer` result surfaced.
- New log events: `forward.acked`, `forward.failed`. Declare in
  `realtime/src/log-events.ts` + Python + frontend mirrors. Drift test
  passes.
- Orchestrator emits on resolved result.

**Phase 3 — Short-circuit on forward-failed (~20 LOC, 1h)**
- On `forward.failed`, emit a recovery banter ("hmm, give me a sec")
  via banter-render path.
- Suppress idle-timeout for the next N seconds to avoid double-firing.

**Total: ~5.5h** + tests.

## Critical files

- `realtime/src/channel-orchestrator.ts` (lines 882-1000 area —
  handleUserMessage + session_state builder)
- `realtime/src/log-events.ts` (+ Python + frontend mirrors)
- `nanoclaw/src/index.ts` (lines 81-97 — onInbound wrapper)
- `nanoclaw/src/container-runner.ts` (wakeContainer)
- `nanoclaw/src/channels/anam-web.ts` (line ~744-755)
- `nanoclaw/src/channels/phone-call.ts` (line ~1005-1016)

## Verification

- Unit: session_state builder produces correct payload for both modes,
  respects length caps.
- Unit: ForwardResult propagates through wakeContainer failure paths.
- E2E (gated on trace test harness): drive a forward that the container
  rejects (e.g. queue-full simulation); assert `forward.failed` event
  fires within 3s of forward; assert recovery banter renders.
- Manual: kill the container mid-turn; confirm front-mind acknowledges
  the failure rather than hanging.

## Open questions

- **Should non-scenario forwards include `back_mind_recently_did`?**
  Pulling from the narrator's buffer is cheap but doubles up content the
  back-mind will see in history. Maybe skip when history already covers
  the last back-mind turn. Decide at implementation time.
- **`forward.failed` recovery banter — what does it say?** Default:
  "hmm, something went sideways on my end, one moment." User to confirm
  the wording is on-voice for Pat.
