"use client";

import { useState, useEffect, useCallback, startTransition } from "react";
import { useSearchParams } from "next/navigation";
import { motion, AnimatePresence } from "motion/react";
import { useResearchStream } from "@/hooks/use-research-stream";
import { useFeedback } from "@/hooks/use-feedback";
import { AgentGrid } from "@/components/research/agent-grid";
import { CandidateList } from "@/components/research/candidate-list";
import { ResultsPanel } from "@/components/research/results-panel";
import { Breadcrumb, type BreadcrumbSegment } from "@/components/research/breadcrumb";
import { ConnectionBadge } from "@/components/research/connection-badge";
import { DeepDivePanel } from "@/components/research/deep-dive-panel";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Card } from "@/components/ui/card";
import type { Candidate, Recommendation } from "@/lib/types/agent";

// ─────────────────────────────────────────────────────
// Navigation state
// ─────────────────────────────────────────────────────

type ViewState =
  | { layer: "overview" }
  | { layer: "candidate"; candidateId: string }
  | { layer: "deep-dive"; candidateId: string; connectionIndex: number; deepDiveId: string };

const statusMessages: Record<string, string> = {
  queued: "Preparing research...",
  agents_starting: "Launching AI research agents...",
  agents_running: "Agents are researching across multiple data sources...",
  finding_connections: "Exploring personal connections for top candidates...",
  synthesizing: "Synthesizing findings into strategic recommendations...",
  completed: "Research complete",
  failed: "Research encountered an error",
};

const statusVariants: Record<string, "gold" | "navy" | "green" | "red" | "default"> = {
  queued: "default",
  agents_starting: "gold",
  agents_running: "navy",
  finding_connections: "gold",
  synthesizing: "gold",
  completed: "green",
  failed: "red",
};

// ─────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────

interface ResearchViewProps {
  researchId: string;
}

export function ResearchView({ researchId }: ResearchViewProps) {
  const { agents, candidates, recommendations, status, error, connectionActivity } = useResearchStream(researchId);
  const { submitFeedback } = useFeedback(researchId);
  const [view, setView] = useState<ViewState>({ layer: "overview" });
  const searchParams = useSearchParams();

  // Context: read from URL params (set by dashboard on navigation)
  // Falls back to fetching from research record
  const [context, setContext] = useState<{ legislatorName?: string; legislatorParty?: string; legislatorState?: string; initiativeTitle?: string } | null>(() => {
    const leg = searchParams.get("leg");
    if (leg) {
      return {
        legislatorName: leg,
        legislatorParty: searchParams.get("party") || undefined,
        legislatorState: searchParams.get("state") || undefined,
        initiativeTitle: searchParams.get("init") || undefined,
      };
    }
    return null;
  });

  useEffect(() => {
    if (context || !researchId) return;
    fetch(`/api/research/${researchId}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data?.legislatorName || data?.initiativeTitle) {
          setContext({
            legislatorName: data.legislatorName,
            legislatorParty: data.legislatorParty,
            legislatorState: data.legislatorState,
            initiativeTitle: data.initiativeTitle,
          });
        }
      })
      .catch(() => {});
  }, [researchId, context]);

  const isRunning = !["completed", "failed"].includes(status);

  const navigateTo = useCallback((newView: ViewState) => {
    startTransition(() => setView(newView));
  }, []);

  // Find focused candidate — match by id or name (candidates may have different ids from inline vs extraction)
  const focusedCandidate = view.layer !== "overview"
    ? candidates.find((c) => c.id === view.candidateId || c.name.toLowerCase() === view.candidateId.toLowerCase())
    : null;

  // Find recommendation for a candidate (by name match)
  const findRecForCandidate = useCallback(
    (candidate: Candidate): Recommendation | undefined =>
      recommendations.find(
        (r) => r.targetLegislatorName.toLowerCase() === candidate.name.toLowerCase()
      ),
    [recommendations]
  );

  // Deep dive launcher
  const launchDeepDive = useCallback(
    async (candidateId: string, connectionIndex: number, recId: string) => {
      try {
        const resp = await fetch("/api/deep-dive", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ researchId, recommendationId: recId, connectionIndex }),
        });
        const data = await resp.json();
        if (data.deepDiveId) {
          navigateTo({ layer: "deep-dive", candidateId, connectionIndex, deepDiveId: data.deepDiveId });
        }
      } catch (err) {
        console.error("Failed to launch deep dive:", err);
      }
    },
    [researchId, navigateTo]
  );

  // Progress
  const progressPercent = (() => {
    if (status === "queued" || status === "agents_starting") return 5;
    if (status === "agents_running") {
      const completed = agents.filter((a) => a.status === "completed").length;
      const total = Math.max(agents.length, 4);
      return 5 + (completed / total) * 50;
    }
    if (status === "finding_connections") return 65;
    if (status === "synthesizing") return 85;
    return 100;
  })();

  // Breadcrumb segments
  const breadcrumbSegments: BreadcrumbSegment[] = (() => {
    const segs: BreadcrumbSegment[] = [{ label: "Research", onClick: () => navigateTo({ layer: "overview" }) }];
    if (view.layer === "candidate" || view.layer === "deep-dive") {
      const name = focusedCandidate?.name || "Candidate";
      segs.push({
        label: name,
        onClick: () => navigateTo({ layer: "candidate", candidateId: view.candidateId }),
      });
    }
    if (view.layer === "deep-dive") {
      const conn = focusedCandidate?.connections[view.connectionIndex];
      segs.push({ label: conn?.type || "Deep Dive" });
    }
    return segs;
  })();

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* ── Fixed chrome ── */}
      <div className="flex-shrink-0 max-w-7xl mx-auto w-full px-6 lg:px-10 pt-4 pb-0">
        {/* Status bar: legislator + initiative + status */}
        <div className="flex items-center gap-4">
          {isRunning && <Spinner size="lg" />}
          <div className="flex items-center gap-3 flex-1 min-w-0">
            {context?.legislatorName && (
              <span className="font-serif font-bold text-ink truncate">
                {context.legislatorName}
              </span>
            )}
            {context?.legislatorParty && (
              <Badge variant={context.legislatorParty === "D" ? "blue" : context.legislatorParty === "R" ? "red" : "purple"} size="sm">
                {context.legislatorParty}-{context.legislatorState}
              </Badge>
            )}
            {context?.initiativeTitle && (
              <span className="text-sm text-ink-muted truncate hidden sm:inline">
                {context.initiativeTitle}
              </span>
            )}
          </div>
          <Badge variant={statusVariants[status]} size="md">
            {status === "agents_running" && agents.length > 0
              ? (() => {
                  const n = agents.filter((a) => ["running", "tool_calling", "thinking", "starting_sandbox"].includes(a.status)).length;
                  return `${n} agent${n !== 1 ? "s" : ""} running`;
                })()
              : status === "finding_connections" ? "finding connections"
              : status.replace(/_/g, " ")}
          </Badge>
        </div>

        {/* Progress Bar — compact, directly under status */}
        {isRunning && (
          <div className="mt-2 h-1 bg-surface-mid overflow-hidden">
            <div
              className="h-full progress-gold transition-all duration-500"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        )}

        {/* Agent grid */}
        <div className="mt-3">
          <AgentGrid agents={agents} isComplete={status === "completed"} />
        </div>

        {/* Breadcrumb — only show when drilled in */}
        {view.layer !== "overview" && <div className="mt-2"><Breadcrumb segments={breadcrumbSegments} /></div>}

        {/* Subtle divider between chrome and content */}
        <div className="mt-3 h-px bg-surface-high" />
      </div>

      {/* ── Scrollable content ── */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-7xl mx-auto w-full px-6 lg:px-10 py-6">
          <AnimatePresence mode="wait">
            {view.layer === "overview" && (
              <motion.div
                key="overview"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.2 }}
                className="space-y-10"
              >
                {/* Live Candidate List — show during all active phases */}
                {(candidates.length > 0 || isRunning) && (
                  <section>
                    <CandidateList
                      candidates={candidates}
                      researchStatus={status}
                      onCandidateClick={(candidateId) => navigateTo({ layer: "candidate", candidateId })}
                      connectionActivity={connectionActivity}
                    />
                  </section>
                )}

                {/* Error Display */}
                {error && (
                  <div className="bg-crimson/5 p-6">
                    <h3 className="title-lg text-crimson mb-2">Research Error</h3>
                    <p className="body-lg text-crimson/80">{error}</p>
                  </div>
                )}

                {/* Final Recommendations */}
                {recommendations.length > 0 && (
                  <section>
                    <ResultsPanel
                      recommendations={recommendations}
                      researchId={researchId}
                      onFeedback={(recId, value) => submitFeedback("recommendation", recId, value)}
                      onStepFeedback={(stepId, value) => submitFeedback("reasoning_step", stepId, value)}
                    />
                  </section>
                )}
              </motion.div>
            )}

            {view.layer === "candidate" && focusedCandidate && (
              <motion.div
                key={`candidate-${view.candidateId}`}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.2 }}
              >
                <CandidateDetailView
                  candidate={focusedCandidate}
                  researchId={researchId}
                  onDeepDive={(connectionIndex) => {
                    launchDeepDive(focusedCandidate.id, connectionIndex, focusedCandidate.id);
                  }}
                  searchActivity={connectionActivity[view.candidateId]}
                />
              </motion.div>
            )}

            {view.layer === "deep-dive" && focusedCandidate && (
              <motion.div
                key={`dive-${view.deepDiveId}`}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.2 }}
              >
                <CandidateDetailView
                  candidate={focusedCandidate}
                  researchId={researchId}
                  onDeepDive={(connectionIndex) => {
                    launchDeepDive(focusedCandidate.id, connectionIndex, focusedCandidate.id);
                  }}
                  searchActivity={connectionActivity[view.candidateId]}
                />
                <div className="mt-6">
                  <DeepDivePanel
                    deepDiveId={view.deepDiveId}
                    connectionType={focusedCandidate.connections[view.connectionIndex]?.type || "Connection"}
                    onClose={() => navigateTo({ layer: "candidate", candidateId: view.candidateId })}
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────
// Candidate detail view — focused single candidate
// ─────────────────────────────────────────────────────

function CandidateDetailView({
  candidate,
  onDeepDive,
  searchActivity,
  researchId,
}: {
  candidate: Candidate;
  onDeepDive?: (connectionIndex: number) => void;
  searchActivity?: Array<{ toolName: string; input: Record<string, unknown> }>;
  researchId: string;
}) {
  const partyVariant = candidate.party === "D" ? "blue" : candidate.party === "R" ? "red" : "purple";
  const isSearching = candidate.status === "researching_connections";
  const [synthesizing, setSynthesizing] = useState(false);
  const [localStrategy, setLocalStrategy] = useState(candidate.approachStrategy);
  const [localTalkingPoints, setLocalTalkingPoints] = useState(candidate.talkingPoints);
  const [localSharedInterests, setLocalSharedInterests] = useState(candidate.sharedInterests);

  // Update local state when candidate updates from stream
  useEffect(() => {
    if (candidate.approachStrategy) setLocalStrategy(candidate.approachStrategy);
    if (candidate.talkingPoints) setLocalTalkingPoints(candidate.talkingPoints);
    if (candidate.sharedInterests) setLocalSharedInterests(candidate.sharedInterests);
  }, [candidate.approachStrategy, candidate.talkingPoints, candidate.sharedInterests]);

  // On-demand synthesis for candidates that weren't preloaded
  const handleSynthesize = useCallback(async () => {
    if (localStrategy || synthesizing) return;
    setSynthesizing(true);
    try {
      const res = await fetch(`/api/research/${researchId}/synthesize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateName: candidate.name }),
      });
      if (res.ok) {
        const data = await res.json();
        setLocalStrategy(data.approachStrategy);
        setLocalTalkingPoints(data.talkingPoints);
        setLocalSharedInterests(data.sharedInterests);
      }
    } catch (err) {
      console.error("Synthesis failed:", err);
    } finally {
      setSynthesizing(false);
    }
  }, [researchId, candidate.name, localStrategy, synthesizing]);

  // Auto-synthesize on mount if not already done
  useEffect(() => {
    if (!localStrategy && !synthesizing && candidate.status !== "nominated" && candidate.status !== "researching_connections") {
      handleSynthesize();
    }
  }, [candidate.status, localStrategy, synthesizing, handleSynthesize]);

  return (
    <div className="space-y-6">
      {/* Candidate header */}
      <Card padding="lg">
        <div className="flex items-start gap-5">
          <div className="h-14 w-14 bg-navy flex items-center justify-center text-xl font-serif font-bold text-white flex-shrink-0">
            {candidate.score}
          </div>
          <div className="flex-1">
            <h2 className="headline-md">{candidate.name}</h2>
            <div className="flex items-center gap-3 mt-1">
              <Badge variant={partyVariant} size="md">
                {candidate.party === "D" ? "Democrat" : candidate.party === "R" ? "Republican" : "Independent"}
              </Badge>
              <span className="label-md">{candidate.state} &middot; {candidate.chamber}</span>
            </div>

            {/* Evidence */}
            {candidate.evidence.length > 0 && (
              <div className="mt-4 space-y-1">
                {candidate.evidence.map((e, i) => (
                  <p key={i} className="text-sm text-ink-light">
                    <span className="text-[10px] text-ink-muted bg-surface-mid px-1.5 py-0.5 mr-2">
                      {e.agentType.replace(/_/g, " ")}
                    </span>
                    {e.summary}
                  </p>
                ))}
              </div>
            )}
          </div>
        </div>
      </Card>

      {/* Approach Strategy — from per-candidate synthesis */}
      {localStrategy ? (
        <Card padding="lg" className="space-y-4">
          <div className="bg-navy/5 p-5">
            <h4 className="label-md text-navy mb-2">Approach Strategy</h4>
            <p className="text-sm text-ink-light leading-relaxed">{localStrategy}</p>
          </div>
          {localTalkingPoints && localTalkingPoints.length > 0 && (
            <div>
              <h4 className="label-md mb-2">Talking Points</h4>
              <ul className="space-y-1.5">
                {localTalkingPoints.map((point, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-ink-light">
                    <span className="text-gold mt-0.5">&#8226;</span>
                    {point}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {localSharedInterests && localSharedInterests.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {localSharedInterests.map((interest, i) => (
                <Badge key={i} variant="purple" size="md">{interest}</Badge>
              ))}
            </div>
          )}
        </Card>
      ) : synthesizing ? (
        <Card padding="lg" className="flex items-center gap-3">
          <Spinner size="sm" />
          <span className="text-sm text-ink-muted">Generating approach strategy...</span>
        </Card>
      ) : null}

      {/* Connections */}
      <div>
        <div className="flex items-center gap-3 mb-4">
          <h3 className="label-md">Personal Connections</h3>
          {isSearching && (
            <span className="text-xs text-gold animate-pulse flex items-center gap-1">
              <Spinner size="sm" />
              {(() => {
                const latest = searchActivity?.[searchActivity.length - 1];
                if (!latest) return "Searching...";
                if (latest.toolName === "instagram_posts") return `Checking Instagram: ${(latest.input.name as string) || ""}`;
                if (latest.toolName === "facebook_posts") return `Checking Facebook: ${(latest.input.name as string) || ""}`;
                if (latest.toolName === "twitter_posts") return `Checking X: ${(latest.input.name as string) || ""}`;
                if (latest.toolName === "google_search") return `Searching: ${(latest.input.query as string)?.slice(0, 40)}`;
                return "Searching...";
              })()}
            </span>
          )}
          {candidate.connections.length > 0 && (
            <span className="text-xs text-ink-muted">{candidate.connections.length} found</span>
          )}
        </div>

        {candidate.connections.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {candidate.connections.map((conn, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.05 }}
              >
                <ConnectionBadge
                  connection={conn}
                  index={i}
                  onDeepDive={onDeepDive}
                  isStreaming={isSearching}
                />
              </motion.div>
            ))}
          </div>
        ) : !isSearching ? (
          <p className="text-sm text-ink-muted">No personal connections found yet.</p>
        ) : null}
      </div>
    </div>
  );
}
