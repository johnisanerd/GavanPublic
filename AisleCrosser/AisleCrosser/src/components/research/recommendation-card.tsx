"use client";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { FeedbackButtons } from "@/components/ui/feedback-buttons";
import { ReasoningChain } from "./reasoning-chain";
import type { Recommendation } from "@/lib/types/agent";

function connectionIcon(type: string, iconSuggestion?: string): string {
  if (iconSuggestion) return iconSuggestion;
  const t = type.toLowerCase();
  if (t.includes("sport") || t.includes("golf") || t.includes("fitness") || t.includes("running") || t.includes("basketball") || t.includes("baseball")) return "🏌️";
  if (t.includes("pet") || t.includes("animal") || t.includes("dog") || t.includes("cat")) return "🐾";
  if (t.includes("alma") || t.includes("university") || t.includes("law") || t.includes("professor") || t.includes("reader") || t.includes("intellectual") || t.includes("school") || t.includes("college") || t.includes("degree")) return "🎓";
  if (t.includes("family") || t.includes("grandchild") || t.includes("grandmother") || t.includes("mother") || t.includes("parent") || t.includes("child")) return "👨‍👩‍👧";
  if (t.includes("military") || t.includes("veteran") || t.includes("reserve") || t.includes("navy") || t.includes("army") || t.includes("marine")) return "🎖️";
  if (t.includes("faith") || t.includes("church") || t.includes("methodist") || t.includes("baptist") || t.includes("catholic")) return "🙏";
  if (t.includes("food") || t.includes("cook") || t.includes("cuisine") || t.includes("restaurant") || t.includes("bbq")) return "🍽️";
  if (t.includes("travel")) return "✈️";
  if (t.includes("music") || t.includes("guitar") || t.includes("piano") || t.includes("bluegrass")) return "🎵";
  if (t.includes("hobby") || t.includes("art")) return "🎯";
  if (t.includes("author") || t.includes("book") || t.includes("publish")) return "📚";
  if (t.includes("farm") || t.includes("rural") || t.includes("working_class") || t.includes("origin") || t.includes("ranch")) return "🌾";
  if (t.includes("cancer") || t.includes("survivor") || t.includes("health")) return "🎗️";
  if (t.includes("disruptor") || t.includes("maverick") || t.includes("outsider")) return "⚡";
  if (t.includes("accountability") || t.includes("whistleblow")) return "🔍";
  if (t.includes("historic") || t.includes("first")) return "🏛️";
  if (t.includes("social") || t.includes("bipartisan")) return "🤝";
  if (t.includes("business") || t.includes("entrepreneur")) return "💼";
  if (t.includes("fish")) return "🎣";
  if (t.includes("hunt")) return "🦌";
  return "🤝";
}

function formatConnectionType(type: string): string {
  return type
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

interface RecommendationCardProps {
  recommendation: Recommendation;
  rank: number;
  onFeedback?: (recId: string, value: "up" | "down" | null) => void;
  onStepFeedback?: (stepId: string, value: "up" | "down" | null) => void;
}

export function RecommendationCard({ recommendation, rank, onFeedback, onStepFeedback }: RecommendationCardProps) {
  const partyColor = recommendation.targetLegislatorParty === "D" ? "blue" : recommendation.targetLegislatorParty === "R" ? "red" : "purple";

  return (
    <Card padding="lg" className="space-y-6">
      {/* Header */}
      <div className="flex items-start gap-5">
        <div className="h-12 w-12 bg-navy flex items-center justify-center text-xl font-serif font-bold text-white flex-shrink-0">
          {rank}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3">
            <h3 className="headline-md">{recommendation.targetLegislatorName}</h3>
            {onFeedback && (
              <FeedbackButtons
                initialValue={recommendation.feedback?.value}
                onFeedback={(v) => onFeedback(recommendation.id, v)}
              />
            )}
          </div>
          <div className="flex items-center gap-3 mt-1">
            <Badge variant={partyColor as "blue" | "red" | "purple"}>
              {recommendation.targetLegislatorParty === "D" ? "Democrat" : recommendation.targetLegislatorParty === "R" ? "Republican" : "Independent"}
            </Badge>
            <span className="label-md">
              {recommendation.targetLegislatorState} &middot; {recommendation.targetLegislatorChamber}
            </span>
          </div>
        </div>
      </div>

      {/* Alignment Score */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="label-md">Alignment Score</span>
          <span className="font-serif text-xl font-bold text-navy">{recommendation.alignmentScore}%</span>
        </div>
        <div className="h-2 bg-surface-mid overflow-hidden">
          <div
            className="h-full progress-gold transition-all duration-1000"
            style={{ width: `${recommendation.alignmentScore}%` }}
          />
        </div>
      </div>

      {/* Summary */}
      <p className="body-lg">{recommendation.summary}</p>

      {/* Approach Strategy */}
      <div className="bg-navy/5 p-5">
        <h4 className="label-md text-navy mb-2">Approach Strategy</h4>
        <p className="text-sm text-ink-light leading-relaxed">{recommendation.approachStrategy}</p>
      </div>

      {/* Personal Connections (Icebreakers) */}
      {recommendation.personalConnections && recommendation.personalConnections.length > 0 && (
        <div>
          <h4 className="label-md mb-3">Personal Icebreakers</h4>
          <div className="space-y-2">
            {recommendation.personalConnections.map((conn, i) => (
              <div key={i} className="flex items-start gap-3 bg-gold/5 p-3">
                <span className="text-lg flex-shrink-0">{connectionIcon(conn.type, conn.iconSuggestion)}</span>
                <div className="min-w-0">
                  <span className="text-[10px] font-semibold text-gold-dim uppercase tracking-wider">
                    {formatConnectionType(conn.type)}
                  </span>
                  <p className="text-sm text-ink leading-snug mt-0.5">{conn.detail}</p>
                  {conn.sharedWith && conn.sharedWith !== recommendation.targetLegislatorName && (
                    <p className="text-xs text-ink-light mt-1">{conn.sharedWith}</p>
                  )}
                  {conn.source && (
                    <p className="text-[10px] text-ink-muted mt-1 truncate">{conn.source}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Shared Interests */}
      {recommendation.sharedInterests.length > 0 && (
        <div>
          <h4 className="label-md mb-3">Shared Interests</h4>
          <div className="flex flex-wrap gap-2">
            {recommendation.sharedInterests.map((interest, i) => (
              <Badge key={i} variant="purple" size="md">{interest}</Badge>
            ))}
          </div>
        </div>
      )}

      {/* Reasoning Chain */}
      {recommendation.reasoningChain.length > 0 && (
        <ReasoningChain steps={recommendation.reasoningChain} onStepFeedback={onStepFeedback} />
      )}
    </Card>
  );
}
