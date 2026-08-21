/**
 * Per-layout content-budget validator. Reveal.js does not autoshrink
 * content vertically (open issue since 2018; maintainer position is
 * "author to fit"). The arxiv survey "Talk to Your Slides" (May 2025)
 * identifies content overflow as the universal failure mode for
 * AI-authored slides, and recommends compile-time content budgets
 * paired with render-time visual feedback. We do the compile-time
 * half.
 *
 * Caps are initial empirical guesses against the 4:3 (1440x1080) deck
 * at the default Lato/40px theme baseline. Iterate against real
 * packets — most likely we'll loosen the bullets cap and tighten the
 * title cap.
 *
 * Two severity levels:
 *  - error: spec is rejected; agent retries.
 *  - warning: spec compiles but may render imperfectly; surfaced to
 *    the operator at packet-upload time, ignored at runtime injection.
 */
import type { SlideSpec, StageDirection, LayoutName } from './slide-spec.js';

export interface ValidationIssue {
  severity: 'error' | 'warning';
  /** Stable code for telemetry / agent-retry routing. */
  code: string;
  /** Human-readable explanation suitable for surfacing to the
   *  authoring agent or operator. */
  message: string;
  /** Path into the spec the issue points at, e.g. `notes.spoken` or
   *  `items[3]`. Empty for whole-spec issues. */
  path?: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

interface LayoutCaps {
  title?: { max: number };
  subtitle?: { max: number };
  body?: { max: number };
  items?: { maxCount: number; maxCharsEach: number };
  text?: { max: number };
  caption?: { max: number };
  label?: { max: number };
  value?: { max: number };
  context?: { max: number };
  table?: { maxColumns: number; maxRows: number; maxCellChars: number };
}

/**
 * Per-layout caps. Empirically tuned at 4:3 (1440×1080) + DM Sans
 * baseline. Calibrated against established slide design wisdom:
 *
 *   - Duarte / 6×6 rule: max ~6 bullets, ~6 words each. Our cap is 5
 *     items at ~90 chars (≈ 12-14 words) to allow "**Lead.** body."
 *     headline-detail bullets while still forcing brevity.
 *   - Takahashi: title-sized typography, very few words. Backs the
 *     short title + section caps.
 *   - Tufte data-ink: tables are tight (≤35 chars/cell, ≤6 cols).
 *
 * The translator (Opus pamphlet → DSL) reads source material and
 * splits over-cap content into multi-slide builds; the validator is
 * the hard ceiling. If real content keeps over-running, push back on
 * the translator's prompt (split harder), not the caps.
 */
const CAPS: Record<LayoutName, LayoutCaps> = {
  title: {
    title: { max: 60 },
    subtitle: { max: 100 },
  },
  section: {
    label: { max: 40 },
  },
  bullets: {
    title: { max: 60 },
    // "**Lead.** Body sentence." structure pushes to ~90; cap there.
    // Five bullets per slide stays readable at 4:3; more wants a split
    // build (auto_animate_from gives two related slides for free).
    items: { maxCount: 5, maxCharsEach: 90 },
  },
  'two-col': {
    title: { max: 60 },
    text: { max: 160 },
    items: { maxCount: 3, maxCharsEach: 75 },
    caption: { max: 90 },
  },
  'image-full': {
    caption: { max: 100 },
  },
  quote: {
    text: { max: 180 },
  },
  stat: {
    value: { max: 12 },
    label: { max: 70 },
    context: { max: 50 },
  },
  table: {
    title: { max: 60 },
    table: { maxColumns: 6, maxRows: 9, maxCellChars: 35 },
  },
};

/** Character length helper — counts grapheme-naively (good enough for
 *  English; revisit if a packet ever needs CJK budgeting). */
function len(s: string): number {
  return s.length;
}

function issueLong(
  issues: ValidationIssue[],
  path: string,
  cap: number,
  actual: number,
  hint?: string,
): void {
  issues.push({
    severity: 'error',
    code: 'content_too_long',
    message:
      `${path} is ${actual} chars, max ${cap} for this layout` +
      (hint ? ` (${hint})` : ''),
    path,
  });
}

function findAllOccurrences(haystack: string, needle: string): number[] {
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    out.push(idx);
    from = idx + 1;
  }
  return out;
}

function checkStageDirections(
  spec: SlideSpec,
  issues: ValidationIssue[],
): void {
  const stages: StageDirection[] | undefined = spec.notes.stage_directions;
  if (!stages || stages.length === 0) return;
  const spoken = spec.notes.spoken;
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    const path = `notes.stage_directions[${i}]`;
    if (!stage.after) {
      issues.push({
        severity: 'error',
        code: 'stage_anchor_missing',
        message: `${path}.after is required`,
        path,
      });
      continue;
    }
    if (!stage.action) {
      issues.push({
        severity: 'error',
        code: 'stage_action_missing',
        message: `${path}.action is required`,
        path,
      });
      continue;
    }
    const matches = findAllOccurrences(spoken, stage.after);
    if (matches.length === 0) {
      issues.push({
        severity: 'error',
        code: 'stage_anchor_not_found',
        message:
          `${path}.after substring not found in notes.spoken: ` +
          `${JSON.stringify(stage.after)}`,
        path,
      });
      continue;
    }
    const occ = stage.occurrence ?? 0;
    if (occ < 0 || occ >= matches.length) {
      issues.push({
        severity: 'error',
        code: 'stage_occurrence_out_of_range',
        message:
          `${path}.occurrence=${occ} but ${JSON.stringify(stage.after)} ` +
          `appears ${matches.length} time${matches.length === 1 ? '' : 's'}`,
        path,
      });
      continue;
    }
    // Multi-match without explicit occurrence is a WARNING (default
    // to occurrence 0). Authors who want explicit disambiguation
    // set `occurrence: N`.
    if (matches.length > 1 && stage.occurrence === undefined) {
      issues.push({
        severity: 'warning',
        code: 'stage_anchor_ambiguous',
        message:
          `${path}.after matches ${matches.length} times; defaulting to ` +
          `occurrence 0. Add \`occurrence: N\` to be explicit.`,
        path,
      });
    }
  }
}

function checkTitleSpec(
  spec: Extract<SlideSpec, { layout: 'title' }>,
  issues: ValidationIssue[],
): void {
  const caps = CAPS.title;
  if (caps.title && len(spec.title) > caps.title.max) {
    issueLong(issues, 'title', caps.title.max, len(spec.title));
  }
  if (
    spec.subtitle &&
    caps.subtitle &&
    len(spec.subtitle) > caps.subtitle.max
  ) {
    issueLong(issues, 'subtitle', caps.subtitle.max, len(spec.subtitle));
  }
}

function checkSectionSpec(
  spec: Extract<SlideSpec, { layout: 'section' }>,
  issues: ValidationIssue[],
): void {
  const caps = CAPS.section;
  if (caps.label && len(spec.label) > caps.label.max) {
    issueLong(issues, 'label', caps.label.max, len(spec.label));
  }
}

function checkBulletsSpec(
  spec: Extract<SlideSpec, { layout: 'bullets' }>,
  issues: ValidationIssue[],
): void {
  const caps = CAPS.bullets;
  if (caps.title && len(spec.title) > caps.title.max) {
    issueLong(issues, 'title', caps.title.max, len(spec.title));
  }
  if (caps.items) {
    if (spec.items.length > caps.items.maxCount) {
      issues.push({
        severity: 'error',
        code: 'too_many_items',
        message:
          `bullets layout: ${spec.items.length} items provided, ` +
          `max ${caps.items.maxCount}. Try splitting into a 2-slide ` +
          `auto-animate build instead of cramming.`,
        path: 'items',
      });
    }
    spec.items.forEach((item, i) => {
      if (len(item) > caps.items!.maxCharsEach) {
        issueLong(
          issues,
          `items[${i}]`,
          caps.items!.maxCharsEach,
          len(item),
          'tighten the wording',
        );
      }
    });
  }
}

function checkTwoColSpec(
  spec: Extract<SlideSpec, { layout: 'two-col' }>,
  issues: ValidationIssue[],
): void {
  const caps = CAPS['two-col'];
  if (spec.title && caps.title && len(spec.title) > caps.title.max) {
    issueLong(issues, 'title', caps.title.max, len(spec.title));
  }
  (['left', 'right'] as const).forEach((side) => {
    const slot = spec[side];
    if (slot.kind === 'text') {
      const body = typeof slot.body === 'string' ? slot.body : slot.body.join(' ');
      if (caps.text && len(body) > caps.text.max) {
        issueLong(issues, `${side}.body`, caps.text.max, len(body));
      }
    } else if (slot.kind === 'list') {
      const items = Array.isArray(slot.body) ? slot.body : [slot.body];
      if (caps.items && items.length > caps.items.maxCount) {
        issues.push({
          severity: 'error',
          code: 'too_many_items',
          message:
            `two-col ${side} list: ${items.length} items, ` +
            `max ${caps.items.maxCount}`,
          path: `${side}.body`,
        });
      }
      items.forEach((item, i) => {
        if (caps.items && len(item) > caps.items.maxCharsEach) {
          issueLong(
            issues,
            `${side}.body[${i}]`,
            caps.items.maxCharsEach,
            len(item),
          );
        }
      });
    } else if (slot.kind === 'figure') {
      if (slot.caption && caps.caption && len(slot.caption) > caps.caption.max) {
        issueLong(
          issues,
          `${side}.caption`,
          caps.caption.max,
          len(slot.caption),
        );
      }
    }
  });
}

function checkImageFullSpec(
  spec: Extract<SlideSpec, { layout: 'image-full' }>,
  issues: ValidationIssue[],
): void {
  const caps = CAPS['image-full'];
  if (!spec.figure) {
    issues.push({
      severity: 'error',
      code: 'figure_missing',
      message: 'image-full layout requires `figure` path',
      path: 'figure',
    });
  }
  if (spec.caption && caps.caption && len(spec.caption) > caps.caption.max) {
    issueLong(issues, 'caption', caps.caption.max, len(spec.caption));
  }
}

function checkQuoteSpec(
  spec: Extract<SlideSpec, { layout: 'quote' }>,
  issues: ValidationIssue[],
): void {
  const caps = CAPS.quote;
  if (!spec.text) {
    issues.push({
      severity: 'error',
      code: 'quote_text_missing',
      message: 'quote layout requires `text`',
      path: 'text',
    });
  } else if (caps.text && len(spec.text) > caps.text.max) {
    issueLong(issues, 'text', caps.text.max, len(spec.text));
  }
}

function checkStatSpec(
  spec: Extract<SlideSpec, { layout: 'stat' }>,
  issues: ValidationIssue[],
): void {
  const caps = CAPS.stat;
  if (!spec.value || spec.value.trim().length === 0) {
    issues.push({
      severity: 'error',
      code: 'stat_value_missing',
      message: 'stat layout requires `value` (the hero number/figure)',
      path: 'value',
    });
  } else if (caps.value && len(spec.value) > caps.value.max) {
    issueLong(
      issues,
      'value',
      caps.value.max,
      len(spec.value),
      'stat hero number must be short ("81%", "10×", "$1-2/hr")',
    );
  }
  if (!spec.label || spec.label.trim().length === 0) {
    issues.push({
      severity: 'error',
      code: 'stat_label_missing',
      message: 'stat layout requires `label` (what the value measures)',
      path: 'label',
    });
  } else if (caps.label && len(spec.label) > caps.label.max) {
    issueLong(issues, 'label', caps.label.max, len(spec.label));
  }
  if (spec.context && caps.context && len(spec.context) > caps.context.max) {
    issueLong(issues, 'context', caps.context.max, len(spec.context));
  }
}

function checkTableSpec(
  spec: Extract<SlideSpec, { layout: 'table' }>,
  issues: ValidationIssue[],
): void {
  const caps = CAPS.table;
  if (spec.title && caps.title && len(spec.title) > caps.title.max) {
    issueLong(issues, 'title', caps.title.max, len(spec.title));
  }
  if (!caps.table) return;
  if (spec.columns.length > caps.table.maxColumns) {
    issues.push({
      severity: 'error',
      code: 'too_many_columns',
      message:
        `table: ${spec.columns.length} columns, max ${caps.table.maxColumns}`,
      path: 'columns',
    });
  }
  if (spec.rows.length > caps.table.maxRows) {
    issues.push({
      severity: 'error',
      code: 'too_many_rows',
      message: `table: ${spec.rows.length} rows, max ${caps.table.maxRows}`,
      path: 'rows',
    });
  }
  spec.rows.forEach((row, r) => {
    if (row.length !== spec.columns.length) {
      issues.push({
        severity: 'error',
        code: 'row_column_mismatch',
        message:
          `table row ${r} has ${row.length} cells, expected ` +
          `${spec.columns.length}`,
        path: `rows[${r}]`,
      });
    }
    row.forEach((cell, c) => {
      if (len(cell) > caps.table!.maxCellChars) {
        issueLong(
          issues,
          `rows[${r}][${c}]`,
          caps.table!.maxCellChars,
          len(cell),
        );
      }
    });
  });
}

function checkSharedNotes(spec: SlideSpec, issues: ValidationIssue[]): void {
  if (!spec.notes || typeof spec.notes.spoken !== 'string') {
    issues.push({
      severity: 'error',
      code: 'notes_spoken_missing',
      message: 'every slide must have notes.spoken (the verbatim narration)',
      path: 'notes.spoken',
    });
    return;
  }
  if (spec.notes.spoken.trim().length === 0) {
    issues.push({
      severity: 'warning',
      code: 'notes_spoken_empty',
      message:
        'notes.spoken is empty — presenter will have nothing to say on ' +
        'this slide',
      path: 'notes.spoken',
    });
  }
  checkStageDirections(spec, issues);
}

/** Run all checks on a spec. Returns `ok: true` iff there are no
 *  `error`-severity issues; warnings don't block. */
export function validateSpec(spec: SlideSpec): ValidationResult {
  const issues: ValidationIssue[] = [];
  checkSharedNotes(spec, issues);
  switch (spec.layout) {
    case 'title':
      checkTitleSpec(spec, issues);
      break;
    case 'section':
      checkSectionSpec(spec, issues);
      break;
    case 'bullets':
      checkBulletsSpec(spec, issues);
      break;
    case 'two-col':
      checkTwoColSpec(spec, issues);
      break;
    case 'image-full':
      checkImageFullSpec(spec, issues);
      break;
    case 'quote':
      checkQuoteSpec(spec, issues);
      break;
    case 'stat':
      checkStatSpec(spec, issues);
      break;
    case 'table':
      checkTableSpec(spec, issues);
      break;
  }
  return {
    ok: !issues.some((i) => i.severity === 'error'),
    issues,
  };
}
