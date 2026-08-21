"use client";

import { Collapsible } from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { FeedbackButtons } from "@/components/ui/feedback-buttons";
import type { ReasoningStep } from "@/lib/types/agent";

interface ReasoningChainProps {
  steps: ReasoningStep[];
  onStepFeedback?: (stepId: string, value: "up" | "down" | null) => void;
}

const categoryLabels: Record<string, string> = {
  voting_alignment: "Voting Record",
  speech_sentiment: "Speech Analysis",
  constituency_overlap: "Constituency",
  personal_interest: "Shared Interests",
  general: "General Analysis",
};

const categoryColors: Record<string, "blue" | "green" | "gold" | "purple" | "default"> = {
  voting_alignment: "blue",
  speech_sentiment: "green",
  constituency_overlap: "gold",
  personal_interest: "purple",
  general: "default",
};

export function ReasoningChain({ steps, onStepFeedback }: ReasoningChainProps) {
  return (
    <div className="space-y-2">
      <h4 className="label-md">Reasoning Chain</h4>
      {steps.map((step, i) => (
        <Collapsible
          key={step.id}
          title={
            <div className="flex items-center gap-2 flex-1">
              <span className="text-sm font-medium text-ink-muted w-6">{i + 1}.</span>
              <Badge variant={categoryColors[step.category] || "default"} size="sm">
                {categoryLabels[step.category] || step.category}
              </Badge>
              <span className="text-sm font-medium text-ink flex-1 truncate">{step.title}</span>
              <span className="text-xs text-ink-muted">{Math.round(step.confidence * 100)}%</span>
              {onStepFeedback && (
                <FeedbackButtons
                  size="sm"
                  onFeedback={(v) => onStepFeedback(step.id, v)}
                />
              )}
            </div>
          }
        >
          <div className="space-y-3">
            <p className="body-lg">{step.evidence}</p>
            {step.sources.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {step.sources.map((source, j) => (
                  <Badge key={j} variant="default" size="sm">
                    {source.url ? (
                      <a href={source.url} target="_blank" rel="noopener noreferrer" className="hover:text-gold transition-tonal">
                        {source.title}
                      </a>
                    ) : (
                      source.title
                    )}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </Collapsible>
      ))}
    </div>
  );
}
