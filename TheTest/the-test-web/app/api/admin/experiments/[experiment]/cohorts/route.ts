import { getSql } from "@/lib/db";
import { requirePalisadeUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

// GET — cohorts for one experiment (looked up by slug), with response roll-ups.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ experiment: string }> },
) {
  const viewer = await requirePalisadeUser();
  if (!viewer) return new Response("forbidden", { status: 403 });

  const { experiment } = await params;
  const sql = getSql();

  const [exp] = (await sql`
    select id, slug, name, description, typeform_form_id, created_at
    from experiment where slug = ${experiment} limit 1
  `) as Record<string, unknown>[];
  if (!exp) return new Response("not found", { status: 404 });

  const cohorts = (await sql`
    select c.id, c.slug, c.name, c.channel, c.short_code, c.prolific_study_id,
           c.typeform_form_id, c.created_at,
           count(sr.id)                                             as responses,
           count(sr.id) filter (where sr.submitted_at is not null)  as complete,
           max(sr.created_at)                                       as last_response_at
    from cohort c
    left join survey_response sr on sr.cohort_id = c.id
    where c.experiment_id = ${exp.id as string}
    group by c.id
    order by max(sr.created_at) desc nulls last, c.created_at desc
  `) as Record<string, unknown>[];

  return Response.json({ experiment: exp, cohorts, viewer: viewer.email });
}
