import { getSql } from "@/lib/db";
import { requirePalisadeUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

// GET — distinct questions (by content hash) across all responses, with answer
// counts. Powers Research → Questions.
export async function GET() {
  const viewer = await requirePalisadeUser();
  if (!viewer) return new Response("forbidden", { status: 403 });

  const sql = getSql();
  const questions = (await sql`
    select sa.question_hash,
           max(sa.question_title)                                    as title,
           max(sa.field_type)                                        as field_type,
           count(*)::int                                             as responses,
           count(*) filter (where sa.field_type = 'multi_format')::int as voice
    from survey_answer sa
    where sa.question_hash is not null
    group by sa.question_hash
    order by responses desc
  `) as Record<string, unknown>[];

  return Response.json({ questions, viewer: viewer.email });
}
