import { notFound } from "next/navigation";
import { getSql } from "@/lib/db";
import { AnswerView } from "../../../../../../../../answer-view";
import type { Answer } from "../../../../../../../../lib";

export const dynamic = "force-dynamic";

// An answer's own page (answers are first-class). Loads the parent response,
// finds the answer by its form position, and renders it with prev/next nav.
export default async function AnswerPage({
  params,
}: {
  params: Promise<{
    experiment: string;
    cohort: string;
    response: string;
    answer: string;
  }>;
}) {
  const { response: responseId, answer: answerPos } = await params;
  const sql = getSql();

  const [resp] = (await sql`
    select sr.id, sr.respondent_ref,
           c.slug as cohort_slug, c.name as cohort_name,
           e.slug as experiment_slug, e.name as experiment_name
    from survey_response sr
    left join cohort c     on c.id = sr.cohort_id
    left join experiment e on e.id = sr.experiment_id
    where sr.id = ${responseId}
    limit 1
  `) as {
    id: string;
    respondent_ref: string | null;
    cohort_slug: string | null;
    cohort_name: string | null;
    experiment_slug: string | null;
    experiment_name: string | null;
  }[];
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
  `) as Answer[];

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
      ...a,
      recordingId: rec?.id ?? null,
      recordingDuration: rec?.duration_seconds ?? null,
    };
  });

  const idx = withRecordings.findIndex((a) => a.position === Number(answerPos));
  if (idx === -1) notFound();

  return (
    <AnswerView
      response={resp}
      answer={withRecordings[idx]}
      index={idx}
      total={withRecordings.length}
      prevPos={idx > 0 ? (withRecordings[idx - 1].position ?? null) : null}
      nextPos={
        idx < withRecordings.length - 1
          ? (withRecordings[idx + 1].position ?? null)
          : null
      }
    />
  );
}
