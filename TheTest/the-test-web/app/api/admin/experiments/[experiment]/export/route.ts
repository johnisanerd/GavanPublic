import { getSql } from "@/lib/db";
import { requirePalisadeUser } from "@/lib/auth";
import { fileSlug } from "@/lib/csv";
import {
  buildResponsesCsv,
  answersByResponseIds,
  type ResponseRow,
} from "@/lib/export";

export const dynamic = "force-dynamic";

// GET — wide CSV of every response across all cohorts of one experiment.
// Completed responses first, then partials; each newest-first within its group.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ experiment: string }> },
) {
  const viewer = await requirePalisadeUser();
  if (!viewer) return new Response("forbidden", { status: 403 });

  const { experiment } = await params;
  const sql = getSql();

  const [exp] = (await sql`
    select id, slug, name from experiment where slug = ${experiment} limit 1
  `) as { id: string; slug: string; name: string }[];
  if (!exp) return new Response("not found", { status: 404 });

  const responses = (await sql`
    select sr.id, c.slug as cohort_slug, sr.channel, sr.respondent_ref,
           sr.submitted_at, sr.duration_seconds, sr.is_low_quality, sr.is_ai_likely
    from survey_response sr
    left join cohort c on c.id = sr.cohort_id
    where sr.experiment_id = ${exp.id}
    order by (sr.submitted_at is null), sr.submitted_at desc nulls last,
             sr.created_at desc
  `) as ResponseRow[];

  const answers = responses.length
    ? await answersByResponseIds(sql, responses.map((r) => r.id))
    : [];

  const csv = buildResponsesCsv(responses, answers);
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `the-test_${fileSlug(exp.slug)}_${stamp}.csv`;

  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}
