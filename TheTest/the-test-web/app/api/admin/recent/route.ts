import { getSql } from "@/lib/db";
import { requirePalisadeUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

// GET — most recent responses across ALL experiments, with the slugs needed to
// build a deep link straight to the response detail. Powers the top "Recent"
// strip on the experiments overview.
export async function GET() {
  const viewer = await requirePalisadeUser();
  if (!viewer) return new Response("forbidden", { status: 403 });

  const sql = getSql();

  const responses = (await sql`
    select sr.id, sr.submitted_at, sr.channel, sr.respondent_ref,
           sr.is_low_quality, sr.is_ai_likely, sr.created_at,
           c.slug as cohort_slug, c.name as cohort_name,
           e.slug as experiment_slug, e.name as experiment_name,
           pv.question_title as preview_question,
           left(pv.answer_text, 220) as preview_answer,
           pv.position as preview_position,
           pv.field_ref as preview_field_ref,
           pv.field_type as preview_field_type,
           vr.id as preview_recording_id
    from survey_response sr
    left join cohort c     on c.id = sr.cohort_id
    left join experiment e on e.id = sr.experiment_id
    -- first non-empty freeform/voice answer, for a content preview
    left join lateral (
      select sa.question_title, sa.answer_text, sa.position, sa.field_ref, sa.field_type
      from survey_answer sa
      where sa.survey_response_id = sr.id and sa.is_freeform
        and sa.answer_text is not null and length(trim(sa.answer_text)) > 0
      order by sa.position nulls last, sa.id
      limit 1
    ) pv on true
    -- persisted clip for that preview answer, if it's a voice answer
    left join voice_recording vr
      on vr.survey_response_id = sr.id and vr.field_ref = pv.field_ref
    where sr.created_at > now() - interval '24 hours'
    order by sr.created_at desc
    limit 50
  `) as Record<string, unknown>[];

  return Response.json({ responses, viewer: viewer.email });
}
