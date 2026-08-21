// Shared formatting + types for the admin drill-down views.

export type RecentResponse = {
  id: string;
  submitted_at: string | null;
  respondent_ref: string | null;
  is_low_quality: boolean;
  is_ai_likely: boolean;
  created_at: string | null;
  cohort_slug: string | null;
  cohort_name: string | null;
  experiment_slug: string | null;
  experiment_name: string | null;
  preview_question: string | null;
  preview_answer: string | null;
  preview_position: number | null;
  preview_field_ref: string | null;
  preview_field_type: string | null;
  preview_recording_id: string | null;
};

// Deep link to a response's detail page, or null if we can't resolve the path.
export function responseHref(r: RecentResponse): string | null {
  if (!r.experiment_slug || !r.cohort_slug) return null;
  return `/admin/e/${r.experiment_slug}/c/${r.cohort_slug}/r/${r.id}`;
}

// Deep link straight to the previewed answer's own page (answers are
// first-class), falling back to the response page.
export function answerHref(r: RecentResponse): string | null {
  const base = responseHref(r);
  if (!base) return null;
  return r.preview_position != null ? `${base}/a/${r.preview_position}` : base;
}

// Middle-truncated identifier, e.g. "5fb3..a4f9" — first `keep` / last `keep`,
// so every id renders the same width. 4/4 everywhere for consistency.
export function maskId(s: string | null, keep = 4): string {
  if (!s) return "—";
  return s.length > keep * 2 + 2
    ? `${s.slice(0, keep)}..${s.slice(-keep)}`
    : s;
}

// Non-freeform, non-voice "pick an option" answers.
export function isChoiceType(fieldType: string | null): boolean {
  return (
    fieldType === "multiple_choice" ||
    fieldType === "dropdown" ||
    fieldType === "picture_choice" ||
    fieldType === "yes_no" ||
    fieldType === "opinion_scale"
  );
}

// Typeform choice labels often lead with a letter ("B. The model …"). Split the
// letter out so we can render it as a chip + the option text.
export function parseChoice(value: string | null): {
  letter: string | null;
  text: string;
} {
  if (!value) return { letter: null, text: "—" };
  const m = value.match(/^([A-Za-z])[.)]\s+(.+)/s);
  return m ? { letter: m[1].toUpperCase(), text: m[2] } : { letter: null, text: value };
}

export type Answer = {
  position?: number;
  field_ref?: string | null;
  question_title: string | null;
  field_type: string | null;
  is_freeform: boolean;
  value: string | null;
  recordingId?: string | null;
  recordingDuration?: number | null;
  // True for a question the participant didn't answer (synthesized from the form
  // definition — never a real survey_answer row). No value, not clickable.
  skipped?: boolean;
};

export function rel(ts: string | null): string {
  if (!ts) return "—";
  const d = (Date.now() - Date.parse(ts)) / 1000;
  if (!Number.isFinite(d)) return "—"; // unparseable timestamp → no "NaN"
  if (d < 60) return `${Math.floor(d)}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

export function fmtDuration(s: number | null): string {
  if (s == null) return "—";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

// Audio source for a voice answer — persisted clip if we have one, otherwise
// the on-demand generate proxy. (Audio API routes are owned elsewhere.)
export function audioSrc(
  responseId: string,
  fieldRef: string,
  recordingId?: string | null,
): string {
  return recordingId
    ? `/api/admin/audio/${recordingId}`
    : `/api/admin/audio/generate?response=${responseId}&ref=${encodeURIComponent(fieldRef)}`;
}
