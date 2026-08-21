"use client";

import { motion } from "motion/react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SiInstagram, SiFacebook, SiX, SiWikipedia } from "react-icons/si";
import { LuSearch, LuGlobe, LuFileText, LuSparkles, LuSettings, LuLandmark } from "react-icons/lu";
import type { Candidate } from "@/lib/types/agent";
import type { ResearchStatus } from "@/lib/types/research";
import type { ConnectionSearchActivity } from "@/hooks/use-research-stream";

interface CandidateListProps {
  candidates: Candidate[];
  researchStatus: ResearchStatus;
  onCandidateClick?: (candidateId: string) => void;
  connectionActivity?: Record<string, ConnectionSearchActivity[]>;
}

function connectionIcon(type: string, iconSuggestion?: string): string {
  if (iconSuggestion) return iconSuggestion;
  const t = type.toLowerCase();
  if (t.includes("sport") || t.includes("golf") || t.includes("fitness") || t.includes("running")) return "🏌️";
  if (t.includes("pet") || t.includes("animal") || t.includes("dog")) return "🐾";
  if (t.includes("alma") || t.includes("university") || t.includes("school") || t.includes("college") || t.includes("law")) return "🎓";
  if (t.includes("family") || t.includes("parent") || t.includes("child")) return "👨‍👩‍👧";
  if (t.includes("military") || t.includes("veteran") || t.includes("navy") || t.includes("army")) return "🎖️";
  if (t.includes("faith") || t.includes("church")) return "🙏";
  if (t.includes("food") || t.includes("cook") || t.includes("restaurant")) return "🍽️";
  if (t.includes("music") || t.includes("guitar") || t.includes("bluegrass")) return "🎵";
  if (t.includes("book") || t.includes("author") || t.includes("reader")) return "📚";
  if (t.includes("farm") || t.includes("rural") || t.includes("ranch")) return "🌾";
  if (t.includes("cancer") || t.includes("survivor") || t.includes("health")) return "🎗️";
  if (t.includes("business") || t.includes("entrepreneur")) return "💼";
  return "🤝";
}

/** Map tool names to display icons + labels */
function toolDisplay(toolName: string, input: Record<string, unknown>): { icon: React.ReactNode; label: string } {
  const sz = 12;
  switch (toolName) {
    case "instagram_posts":
      return { icon: <SiInstagram size={sz} />, label: `Instagram: ${(input.name as string) || ""}` };
    case "twitter_posts":
      return { icon: <SiX size={sz} />, label: `X: ${(input.name as string) || ""}` };
    case "facebook_posts":
      return { icon: <SiFacebook size={sz} />, label: `Facebook: ${(input.name as string) || ""}` };
    case "google_search":
      return { icon: <LuSearch size={sz} />, label: `${(input.query as string)?.slice(0, 50) || "searching..."}` };
    case "crawl_website":
      return { icon: <LuGlobe size={sz} />, label: `Crawling: ${(input.url as string)?.split("/").slice(2, 3).join("") || ""}` };
    case "web_search":
      return { icon: <LuSearch size={sz} />, label: `${(input.query as string)?.slice(0, 50) || "searching..."}` };
    case "fetch_url":
      return { icon: <LuFileText size={sz} />, label: `Reading: ${(input.url as string)?.split("/").slice(2, 3).join("") || ""}` };
    case "report_connection":
      return { icon: <LuSparkles size={sz} />, label: `Found: ${(input.type as string) || "connection"}` };
    default:
      return { icon: <LuSettings size={sz} />, label: toolName };
  }
}

/** Detect platform from connection source URL/text */
function sourceBadge(source?: string): { icon: React.ReactNode; label: string } | null {
  if (!source) return null;
  const s = source.toLowerCase();
  const sz = 10;
  if (s.includes("instagram")) return { icon: <SiInstagram size={sz} />, label: "Instagram" };
  if (s.includes("twitter") || s.includes("x.com")) return { icon: <SiX size={sz} />, label: "X" };
  if (s.includes("facebook")) return { icon: <SiFacebook size={sz} />, label: "Facebook" };
  if (s.includes("wikipedia")) return { icon: <SiWikipedia size={sz} />, label: "Wikipedia" };
  if (s.includes("senate.gov") || s.includes("house.gov") || s.includes("congress.gov")) return { icon: <LuLandmark size={sz} />, label: "Congress" };
  if (s.includes("google")) return { icon: <LuSearch size={sz} />, label: "Google" };
  return null;
}

const AGENT_LABELS: Record<string, string> = {
  speech_analyzer: "Speech",
  voting_analyzer: "Voting",
  constituency_analyzer: "District",
  interest_analyzer: "Interests",
};

export function CandidateList({ candidates, researchStatus, onCandidateClick, connectionActivity }: CandidateListProps) {
  if (candidates.length === 0) {
    if (researchStatus !== "completed" && researchStatus !== "failed" && researchStatus !== "queued") {
      return (
        <div className="space-y-4">
          <h2 className="headline-md gold-thread pb-3">Potential Allies</h2>
          <div className="bg-surface-bright ghost-border p-6 text-center">
            <div className="animate-pulse text-ink-muted text-sm">
              Scanning for potential cross-party allies...
            </div>
          </div>
        </div>
      );
    }
    return null;
  }

  const showConnectionStatus =
    researchStatus === "finding_connections" ||
    researchStatus === "synthesizing" ||
    researchStatus === "completed";

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-4">
        <h2 className="headline-md gold-thread pb-3">Potential Allies</h2>
        <span className="label-md">{candidates.length} identified</span>
      </div>

      <div className="space-y-3">
        {candidates.map((candidate, i) => (
          <motion.div
            key={candidate.id}
            layoutId={`candidate-${candidate.id}`}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.03, duration: 0.2 }}
          >
            <CandidateCard
              candidate={candidate}
              rank={i + 1}
              showConnections={showConnectionStatus}
              onClick={onCandidateClick ? () => onCandidateClick(candidate.id) : undefined}
              activities={connectionActivity?.[candidate.id]}
            />
          </motion.div>
        ))}
      </div>
    </div>
  );
}

function CandidateCard({
  candidate,
  rank,
  showConnections,
  onClick,
  activities,
}: {
  candidate: Candidate;
  rank: number;
  showConnections: boolean;
  onClick?: () => void;
  activities?: ConnectionSearchActivity[];
}) {
  const partyVariant = candidate.party === "D" ? "blue" : candidate.party === "R" ? "red" : "purple";
  const isSearching = candidate.status === "researching_connections";
  const hasConnections = candidate.connections.length > 0;
  const latestActivity = activities?.[activities.length - 1];

  return (
    <Card
      padding="sm"
      className={`transition-all duration-500 ${isSearching ? "ring-1 ring-gold/30" : ""} ${onClick ? "cursor-pointer hover:bg-surface-mid/30" : ""}`}
      onClick={onClick}
    >
      <div className="flex items-start gap-4">
        {/* Rank */}
        <div className="h-8 w-8 bg-navy/10 flex items-center justify-center text-sm font-serif font-bold text-navy flex-shrink-0">
          {rank}
        </div>

        <div className="flex-1 min-w-0">
          {/* Name + party + score */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-serif font-bold text-ink truncate">{candidate.name}</span>
              <Badge variant={partyVariant} size="sm">
                {candidate.party}-{candidate.state}
              </Badge>
              <span className="text-xs text-ink-muted">{candidate.chamber}</span>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <span className="font-serif font-bold text-navy text-sm">{candidate.score}%</span>
              <div className="w-16 h-1.5 bg-surface-mid overflow-hidden">
                <div
                  className="h-full progress-gold transition-all duration-700"
                  style={{ width: `${candidate.score}%` }}
                />
              </div>
            </div>
          </div>

          {/* Nominated by badges */}
          <div className="flex items-center gap-1.5 mt-1.5">
            {candidate.nominatedBy.map((agent) => (
              <span key={agent} className="text-[10px] text-ink-muted bg-surface-mid px-1.5 py-0.5">
                {AGENT_LABELS[agent] || agent}
              </span>
            ))}
            {candidate.nominatedBy.length > 1 && (
              <span className="text-[10px] text-gold font-semibold">
                {candidate.nominatedBy.length}x nominated
              </span>
            )}
          </div>

          {/* Top evidence */}
          {candidate.evidence.length > 0 && (
            <p className="text-xs text-ink-light mt-1.5 line-clamp-2">
              {candidate.evidence[0].summary}
            </p>
          )}

          {/* Live activity feed — shows what the agent is doing right now */}
          {isSearching && activities && activities.length > 0 && (
            <div className="mt-2 space-y-0.5">
              {activities.slice(-4).map((act, i) => {
                const display = toolDisplay(act.toolName, act.input);
                const isLatest = i === Math.min(activities.length, 4) - 1;
                return (
                  <div
                    key={i}
                    className={`flex items-center gap-1.5 text-[11px] ${
                      isLatest ? "text-gold" : "text-ink-muted"
                    } ${isLatest ? "animate-pulse" : ""}`}
                  >
                    <span className="flex-shrink-0">{display.icon}</span>
                    <span className="truncate">{display.label}</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Searching placeholder when no activities yet */}
          {isSearching && (!activities || activities.length === 0) && (
            <div className="mt-2 flex items-center gap-1.5 text-[11px] text-gold animate-pulse">
              <span>🔍</span>
              <span>Finding personal connections...</span>
            </div>
          )}

          {/* Personal connections with source badges */}
          {showConnections && hasConnections && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {candidate.connections.map((conn, i) => {
                const src = sourceBadge(conn.source);
                return (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1 text-[11px] bg-gold/10 text-gold-dim px-2 py-0.5"
                    title={`${conn.detail} — shared: ${conn.sharedWith}${conn.source ? `\nSource: ${conn.source}` : ""}`}
                  >
                    <span>{connectionIcon(conn.type, conn.iconSuggestion)}</span>
                    <span>{conn.detail.length > 30 ? conn.detail.slice(0, 30) + "..." : conn.detail}</span>
                    {src && (
                      <span className="text-[9px] text-ink-muted ml-1" title={conn.source}>
                        {src.icon}
                      </span>
                    )}
                  </span>
                );
              })}
              {isSearching && (
                <span className="text-[11px] text-gold animate-pulse px-1">
                  {latestActivity ? toolDisplay(latestActivity.toolName, latestActivity.input).icon : "🔍"} searching...
                </span>
              )}
            </div>
          )}

          {/* No connections found */}
          {showConnections && !isSearching && !hasConnections && candidate.status === "enriched" && (
            <span className="text-[10px] text-ink-muted mt-2 block">No personal connections found</span>
          )}
        </div>

        {/* Drill-in indicator */}
        {onClick && (
          <span className="text-ink-muted/40 text-sm flex-shrink-0 mt-2">→</span>
        )}
      </div>
    </Card>
  );
}
