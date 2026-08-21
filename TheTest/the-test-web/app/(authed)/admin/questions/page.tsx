import Link from "next/link";
import { ChevronRight, Mic } from "lucide-react";

import { getSql } from "@/lib/db";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";

export const dynamic = "force-dynamic";

type Q = {
  question_hash: string;
  title: string | null;
  field_type: string | null;
  responses: number;
  voice: number;
};

// Research → Questions: every distinct question (by content hash), click through
// to read/listen to all responses to it back-to-back.
export default async function QuestionsPage() {
  const sql = getSql();
  const questions = (await sql`
    select sa.question_hash,
           max(sa.question_title)                                       as title,
           max(sa.field_type)                                           as field_type,
           count(*)::int                                                as responses,
           count(*) filter (where sa.field_type = 'multi_format')::int  as voice
    from survey_answer sa
    where sa.question_hash is not null
    group by sa.question_hash
    order by responses desc
  `) as Q[];

  return (
    <div className="flex min-w-0 flex-col gap-6 p-4 sm:p-6">
      <div>
        <p className="text-muted-foreground font-mono text-xs uppercase tracking-wide">
          Research
        </p>
        <h1 className="mt-1 text-2xl font-normal tracking-tight">Questions</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {questions.length} questions · click to see every response
        </p>
      </div>

      <Card className="divide-y overflow-hidden p-0">
        {questions.map((q) => (
          <Link
            key={q.question_hash}
            href={`/admin/questions/${q.question_hash}`}
            className="hover:bg-accent flex items-center gap-3 px-4 py-3 transition-colors"
          >
            <span className="min-w-0 flex-1 truncate text-sm">
              {q.title ?? q.field_type ?? "—"}
            </span>
            {q.voice > 0 && (
              <Badge variant="secondary" className="shrink-0">
                <Mic className="size-3" />
                {q.voice}
              </Badge>
            )}
            <span className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums">
              {q.responses} responses
            </span>
            <ChevronRight className="text-muted-foreground/50 size-4 shrink-0" />
          </Link>
        ))}
      </Card>
    </div>
  );
}
