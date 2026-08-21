# Voice agent latency + UX research — reference notes

Reference material from a 2026-05-23 research sweep on what
production voice-agent stacks target for latency and what UX
patterns the field reports as load-bearing. **The first half is
findings with sources.** The second half is a clearly-separated
suggestions section — those are tentative, humble, and not a
roadmap.

---

## Part I — Findings

### Latency budgets

Numbers below are **time-to-first-audio (TTFA)**: from user
end-of-speech to first audible byte at the user's ear. This is
the user-perceived metric, NOT TTFC at any individual layer.

| Threshold | Perceptual quality |
|---|---|
| < 200 ms | Human turn-taking baseline |
| < 300 ms | "Instantaneous," natural flow |
| 300–800 ms | Responsive sweet spot |
| 800–1200 ms | Noticeable but functional |
| > 1500 ms | Conversation breakdown |
| > 4000 ms | Hard quality-of-experience degradation |

**Component budgets** that production stacks target:

| Component | Optimized target |
|---|---|
| STT streaming partials | 100–200 ms |
| LLM TTFT (fast tier) | 200–500 ms |
| TTS time-to-first-audio | Cartesia Sonic 40–90 ms; ElevenLabs Flash 75 ms; Deepgram Aura-2 200 ms |
| Turn detection | 200–400 ms |
| Regional network | 50–150 ms |

**Production reality vs targets.** Sierra and Hamming, reporting
on millions of calls in 2025-2026, see p50 ≈ 1.4–1.7s end-to-end,
p95 ≈ 4.3–5.4s, p99 ≈ 8–15s. The component-level "optimized
targets" stack cleanly only when every layer is on its hot path
— in practice tails dominate.

### UX patterns documented as working in production

These are listed because production teams or papers explicitly
report them. Not endorsements — see Part II for context.

**Adaptive interruption (acoustic classifier).** Pure VAD has high
false-positive rate from backchannel ("mm-hmm"), coughs, TV. LiveKit
ships a CNN-on-first-216ms classifier that achieves 86% precision /
100% recall, rejecting ~51% of VAD-detected events as not-real
interruptions. Decision happens at the audio layer, before any
barge-in event fires downstream.

**`min_interruption_duration` + `false_interruption_timeout` with
resume.** LiveKit defaults: require ≥500 ms of detected user speech
before triggering interruption; if no transcript materializes
within 2 s, resume the original utterance from where it stopped.
Treats short noise as a false positive without needing a smarter
classifier.

**Speculative tool calling / phased filler.** Two parallel tracks:
filler (low-content TTS) streams audio while the actual reasoning /
tool call runs silently. Sierra calls this "interim responses while
longer processing happens." getstream.io documents hiding 1.5–2s
of back-mind latency under continuous audio.

**Streaming JSON parsing for tool/routing decisions.** Partial-JSON
parsers (vectorjson, partial-json-parser) extract complete
key-value pairs from a streaming LLM response before `}` lands.
Fire downstream action on the first complete `{intent, target}`
keys; saves the tail-latency of the JSON close (often 100–400 ms
per turn).

**Semantic / smart turn detection.** Pure VAD calls "I understand
your point, but…" an end-of-turn. LiveKit's transformer turn
detector and Daily Smart Turn v2 use semantic + prosodic cues to
distinguish real ends from mid-utterance pauses. Multiple sources
flag this as the largest perceived-latency win remaining once the
LLM tier is already fast.

### Anti-patterns reported by production teams

**Promise/action mismatch.** ElevenLabs FDE team flags "tool
misuse — incorrect invocation timing or missing calls when
needed" as a top-three failure mode. The structural fix multiple
sources converge on: the conversational layer (ack/filler) should
never name a specific action; only the routing decision layer
gets to commit to one.

**Hard interrupt without context.** Production teams report LLMs
resuming after interruption as though the user heard the full
utterance — leading to double-commit. The fix is to track what was
actually broadcast (TTS-played position, not LLM-emitted text),
and include `[interrupted at: "…last spoken phrase"]` in the next
LLM context.

**Skipping staged rollouts.** ElevenLabs: teams patching one bad
call without re-running a regression simulation set cause
behavior regressions in previously-stable areas. The pattern that
holds up is a small replay suite of recorded calls run before any
prompt or model swap.

### Stack-specific notes

These come from the same research sweep, cross-referenced with
PAT's existing auto-memory entries.

- **Cartesia Sonic 3** measured at ~188 ms TTFT p50 by independent
  benchmarks (Gradium 2026); their own docs claim 40–90 ms.
  Different methodology — the gap is the audio-prep + first-byte
  shipping time.
- **Cartesia's queue is opaque** — there's no built-in
  "how many ms of audio are buffered" API. Estimating buffer depth
  requires stamping submitted chunks and tracking confirmed-played
  events (if exposed) or cumulative duration of acked chunks.
- **Groq streaming** delivers tokens in large bursts (chunk size
  considerably bigger than Anthropic) because the underlying
  generation rate so far exceeds network framing. Measured during
  PAT's 2026-05-22 head-to-head: 9 chunks of ~5 chars each over
  ~270 ms vs Haiku's 2 chunks of ~25 chars with 145 ms inter-chunk
  gap. Downstream consumers see "all-at-once" rather than smooth
  tokens.
- **Anam endOfSpeech is the audio-end signal** (corroborates the
  PAT memory note from 2026-05-20). The earlier "endOfSpeech fires
  early" interpretation may have been confounded by pacing-layer
  queuing past the endOfSpeech event.
- **Groq supports `response_format: json_schema`** with strict
  validation (per Groq docs). OpenRouter passes this through.

### Sources

- [Hamming AI — Voice AI Latency](https://hamming.ai/resources/voice-ai-latency-whats-fast-whats-slow-how-to-fix-it)
- [Sierra — Engineering low-latency voice agents](https://sierra.ai/blog/voice-latency)
- [Cerebrium — Global 500ms voice agent](https://cerebrium.ai/blog/deploying-a-global-scale-ai-voice-agent-with-500ms-latency)
- [LiveKit — Adaptive Interruption Handling](https://livekit.com/blog/adaptive-interruption-handling)
- [LiveKit — Turn Detection for Voice Agents](https://livekit.com/blog/turn-detection-voice-agents-vad-endpointing-model-based-detection)
- [Daily.co — Smart Turn v2](https://www.daily.co/blog/smart-turn-v2-faster-inference-and-13-new-languages-for-voice-ai/)
- [Speechmatics — Semantic turn detection](https://blog.speechmatics.com/semantic-turn-detection)
- [GetStream — Speculative tool calling for voice](https://getstream.io/blog/speculative-tool-calling-voice/)
- [Mitigating Response Delays with Filler — arXiv 2507.22352](https://arxiv.org/pdf/2507.22352)
- [PredGen paper — arXiv 2506.15556](https://arxiv.org/html/2506.15556)
- [ElevenLabs FDE — Building voice agents that last](https://elevenlabs.io/blog/building-voice-agents-that-last-some-lessons-learned-from-forward-deployed-engineering)
- [Cekura — Why voice AI fails in production](https://www.cekura.ai/blogs/the-silence-between-words-architecting-resilient-voice-ai-systems)
- [Retell — Hallucinations in voice agents](https://www.retellai.com/blog/the-ultimate-guide-to-ai-hallucinations-in-voice-agents-and-how-to-mitigate-them)
- [Cartesia Sonic 3 docs](https://docs.cartesia.ai/build-with-cartesia/tts-models/latest)
- [Gradium — Low-latency TTS benchmark 2026](https://gradium.ai/content/best-low-latency-tts-apis-2026)
- [Groq — Optimizing latency](https://console.groq.com/docs/production-readiness/optimizing-latency)
- [USPTO 11373635 — Faded system utterance on interruption](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/11373635)
- [vectorjson — Streaming JSON parser](https://github.com/teamchong/vectorjson)
- [partial-json-parser](https://github.com/promplate/partial-json-parser)

---

## Part II — Suggestions for PAT (tentative)

This section is **distinct from the findings above**. The items
here are my reading of how the research might apply to PAT given
the architecture as of 2026-05-23. None of them are required;
each one is a small bet that could turn out wrong. Most haven't
been tested against PAT's actual call traces.

### What the research seems to most clearly apply to

Two areas where the findings line up with pain points we've
already identified in PAT:

- **Hard cuts on barge-in (PAT pain point).** The research's
  "adaptive interruption" pattern + the "false-interruption
  resume" pattern are both addressing the same family of issues.
  Whether either is the right shape for PAT specifically is an
  open question — we haven't measured how often our barge-in
  fires on backchannel vs real interruption.

- **Banter promising what the back-mind doesn't deliver
  (PAT pain point).** The research's "constrain banter to
  acknowledgment-only verbs" pattern is essentially the same
  framing as the contract we just tightened in `prompts/banter-ack.ts`
  and `prompts/request-layer.ts` on 2026-05-22. So we already
  partially adopted this. The remaining open question is whether
  the prompt-level fix is sufficient or whether we eventually want
  a structural constraint (e.g., banter prompt has zero
  action-naming verbs at all and only knows ack vocabulary).

### Things that might be worth measuring before deciding

Several of the research suggestions assume facts about PAT that we
haven't actually measured:

- **Pacing target window.** The research suggests 300–500 ms of
  pre-buffered audio as a sweet spot. We don't know what PAT's
  current Cartesia buffer behavior actually is. Before designing
  to a target, we'd want to instrument the existing path — what
  does Cartesia tell us via `cartesia.agent-text-sent` vs actual
  audio at the listener? Without that we'd be designing toward
  a number that may not match our reality.

- **Whether banter-act-then-back-mind-dispatch is really the
  bottleneck.** The research talks a lot about end-to-end TTFA.
  Our 224 ms front-mind TTFC is great, but our total
  end-of-speech-to-first-audio is unknown. STT partials + LLM +
  TTS + network all stack. A real measurement on a recent call
  would clarify whether the front-mind swap actually moved the
  user-perceived metric or just one component.

- **Whether the narrator XML-leak is a model bug or a prompt
  bug.** The research's suggestion (switch to `json_schema`
  structured output) assumes the issue is "the model occasionally
  echoes wrappers because they're allowed in its output space."
  But we've never confirmed whether it's that, or a different
  failure mode (over-truncated context, wrong base model
  behavior, prompt instruction conflict). A diagnostic pass
  reading 5–10 recent leak events would tell us before we invest
  in the fix.

### Patterns worth understanding better before adopting

These are intriguing but I'm not confident they fit PAT's shape:

- **Streaming JSON parsing for request-layer.** The research says
  this saves 100–400 ms per turn. For PAT, request-layer fires
  AFTER banter-ack, and the back-mind dispatch happens at the end
  of its turn. The savings only matter if the back-mind's spawn
  latency is on the critical path. If banter is still speaking
  when the JSON parse completes, the saved 200 ms is invisible.
  Need to look at real call traces to see whether request-layer
  closure is actually gating anything.

- **LiveKit-style turn detection** (transformer-based,
  semantic + prosodic). Big perceived-latency win in their
  benchmarks, but moving turn detection into the audio path
  introduces a new model dependency. For PAT today, our STT
  (Cartesia, Deepgram per channel) handles turn detection. Worth
  understanding what we'd actually swap and whether the
  improvement justifies the new component.

- **Warm-up pings on idle calls.** The research suggests these
  keep prefill caches hot. With OpenRouter routing to Groq, we
  don't control the infra and warm-up may or may not help. Cheap
  to test if we're curious; unclear whether it materially moves
  the metric.

### Things the research suggests that I'd be cautious about

- **Speculative tool calling / phased filler at the architectural
  level.** PAT already does something like this (banter speaks
  while back-mind processes), but the research's stronger version
  (start the back-mind work *before* the routing decision lands)
  changes the structural relationship between layers. That's a
  significant rework of how `handleUserMessage` flows. Hard to
  retrofit cleanly into the current channel orchestrator. Worth
  understanding the win before designing for it.

- **TTS-played-bytes tracking.** Useful in principle (we'd know
  what the user actually heard, not just what we sent). But
  Cartesia doesn't natively expose this and the estimation logic
  (cumulative duration of acked chunks, with playback-rate
  assumptions) is error-prone. The marginal value vs the
  complexity isn't obvious without a specific bug it would fix.

### Open question I genuinely don't know the answer to

The research consistently treats `min_interruption_duration` as
the right knob — wait some ms before triggering barge-in to filter
false positives. But PAT's user experience prizes responsiveness;
adding 500 ms of "is this really an interruption" before doing
anything would be felt as the agent being slow to notice the user.
Whether the research-favored tradeoff (false positives more
expensive than slow response) matches PAT's tradeoff is unclear.
Probably worth instrumenting before committing either way.

### What's NOT a suggestion

The research recommends a number of things I haven't included
above because they don't seem to fit PAT specifically, or because
they're things we'd want to validate in a different context:

- Migrating to LiveKit as a framework — we have our own
  orchestrator
- Replacing Cartesia — the Sonic/Sonic-3 numbers are competitive
  with what the research benchmarks
- Adding a separate critic LLM in CI to check banter↔routing
  consistency — interesting but the validation effort exceeds the
  bug volume we're seeing
- Sub-utterance backchannels ("mm-hm" while user speaks) — the
  research mentions these but doesn't endorse them for non-human
  voice agents; the field seems split on whether they help or feel
  uncanny

These could come back into scope later but they're outside the
"clearly applicable to PAT today" set.
