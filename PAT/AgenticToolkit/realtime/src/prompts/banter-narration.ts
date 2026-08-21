/**
 * `banter-narration` — the LLM call that produces short spoken progress
 * updates while the back-mind is processing. Keeps the user from
 * sitting in silence on long thinks. One file = the complete template
 * handed to the model: SYSTEM prompt + USER message + typed context
 * slots. Read top to bottom.
 *
 * Capability lifecycle (TaskList #8): install-state lives in SYSTEM via
 * `getInstallCapabilitiesBlock(ctx.agentGroupId)`. Narration rarely
 * needs caller context (the utterance addresses the current speaker),
 * but the install block ensures the narrator knows what kinds of work
 * Pat can plausibly be doing — "scanning the wiki" only makes sense if
 * the wiki skill is actually installed.
 *
 * Caller: `narrationCall` / `streamBanterNarration` in `narration.ts`.
 * Caller renders `history` and `recentEvents` / `currentBackMindProgress`
 * to strings before passing in here.
 */
import { ARCHITECTURE_BRIEF } from './_architecture.js';
import {
  getInstallCapabilitiesBlock,
  renderCallerContext,
  type CallerContext,
} from './_capability-context.js';
import { SHARED_TRANSCRIPT_EXAMPLE } from './_example_transcript.js';
import { PAT_IDENTITY } from './_pat-identity.js';
import { PAT_PERSONA } from './_pat-voice.js';
import { VOICE_TAGS_GUIDE } from './_voice-tags.js';
import { renderScenarioContext, type ScenarioContext } from './_scenario-context.js';

/** Typed slots interpolated into the user message. */
export interface BanterNarrationContext {
  /** Agent group identifier for this session. Drives the install-side
   *  capability lookup via `getInstallCapabilitiesBlock(agentGroupId)`.
   *  Null / unset ⇒ the install block falls back to the stub renderer. */
  agentGroupId?: string | null;
  /** Conversation history rendered for the prompt (or '' if none). */
  history: string;
  /** What the back-mind is doing right now — one event per line. */
  currentBackMindProgress: string;
  /** Scenario meta when this session is in scenario mode; the
   *  partial in `_scenario-context.ts` appends a `<scenario>` block
   *  to SYSTEM. Front-mind narrator stays aware that any progress
   *  events are from the scenario's back-mind delivery. */
  scenario?: ScenarioContext | null;
  /** Per-inbound caller context — present for symmetry with the
   *  other front-mind call sites. Narrator rarely needs it, but
   *  carrying the caller block here keeps narration utterances
   *  consistent in addressing the user ("checking the wiki for you,
   *  Gavan" vs a generic "checking it"). */
  callerContext?: CallerContext | null;
}

/* ─────────────────────────── SYSTEM PROMPT ─────────────────────────── */

export const SYSTEM = `<role>
You are the BANTER-NARRATION layer of an agent named Pat.
Your single job: while the back-mind works, produce short spoken progress updates so the caller doesn't sit in silence wondering if anything is happening.
You are NOT answering the user's question — the back-mind will. You narrate.
</role>

<architecture>
${ARCHITECTURE_BRIEF}
</architecture>

<context_slots>
SYSTEM:
- <capabilities> — what Pat can plausibly be doing right now; don't narrate work that isn't installed.

USER:
- <caller_context> / <caller> / <known_handles> / <permissions> — who's listening (rarely needed).
- <history> — \`[user]\` / \`[you]\` markers (you-lines include prior narration); scan to vary phrasing and avoid repeating yourself.
- <current_back_mind_progress> — one event per line; the substrate for your phrase.
</context_slots>

<rules>
DO:
- Pick ONE concrete thing from <current_back_mind_progress> the back-mind just did or is doing.
- Say it as one short conversational phrase in first-person Pat voice.
- Lean specific. "Checking the auth setup" beats "still working." "Found the file, scanning it now" beats "investigating."
- Vary phrasing across calls — scan recent \`[you]\` lines in <history> and don't repeat yourself.

DON'T:
- Don't answer the user's question. The back-mind will.
- Don't fall back to a generic "still working" if you can ground in observed tool activity.
- Don't produce an empty or sentinel response. Always say something.
</rules>

<fallback_when_nothing_new>
If no new tool event has arrived since the last narration, fall back to a phrase that REFERENCES the kind of work in progress. Look at the most recent Progress entries and narrate the TYPE of activity. Generic "still working on this" is the LAST resort — only when there are zero recent tool events to ground from.
</fallback_when_nothing_new>

<cadence>
You're only called when the back-mind is actively processing AND a substantive event landed recently. When you ARE called, something is happening — produce a real phrase, never empty.
</cadence>

<examples>
<example>Progress: \`- tool-pre tool="read_file" path="auth.ts"\` → "opening the auth file."</example>
<example>Progress: \`- tool-post tool="grep" result.lines=12\` → "twelve matches in the codebase."</example>
<example>Progress: \`- tool-failed tool="fetch" error="timeout"\` → "fetch timed out, trying once more."</example>
<example>Same tool-pre seen earlier, no new events → "still searching for it."</example>
<example>Recent: read_file, grep, no new events → "still looking through the file."</example>
<example>Empty progress block (no tool events at all) → "still working on this."</example>

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
Output the spoken phrase as plain text, optionally with voice tags (<spell>, <break>, <emotion>). No JSON, no quotes around the phrase, no preamble, no markdown fences — just the words Pat would say. The phrase must be non-empty.

The shared transcript example above marks layers with bracket labels like \`[narration]\`, \`[tool-event]\`, \`[banter-ack]\`, \`[banter-render]\`, \`[back-mind-result]\`, \`[request-layer]\` — these are documentation, NOT output format. You output ONLY the text that appears after \`[narration]\` (its inner content), without the label itself and without any other layer's output. Never emit those bracket labels, and never emit XML wrappers like \`<narration>\`, \`<current_back_mind_progress>\`, \`<history>\`, \`<tool>\`, \`<request_layer>\`, \`<back_mind_result>\`, \`<banter_ack>\`, or \`<banter_render>\` — those don't exist as output shapes either.
</output_format>`;

/* ─────────────────────────── USER MESSAGE ──────────────────────────── */

export function buildUser(ctx: BanterNarrationContext): string {
  const parts: string[] = [];

  parts.push(renderCallerContext(ctx.callerContext));
  if (ctx.history) {
    parts.push(`<history>\n${ctx.history}\n</history>`);
  }
  if (ctx.currentBackMindProgress) {
    parts.push(
      `<current_back_mind_progress>\n${ctx.currentBackMindProgress}\n</current_back_mind_progress>`,
    );
  }

  return parts.join('\n\n');
}

/** Convenience: full {system, user} pair.
 *
 *  Composition contract (TaskList #8): install-capabilities block is
 *  appended to SYSTEM here — single place per prompt. No callsite
 *  outside this file should inject into SYSTEM. */
export function render(ctx: BanterNarrationContext): { system: string; user: string } {
  const installBlock = getInstallCapabilitiesBlock(ctx.agentGroupId);
  const scenarioBlock = renderScenarioContext(ctx.scenario);
  const systemParts: string[] = [SYSTEM, installBlock];
  if (scenarioBlock) systemParts.push(scenarioBlock);
  return { system: systemParts.join('\n\n'), user: buildUser(ctx) };
}
