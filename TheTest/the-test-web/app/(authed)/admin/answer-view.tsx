import Link from "next/link";
import { ChevronLeft, ChevronRight, ListChecks, Mic } from "lucide-react";

import {
  fmtDuration,
  maskId,
  audioSrc,
  isChoiceType,
  parseChoice,
  type Answer,
} from "./lib";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

export type AnswerResponse = {
  id: string;
  respondent_ref: string | null;
  experiment_slug: string | null;
  experiment_name: string | null;
  cohort_slug: string | null;
  cohort_name: string | null;
};

// An answer as a first-class page: its own URL, breadcrumb, and prev/next nav
// through the response's answers. (Replaces the old slide-in Sheet.)
export function AnswerView({
  response,
  answer,
  index,
  total,
  prevPos,
  nextPos,
}: {
  response: AnswerResponse;
  answer: Answer;
  index: number;
  total: number;
  prevPos: number | null;
  nextPos: number | null;
}) {
  const base = `/admin/e/${response.experiment_slug}/c/${response.cohort_slug}/r/${response.id}`;
  const isVoice = answer.field_type === "multi_format" && !!answer.field_ref;
  const isChoice = isChoiceType(answer.field_type);
  const choice = isChoice ? parseChoice(answer.value) : null;
  const respLabel = maskId(response.respondent_ref ?? response.id, 4);

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href="/admin">Experiments</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href={`/admin/e/${response.experiment_slug}`}>
                {response.experiment_name ?? response.experiment_slug}
              </Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href={`/admin/e/${response.experiment_slug}/c/${response.cohort_slug}`}>
                {response.cohort_name ?? response.cohort_slug}
              </Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href={base} className="font-mono text-xs">
                {respLabel}
              </Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>
              <span className="sm:hidden">Q. {index + 1}</span>
              <span className="hidden sm:inline">Question {index + 1}</span>
            </BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div>
        <div className="flex items-center gap-2">
          <p className="text-muted-foreground font-mono text-xs uppercase tracking-wide">
            Answer {index + 1} of {total}
          </p>
          {answer.is_freeform && (
            <Badge className="bg-primary text-primary-foreground">Freeform</Badge>
          )}
          {isVoice && (
            <Badge variant="secondary">
              <Mic className="size-3" />
              Voice
            </Badge>
          )}
          {isChoice && (
            <Badge variant="secondary">
              <ListChecks className="size-3" />
              Choice
            </Badge>
          )}
        </div>
        <h1 className="mt-1 text-2xl font-normal leading-snug tracking-tight">
          {answer.question_title ?? answer.field_type ?? "—"}
        </h1>
        <p className="text-muted-foreground mt-1 font-mono text-xs">
          {answer.field_type ?? "—"}
          {answer.field_ref ? ` · ${answer.field_ref}` : ""}
        </p>
      </div>

      <div>
        <p className="text-muted-foreground mb-2 font-mono text-xs uppercase tracking-wide">
          Answer
        </p>
        <div
          className={`text-sm leading-relaxed break-words whitespace-pre-wrap ${answer.is_freeform ? "border-primary bg-primary/5 rounded border-l-2 p-4" : "text-foreground"}`}
        >
          {isChoice && choice ? (
            <span className="inline-flex items-start gap-2.5">
              {choice.letter && (
                <span className="border-border text-foreground flex size-7 shrink-0 items-center justify-center rounded-md border font-mono text-sm">
                  {choice.letter}
                </span>
              )}
              <span className="pt-1 text-base">{choice.text}</span>
            </span>
          ) : (
            (answer.value ?? <span className="text-muted-foreground/50">—</span>)
          )}
        </div>
      </div>

      {isVoice && answer.field_ref && (
        <div>
          <p className="text-muted-foreground mb-2 font-mono text-xs uppercase tracking-wide">
            Voice
          </p>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio
            controls
            preload="none"
            src={audioSrc(response.id, answer.field_ref, answer.recordingId)}
            className="w-full max-w-md"
          />
          <p className="text-muted-foreground/70 mt-1.5 font-mono text-[10px]">
            {answer.recordingId ? "Recording" : "Generate on play"}
            {answer.recordingDuration != null
              ? ` · ${fmtDuration(answer.recordingDuration)}`
              : ""}
          </p>
        </div>
      )}

      <div className="mt-2 flex items-center justify-between border-t pt-4">
        {prevPos != null ? (
          <Button variant="outline" asChild>
            <Link href={`${base}/a/${prevPos}`}>
              <ChevronLeft />
              Previous
            </Link>
          </Button>
        ) : (
          <Button variant="outline" disabled>
            <ChevronLeft />
            Previous
          </Button>
        )}
        {nextPos != null ? (
          <Button variant="outline" asChild>
            <Link href={`${base}/a/${nextPos}`}>
              Next
              <ChevronRight />
            </Link>
          </Button>
        ) : (
          <Button variant="outline" disabled>
            Next
            <ChevronRight />
          </Button>
        )}
      </div>
    </div>
  );
}
