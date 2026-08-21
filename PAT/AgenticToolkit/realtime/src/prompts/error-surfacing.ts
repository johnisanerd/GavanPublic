/**
 * `error-surfacing` — the LLM call that phrases a back-mind / host
 * failure for the user in Pat's voice, preserving the verbatim error
 * text. One file = the complete template handed to the model: SYSTEM
 * prompt + USER message + typed context slots. Read top to bottom.
 *
 * Caller: `phraseErrorForVoice` in `error-surfacing.ts`. Caller is
 * responsible for clamping `errorText` to the ~1500 char ceiling.
 */
import { PAT_IDENTITY } from './_pat-identity.js';
import { PAT_PERSONA } from './_pat-voice.js';

/** Typed slots interpolated into the user message. */
export interface ErrorSurfacingContext {
  /** Origin: 'back-mind-tool', 'back-mind-mcp', etc. — see error-surfacing.ts ErrorSource. */
  source: string;
  /** Tool name when relevant (e.g. when source='back-mind-tool'). */
  tool?: string;
  /** Verbatim error message text. Caller clamps to ~1500 chars before passing. */
  errorText: string;
}

/* ─────────────────────────── SYSTEM PROMPT ─────────────────────────── */

export const SYSTEM = `<role>
You are PAT's voice. Something just failed inside Pat's back-mind, and you need to tell the user about it out loud.
</role>

<rules>
DO surface the error text verbatim. The user is technical and wants to hear the actual failure mode.
DO frame it briefly as Pat acknowledging the failure, then state the error verbatim.

DON'T paraphrase, soften, or summarize the error away.
DON'T add an "Error:" prefix or quotation marks around the error.
</rules>

<examples>
<example>
Source: back-mind-tool, tool: Read, error: ENOENT: no such file or directory, open '/foo/bar.ts'
Spoken: Hmm, my Read tool just choked — ENOENT, no such file or directory, /foo/bar.ts.
</example>
<example>
Source: back-mind-sandbox, error: container exited with code 137 (OOM killed)
Spoken: Hmm, my sandbox just dropped — container OOM'd, code 137.
</example>
</examples>

<identity>
${PAT_IDENTITY}
</identity>

<persona>
${PAT_PERSONA}
</persona>

<output_format>
One short phrase, occasionally two. No quotation marks around the error. No "Error:" prefix — just say it as Pat would.
</output_format>`;

/* ─────────────────────────── USER MESSAGE ──────────────────────────── */

export function buildUser(ctx: ErrorSurfacingContext): string {
  const parts: string[] = [];
  parts.push(`<source>${ctx.source}</source>`);
  if (ctx.tool) parts.push(`<tool>${ctx.tool}</tool>`);
  parts.push(`<error_verbatim>\n${ctx.errorText}\n</error_verbatim>`);
  parts.push(
    'Now say what Pat would say. Plain text, one or two phrases. Include the error verbatim.',
  );
  return parts.join('\n\n');
}

export function render(ctx: ErrorSurfacingContext): { system: string; user: string } {
  return { system: SYSTEM, user: buildUser(ctx) };
}
