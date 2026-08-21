"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  Link2,
  Pencil,
  Play,
  Plus,
  Replace,
  Trash2,
  Users,
  X,
} from "lucide-react";

import { rel } from "./lib";
import {
  bindExperimentForm,
  createCohort,
  deleteExperiment,
  renameExperiment,
} from "./actions";
import { FormCombobox, useForms } from "./form-combobox";
import { ProlificRunDialog } from "./prolific-run-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
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
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type Cohort = {
  id: string;
  slug: string;
  name: string;
  channel: string | null;
  short_code: string | null;
  prolific_study_id: string | null;
  typeform_form_id: string | null;
  created_at: string | null;
  responses: number;
  complete: number;
  last_response_at: string | null;
};

type Data = {
  experiment: {
    id: string;
    slug: string;
    name: string;
    typeform_form_id: string | null;
  };
  cohorts: Cohort[];
};

// The /g/ short link for a cohort plus a Copy button. Both the link and the
// button stop click propagation so they don't trigger the row's drill-in.
// Copies the absolute URL (the cell shows the relative /g/ path).
function CopyLink({ shortCode }: { shortCode: string }) {
  const [copied, setCopied] = React.useState(false);
  const path = `/g/${shortCode}`;
  return (
    <span className="inline-flex items-center gap-0.5">
      <Link
        href={path}
        className="text-muted-foreground align-middle font-mono text-xs hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        {path}
      </Link>
      <Tooltip open={copied || undefined}>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            aria-label="Copy link"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              const url =
                typeof window !== "undefined"
                  ? new URL(path, window.location.origin).toString()
                  : path;
              navigator.clipboard.writeText(url);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? (
              <Check className="text-success size-3.5" />
            ) : (
              <Copy className="size-3.5" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{copied ? "Copied!" : "Copy link"}</TooltipContent>
      </Tooltip>
    </span>
  );
}

function channelBadge(ch: string | null) {
  if (ch === "prolific") return <Badge variant="secondary">Prolific</Badge>;
  return <Badge variant="outline">{ch ?? "direct"}</Badge>;
}

// "Run" the experiment: pick how to recruit. Disabled until a form is bound
// (a launch link / study needs somewhere to send people).
function RunMenu({
  disabled,
  linkPending,
  onLink,
  onProlific,
}: {
  disabled: boolean;
  linkPending: boolean;
  onLink: () => void;
  onProlific: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          disabled={disabled || linkPending}
          title={
            disabled
              ? "Bind a survey form first"
              : "Recruit participants for this experiment"
          }
        >
          <Play />
          {linkPending ? "Creating…" : "Run"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuItem onClick={onLink}>
          <Link2 />
          <div className="flex flex-col">
            <span>Shareable link</span>
            <span className="text-muted-foreground text-xs">
              Mint a direct /g/ link
            </span>
          </div>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onProlific}>
          <Users />
          <div className="flex flex-col">
            <span>Prolific draft…</span>
            <span className="text-muted-foreground text-xs">
              Create an unpublished study
            </span>
          </div>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function CohortsView({
  experimentSlug,
  initialData,
}: {
  experimentSlug: string;
  initialData: Data;
}) {
  const qc = useQueryClient();
  const { data } = useQuery<Data>({
    queryKey: ["admin-cohorts", experimentSlug],
    queryFn: async () => {
      const r = await fetch(`/api/admin/experiments/${experimentSlug}/cohorts`);
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    },
    initialData,
    refetchInterval: 5000,
  });

  const experiment = data?.experiment ?? initialData.experiment;
  const cohorts = data?.cohorts ?? [];

  const [created, setCreated] = React.useState<{
    name: string;
    link: string;
  } | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [prolificOpen, setProlificOpen] = React.useState(false);

  // Inline rename of the experiment name. The mutation is a Server Function
  // (./actions) used as React Query's mutationFn — typed call, no fetch wiring.
  const [editingName, setEditingName] = React.useState(false);
  const [draftName, setDraftName] = React.useState("");
  const renameMut = useMutation({
    mutationFn: (name: string) => renameExperiment(experimentSlug, name),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["admin-cohorts", experimentSlug] }),
  });

  async function saveName() {
    const name = draftName.trim();
    if (!name || name === experiment.name) {
      setEditingName(false);
      return;
    }
    try {
      await renameMut.mutateAsync(name);
      setEditingName(false);
    } catch {
      alert("Failed to rename experiment");
    }
  }

  const createMut = useMutation({
    mutationFn: () => createCohort(experiment.id),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["admin-cohorts", experimentSlug] }),
  });

  async function newCohort() {
    setCopied(false);
    try {
      const res = await createMut.mutateAsync();
      setCreated({ name: res.cohort.name, link: res.short_link });
      try {
        await navigator.clipboard.writeText(res.short_link);
        setCopied(true);
      } catch {}
    } catch {
      alert("Failed to create cohort");
    }
  }

  // Survey-form binding: resolve the bound form's title/edit-link from the cached
  // forms list, and a "change form" modal (a swap, not the inline name rename).
  const { data: forms } = useForms();
  const boundForm = forms?.find((f) => f.id === experiment.typeform_form_id);
  const [changingForm, setChangingForm] = React.useState(false);
  const [draftForm, setDraftForm] = React.useState<string | null>(null);
  const bindMut = useMutation({
    mutationFn: (formId: string) => bindExperimentForm(experimentSlug, formId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-cohorts", experimentSlug] });
      setChangingForm(false);
    },
  });

  // Permanently delete the experiment. Type-to-confirm (the name) gates it.
  const router = useRouter();
  const [deletingOpen, setDeletingOpen] = React.useState(false);
  const [deleteConfirm, setDeleteConfirm] = React.useState("");
  const deleteMut = useMutation({
    mutationFn: () => deleteExperiment(experimentSlug, deleteConfirm),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-experiments"] });
      router.push("/admin");
    },
  });

  const complete = cohorts.reduce((n, c) => n + Number(c.complete), 0);
  const totalResponses = cohorts.reduce((n, c) => n + Number(c.responses), 0);
  const hasForm = Boolean(experiment.typeform_form_id);

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
            <BreadcrumbPage>{experiment.name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-muted-foreground font-mono text-xs uppercase tracking-wide">
            Experiment
          </p>
          {editingName ? (
            <div className="mt-1 flex items-center gap-1.5">
              <Input
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveName();
                  if (e.key === "Escape") setEditingName(false);
                }}
                autoFocus
                disabled={renameMut.isPending}
                // Render as the heading itself: same DM Sans 2xl, no field chrome,
                // just an underline + caret so editing happens "in place".
                className="h-auto max-w-md rounded-none border-0 border-b border-foreground/30 bg-transparent px-0 py-1 text-2xl font-normal tracking-tight shadow-none focus-visible:border-foreground focus-visible:ring-0"
                aria-label="Experiment name"
              />
              <Button
                size="icon"
                variant="ghost"
                className="size-8 shrink-0"
                onClick={() => void saveName()}
                disabled={renameMut.isPending}
                aria-label="Save name"
              >
                <Check className="text-success size-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="text-destructive/70 hover:text-destructive hover:bg-destructive/10 size-8 shrink-0"
                onClick={() => setEditingName(false)}
                disabled={renameMut.isPending}
                aria-label="Cancel"
              >
                <X className="size-4" />
              </Button>
            </div>
          ) : (
            <div className="mt-1 flex items-center gap-1.5">
              <h1 className="text-2xl font-normal tracking-tight">
                {experiment.name}
              </h1>
              <Button
                size="icon"
                variant="ghost"
                className="text-muted-foreground/60 hover:text-foreground size-7 shrink-0"
                onClick={() => {
                  setDraftName(experiment.name);
                  setEditingName(true);
                }}
                aria-label="Rename experiment"
              >
                <Pencil className="size-3.5" />
              </Button>
            </div>
          )}
          <p className="text-muted-foreground mt-1 text-sm">
            {cohorts.length} cohorts · {complete} complete
          </p>
          {/* Survey-form binding. The form's title links out to the Typeform
              editor; "Change form" is a swap (distinct from the name pencil). */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-sm">
            <span className="text-muted-foreground font-mono text-xs uppercase tracking-wide">
              Form
            </span>
            {hasForm ? (
              <>
                {boundForm ? (
                  <a
                    href={boundForm.editUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 hover:underline"
                    title="Open in the Typeform editor"
                  >
                    {boundForm.title}
                    <ExternalLink className="text-muted-foreground size-3" />
                  </a>
                ) : (
                  <span className="font-mono text-xs">
                    {experiment.typeform_form_id}
                  </span>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground hover:text-foreground h-6 gap-1 px-1.5"
                  onClick={() => {
                    setDraftForm(experiment.typeform_form_id);
                    setChangingForm(true);
                  }}
                >
                  <Replace className="size-3" />
                  Change form
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="h-6 gap-1 px-2"
                onClick={() => {
                  setDraftForm(null);
                  setChangingForm(true);
                }}
              >
                <Plus className="size-3" />
                Bind form
              </Button>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild>
            <a
              href={`/api/admin/experiments/${experimentSlug}/export`}
              download
            >
              <Download />
              Export CSV
            </a>
          </Button>
          <RunMenu
            disabled={!hasForm}
            linkPending={createMut.isPending}
            onLink={newCohort}
            onProlific={() => setProlificOpen(true)}
          />
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground/60 hover:text-destructive hover:bg-destructive/10"
            title="Delete experiment"
            aria-label="Delete experiment"
            onClick={() => {
              setDeleteConfirm("");
              deleteMut.reset();
              setDeletingOpen(true);
            }}
          >
            <Trash2 />
          </Button>
        </div>
      </div>

      {created && (
        <div className="border-success/40 bg-success/5 flex flex-wrap items-center gap-3 rounded-lg border border-l-4 p-3 text-sm">
          <Badge className="bg-success text-white">New cohort</Badge>
          <span className="font-mono">{created.name}</span>
          <a
            href={created.link}
            className="text-muted-foreground font-mono text-xs hover:underline"
          >
            {created.link}
          </a>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => {
              navigator.clipboard.writeText(created.link);
              setCopied(true);
            }}
          >
            {copied ? <Check className="text-success" /> : <Copy />}
            {copied ? "Copied" : "Copy link"}
          </Button>
        </div>
      )}

      <Card className="overflow-hidden p-0">
        {cohorts.length === 0 ? (
          <CardHeader className="items-center py-10 text-center">
            <CardTitle className="font-normal">No cohorts yet</CardTitle>
            <CardDescription>
              Run the experiment — a shareable link or a Prolific draft — to
              start collecting responses.
            </CardDescription>
            <CardContent className="pt-2">
              <RunMenu
                disabled={!hasForm}
                linkPending={createMut.isPending}
                onLink={newCohort}
                onProlific={() => setProlificOpen(true)}
              />
            </CardContent>
          </CardHeader>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Cohort</TableHead>
                <TableHead className="font-mono text-xs uppercase">
                  Slug
                </TableHead>
                <TableHead>Channel</TableHead>
                <TableHead>Link</TableHead>
                <TableHead className="text-right">Responses</TableHead>
                <TableHead className="text-right">Complete</TableHead>
                <TableHead className="text-right">Last response</TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {cohorts.map((c) => (
                <TableRow
                  key={c.id}
                  className="group cursor-pointer"
                  onClick={() => {
                    window.location.href = `/admin/e/${experimentSlug}/c/${c.slug}`;
                  }}
                >
                  <TableCell className="font-medium">
                    <Link
                      href={`/admin/e/${experimentSlug}/c/${c.slug}`}
                      className="hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {c.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground font-mono text-xs">
                    {c.slug}
                  </TableCell>
                  <TableCell>{channelBadge(c.channel)}</TableCell>
                  <TableCell>
                    {c.short_code ? (
                      <CopyLink shortCode={c.short_code} />
                    ) : (
                      <span className="text-muted-foreground/50">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {Number(c.responses)}
                  </TableCell>
                  <TableCell className="text-right">
                    <span className="text-success font-mono tabular-nums">
                      {Number(c.complete)}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-right font-mono text-xs tabular-nums">
                    {c.last_response_at ? rel(c.last_response_at) : "—"}
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

      <ProlificRunDialog
        open={prolificOpen}
        onOpenChange={setProlificOpen}
        experimentSlug={experimentSlug}
        experimentId={experiment.id}
        experimentName={experiment.name}
      />

      {/* Permanently delete the experiment. Type-to-confirm — destructive and
          not undoable; takes the cohorts + responses with it. */}
      <Dialog open={deletingOpen} onOpenChange={setDeletingOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-destructive">
              Delete experiment?
            </DialogTitle>
            <DialogDescription>
              This permanently deletes{" "}
              <span className="text-foreground font-medium">
                {experiment.name}
              </span>{" "}
              and its {cohorts.length}{" "}
              {cohorts.length === 1 ? "cohort" : "cohorts"}
              {totalResponses > 0 && (
                <>
                  {" "}
                  and{" "}
                  <span className="text-foreground font-medium">
                    {totalResponses} {totalResponses === 1 ? "response" : "responses"}
                  </span>
                </>
              )}
              . This can’t be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <label className="text-muted-foreground text-sm">
              Type{" "}
              <span className="text-foreground font-mono">{experiment.name}</span>{" "}
              to confirm
            </label>
            <Input
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
              autoFocus
              placeholder={experiment.name}
              aria-label="Confirm experiment name"
            />
            {deleteMut.isError && (
              <p className="text-destructive text-sm">
                Failed to delete experiment.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeletingOpen(false)}
              disabled={deleteMut.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteMut.mutate()}
              disabled={
                deleteConfirm.trim() !== experiment.name || deleteMut.isPending
              }
            >
              {deleteMut.isPending ? "Deleting…" : "Delete experiment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Change / bind the experiment's survey form. A confirmation modal (not an
          inline edit) — rebinding is rare and only affects FUTURE cohorts. */}
      <Dialog open={changingForm} onOpenChange={setChangingForm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{hasForm ? "Change survey form" : "Bind survey form"}</DialogTitle>
            <DialogDescription>
              {hasForm
                ? "New cohorts will use this form. Existing cohorts keep the form they were created with."
                : "Pick the Typeform survey this experiment runs. Its webhook is registered automatically."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <FormCombobox value={draftForm} onChange={setDraftForm} />
            {hasForm && totalResponses > 0 && draftForm !== experiment.typeform_form_id && (
              <p className="text-warning text-sm">
                This experiment already has {totalResponses}{" "}
                {totalResponses === 1 ? "response" : "responses"} from{" "}
                {boundForm?.title ?? "the current form"}. New responses will come
                from the new form.
              </p>
            )}
            {bindMut.isError && (
              <p className="text-destructive text-sm">Failed to change form.</p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setChangingForm(false)}
              disabled={bindMut.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={() => draftForm && bindMut.mutate(draftForm)}
              disabled={
                !draftForm ||
                draftForm === experiment.typeform_form_id ||
                bindMut.isPending
              }
            >
              {bindMut.isPending
                ? "Saving…"
                : hasForm
                  ? "Change form"
                  : "Bind form"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
