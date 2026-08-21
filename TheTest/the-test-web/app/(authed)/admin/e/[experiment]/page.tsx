import { notFound } from "next/navigation";
import { getSql } from "@/lib/db";
import { CohortsView } from "../../cohorts-view";

export const dynamic = "force-dynamic";

type Experiment = {
  id: string;
  slug: string;
  name: string;
  typeform_form_id: string | null;
};
type Cohort = {
  id: string;
  slug: string;
  name: string;
  channel: string | null;
  short_code: string | null;
  prolific_study_id: string | null;
  typeform_form_id: string | null;
  created_at: string | null;
  responses: number;
  complete: number;
  last_response_at: string | null;
};

export default async function ExperimentPage({
  params,
}: {
  params: Promise<{ experiment: string }>;
}) {
  const { experiment } = await params;
  const sql = getSql();

  const [exp] = (await sql`
    select id, slug, name, typeform_form_id from experiment where slug = ${experiment} limit 1
  `) as Experiment[];
  if (!exp) notFound();

  const cohorts = (await sql`
    select c.id, c.slug, c.name, c.channel, c.short_code, c.prolific_study_id,
           c.typeform_form_id, c.created_at,
           count(sr.id)                                             as responses,
           count(sr.id) filter (where sr.submitted_at is not null)  as complete,
           max(sr.created_at)                                       as last_response_at
    from cohort c
    left join survey_response sr on sr.cohort_id = c.id
    where c.experiment_id = ${exp.id}
    group by c.id
    order by c.created_at desc
  `) as Cohort[];

  return (
    <CohortsView
      experimentSlug={exp.slug}
      initialData={{ experiment: exp, cohorts }}
    />
  );
}
