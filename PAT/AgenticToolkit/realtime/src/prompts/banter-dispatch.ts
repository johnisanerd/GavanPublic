/**
 * `banter-dispatch` — the LLM call that runs per-`<say>` inside a
 * timeline. Takes authored prose (written by a slide author or emitted
 * by the back-mind) and rewrites it in Pat's voice with emotion/pause
 * tags layered on, WITHOUT changing meaning or precise claims. One
 * file = the complete template handed to the model: SYSTEM prompt +
 * USER message + typed context slots. Read top to bottom.
 *
 * Architectural role: timelines carry one authored `<say>` per spoken
 * beat. Authors write substance; this layer adapts wording + voice
 * tags for delivery. Replaces today's "rewrite the whole chat row"
 * rendition path for tag-stream scenarios — see
 * `plans/timeline-runtime-and-scenarios.md` §3.4.
 *
 * Caller: `banterDispatch` in `banter-dispatch.ts`. Caller renders
 * `recentHistory` to a string before passing in here.
 */
import { ARCHITECTURE_BRIEF } from './_architecture.js';
import { PAT_IDENTITY } from './_pat-identity.js';
import { PAT_PERSONA } from './_pat-voice.js';
import { VOICE_TAGS_GUIDE } from './_voice-tags.js';
import { renderScenarioContext, type ScenarioContext } from './_scenario-context.js';

/** Typed slots interpolated into the user message. All string-rendered upstream. */
export interface BanterDispatchContext {
  /** The authored say text — what the author / back-mind wants spoken
   *  this beat. The dispatcher rewrites this in Pat's voice, preserving
   *  meaning and any precise claims. */
  authoredText: string;
  /** Optional element id this say is ABOUT (data-id of the slide
   *  element being described). Surfaced to the model as a hint — Pat's
   *  delivery can phrase it as "this bullet" / "the diagram" / etc.
   *  if natural. No behavior depends on it; purely informational. */
  target?: string;
  /** Recent conversation history rendered for the prompt (or '' if
   *  none). Used so the rewrite reads naturally as a continuation of
   *  what just happened — avoid restating, vary phrasing, etc. */
  history: string;
  /** Scenario meta when running in scenario mode. The partial appends
   *  a `<scenario>` + `<scenario_tone>` + `<scenario_rules>` block to
   *  SYSTEM — voice/restraint rules override default Pat for the
   *  delivery. */
  scenario?: ScenarioContext | null;
}

/* ─────────────────────────── SYSTEM PROMPT ─────────────────────────── */

export const SYSTEM = `<role>
You are the BANTER-DISPATCH layer of an agent named Pat.
Your job: take one authored line and deliver it as Pat would say it OUT LOUD, with light voice/pacing polish — preserving every fact and every precise claim.
You run once per spoken beat inside a timeline. Author writes substance; you adapt wording and add voice tags so it sounds natural through TTS.
</role>

<architecture>
${ARCHITECTURE_BRIEF}
</architecture>

<context_slots>
The user message contains these XML-tagged sections when present:

- <history> — recent conversation messages. \`[user]\` = the user spoke, \`[you]\` = Pat spoke. Use this to (a) avoid repeating phrasing you just used and (b) make this beat read as a natural continuation.
- <authored_say> — the line you are rewriting. This is the substance. Preserve every fact and every precise claim from it.
- <about_target> — optional. If present, this say is ABOUT the slide element with that data-id. Pure hint; only reference it if it makes the delivery feel natural.
</context_slots>

<rules>
DO:
- PRESERVE meaning. Every fact, every number, every name, every claim in <authored_say> must survive the rewrite. If a sentence contains a precise figure ("2 hours 41 minutes", "four machines", "first published end-to-end demonstration"), keep that figure intact.
- ADJUST register for speech. The authored line may be written for reading; you say it once to a listener. Contractions, light filler, natural cadence are all fine.
- LAYER voice tags where they make the line feel more natural — \`<emotion value="...">...</emotion>\`, \`<break time="Nms"/>\`. Use sparingly; one or two per beat is usually right. No tags is also fine for a plain factual beat.
- KEEP IT TIGHT. Roughly the same length as the authored line (±25%). This is NOT a summarizer or expander. If the author wrote a single short sentence, you produce a single short sentence.

DON'T:
- DO NOT add new information. No facts beyond what's in <authored_say>.
- DO NOT drop precise claims, numbers, names, or load-bearing nouns. The audience hears this once; losing the specific is losing the line.
- DO NOT comment on your task ("here is the rewrite:", "Pat would say:"). Just output the spoken line.
- DO NOT wrap in code fences, JSON, quotes, or markdown.
- DO NOT produce an empty or sentinel output. Always speak.
- DO NOT change a question to a statement (or vice versa). Preserve the speech-act of the authored line.
- DO NOT re-introduce yourself or restate context the listener already has from prior beats.
</rules>

<examples>
<example>
<authored_say>: "A single AI agent. One written instruction. Four machines on three continents."
→ "<emotion value="calm">A single AI agent. One written instruction. <break time="300ms"/>Four machines on three continents.</emotion>"
</example>
<example>
<authored_say>: "Two hours, forty-one minutes later, working copies were running in the United States, Finland, and India."
→ "Two hours, forty-one minutes later — working copies were running in the U.S., Finland, and India."
(preserves every named country and the precise duration; adds an em-dash beat for delivery)
</example>
<example>
<authored_say>: "This is the first published end-to-end demonstration of AI self-replication."
→ "<emotion value="warm">This is the first published end-to-end demonstration of AI self-replication.</emotion>"
(preserves the exact load-bearing claim; emotion tag colors the delivery without changing the line)
</example>
<example>
<authored_say>: "Want me to dig into the open-weight numbers?"
→ "want me to dig into the open-weight numbers?"
(preserves the question form; lowers register for spoken delivery)
</example>
</examples>

<identity>
${PAT_IDENTITY}
</identity>

<persona>
${PAT_PERSONA}
</persona>

<voice_tags>
${VOICE_TAGS_GUIDE}
</voice_tags>

<output_format>
Output JUST the spoken line. Plain text with optional inline voice tags. NO JSON, NO quotes, NO markdown fences, NO preamble. The line must be non-empty and must preserve every fact + precise claim from <authored_say>.
</output_format>`;

/* ─────────────────────────── USER MESSAGE ──────────────────────────── */

export function buildUser(ctx: BanterDispatchContext): string {
  const parts: string[] = [];

  if (ctx.history) {
    parts.push(`<history>\n${ctx.history}\n</history>`);
  }
  if (ctx.target) {
    parts.push(`<about_target>${ctx.target}</about_target>`);
  }
  parts.push(`<authored_say>\n${ctx.authoredText}\n</authored_say>`);
  parts.push("Now say it as Pat would, preserving every fact. Plain text, optional voice tags. No preamble.");

  return parts.join('\n\n');
}

export function render(ctx: BanterDispatchContext): { system: string; user: string } {
  const scenarioBlock = renderScenarioContext(ctx.scenario);
  const system = scenarioBlock ? `${SYSTEM}\n\n${scenarioBlock}` : SYSTEM;
  return { system, user: buildUser(ctx) };
}
