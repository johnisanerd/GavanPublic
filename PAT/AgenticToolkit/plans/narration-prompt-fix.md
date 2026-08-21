# Narration prompt fix

**Status:** planned 2026-05-18. Not started. Awaiting user bundle decision.

## Context

The narration brain (Haiku, fires on a cadence to update the user on
back-mind progress) is hallucinating tool events the audience hears as
TTS. Observed output during the AI-self-replication demo:

> "task start, task demo delivery, tool pre-tool load presentation file
>  demo dot pptx, loading up the slides now."

Two distinct failure modes, both prompt-level:

1. **Input template leak.** The narrator's prompt structure includes a
   `<current_back_mind_progress>` block in its SYSTEM input. The model
   sometimes echoes that block back into its OUTPUT — verbatim XML and
   all. The current `<output_format>` rules say "no markdown fences" but
   don't ban emitting input templates.
2. **Hallucinated tool events.** When the back-mind hasn't fired any real
   `tool-pre`/`tool-post` events yet (e.g. mid-thinking, mid-streaming
   tokens), the narrator invents plausible-sounding ones to fill the
   silence. The prompt doesn't have a "if no real events, output
   silence" instruction.

The timeline state machine (see `plans/timeline-architecture.md`)
prevents narration during delivery mode entirely — which covers ~80% of
where this is currently noticed. This plan handles the residual
conversing-mode case, where the narrator still ticks but should never
emit XML or fabricate events.

## Architecture

Two changes, both small, both orthogonal to the state machine:

### Prompt tightening (`realtime/src/prompts/banter-narration.ts`)

Add to `<output_format>`:

- **Never emit XML tags or template markers in output.** The
  `<current_back_mind_progress>` block in input is data for you to read,
  not text to echo. Output is plain prose only.
- **If no real tool events have fired, output the single token
  `<silent>`.** Downstream interprets this as "do not narrate this tick"
  and suppresses TTS. Do not invent events.
- **Bad output examples** (forbidden):
  - `<current_back_mind_progress>...` (template echo)
  - `task start, task demo delivery, tool pre...` (template paraphrase)
  - `loading up the slides now` (fabricated event)
- **Good output examples** when no events present:
  - `<silent>` (silence)

### Defensive XML-strip (`realtime/src/streaming-primitive.ts` or callsite)

Belt-and-suspenders: strip any leading-XML-or-angle-bracketed content
from narrator output before broadcast. If the stripped output is empty or
only whitespace, treat as `<silent>`. Catches the case where the prompt
fails to suppress the leak.

```ts
function stripXmlPreamble(text: string): string {
  // Remove leading XML tags, template markers, and whitespace.
  return text.replace(/^(\s*<[^>]+>\s*)+/, '').trim();
}
```

Wire in the narrator's broadcast path right before the SSE emit. Log a
`warn`-level `narration.xml-stripped` event when triggered so we can
catch prompt regressions.

## Phases

**Phase 1 — Prompt tightening (~10 LOC of prompt text, 30min)**
- Edit `realtime/src/prompts/banter-narration.ts` `<output_format>` block.
- Edit prompt sample test (if exists) to assert `<silent>` output on
  empty-events input.

**Phase 2 — Defensive XML-strip (~15 LOC, 30min)**
- Add helper in narration broadcast path.
- New `narration.xml-stripped` log event (warn-level) — declare in
  `realtime/src/log-events.ts` + Python mirror.
- Unit test on the stripper.

**Phase 3 — Manual verification (15min)**
- Drive a conversing-mode session, force the narrator to tick with empty
  events, confirm `<silent>` output (no TTS).
- Drive a conversing-mode session with real tool events, confirm
  narration fires normally.

**Total: ~1.5h.**

## Critical files

- `realtime/src/prompts/banter-narration.ts`
- `realtime/src/narration.ts` (broadcast path)
- `realtime/src/log-events.ts` (new `narration.xml-stripped` kind)
- `transports/log_events.py` (mirror)
- `pat-frontend/src/types/log-events.ts` (mirror)

## Verification

- Unit: stripper handles leading XML, empty output, mixed content.
- Unit: narrator-prompt-test (if it exists) asserts `<silent>` on
  empty-events input via real Haiku call.
- E2E (gated on trace test harness): drive a conversing-mode session, no
  `narration.xml-stripped` events fire during a healthy run; force a
  prompt regression and confirm the stripper catches it.
- Manual: listen to a demo with narration enabled; confirm no XML
  artifacts or fabricated tool descriptions.

## Open questions

- **Bundle with `plans/timeline-architecture.md`?** Same prompt area,
  same risk surface (narration layer). Splitting means two passes.
  Bundling means one larger PR. User to decide.
- **Should `<silent>` be a structural keyword or a magic string?** Magic
  string is cheapest. A structural choice (e.g. zero-length output) is
  cleaner but couples prompt + parser. Lean magic-string.
