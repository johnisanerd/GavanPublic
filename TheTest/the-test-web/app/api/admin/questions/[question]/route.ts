import { getSql } from "@/lib/db";
import { requirePalisadeUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

// GET — every answer to one question (by content hash), across all responses /
// experiments / cohorts, newest first. Powers the question detail page where
// you can read/listen to all responses to a question back-to-back.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ question: string }> },
) {
  const viewer = await requirePalisadeUser();
  if (!viewer) return new Response("forbidden", { status: 403 });

  const { question: hash } = await params;
  const sql = getSql();

  const [meta] = (await sql`
    select max(question_title) as title, max(field_type) as field_type
    from survey_answer where question_hash = ${hash}
  `) as { title: string | null; field_type: string | null }[];
  if (!meta || meta.title == null) return new Response("not found", { status: 404 });

  const answers = (await sql`
    select sa.position, sa.field_ref, sa.field_type, sa.is_freeform,
           coalesce(
             sa.answer_text, sa.answer_number::text, sa.answer_boolean::text,
             sa.answer_choice,
             (select string_agg(lbl, ', ' order by ord)
                from jsonb_array_elements_text(sa.answer_choices->'labels')
                with ordinality as t(lbl, ord))
           ) as value,
           sr.id as response_id, sr.respondent_ref, sr.submitted_at, sr.created_at,
           c.slug as cohort_slug, c.name as cohort_name,
           e.slug as experiment_slug, e.name as experiment_name,
           vr.id as recording_id, vr.duration_seconds as recording_duration
    from survey_answer sa
    join survey_response sr on sr.id = sa.survey_response_id
    left join cohort c     on c.id = sr.cohort_id
    left join experiment e on e.id = sr.experiment_id
    left join voice_recording vr
      on vr.survey_response_id = sr.id and vr.field_ref = sa.field_ref
    where sa.question_hash = ${hash}
    order by sr.created_at desc
  `) as Record<string, unknown>[];

  return Response.json({
    question: { hash, title: meta.title, field_type: meta.field_type },
    answers,
    viewer: viewer.email,
  });
}
