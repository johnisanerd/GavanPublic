"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";

import { rel, maskId, answerHref, audioSrc, type RecentResponse } from "../lib";
import { Badge } from "@/components/ui/badge";
import { MiniAudio } from "../mini-audio";

// Live feed of responses as they arrive (newest first), auto-refreshing.
export function LiveView() {
  const { data, isLoading } = useQuery<{ responses: RecentResponse[] }>({
    queryKey: ["admin-recent"],
    queryFn: async () => {
      const r = await fetch("/api/admin/recent");
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    },
    refetchInterval: 4000,
  });

  const responses = data?.responses ?? [];

  return (
    <div className="flex min-w-0 flex-col gap-4 p-4 sm:p-6">
      <div>
        <p className="text-muted-foreground font-mono text-xs uppercase tracking-wide">
          Research
        </p>
        <div className="mt-1 flex items-center gap-3">
          <h1 className="text-2xl font-normal tracking-tight">Live Results</h1>
          <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <span className="bg-success inline-block size-2 animate-pulse rounded-full" />
            live
          </span>
        </div>
        <p className="text-muted-foreground mt-1 text-sm">
          Responses as they come in, across all experiments.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        {isLoading && (
          <p className="text-muted-foreground text-sm">Loading…</p>
        )}
        {!isLoading && responses.length === 0 && (
          <p className="text-muted-foreground text-sm">No responses yet.</p>
        )}
        {responses.map((r) => {
          const href = answerHref(r);
          const row = (
            <div className="bg-card hover:bg-accent flex flex-col gap-1.5 rounded-lg border p-3 transition-colors">
              <div className="flex items-center gap-3">
                {r.is_low_quality ? (
                  <Badge
                    variant="outline"
                    className="border-warning/50 text-warning"
                  >
                    Low Quality
                  </Badge>
                ) : r.submitted_at ? (
                  <Badge
                    variant="outline"
                    className="border-success/50 text-success"
                  >
                    Done
                  </Badge>
                ) : (
                  <Badge
                    variant="outline"
                    className="border-warning/50 text-warning"
                  >
                    Partial
                  </Badge>
                )}
                {r.is_ai_likely && <Badge variant="outline">AI?</Badge>}
                <span className="font-mono text-xs">
                  {maskId(r.respondent_ref ?? r.id)}
                </span>
                {r.preview_field_type === "multi_format" && r.preview_field_ref && (
                  <MiniAudio
                    src={audioSrc(r.id, r.preview_field_ref, r.preview_recording_id)}
                  />
                )}
                <span className="text-muted-foreground hidden truncate text-xs sm:inline">
                  {r.experiment_name ?? r.experiment_slug} ·{" "}
                  {r.cohort_name ?? r.cohort_slug}
                </span>
                <span className="text-muted-foreground ml-auto shrink-0 font-mono text-xs whitespace-nowrap">
                  {rel(r.created_at)}
                </span>
              </div>
              {r.preview_answer && (
                <div className="min-w-0">
                  {r.preview_question && (
                    <p className="text-muted-foreground truncate text-xs">
                      {r.preview_question}
                    </p>
                  )}
                  <p className="text-foreground/80 line-clamp-2 text-sm">
                    {r.preview_answer}
                  </p>
                </div>
              )}
            </div>
          );
          return href ? (
            <Link key={r.id} href={href}>
              {row}
            </Link>
          ) : (
            <div key={r.id}>{row}</div>
          );
        })}
      </div>
    </div>
  );
}
