import type { NeonQueryFunction } from "@neondatabase/serverless";
import { toCsv } from "./csv";

// Shared "wide" CSV builder for the admin response exports. One row per
// response; lead metadata columns, then one column per distinct question in
// scope (ordered by form position). A voice answer's transcript lives in
// answer_text, so the per-question cell already carries it.

type ResponseRow = {
  id: string;
  cohort_slug: string | null;
  channel: string | null;
  respondent_ref: string | null;
  submitted_at: string | null;
  duration_seconds: number | null;
  is_low_quality: boolean;
  is_ai_likely: boolean;
};

type AnswerRow = {
  survey_response_id: string;
  field_ref: string | null;
  question_title: string | null;
  position: number | null;
  value: string | null;
};

const LEAD = [
  "response_id",
  "cohort",
  "channel",
  "respondent_ref",
  "submitted_at",
  "duration_seconds",
  "is_low_quality",
  "is_ai_likely",
];

// Timestamps arrive from the driver as Date objects; emit ISO 8601 (UTC), not
// the JS locale string, so the CSV is analysis-friendly across tools.
function isoOrEmpty(v: string | Date | null): string {
  if (v == null) return "";
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

// Build the CSV text for a set of responses (by id) plus their answers. The
// caller runs the scoped queries; this only pivots + serializes so the two
// routes share identical column logic.
export function buildResponsesCsv(
  responses: ResponseRow[],
  answers: AnswerRow[],
): string {
  // Distinct questions across in-scope answers, ordered by form position.
  // Key on field_ref when present (stable), else the title. Header prefers
  // question_title, falling back to field_ref.
  const cols = new Map<
    string,
    { header: string; position: number; order: number }
  >();
  let seen = 0;
  for (const a of answers) {
    const key = a.field_ref ?? a.question_title ?? `col_${seen}`;
    if (!cols.has(key)) {
      cols.set(key, {
        header: a.question_title || a.field_ref || key,
        position: a.position ?? Number.MAX_SAFE_INTEGER,
        order: seen++,
      });
    }
  }
  const colKeys = [...cols.keys()].sort((x, y) => {
    const cx = cols.get(x)!;
    const cy = cols.get(y)!;
    return cx.position - cy.position || cx.order - cy.order;
  });

  // response_id -> (column key -> value)
  const byResp = new Map<string, Map<string, string>>();
  for (const a of answers) {
    const key = a.field_ref ?? a.question_title ?? "";
    if (!byResp.has(a.survey_response_id))
      byResp.set(a.survey_response_id, new Map());
    // First non-empty value wins for a given question on a response.
    const m = byResp.get(a.survey_response_id)!;
    if (!m.has(key) && a.value != null) m.set(key, a.value);
  }

  const header = [...LEAD, ...colKeys.map((k) => cols.get(k)!.header)];

  const rows = responses.map((r) => {
    const m = byResp.get(r.id) ?? new Map<string, string>();
    return [
      r.id,
      r.cohort_slug ?? "",
      r.channel ?? "",
      r.respondent_ref ?? "",
      isoOrEmpty(r.submitted_at as string | Date | null),
      r.duration_seconds ?? "",
      r.is_low_quality,
      r.is_ai_likely,
      ...colKeys.map((k) => m.get(k) ?? ""),
    ];
  });

  return toCsv(header, rows);
}

// The answer value coalesce expression used by both export routes. answer_text
// holds freeform + voice transcripts; fall back through the typed columns.
export async function answersByResponseIds(
  sql: NeonQueryFunction<false, false>,
  responseIds: string[],
): Promise<AnswerRow[]> {
  return (await sql`
    select survey_response_id, field_ref, question_title, position,
           coalesce(
             answer_text, answer_number::text, answer_boolean::text,
             answer_choice,
             -- multi-select: ALL selected labels in order (was ->>0, which kept
             -- only the first and silently dropped the rest)
             (select string_agg(lbl, ', ' order by ord)
                from jsonb_array_elements_text(answer_choices->'labels')
                with ordinality as t(lbl, ord))
           ) as value
    from survey_answer
    where survey_response_id = any(${responseIds}::uuid[])
    order by position nulls last, id
  `) as AnswerRow[];
}

export type { ResponseRow, AnswerRow };
