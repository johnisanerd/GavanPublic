/**
 * Scenario context — partial composed into every front-mind prompt
 * that runs at the channel layer (banter-ack, banter-narration,
 * banter-render, request-layer). When a session is in scenario mode
 * (messaging-group platform_id has `:scenario-<slug>` in it), the
 * channel orchestrator loads packet meta from disk and threads it
 * through to each LLM call site as a `ScenarioContext`.
 *
 * Why this file exists: edit one place to change how all front-mind
 * layers behave in scenarios. The text below is the source of truth
 * for what front-mind knows when running a prepared experience.
 *
 * Caller renders it once via `renderScenarioContext(ctx)` and
 * embeds the result inside the SYSTEM prompt of each consumer
 * (banter-ack.ts, banter-narration.ts, banter-render.ts,
 * request-layer.ts).
 *
 * When `ctx` is null/undefined, the renderer returns the empty
 * string — non-scenario sessions are completely unaffected.
 */

export interface ScenarioContext {
  /** Stable kebab-case identifier for this scenario. */
  slug: string;
  /** Scenario kind — `presentation` today; future kinds extend. */
  kind: 'presentation' | string;
  /** Human-readable title from packet/manifest.yaml. */
  title: string;
  /** Audience descriptor — "Senate staffer", "ML researcher", etc. */
  audience?: string;
  /** Per-scenario persona name (overrides default Pat). */
  persona_name?: string;
  /** Total slide count (presentation kind). */
  slide_count?: number;
  /** Current cursor 1-indexed (read from packet/.cursor). */
  current_slide?: number;
  /** Verbatim tone guidance from packet/tone.md, if present.
   *  Single source of truth for restraint rules, voice, what to
   *  avoid. Markdown allowed. */
  tone?: string;
  /** Whether delivery has begun (audience_ready fired). Pre-delivery
   *  the agent is in setup mode and shouldn't start the script. */
  delivery_started?: boolean;
  /** PAT Phase 6: the CURRENT slide's authored timeline as the raw
   *  `<timeline>...</timeline>` XML extracted by `extract.ts`. The
   *  orchestrator hydrates `<timeline_span from="N" to="M"/>` against
   *  this string: parse, take actions N..M, splice inline. When unset
   *  (legacy YAML packets without an authored timeline), span emissions
   *  emit a warning and are skipped. */
  current_slide_authored_timeline?: string;
  /** PAT: tag-stream mode — whether this scenario emits tag streams
   *  in chat rows (banter-render is bypassed) versus the legacy
   *  send_message-per-slide rendition path. Resolver sets this based
   *  on the packet's manifest (eventually) or a per-channel flag.
   *  Default false to keep existing scenarios behaving unchanged. */
  tag_stream_enabled?: boolean;
}

/**
 * Render the scenario context for inclusion in a front-mind SYSTEM
 * prompt. Returns '' when ctx is null/undefined (non-scenario
 * session). Wraps every section in XML so the model can dispatch
 * on the tag rather than guess from prose.
 */
export function renderScenarioContext(ctx: ScenarioContext | null | undefined): string {
  if (!ctx) return '';

  const meta: string[] = [];
  meta.push(`slug: ${ctx.slug}`);
  meta.push(`kind: ${ctx.kind}`);
  meta.push(`title: ${ctx.title}`);
  if (ctx.audience) meta.push(`audience: ${ctx.audience}`);
  if (ctx.persona_name) meta.push(`persona: ${ctx.persona_name}`);
  if (typeof ctx.slide_count === 'number') {
    const cur = ctx.current_slide ?? 1;
    meta.push(`cursor: slide ${cur} of ${ctx.slide_count}`);
  }
  meta.push(`delivery_started: ${ctx.delivery_started ? 'yes' : 'no'}`);

  const parts: string[] = [];
  parts.push(`<scenario>`);
  parts.push(meta.map((line) => `  ${line}`).join('\n'));
  parts.push(`</scenario>`);

  if (ctx.tone) {
    parts.push(`\n<scenario_tone>\n${ctx.tone.trim()}\n</scenario_tone>`);
  }

  parts.push(`\n<scenario_rules>`);
  parts.push(`This session is a prepared scenario (not a generic Pat conversation). The full briefing content (slides, off-script notes, FAQ, deep context) lives in the back-mind container's workspace; the back-mind has been provisioned to deliver it.

Your job at the channel/front-mind layer:

- **Stay in character.** When persona is set above, speak AS that persona. Otherwise speak as the default voice, but acknowledge you're presenting (don't say "I'm Pat, not the presenter").
- **Don't improvise the script.** The slides and spoken script are authored. You shouldn't try to invent the briefing's content yourself — that's the back-mind's job. If asked about content you don't have at front-mind layer, defer to back-mind.
- **Pre-delivery vs in-delivery matters.** When delivery_started is "no", the operator is setting up; greet the operator, confirm setup, prompt them to say when audience is ready. When delivery_started is "yes", you are mid-presentation; banter responses should fit the talk's flow (acks, brief clarifications), not chatty asides.
- **"Begin" / "go ahead" / "audience is ready" → these are SCENARIO CUES, not chitchat.** They should wake the back-mind to start delivery. The request-layer should forward, not noop.
- **Tone overrides default voice.** When scenario_tone is set above, those rules take precedence over default voice rules for this session. Restraint, formality, audience-specific guidance all live there.

**Audience Q&A — be SHORT, never start the answer.**

When the audience asks a substantive content question (anything that the back-mind would need to answer with packet material — "how did it X", "what about Y", "can you explain Z"), your banter reply MUST be a single short acknowledgment fragment. The back-mind is about to answer; if you start the answer too, the audience hears the same opener twice in two voices and it feels like Pat just said the same thing twice.

GOOD scenario-Q&A acks (one short phrase, ≤8 words, no commitments about content):
- "good question — one sec"
- "lemme pull that up"
- "hang on, getting that"
- "yeah, hold on"
- "good one — back in a moment"

BAD scenario-Q&A acks (starts the answer, narrates what the back-mind will say, or telegraphs slide content):
- "good question — that's slide two, where we walk through the attack surface"
- "yeah, the agent used SQL injection and a few other vulnerabilities…"
- "let me get there and show you exactly how it found the vulnerability"
- "great, that's covered in the next section — I'll go through the four vulnerabilities one by one"

Do not narrate what the back-mind is about to do. Do not preview slide topics. Do not summarize the answer. A short fragment is enough; the back-mind owns the substance.`);
  parts.push(`</scenario_rules>`);

  return parts.join('\n');
}
