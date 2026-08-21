"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ChevronRight, ChevronsUpDown, Download } from "lucide-react";

import { rel, fmtDuration, maskId } from "./lib";
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
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

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

type Data = {
  experiment: { slug: string; name: string };
  cohort: { slug: string; name: string; channel: string | null };
  responses: ResponseRow[];
  viewer: string;
};

type SortKey = "submitted_at" | "respondent_ref" | "duration_seconds" | "answers" | "freeform";

function statusBadge(r: ResponseRow) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {r.is_low_quality ? (
        <Badge variant="outline" className="border-warning/50 text-warning">
          Low Quality
        </Badge>
      ) : r.submitted_at ? (
        <Badge variant="outline" className="border-success/50 text-success">
          Complete
        </Badge>
      ) : (
        <Badge variant="outline" className="border-warning/50 text-warning">
          Partial
        </Badge>
      )}
      {r.is_ai_likely && (
        <Badge
          variant="outline"
          title="Contains an em-dash — likely pasted from an LLM"
        >
          AI?
        </Badge>
      )}
    </span>
  );
}

// Comparable value per sort key; null/undefined sort last in both directions.
function cmpValue(r: ResponseRow, key: SortKey): number | string | null {
  switch (key) {
    case "submitted_at":
      return r.submitted_at ? Date.parse(r.submitted_at) : null;
    case "respondent_ref":
      return r.respondent_ref ?? null;
    case "duration_seconds":
      return r.duration_seconds;
    case "answers":
      return Number(r.answers);
    case "freeform":
      return Number(r.freeform);
  }
}

function sortRows(
  rows: ResponseRow[],
  key: SortKey,
  dir: "asc" | "desc",
): ResponseRow[] {
  return [...rows].sort((a, b) => {
    const av = cmpValue(a, key);
    const bv = cmpValue(b, key);
    if (av === null && bv === null) return 0;
    if (av === null) return 1; // nulls always last
    if (bv === null) return -1;
    const d = av < bv ? -1 : av > bv ? 1 : 0;
    return dir === "asc" ? d : -d;
  });
}

function SortHeader({
  label,
  col,
  sort,
  onSort,
  align = "left",
}: {
  label: string;
  col: SortKey;
  sort: { key: SortKey; dir: "asc" | "desc" };
  onSort: (key: SortKey) => void;
  align?: "left" | "right";
}) {
  const active = sort.key === col;
  return (
    <button
      type="button"
      onClick={() => onSort(col)}
      className={`text-muted-foreground hover:text-foreground inline-flex items-center gap-1 transition-colors ${align === "right" ? "ml-auto" : ""}`}
    >
      {label}
      {active ? (
        sort.dir === "desc" ? (
          <ArrowDown className="size-3" />
        ) : (
          <ArrowUp className="size-3" />
        )
      ) : (
        <ChevronsUpDown className="size-3 opacity-40" />
      )}
    </button>
  );
}

export function ResponsesView({
  experimentSlug,
  cohortSlug,
  initialData,
}: {
  experimentSlug: string;
  cohortSlug: string;
  initialData: Data;
}) {
  const { data } = useQuery<Data>({
    queryKey: ["admin-responses", experimentSlug, cohortSlug],
    queryFn: async () => {
      const r = await fetch(
        `/api/admin/experiments/${experimentSlug}/cohorts/${cohortSlug}/responses`,
      );
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    },
    initialData,
    refetchInterval: 4000,
  });

  const experiment = data?.experiment ?? initialData.experiment;
  const cohort = data?.cohort ?? initialData.cohort;
  const rows = data?.responses ?? [];

  // Default: submitted_at desc, nulls last (in-progress responses sink).
  const [sort, setSort] = React.useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "submitted_at",
    dir: "desc",
  });

  function onSort(key: SortKey) {
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "desc" ? "asc" : "desc" }
        : { key, dir: "desc" },
    );
  }

  const sorted = sortRows(rows, sort.key, sort.dir);
  const complete = rows.filter((r) => r.submitted_at != null).length;

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
              <Link href={`/admin/e/${experimentSlug}`}>{experiment.name}</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{cohort.name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-muted-foreground font-mono text-xs uppercase tracking-wide">
            Cohort
          </p>
          <h1 className="mt-1 text-2xl font-normal tracking-tight">
            {cohort.name}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {rows.length} responses · {complete} complete
          </p>
        </div>
        <Button variant="outline" asChild>
          <a
            href={`/api/admin/experiments/${experimentSlug}/cohorts/${cohortSlug}/export`}
            download
          >
            <Download />
            Export CSV
          </a>
        </Button>
      </div>

      <Card className="overflow-hidden p-0">
        {rows.length === 0 ? (
          <CardHeader className="py-10 text-center">
            <CardTitle className="font-normal">No responses yet</CardTitle>
            <CardDescription>
              Responses appear here as they come in.
            </CardDescription>
          </CardHeader>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Status</TableHead>
                <TableHead>
                  <SortHeader label="When" col="submitted_at" sort={sort} onSort={onSort} />
                </TableHead>
                <TableHead>
                  <SortHeader label="Respondent" col="respondent_ref" sort={sort} onSort={onSort} />
                </TableHead>
                <TableHead className="text-right">
                  <SortHeader label="Duration" col="duration_seconds" sort={sort} onSort={onSort} align="right" />
                </TableHead>
                <TableHead className="text-right">
                  <SortHeader label="Answers" col="answers" sort={sort} onSort={onSort} align="right" />
                </TableHead>
                <TableHead className="text-right">
                  <SortHeader label="Freeform" col="freeform" sort={sort} onSort={onSort} align="right" />
                </TableHead>
                <TableHead className="text-center">Scored</TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((r) => (
                <TableRow
                  key={r.id}
                  className="group cursor-pointer"
                  onClick={() => {
                    window.location.href = `/admin/e/${experimentSlug}/c/${cohortSlug}/r/${r.id}`;
                  }}
                >
                  <TableCell>{statusBadge(r)}</TableCell>
                  <TableCell className="font-mono text-xs tabular-nums">
                    {r.submitted_at ? (
                      rel(r.submitted_at)
                    ) : (
                      <span className="text-muted-foreground/50">in progress</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground font-mono text-xs">
                    {maskId(r.respondent_ref)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    {r.duration_seconds == null ? "—" : fmtDuration(r.duration_seconds)}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {Number(r.answers)}
                  </TableCell>
                  <TableCell className="text-right">
                    <span
                      className={`font-mono tabular-nums ${Number(r.freeform) ? "text-primary" : "text-muted-foreground/50"}`}
                    >
                      {Number(r.freeform)}
                    </span>
                  </TableCell>
                  <TableCell className="text-center">
                    {r.is_scored ? (
                      <span className="text-success">✓</span>
                    ) : (
                      <span className="text-muted-foreground/50">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <ChevronRight className="text-muted-foreground/50 size-4" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
