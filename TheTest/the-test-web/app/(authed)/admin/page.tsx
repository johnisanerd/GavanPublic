import { getSql } from "@/lib/db";
import { ExperimentsTable } from "./_shell/experiments-table";

export const dynamic = "force-dynamic";

type Experiment = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  created_at: string | null;
  cohorts: number;
  responses: number;
  complete: number;
  last_response_at: string | null;
};

// Experiments landing — the shadcn proof-of-look page. Auth + the sidebar
// shell + QueryProvider are provided by the admin layout; this page just
// renders the live experiments table inside the inset.
export default async function AdminPage() {
  const sql = getSql();
  const experiments = (await sql`
    select e.id, e.slug, e.name, e.description, e.created_at,
           count(distinct c.id)                             as cohorts,
           count(distinct sr.id)                            as responses,
           count(distinct sr.id) filter (where sr.submitted_at is not null) as complete,
           max(sr.created_at)                               as last_response_at
    from experiment e
    left join cohort c          on c.experiment_id = e.id
    left join survey_response sr on sr.experiment_id = e.id
    group by e.id
    order by e.created_at desc
  `) as Experiment[];

  return <ExperimentsTable initialData={{ experiments }} />;
}
