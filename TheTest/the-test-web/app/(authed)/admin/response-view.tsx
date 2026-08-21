"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Mic } from "lucide-react";

import {
  rel,
  fmtDuration,
  maskId,
  isChoiceType,
  parseChoice,
  audioSrc,
  type Answer,
} from "./lib";
import { MiniAudio } from "./mini-audio";
import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Card } from "@/components/ui/card";

type ResponseDetail = {
  id: string;
  submitted_at: string | null;
  channel: string | null;
  respondent_ref: string | null;
  prolific_session_id: string | null;
  duration_seconds: number | null;
  is_scored: boolean;
  is_prolific_enriched: boolean;
  is_low_quality: boolean;
  is_ai_likely: boolean;
  created_at: string | null;
  cohort_slug: string | null;
  cohort_name: string | null;
  experiment_slug: string | null;
  experiment_name: string | null;
  answers: Answer[];
};

type Data = { response: ResponseDetail; viewer: string };

function isVoiceAnswer(a: Answer): boolean {
  return a.field_type === "multi_format" && !!a.field_ref;
}

function MetaGrid({ r }: { r: ResponseDetail }) {
  const items: [string, React.ReactNode][] = [
    [
      "Status",
      r.is_low_quality
        ? "Low Quality"
        : r.submitted_at
          ? "Complete"
          : "Partial",
    ],
    ["When", r.submitted_at ? rel(r.submitted_at) : "in progress"],
    ["Channel", r.channel ?? "—"],
    ["Respondent", maskId(r.respondent_ref, 4)],
    ["Duration", fmtDuration(r.duration_seconds)],
    ["Scored", r.is_scored ? "yes" : "no"],
  ];
  return (
    <Card className="grid grid-cols-2 gap-px overflow-hidden p-0 sm:grid-cols-3 lg:grid-cols-6">
      {items.map(([k, v]) => (
        <div key={k} className="bg-card p-3">
          <div className="text-muted-foreground font-mono text-[10px] uppercase tracking-wide">
            {k}
          </div>
          <div className="mt-1 font-mono text-sm">{v}</div>
        </div>
      ))}
    </Card>
  );
}

export function ResponseView({
  responseId,
  initialData,
}: {
  responseId: string;
  initialData: Data;
}) {
  const { data } = useQuery<Data>({
    queryKey: ["admin-response", responseId],
    queryFn: async () => {
      const r = await fetch(`/api/admin/responses/${responseId}`);
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    },
    initialData,
    refetchInterval: 5000,
  });

  const r = data?.response ?? initialData.response;
  const answers = r.answers ?? [];
  const answeredCount = answers.filter((a) => !a.skipped).length;
  const skippedCount = answers.length - answeredCount;

  const expSlug = r.experiment_slug ?? initialData.response.experiment_slug;
  const cohSlug = r.cohort_slug ?? initialData.response.cohort_slug;
  const base = `/admin/e/${expSlug}/c/${cohSlug}/r/${responseId}`;
  const label = maskId(r.respondent_ref ?? r.id, 4);

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
              <Link href={`/admin/e/${expSlug}`}>
                {r.experiment_name ?? expSlug}
              </Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href={`/admin/e/${expSlug}/c/${cohSlug}`}>
                {r.cohort_name ?? cohSlug}
              </Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage className="font-mono text-xs">{label}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div>
        <p className="text-muted-foreground font-mono text-xs uppercase tracking-wide">
          Response
        </p>
        <h1 className="mt-1 font-mono text-2xl font-normal tracking-tight">
          {label}
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {answeredCount} answered
          {skippedCount > 0 && ` · ${skippedCount} skipped`}
        </p>
      </div>

      <MetaGrid r={r} />

      <div>
        <p className="text-muted-foreground mb-2 font-mono text-xs uppercase tracking-wide">
          Questions — click to open
        </p>
        <Card className="overflow-hidden p-0">
          {answers.length === 0 ? (
            <div className="text-muted-foreground py-10 text-center text-sm">
              No answers recorded yet.
            </div>
          ) : (
            <ul className="divide-y">
              {answers.map((a, i) => {
                if (a.skipped) {
                  return (
                    <li key={i}>
                      <div className="grid w-full grid-cols-[minmax(120px,34%)_1fr_auto] items-start gap-4 border-l-2 border-transparent px-4 py-3 text-left opacity-60">
                        <span className="flex min-w-0 items-baseline gap-2">
                          <span className="text-muted-foreground/50 shrink-0 font-mono text-xs">
                            {String(i + 1).padStart(2, "0")}
                          </span>
                          <span className="text-muted-foreground text-sm leading-snug">
                            {a.question_title ?? a.field_type ?? "—"}
                          </span>
                        </span>
                        <span className="min-w-0 text-sm">
                          <Badge
                            variant="outline"
                            className="text-muted-foreground font-normal"
                          >
                            Not answered
                          </Badge>
                        </span>
                        <span className="size-4" />
                      </div>
                    </li>
                  );
                }
                const voice = isVoiceAnswer(a);
                const choice = isChoiceType(a.field_type)
                  ? parseChoice(a.value)
                  : null;
                return (
                  <li key={i}>
                    <Link
                      href={`${base}/a/${a.position ?? i}`}
                      className={`hover:bg-accent grid w-full grid-cols-[minmax(120px,34%)_1fr_auto] items-start gap-4 px-4 py-3 text-left transition-colors ${a.is_freeform ? "border-primary border-l-2" : "border-l-2 border-transparent"}`}
                    >
                      <span className="flex min-w-0 items-baseline gap-2">
                        <span className="text-muted-foreground/50 shrink-0 font-mono text-xs">
                          {String(i + 1).padStart(2, "0")}
                        </span>
                        <span className="text-muted-foreground text-sm leading-snug">
                          {a.question_title ?? a.field_type ?? "—"}
                        </span>
                      </span>
                      <span className="min-w-0 truncate text-sm">
                        {voice ? (
                          <span className="inline-flex min-w-0 items-center gap-1.5">
                            <Badge variant="secondary">
                              <Mic className="size-3" />
                              Voice
                            </Badge>
                            {a.field_ref && (
                              <MiniAudio
                                src={audioSrc(r.id, a.field_ref, a.recordingId)}
                              />
                            )}
                            <span className="text-muted-foreground truncate">
                              {a.value ?? "—"}
                            </span>
                          </span>
                        ) : choice ? (
                          <span className="inline-flex min-w-0 items-center gap-1.5">
                            {choice.letter && (
                              <span className="border-border text-muted-foreground inline-flex size-5 shrink-0 items-center justify-center rounded border font-mono text-[11px]">
                                {choice.letter}
                              </span>
                            )}
                            <span className="text-muted-foreground truncate">
                              {choice.text}
                            </span>
                          </span>
                        ) : (
                          <span
                            className={a.is_freeform ? "" : "text-muted-foreground"}
                          >
                            {a.value ?? "—"}
                          </span>
                        )}
                      </span>
                      <ChevronRight className="text-muted-foreground/50 mt-0.5 size-4" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
