import { getSql } from "@/lib/db";
import { requirePalisadeUser } from "@/lib/auth";
import { getFormFields, mergeSkippedQuestions } from "@/lib/response-questions";
import type { Answer } from "@/app/(authed)/admin/lib";

export const dynamic = "force-dynamic";

// GET — one full response (by id) with all answers + voice recordings attached.
// Powers the response-detail / question drill-down view. Mirrors the answer +
// recording shaping from the list endpoint so the audio player keys line up.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ response: string }> },
) {
  const viewer = await requirePalisadeUser();
  if (!viewer) return new Response("forbidden", { status: 403 });

  const { response: responseId } = await params;
  const sql = getSql();

  const [resp] = (await sql`
    select sr.id, sr.submitted_at, sr.channel, sr.respondent_ref,
           sr.prolific_session_id, sr.duration_seconds, sr.is_scored,
           sr.is_prolific_enriched, sr.is_low_quality, sr.is_ai_likely,
           sr.created_at,
           c.slug as cohort_slug, c.name as cohort_name,
           e.slug as experiment_slug, e.name as experiment_name,
           coalesce(raw.typeform_form_id, c.typeform_form_id, e.typeform_form_id) as form_id
    from survey_response sr
    left join cohort c     on c.id = sr.cohort_id
    left join experiment e on e.id = sr.experiment_id
    left join survey_response_raw raw on raw.id = sr.raw_id
    where sr.id = ${responseId}
    limit 1
  `) as Record<string, unknown>[];
  if (!resp) return new Response("not found", { status: 404 });

  const answers = (await sql`
    select position, field_ref, question_title, field_type, is_freeform,
           coalesce(
             answer_text, answer_number::text, answer_boolean::text,
             answer_choice,
             (select string_agg(lbl, ', ' order by ord)
                from jsonb_array_elements_text(answer_choices->'labels')
                with ordinality as t(lbl, ord))
           ) as value
    from survey_answer
    where survey_response_id = ${responseId}
    order by position nulls last, id
  `) as { field_ref: string | null }[];

  const recordings = (await sql`
    select id, field_ref, duration_seconds
    from voice_recording
    where survey_response_id = ${responseId}
  `) as { id: string; field_ref: string; duration_seconds: number | null }[];
  const recByRef = new Map<string, (typeof recordings)[number]>();
  for (const r of recordings) recByRef.set(r.field_ref, r);

  const withRecordings = answers.map((a) => {
    const rec = a.field_ref ? recByRef.get(a.field_ref) : undefined;
    return {
      ...a,
      recordingId: rec?.id ?? null,
      recordingDuration: rec?.duration_seconds ?? null,
    };
  }) as unknown as Answer[];

  // Fold in the questions the participant skipped (best-effort — never break the
  // view if the form can't be fetched).
  let questions = withRecordings;
  const formId = resp.form_id as string | null;
  if (formId) {
    try {
      questions = mergeSkippedQuestions(withRecordings, await getFormFields(formId));
    } catch {
      // keep answered-only ordering
    }
  }

  return Response.json({
    response: { ...resp, answers: questions },
    viewer: viewer.email,
  });
}
