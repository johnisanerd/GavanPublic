import { notFound } from "next/navigation";
import { getSql } from "@/lib/db";
import { getFormFields, mergeSkippedQuestions } from "@/lib/response-questions";
import { ResponseView } from "../../../../../../response-view";
import type { Answer } from "../../../../../../lib";

export const dynamic = "force-dynamic";

type Resp = {
  id: string;
  submitted_at: string | null;
  channel: string | null;
  respondent_ref: string | null;
  prolific_session_id: string | null;
  duration_seconds: number | null;
  is_scored: boolean;
  is_prolific_enriched: boolean;
  is_low_quality: boolean;
  is_ai_likely: boolean;
  created_at: string | null;
  cohort_slug: string | null;
  cohort_name: string | null;
  experiment_slug: string | null;
  experiment_name: string | null;
  form_id: string | null;
};

export default async function ResponsePage({
  params,
}: {
  params: Promise<{ experiment: string; cohort: string; response: string }>;
}) {
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
  `) as Resp[];
  if (!resp) notFound();

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
  for (const rec of recordings) recByRef.set(rec.field_ref, rec);

  const withRecordings: Answer[] = answers.map((a) => {
    const rec = a.field_ref ? recByRef.get(a.field_ref) : undefined;
    return {
      ...(a as unknown as Answer),
      recordingId: rec?.id ?? null,
      recordingDuration: rec?.duration_seconds ?? null,
    };
  });

  // Fold in the questions the participant skipped (best-effort).
  let questions = withRecordings;
  if (resp.form_id) {
    try {
      questions = mergeSkippedQuestions(
        withRecordings,
        await getFormFields(resp.form_id),
      );
    } catch {
      // keep answered-only ordering
    }
  }

  return (
    <ResponseView
      responseId={resp.id}
      initialData={{
        response: { ...resp, answers: questions },
        viewer: "",
      }}
    />
  );
}
