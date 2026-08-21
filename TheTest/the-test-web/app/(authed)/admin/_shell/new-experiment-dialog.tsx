"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";

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
import { createExperiment } from "../actions";
import { FormCombobox } from "../form-combobox";

// Create-experiment flow shared by the sidebar action and the landing page.
// Both a name and a bound survey form are required up front — an experiment with
// no form can't collect responses, so we don't let one exist half-configured.
// (The DB column is nullable to leave room for a future configure-after path.)
export function NewExperimentDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = React.useState("");
  const [formId, setFormId] = React.useState<string | null>(null);
  const router = useRouter();
  const qc = useQueryClient();

  const createMut = useMutation({
    mutationFn: () => createExperiment(name.trim(), formId!),
    onSuccess: async (experiment) => {
      await qc.invalidateQueries({ queryKey: ["admin-experiments"] });
      onOpenChange(false);
      setName("");
      setFormId(null);
      router.push(`/admin/e/${experiment.slug}`);
    },
  });

  const canCreate = Boolean(name.trim() && formId) && !createMut.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New experiment</DialogTitle>
          <DialogDescription>
            Name it and bind the survey form it runs. Cohorts inherit this form
            when they’re created.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <label className="text-muted-foreground font-mono text-xs uppercase tracking-wide">
              Name
            </label>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canCreate) createMut.mutate();
              }}
              placeholder="e.g. Wave 3 — AI risk literacy"
            />
          </div>
          <div className="grid gap-2">
            <label className="text-muted-foreground font-mono text-xs uppercase tracking-wide">
              Survey form
            </label>
            <FormCombobox value={formId} onChange={setFormId} />
          </div>
          {createMut.isError && (
            <p className="text-destructive text-sm">
              Failed to create experiment.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={createMut.isPending}
          >
            Cancel
          </Button>
          <Button onClick={() => createMut.mutate()} disabled={!canCreate}>
            {createMut.isPending ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
