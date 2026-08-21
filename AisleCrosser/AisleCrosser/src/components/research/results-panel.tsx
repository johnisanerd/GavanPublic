"use client";

import { RecommendationCard } from "./recommendation-card";
import type { Recommendation } from "@/lib/types/agent";

interface ResultsPanelProps {
  recommendations: Recommendation[];
  researchId: string;
  onFeedback?: (recId: string, value: "up" | "down" | null) => void;
  onStepFeedback?: (stepId: string, value: "up" | "down" | null) => void;
}

export function ResultsPanel({ recommendations, onFeedback, onStepFeedback }: ResultsPanelProps) {
  if (recommendations.length === 0) return null;

  const sorted = [...recommendations].sort((a, b) => b.alignmentScore - a.alignmentScore);

  return (
    <div className="space-y-8">
      <div className="flex items-baseline gap-4">
        <h2 className="headline-md gold-thread pb-3">Recommended Allies</h2>
        <span className="label-md">{recommendations.length} found</span>
      </div>
      <div className="space-y-5">
        {sorted.map((rec, i) => (
          <RecommendationCard
            key={rec.id}
            recommendation={rec}
            rank={i + 1}
            onFeedback={onFeedback}
            onStepFeedback={onStepFeedback}
          />
        ))}
      </div>
    </div>
  );
}
