"use client";

import type { DeepDiveResult } from "@/lib/types/deep-dive";

const TYPE_ICONS: Record<DeepDiveResult["type"], string> = {
  report: "📄",
  event: "📅",
  article: "📰",
  speech: "🎤",
  organization: "🏛️",
  other: "🔗",
};

interface DeepDiveResultCardProps {
  result: DeepDiveResult;
}

export function DeepDiveResultCard({ result }: DeepDiveResultCardProps) {
  return (
    <div className="bg-surface-bright p-4 space-y-2">
      <div className="flex items-start gap-3">
        <span className="text-base flex-shrink-0">{TYPE_ICONS[result.type] || "🔗"}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-serif font-bold text-ink leading-snug">
              {result.url ? (
                <a
                  href={result.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-navy transition-colors underline underline-offset-2 decoration-ink-muted/30"
                >
                  {result.title}
                </a>
              ) : (
                result.title
              )}
            </h4>
            <span className="text-[10px] font-semibold text-ink-muted uppercase tracking-wider flex-shrink-0">
              {result.type}
            </span>
          </div>
          <p className="text-xs text-ink-light leading-relaxed mt-1">{result.summary}</p>
          <p className="text-xs text-gold-dim mt-1.5">{result.relevance}</p>
          {result.date && (
            <span className="text-[10px] text-ink-muted mt-1 block">{result.date}</span>
          )}
        </div>
      </div>
    </div>
  );
}
