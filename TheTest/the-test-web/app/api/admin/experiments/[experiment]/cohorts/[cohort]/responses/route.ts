import { getSql } from "@/lib/db";
import { requirePalisadeUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

// GET — responses for one cohort within one experiment (both by slug), with a
// per-response answer/freeform count for the list. Answers themselves are
// fetched on the response-detail route.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ experiment: string; cohort: string }> },
) {
  const viewer = await requirePalisadeUser();
  if (!viewer) return new Response("forbidden", { status: 403 });

  const { experiment, cohort } = await params;
  const sql = getSql();

  const [row] = (await sql`
    select c.id as cohort_id, c.slug as cohort_slug, c.name as cohort_name,
           c.channel, c.short_code,
           e.id as experiment_id, e.slug as experiment_slug, e.name as experiment_name
    from cohort c
    join experiment e on e.id = c.experiment_id
    where e.slug = ${experiment} and c.slug = ${cohort}
    limit 1
  `) as Record<string, unknown>[];
  if (!row) return new Response("not found", { status: 404 });

  const responses = (await sql`
    select sr.id, sr.submitted_at, sr.channel, sr.respondent_ref,
           sr.duration_seconds, sr.is_scored, sr.is_prolific_enriched,
           sr.is_low_quality, sr.is_ai_likely, sr.created_at,
           count(sa.id)                                  as answers,
           count(sa.id) filter (where sa.is_freeform)    as freeform
    from survey_response sr
    left join survey_answer sa on sa.survey_response_id = sr.id
    where sr.cohort_id = ${row.cohort_id as string}
    group by sr.id
    order by sr.created_at desc
    limit 200
  `) as Record<string, unknown>[];

  return Response.json({
    experiment: { slug: row.experiment_slug, name: row.experiment_name },
    cohort: {
      slug: row.cohort_slug,
      name: row.cohort_name,
      channel: row.channel,
      short_code: row.short_code,
    },
    responses,
    viewer: viewer.email,
  });
}
