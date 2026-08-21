import { getSql } from "@/lib/db";
import { requirePalisadeUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

// GET — every experiment with cohort + response roll-ups for the list view.
// (Experiment creation is the createExperiment Server Function in admin/actions.)
export async function GET() {
  const viewer = await requirePalisadeUser();
  if (!viewer) return new Response("forbidden", { status: 403 });

  const sql = getSql();

  const experiments = (await sql`
    select e.id, e.slug, e.name, e.description, e.typeform_form_id, e.created_at,
           count(distinct c.id)                             as cohorts,
           count(distinct sr.id)                            as responses,
           count(distinct sr.id) filter (where sr.submitted_at is not null) as complete,
           max(sr.created_at)                               as last_response_at
    from experiment e
    left join cohort c          on c.experiment_id = e.id
    left join survey_response sr on sr.experiment_id = e.id
    group by e.id
    order by e.created_at desc
  `) as Record<string, unknown>[];

  return Response.json({ experiments, viewer: viewer.email });
}
