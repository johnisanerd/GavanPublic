# Streaming pivot pipeline — owned pacing + graceful transitions

> **Status: SPECULATIVE (architecture unbuilt).** Architecture agreed
> during 2026-05-22 design session. Three quick Cerebras tests proved
> the prefill technique works end-to-end (sub-150ms pivot generation).
> **Provider substrate is now decided and live: Cerebras `zai-glm-4.7`**
> via the official SDK (`realtime/src/llm-provider.ts`,
> `reasoning_effort='none'`) — the fast-tier for the whole front-mind.
> The architecture here is provider-agnostic and worth landing
> regardless, but the "no hard cuts" pivot latency is achievable on
> that live substrate.

## Why this exists

Today the LLM → TTS handoff is fire-and-forget. The front-mind
streams chunks to Cartesia, Cartesia plays them on its own clock,
and "interrupts" are hard cuts — the speech literally stops
mid-word. Same for back-mind-result handoff: narration finishes
naturally OR gets clipped, then a new utterance starts. The seams
are audible.

The user's instinct, from the design session:

> "I don't want us firing a hard cut. We're just no longer serving
> tokens to the text-to-speech, right? […] If we're narrating and
> the user asks something, rather than just chopping it, what
> happens is that we transition with two to three words. 'Oh, oh,
> wait, what's that?' Right? Or 'uh, go ahead.' […] And if we're
> narrating and a back-mind result comes in, we also do a really
> graceful transition."

The shape: PAT should sound like a human conversational partner —
who trails off when interrupted, who pivots smoothly when new info
arrives, never amputates speech mid-syllable.

Achieving that requires three things we don't have today:

1. **We own the pacing.** Today Cartesia consumes our stream on
   its own clock; we don't know how much audio is queued vs played.
   We need to throttle our emit rate to keep TTS in a narrow
   buffer window — enough to play smoothly, not so much that
   interrupts have to wait for buffered audio to drain.

2. **We track what's actually been spoken.** Not what the LLM has
   emitted (that races ahead of audio), but what Cartesia has
   actually broadcast — per `cartesia.agent-text-sent` events.
   That's the anchor for the prefill on a pivot.

3. **We generate the pivot.** On event (user interrupt, back-mind
   result), a short LLM call produces a contextually-aware
   transition using prefill: the spoken tail goes in as an
   `assistant` turn, the prompt instructs the pivot, the model
   continues naturally from where the audience last heard.

## Evidence — three working tests against Cerebras (2026-05-22)

**Test 1: assistant-as-last-message continuation supported.**
```json
messages: [{role:"system",...}, {role:"user",...},
           {role:"assistant", content:"My favorite color is"}]
→ output: "blue."  (continuation only, not prefill+continuation)
```
OpenAI-compatible behavior — we stream the new tokens, the prefill
is invisible to the listener (they've already heard it).

**Test 2: narration→result pivot.**
```
spoken_so_far: "im doing some web searches on palisade research"
just_arrived: <back-mind result text>
prompt: "produce a SHORT natural transition (2-4 words), then
        deliver the result conversationally"
prefill: "im doing some web searches on palisade research"

→ output: "and—oh, here's something—turns out palisade research is
   actually an ai safety nonprofit that just published this self-
   replication study back in march."

Listener experience: "im doing some web searches on palisade
research and—oh, here's something—turns out palisade research is
actually an ai safety nonprofit..."

Total: 138ms / Generation: 45ms.
```
Natural seam. Lowercase casual voice carried through. The "and"
grammatically bridges; "oh, here's something" is the pivot beat.

**Test 3: graceful trail-off on user interrupt.**
```
spoken_so_far: "<long mid-utterance>...and they share"
prompt: "produce a graceful trail-off (2-3 words max)"
prefill: <same>

→ output: "oh — what's up"

Total: 35ms.
```
Sub-frame for voice realtime. Acknowledges the interrupt
naturally before silencing TTS.

Tests proved:
- Prefill works on Cerebras (OpenAI-compatible)
- Generation latency is well within voice budget
- Quality of the natural transition is good with a small dedicated
  prompt

Prefill also explicitly supported on Anthropic
(`messages[messages.length-1].role === 'assistant'` continues the
turn). Architecture transfers regardless of which provider we end
up using for front-mind.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  LLM stream (banter-ack, banter-render, narrator)           │
│  ↓                                                          │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  PACING LAYER (new)                                    │ │
│  │  - emits chunks to TTS at target rate                  │ │
│  │  - maintains <SPOKEN_TAIL> from cartesia.agent-text-sent│ │
│  │  - subscribes to interrupt + result events             │ │
│  │  - on event: stop emit, fire pivot generator           │ │
│  └────────────────────────────────────────────────────────┘ │
│  ↓                                                          │
│  Cartesia TTS                                               │
└─────────────────────────────────────────────────────────────┘
                          ↑
                          │ on event (user-spoke OR back-mind-result)
                          │
              ┌───────────────────────────┐
              │  PIVOT GENERATOR (new)    │
              │  - input: spoken_tail +   │
              │    transition context     │
              │  - small dedicated prompt │
              │  - prefill: spoken_tail   │
              │  - outputs continuation   │
              └───────────────────────────┘
```

### Pacing layer (new — `realtime/src/streaming-pipeline.ts`)

Sits between the LLM stream callback and the channel transport's
`onDelta`. Today's path:
```
LLM delta → transport.onDelta(text, seq)  →  Cartesia
```

New path:
```
LLM delta → pacingLayer.push(text, seq)
   pacingLayer maintains:
     - bufferAhead_ms: estimated audio queued at Cartesia
     - target: keep bufferAhead_ms in [800, 1500] window
     - drainRate: estimated TTS playback chars/sec
   pacingLayer.tick() flushes chunks to transport.onDelta when
     bufferAhead_ms < target.upperBound
```

The window numbers are empirical — Phase 1 is to measure them.
Cartesia plays ~15 chars/sec for natural speech; we want enough
buffer to ride out network jitter but not so much that an
interrupt has to wait 3s for audio to drain.

### Spoken-tail tracker

The pacing layer subscribes to `cartesia.agent-text-sent` events
(already emitted per realtime/src/log-events.ts). Each event
carries the text Cartesia logged as actually broadcast. The
pacing layer maintains a per-thread rolling buffer:

```ts
class SpokenTail {
  private byThread = new Map<string, string>();

  appendBroadcast(threadKey: string, text: string): void {...}
  get(threadKey: string, maxChars = 200): string {...}
  clear(threadKey: string): void {...}  // on turn end
}
```

`get()` returns the last ~200 chars of broadcast text — that's
what the pivot generator prefills as `assistant` content.

### Pivot generator (new — `realtime/src/streaming-pivots.ts`)

Two flavors, both small LLM calls, both prefill-based:

**Trail-off (user-interrupted):**
```
system: "produce a VERY SHORT graceful trail-off (2-3 words)"
user:   "<spoken_so_far>...</spoken_so_far>
         user just spoke; acknowledge"
assistant: <spoken_tail>   ← prefill
→ outputs: "oh — what's up" / "yeah go ahead" / "sorry — what?"
```

**Result-pivot (back-mind landed):**
```
system: "you were narrating progress; a result arrived;
         continue smoothly with a 2-4 word transition, then
         deliver the result conversationally"
user:   "<spoken_so_far>...</spoken_so_far>
         <just_arrived>...</just_arrived>"
assistant: <spoken_tail>   ← prefill
→ outputs: "and—oh, here's something—turns out X..."
```

Two prompt files, ~30 LOC each.

### Event wiring (channel-orchestrator delta)

The orchestrator already emits structured events. Two new
subscriptions on the pacing layer:

1. **`bargein.received`** → cancel in-flight LLM stream, fire
   trail-off pivot, emit it to TTS, then silence.
2. **`chat.row-received` (back-mind result, when narration is
   active)** → cancel narration stream, fire result-pivot, emit
   to TTS, transition into normal banter-render flow.

Today the orchestrator already cancels in-flight banter-render
on barge-in. The new behavior is the pivot insertion before the
cancel completes.

## Phases

### Phase 1 — Measure Cartesia's pacing window

Before we build the pacing layer, we need the numbers it'll
target. Run a controlled test:

- Stream a 60-char utterance to Cartesia at various rates:
  10 chars/sec, 15 c/s, 20 c/s, 30 c/s, all-at-once
- For each, measure: time-to-first-audio, audio gaps (if any),
  buffer drain behavior on a mid-stream stop signal
- Repeat with a stop-emit signal fired at t=500ms; measure how
  much audio plays after the stop (this is the interrupt-latency
  floor — what's already buffered will play regardless)

**Deliverable:** `scripts/bench-cartesia-pacing.py` — fires
controlled streams at Cartesia voice-line, reads back audio
timing from the channel adapter's events. ~150 LOC.

**Output:** Empirical pacing window: target buffer depth,
acceptable jitter, interrupt-latency floor.

### Phase 2 — Pacing layer (no pivot yet)

Build the pacing layer purely as throttling. No pivot generation
yet. Goal: prove we can hold the TTS buffer in a narrow window
without audible artifacts.

**Deliverables:**
- `realtime/src/streaming-pipeline.ts` (new, ~200 LOC)
- `SpokenTail` tracker
- Integration into `channel-orchestrator.ts` so existing
  banter-ack and banter-render streams flow through it
- New structured-log events: `pacing.buffer-depth`,
  `pacing.emit-stalled`, `pacing.emit-resumed`
- Dashboard view: per-thread buffer depth over time (~50 LOC in
  pat-frontend)

**Acceptance:**
- E2E smoketest passes — no audio gaps, no clipping
- Real anam-web call sounds indistinguishable from main
- Dashboard shows buffer depth staying in target window

**Estimated:** ~400 LOC, 1-2 days.

### Phase 3 — Pivot generator (interrupt case)

Add the trail-off pivot for user interrupts. Result-pivot stays
deferred until this case is validated.

**Deliverables:**
- `realtime/src/prompts/pivot-trailoff.ts` (new, ~30 LOC)
- `realtime/src/streaming-pivots.ts` (new, ~100 LOC) — the
  generator function
- Channel orchestrator: on `bargein.received`, call
  `generateTrailoff(spokenTail)`, emit result to TTS, THEN
  silence
- Log event: `pivot.fired` with `kind: 'trailoff'`, latency,
  output text

**Acceptance:**
- Interrupt a narration mid-sentence on a real call
- Hear a natural trail-off (2-3 words) before silence
- Trail-off generation latency p99 < 200ms
- No double-speak (the trail-off doesn't repeat the spoken tail)

**Estimated:** ~200 LOC + prompt iteration.

### Phase 4 — Pivot generator (result-pivot case)

Add the result-pivot for back-mind-result-arriving-mid-narration.

**Deliverables:**
- `realtime/src/prompts/pivot-result.ts` (new, ~30 LOC)
- Generator extended to dispatch on event type
- Orchestrator: on chat-row-received while narration is active,
  fire result-pivot instead of standard banter-render
- Log event: `pivot.fired` with `kind: 'result'`

**Acceptance:**
- Mid-narration result arrival produces a natural seam in audio
- No double-speak (the result-pivot continues from spoken tail,
  doesn't repeat it)
- Listener perception test: utterance feels continuous, not
  spliced

**Estimated:** ~150 LOC + prompt iteration.

### Phase 5 — Speculative pre-warm (optional)

Today: when a back-mind result arrives, we fire the pivot LLM
call, wait ~100-200ms, then emit. That's audible dead air after
the spoken tail.

Speculative: when we KNOW a result is coming (e.g., on
`query-end` signal from the back-mind, before the chat row
lands), pre-fire the pivot generator with the in-flight
narration tail. When the result actually lands, we already have
the pivot ready and TTS gets a sub-50ms handoff.

Cost: one extra LLM call per back-mind query (not all of which
end with a mid-narration result). Worth it for the perceptual
seam quality.

**Estimated:** ~100 LOC, deferred until Phase 4 confirms the
non-speculative version works.

## Critical files

To create:
- `realtime/src/streaming-pipeline.ts` — pacing layer +
  SpokenTail
- `realtime/src/streaming-pivots.ts` — pivot generator
- `realtime/src/prompts/pivot-trailoff.ts`
- `realtime/src/prompts/pivot-result.ts`
- `scripts/bench-cartesia-pacing.py` — Phase 1 measurement tool

To modify:
- `realtime/src/channel-orchestrator.ts` — route deltas through
  pacing layer; subscribe to bargein + chat-row events for
  pivot dispatch
- `realtime/src/log-events.ts` — new event kinds for
  `pacing.*`, `pivot.*`
- `transports/log_events.py` — mirror new event kinds
- `pat-frontend/src/types/log-events.ts` — mirror
- Channel transports (`nanoclaw/src/channels/anam-web.ts`,
  `phone-call.ts`) — adjust streaming path to feed pacing layer

## Verification criteria

**Phase 1 (measurement):**
- Reproducible Cartesia pacing window numbers
- Target buffer depth ± tolerance documented

**Phase 2 (pacing, no pivot):**
- Real anam-web call sounds identical to main
- Buffer depth stays in [800ms, 1500ms] window 95%+ of stream
- No new audio artifacts (gaps, stutters)

**Phase 3 (trail-off):**
- Interrupt-then-trail-off produces audible 2-3 word
  acknowledgment before silence
- No double-speak across spoken_tail boundary
- Trail-off latency p99 < 200ms

**Phase 4 (result-pivot):**
- Mid-narration result produces continuous-sounding utterance
- Listener can't identify the seam between narration and result
  in blind A/B (subjective but verifiable)
- No double-speak

**Phase 5 (speculative pre-warm):**
- Pre-warm hit rate (pivot ready when result lands) > 70%
- Cost overhead < 1 extra LLM call per inbound

## Risks

1. **Pacing might starve TTS.** Too conservative an emit rate
   leaves audio gaps. Phase 1 measurement is the mitigation;
   tune target window upward if needed.

2. **Pivot generation might exceed perceptual budget.** Users
   notice latency above ~200ms on interrupt acknowledgment.
   Our test showed 35ms (trail-off) and 138ms (result-pivot) on
   Cerebras — fine. Anthropic Haiku for the same call would be
   ~600-800ms — NOT fine. The pivot generator's speed is
   provider-dependent.

3. **Spoken-tail is approximate.** Cartesia's
   `agent-text-sent` is what Cartesia logged as broadcast; the
   actual audio at the listener's ear lags by network +
   playback. So the prefill is the model's best guess at "where
   the audience is" — might be a word or two ahead. Usually
   doesn't matter (pivot phrasing tolerates small lag), but
   edge cases (very fast STT-to-TTS round trip) might land
   awkwardly.

4. **Mixed-provider story.** If front-mind ends up on a mix
   (some calls Anthropic, some elsewhere), the pivot generator
   needs both code paths. Manageable but adds surface area.

5. **The pivot LLM call is a new failure mode.** If it 5xx's,
   we hard-cut (today's behavior). Need fallback to "no pivot,
   just silence" so a pivot-generator outage doesn't break
   barge-in.

6. **Sub-word streaming on Cartesia.** Cartesia's
   `passthrough_tool` accepts character-level emits today. If
   any provider streams in larger batches (e.g., 50 tokens at a
   time), the pacing layer can break those down — but we lose
   the ability to truly stop mid-word. Probably not a problem;
   most providers stream in small chunks naturally.

## Why this is worth doing regardless of provider choice

Even if we stay on Anthropic Haiku for front-mind, the streaming
architecture lets us:

- Eliminate hard cuts on barge-in (subjective UX win)
- Smooth narration → result handoff (subjective UX win)
- Track buffer depth as a structured observability surface (debug
  win)

The pivot generation latency hurts on Haiku (600-800ms) and
makes the architecture less compelling — the trail-off would
take longer than the original narration tail itself. So this
plan is *more* valuable on a fast-tier substrate. But the
architecture transfers either way, and Phase 1-2 (pacing layer
without pivots) is useful on its own.

## Open questions

- **Cartesia buffer depth visibility.** Do we get any signal
  from Cartesia about its internal queue length, or do we have
  to estimate from `agent-text-sent` timing? Affects Phase 1
  measurement design.

- **Provider-specific prefill quirks.** Anthropic's prefill
  format vs OpenAI-compatible providers' assistant-as-last-
  message — do they produce subtly different continuations?
  Worth a side-by-side comparison once we pick a fast-tier.

- **Result-pivot prompt: who is the speaker?** When the back-mind
  result arrives, the "right" pivot voice is Pat's. But we'd be
  generating it with the same model that's doing narrator + ack.
  Does the model conflate "I was narrating" with "I have the
  result"? Test in Phase 4 — may need to clarify in the prompt.

- **What about user-interrupts-banter-ack?** The user flagged
  this as "maybe too hard" — banter-ack utterances are short
  enough that there's not much time to pivot. Phase 3 handles
  narration-interrupts; banter-ack-interrupts deferred until
  the architecture is validated.

## Dependencies

- Phase 1 can start any time — purely empirical measurement.
- Phase 2 depends on Phase 1's numbers but not on the
  Cerebras-swap plan landing.
- Phases 3+ benefit from but don't strictly require a fast-tier
  provider. On Haiku, pivot latency is ~600ms — the architecture
  still works, just less compellingly.

## Related plans

- The fast-tier substrate that makes pivot latency genuinely invisible
  is **live**: Cerebras `zai-glm-4.7` via the official SDK
  (`realtime/src/llm-provider.ts`, `reasoning_effort='none'`). Pivot LLM
  calls on this substrate measured at sub-150ms (Cerebras-direct test),
  so the architecture's "no hard cuts" promise is achievable on real
  hardware. (Supersedes the earlier `front-mind-llm-swap.md` /
  `front-mind-cerebras-swap.md` Llama-on-Groq and Cerebras-qwen notes —
  those swap chains are archived.)
