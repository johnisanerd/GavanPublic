import { notFound } from "next/navigation";
import { getSql } from "@/lib/db";
import { ResponsesView } from "../../../../responses-view";

export const dynamic = "force-dynamic";

type Meta = {
  cohort_id: string;
  cohort_slug: string;
  cohort_name: string;
  channel: string | null;
  experiment_slug: string;
  experiment_name: string;
};
type ResponseRow = {
  id: string;
  submitted_at: string | null;
  channel: string | null;
  respondent_ref: string | null;
  duration_seconds: number | null;
  is_scored: boolean;
  is_prolific_enriched: boolean;
  is_low_quality: boolean;
  is_ai_likely: boolean;
  created_at: string | null;
  answers: number;
  freeform: number;
};

export default async function CohortPage({
  params,
}: {
  params: Promise<{ experiment: string; cohort: string }>;
}) {
  const { experiment, cohort } = await params;
  const sql = getSql();

  const [meta] = (await sql`
    select c.id as cohort_id, c.slug as cohort_slug, c.name as cohort_name,
           c.channel,
           e.slug as experiment_slug, e.name as experiment_name
    from cohort c
    join experiment e on e.id = c.experiment_id
    where e.slug = ${experiment} and c.slug = ${cohort}
    limit 1
  `) as Meta[];
  if (!meta) notFound();

  const responses = (await sql`
    select sr.id, sr.submitted_at, sr.channel, sr.respondent_ref,
           sr.duration_seconds, sr.is_scored, sr.is_prolific_enriched,
           sr.is_low_quality, sr.is_ai_likely, sr.created_at,
           count(sa.id)                               as answers,
           count(sa.id) filter (where sa.is_freeform) as freeform
    from survey_response sr
    left join survey_answer sa on sa.survey_response_id = sr.id
    where sr.cohort_id = ${meta.cohort_id}
    group by sr.id
    order by sr.created_at desc
    limit 200
  `) as ResponseRow[];

  return (
    <ResponsesView
      experimentSlug={experiment}
      cohortSlug={cohort}
      initialData={{
        experiment: { slug: meta.experiment_slug, name: meta.experiment_name },
        cohort: {
          slug: meta.cohort_slug,
          name: meta.cohort_name,
          channel: meta.channel,
        },
        responses,
        viewer: "",
      }}
    />
  );
}
