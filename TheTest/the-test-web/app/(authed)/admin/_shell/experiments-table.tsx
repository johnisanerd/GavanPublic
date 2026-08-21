"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ChevronRight, Plus } from "lucide-react";

import { rel } from "../lib";
import { NewExperimentDialog } from "./new-experiment-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type Experiment = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  created_at: string | null;
  cohorts: number;
  responses: number;
  complete: number;
  last_response_at: string | null;
};

// Sort helper: last-response desc with nulls last (default), toggleable asc.
function sortByLastResponse(
  rows: Experiment[],
  dir: "asc" | "desc",
): Experiment[] {
  return [...rows].sort((a, b) => {
    const at = a.last_response_at ? Date.parse(a.last_response_at) : null;
    const bt = b.last_response_at ? Date.parse(b.last_response_at) : null;
    if (at === null && bt === null) return 0;
    if (at === null) return 1; // nulls always last
    if (bt === null) return -1;
    return dir === "desc" ? bt - at : at - bt;
  });
}

export function ExperimentsTable({
  initialData,
}: {
  initialData: { experiments: Experiment[] };
}) {
  const [newOpen, setNewOpen] = React.useState(false);
  const [sortDir, setSortDir] = React.useState<"asc" | "desc">("desc");

  const { data } = useQuery<{ experiments: Experiment[] }>({
    queryKey: ["admin-experiments"],
    queryFn: async () => {
      const r = await fetch("/api/admin/experiments");
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    },
    initialData,
    refetchInterval: 5000,
  });

  const experiments = sortByLastResponse(data?.experiments ?? [], sortDir);

  return (
    <div className="flex min-w-0 flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-muted-foreground font-mono text-xs uppercase tracking-wide">
            Research
          </p>
          <h1 className="mt-1 text-2xl font-normal tracking-tight">
            Experiments
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {experiments.length} total
          </p>
        </div>
        <Button onClick={() => setNewOpen(true)}>
          <Plus />
          New experiment
        </Button>
      </div>

      <Card className="overflow-hidden p-0">
        {experiments.length === 0 ? (
          <CardHeader className="py-10 text-center">
            <CardTitle className="font-normal">No experiments yet</CardTitle>
            <CardDescription>
              Create one to start collecting responses.
            </CardDescription>
          </CardHeader>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Experiment</TableHead>
                <TableHead className="font-mono text-xs uppercase">
                  Slug
                </TableHead>
                <TableHead className="text-right">Cohorts</TableHead>
                <TableHead className="text-right">Responses</TableHead>
                <TableHead className="text-right">Complete</TableHead>
                <TableHead className="text-right">
                  <button
                    type="button"
                    onClick={() =>
                      setSortDir((d) => (d === "desc" ? "asc" : "desc"))
                    }
                    className="text-muted-foreground hover:text-foreground ml-auto inline-flex items-center gap-1 transition-colors"
                  >
                    Last response
                    {sortDir === "desc" ? (
                      <ArrowDown className="size-3" />
                    ) : (
                      <ArrowUp className="size-3" />
                    )}
                  </button>
                </TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {experiments.map((e) => (
                <TableRow
                  key={e.id}
                  className="group cursor-pointer"
                  onClick={() => {
                    window.location.href = `/admin/e/${e.slug}`;
                  }}
                >
                  <TableCell className="font-medium">
                    <Link
                      href={`/admin/e/${e.slug}`}
                      className="hover:underline"
                      onClick={(ev) => ev.stopPropagation()}
                    >
                      {e.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground font-mono text-xs">
                    {e.slug}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {Number(e.cohorts) || 0}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {Number(e.responses) || 0}
                  </TableCell>
                  <TableCell className="text-right">
                    <span className="text-success font-mono tabular-nums">
                      {Number(e.complete) || 0}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-right font-mono text-xs tabular-nums">
                    {e.last_response_at ? rel(e.last_response_at) : "—"}
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

      <NewExperimentDialog open={newOpen} onOpenChange={setNewOpen} />
    </div>
  );
}
