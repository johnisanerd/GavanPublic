"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, ExternalLink, Loader2 } from "lucide-react";

import { createProlificRun } from "./actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

const Field = ({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) => (
  <div className="grid gap-1.5">
    <label className="text-muted-foreground font-mono text-xs uppercase tracking-wide">
      {label}
    </label>
    {children}
  </div>
);

// Create a Prolific DRAFT for an experiment. A draft recruits no one and costs
// nothing — the researcher reviews + publishes it in Prolific (the money step).
export function ProlificRunDialog({
  open,
  onOpenChange,
  experimentSlug,
  experimentId,
  experimentName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  experimentSlug: string;
  experimentId: string;
  experimentName: string;
}) {
  const qc = useQueryClient();
  const [name, setName] = React.useState("");
  const [places, setPlaces] = React.useState("3");
  const [reward, setReward] = React.useState("6.00"); // major units (account currency)
  const [minutes, setMinutes] = React.useState("12");
  const [mic, setMic] = React.useState(false);

  // Seed the name from the experiment each time it opens; clear any prior result.
  const runMut = useMutation({
    mutationFn: () =>
      createProlificRun(experimentId, {
        name: name.trim(),
        places: Number(places),
        rewardCents: Math.round(Number(reward) * 100),
        minutes: Number(minutes),
        requireMicrophone: mic,
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["admin-cohorts", experimentSlug] }),
  });

  React.useEffect(() => {
    if (open) {
      setName(experimentName);
      runMut.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, experimentName]);

  const result = runMut.data;
  const valid =
    name.trim() &&
    Number(places) >= 1 &&
    Number(reward) >= 0 &&
    Number(minutes) >= 1;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {result ? (
          // ── Result: hand back the draft link + the manual-publish reminder ──
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Check className="text-success size-5" />
                Prolific draft created
              </DialogTitle>
              <DialogDescription>
                A <b>draft</b> — no one is recruited and nothing is charged.
                Review eligibility, the completion code, and reward, then{" "}
                <b>publish it in Prolific yourself</b>.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 text-sm">
              <Button asChild>
                <a href={result.studyUrl} target="_blank" rel="noreferrer">
                  Review &amp; publish in Prolific
                  <ExternalLink className="size-4" />
                </a>
              </Button>
              <p className="text-muted-foreground">
                Cohort{" "}
                <span className="text-foreground font-mono">
                  {result.cohort.name}
                </span>{" "}
                · launch link{" "}
                <span className="font-mono">{result.short_link}</span>
              </p>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          // ── Form ────────────────────────────────────────────────────────────
          <>
            <DialogHeader>
              <DialogTitle>Run on Prolific</DialogTitle>
              <DialogDescription>
                Creates a new cohort and an <b>unpublished</b> Prolific study
                pointed at its launch link. You publish it in Prolific.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4">
              <Field label="Study name">
                <Input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <div className="grid grid-cols-3 gap-3">
                <Field label="Places">
                  <Input
                    type="number"
                    min={1}
                    value={places}
                    onChange={(e) => setPlaces(e.target.value)}
                  />
                </Field>
                <Field label="Reward">
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    value={reward}
                    onChange={(e) => setReward(e.target.value)}
                  />
                </Field>
                <Field label="Minutes">
                  <Input
                    type="number"
                    min={1}
                    value={minutes}
                    onChange={(e) => setMinutes(e.target.value)}
                  />
                </Field>
              </div>
              <label className="flex items-center justify-between gap-3">
                <span className="text-sm">
                  Require microphone
                  <span className="text-muted-foreground"> (voice surveys)</span>
                </span>
                <Switch checked={mic} onCheckedChange={setMic} />
              </label>
              <p className="text-muted-foreground text-xs">
                Reward is per participant in your Prolific account currency.
                Eligibility/blocklist are set in Prolific before publishing.
              </p>
              {runMut.isError && (
                <p className="text-destructive text-sm">
                  {String(
                    runMut.error instanceof Error
                      ? runMut.error.message
                      : runMut.error,
                  )}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={runMut.isPending}
              >
                Cancel
              </Button>
              <Button
                onClick={() => runMut.mutate()}
                disabled={!valid || runMut.isPending}
              >
                {runMut.isPending && (
                  <Loader2 className="size-4 animate-spin" />
                )}
                {runMut.isPending ? "Creating draft…" : "Create draft"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
