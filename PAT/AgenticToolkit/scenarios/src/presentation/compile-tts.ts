/**
 * compileTtsSource — produce the spoken-text payload the presenter
 * agent uses.
 *
 * Per the suggestion-not-hardwired design (see ./slide-spec.ts
 * StageDirection doc + the present-slides SKILL.md), the agent
 * receives `notes.spoken` AS-IS plus the parallel
 * `stage_directions[]` array and decides timing itself. The compile
 * step's main jobs are:
 *
 *   1. Resolve stage anchors — produce a list of { position, action,
 *      args } so the agent knows exactly which byte offset each
 *      suggested beat lives at. Useful for prompt construction.
 *   2. Inject SSML pause breaks at paragraph boundaries for natural
 *      pacing. Both Cartesia and Anam pass SSML through; engines
 *      that don't simply render the tag as literal text — minor
 *      pollution we accept for now.
 *
 * Optional "strict marker" mode (off by default): re-introduces the
 * inline `{{stage:NAME:IDX}}` marker token that the runtime channel
 * can parse and fire deterministically. Use only when verbatim
 * delivery is hard-required (testing, demo recording).
 */
import type { SlideSpec, StageDirection } from './slide-spec.js';

const PARAGRAPH_BREAK = '\n\n';
const SSML_PARAGRAPH_BREAK = '<break time="700ms"/>';
const SSML_STAGE_BREAK = '<break time="500ms"/>';

export interface CompileTtsError {
  code:
    | 'anchor_not_found'
    | 'occurrence_out_of_range';
  message: string;
  /** Index into `notes.stage_directions[]` that failed. */
  stage_index: number;
}

export interface ResolvedStage {
  /** Byte offset in `notes.spoken` immediately after the anchored
   *  substring's last character. */
  position: number;
  action: string;
  args?: Record<string, unknown>;
  fireAndForget?: boolean;
  /** Index into the original `stage_directions[]` array. */
  stage_index: number;
}

export interface CompileTtsResult {
  ok: boolean;
  /** Spoken text — clean by default. In strict mode includes
   *  `{{stage:NAME:IDX}}` markers inline. */
  text: string;
  /** Resolved stages with concrete byte offsets in `text`. Even in
   *  the non-strict (default) mode, the agent can use these offsets
   *  to plan its own action timing. */
  stages: ResolvedStage[];
  errors: CompileTtsError[];
}

export interface CompileTtsOptions {
  /** When true, re-introduces inline `{{stage:NAME:IDX}}` markers
   *  in the output text. Default false (suggestion-not-hardwired). */
  strict?: boolean;
  /** When true, injects SSML pause hints at paragraph boundaries.
   *  Default true. */
  injectBreaks?: boolean;
}

function findOccurrence(haystack: string, needle: string, occurrence: number): number {
  let from = 0;
  let n = occurrence;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return -1;
    if (n === 0) return idx;
    from = idx + 1;
    n--;
  }
}

function resolveStages(
  spoken: string,
  stages: StageDirection[],
): { resolved: ResolvedStage[]; errors: CompileTtsError[] } {
  const errors: CompileTtsError[] = [];
  const resolved: ResolvedStage[] = [];
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    const occ = stage.occurrence ?? 0;
    const start = findOccurrence(spoken, stage.after, occ);
    if (start === -1) {
      errors.push({
        code: occ > 0 ? 'occurrence_out_of_range' : 'anchor_not_found',
        message:
          `stage_directions[${i}]: ${JSON.stringify(stage.after)} ` +
          (occ > 0
            ? `does not have ${occ + 1} occurrences in spoken text`
            : `not found in spoken text`),
        stage_index: i,
      });
      continue;
    }
    resolved.push({
      position: start + stage.after.length,
      action: stage.action,
      args: stage.args,
      fireAndForget: stage.fireAndForget,
      stage_index: i,
    });
  }
  // Sort by position so callers can iterate in delivery order.
  resolved.sort((a, b) => a.position - b.position);
  return { resolved, errors };
}

function applyStrictMarkers(spoken: string, resolved: ResolvedStage[]): string {
  type Insertion = { pos: number; marker: string };
  const inserts: Insertion[] = resolved.map((r) => ({
    pos: r.position,
    marker: ` ${SSML_STAGE_BREAK}{{stage:${r.action}:${r.stage_index}}}${SSML_STAGE_BREAK} `,
  }));
  // Apply rightmost-first so earlier offsets remain valid.
  inserts.sort((a, b) => b.pos - a.pos);
  let text = spoken;
  for (const ins of inserts) {
    text = text.slice(0, ins.pos) + ins.marker + text.slice(ins.pos);
  }
  return text;
}

function injectParagraphBreaks(text: string): string {
  return text.replace(
    new RegExp(PARAGRAPH_BREAK, 'g'),
    `${SSML_PARAGRAPH_BREAK}\n\n`,
  );
}

export function compileTtsSource(
  spec: SlideSpec,
  options: CompileTtsOptions = {},
): CompileTtsResult {
  const { strict = false, injectBreaks = true } = options;
  const spoken = spec.notes.spoken;
  if (typeof spoken !== 'string' || spoken.trim().length === 0) {
    return { ok: true, text: '', stages: [], errors: [] };
  }
  const stages = spec.notes.stage_directions ?? [];
  const { resolved, errors } = resolveStages(spoken, stages);
  if (errors.length > 0) {
    return { ok: false, text: '', stages: [], errors };
  }
  let text = strict ? applyStrictMarkers(spoken, resolved) : spoken;
  if (injectBreaks) text = injectParagraphBreaks(text);
  return { ok: true, text, stages: resolved, errors: [] };
}

// ─── Runtime-side: parse markers back into segments (strict mode) ──

export interface SpokenSegment {
  kind: 'speech';
  text: string;
}

export interface StageMarkerSegment {
  kind: 'stage';
  action: string;
  index: number;
}

export type CompiledSegment = SpokenSegment | StageMarkerSegment;

const MARKER_RX = /\{\{stage:([a-zA-Z0-9_-]+):(\d+)\}\}/g;

/** Parse a strict-mode compiled string into ordered segments. Used
 *  by the channel orchestrator when running strict mode. */
export function parseCompiledTts(text: string): CompiledSegment[] {
  const segments: CompiledSegment[] = [];
  let cursor = 0;
  MARKER_RX.lastIndex = 0;
  for (;;) {
    const match = MARKER_RX.exec(text);
    if (!match) break;
    const before = text.slice(cursor, match.index);
    if (before.length > 0) {
      segments.push({ kind: 'speech', text: before });
    }
    segments.push({
      kind: 'stage',
      action: match[1],
      index: Number(match[2]),
    });
    cursor = match.index + match[0].length;
  }
  const tail = text.slice(cursor);
  if (tail.length > 0) {
    segments.push({ kind: 'speech', text: tail });
  }
  return segments;
}
