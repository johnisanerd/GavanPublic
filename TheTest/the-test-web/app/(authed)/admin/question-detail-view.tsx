"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";

import {
  rel,
  maskId,
  audioSrc,
  isChoiceType,
  parseChoice,
} from "./lib";
import { MiniAudio } from "./mini-audio";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

export type QAnswer = {
  position: number | null;
  field_ref: string | null;
  field_type: string | null;
  is_freeform: boolean;
  value: string | null;
  response_id: string;
  respondent_ref: string | null;
  submitted_at: string | null;
  created_at: string | null;
  cohort_slug: string | null;
  cohort_name: string | null;
  experiment_slug: string | null;
  experiment_name: string | null;
  recording_id: string | null;
  recording_duration: number | null;
};

const isVoice = (a: QAnswer) => a.field_type === "multi_format" && !!a.field_ref;

export function QuestionDetailView({
  title,
  fieldType,
  answers,
}: {
  title: string | null;
  fieldType: string | null;
  answers: QAnswer[];
}) {
  const [autoplay, setAutoplay] = React.useState(false);
  const [activeIdx, setActiveIdx] = React.useState<number | null>(null);

  const voiceIdxs = React.useMemo(
    () => answers.map((a, i) => (isVoice(a) ? i : -1)).filter((i) => i >= 0),
    [answers],
  );

  function onAutoplayChange(checked: boolean) {
    setAutoplay(checked);
    setActiveIdx(checked ? (voiceIdxs[0] ?? null) : null);
  }

  function handleEnded(i: number) {
    setActiveIdx((cur) => {
      if (cur !== i) return cur;
      const pos = voiceIdxs.indexOf(i);
      const next = voiceIdxs[pos + 1];
      if (next == null) setAutoplay(false);
      return next ?? null;
    });
  }

  return (
    <div className="flex min-w-0 flex-col gap-6 p-4 sm:p-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href="/admin/questions">Questions</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage className="max-w-[60vw] truncate">
              {title ?? fieldType ?? "—"}
            </BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-muted-foreground font-mono text-xs uppercase tracking-wide">
            Question
          </p>
          <h1 className="mt-1 text-2xl font-normal leading-snug tracking-tight">
            {title ?? fieldType ?? "—"}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {answers.length} responses
          </p>
        </div>
        {voiceIdxs.length > 0 && (
          <label
            className="flex cursor-pointer items-center gap-2 text-sm"
            title="Play every voice answer back-to-back"
          >
            <Switch
              checked={autoplay}
              onCheckedChange={onAutoplayChange}
              aria-label="Autoplay voice answers"
            />
            <span className="text-muted-foreground">Autoplay</span>
          </label>
        )}
      </div>

      <Card className="divide-y overflow-hidden p-0">
        {answers.map((a, i) => {
          const voice = isVoice(a);
          const choice = isChoiceType(a.field_type) ? parseChoice(a.value) : null;
          const href =
            a.experiment_slug && a.cohort_slug
              ? `/admin/e/${a.experiment_slug}/c/${a.cohort_slug}/r/${a.response_id}/a/${a.position}`
              : null;
          return (
            <div
              key={`${a.response_id}-${i}`}
              className={`flex flex-col gap-1.5 px-4 py-3 ${activeIdx === i ? "bg-accent/50" : ""}`}
            >
              <div className="flex items-center gap-2">
                {voice && a.field_ref && (
                  <MiniAudio
                    src={audioSrc(a.response_id, a.field_ref, a.recording_id)}
                    active={autoplay ? activeIdx === i : undefined}
                    onEnded={() => handleEnded(i)}
                  />
                )}
                <span className="font-mono text-xs">
                  {maskId(a.respondent_ref ?? a.response_id)}
                </span>
                <span className="text-muted-foreground hidden truncate text-xs sm:inline">
                  {a.experiment_name} · {a.cohort_name}
                </span>
                <span className="text-muted-foreground ml-auto shrink-0 font-mono text-xs whitespace-nowrap">
                  {rel(a.created_at)}
                </span>
                {href && (
                  <Link
                    href={href}
                    className="text-muted-foreground/50 hover:text-foreground shrink-0"
                    aria-label="Open answer"
                  >
                    <ChevronRight className="size-4" />
                  </Link>
                )}
              </div>
              <div className="text-sm">
                {choice ? (
                  <span className="inline-flex items-center gap-1.5">
                    {choice.letter && (
                      <span className="border-border text-muted-foreground inline-flex size-5 shrink-0 items-center justify-center rounded border font-mono text-[11px]">
                        {choice.letter}
                      </span>
                    )}
                    <span className="text-muted-foreground">{choice.text}</span>
                  </span>
                ) : (
                  <span
                    className={`line-clamp-3 ${a.is_freeform ? "text-foreground/90" : "text-muted-foreground"}`}
                  >
                    {a.value ?? "—"}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </Card>
    </div>
  );
}
