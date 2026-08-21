"use client";

import { useMemo } from "react";
import { motion, AnimatePresence } from "motion/react";
import { useDeepDiveStream } from "@/hooks/use-deep-dive-stream";
import { DeepDiveResultCard } from "./deep-dive-result-card";
import { Spinner } from "@/components/ui/spinner";
import type { DeepDiveToolCall } from "@/lib/types/deep-dive";

interface DeepDivePanelProps {
  deepDiveId: string;
  connectionType: string;
  onClose?: () => void;
}

interface ParsedSearchResult {
  title: string;
  url: string;
  snippet?: string;
}

/** Extract all unique search result URLs discovered so far */
function collectDiscoveries(toolCalls: DeepDiveToolCall[]): ParsedSearchResult[] {
  const seen = new Set<string>();
  const discoveries: ParsedSearchResult[] = [];
  for (const tc of toolCalls) {
    if (tc.toolName === "web_search" && Array.isArray(tc.output)) {
      for (const r of tc.output as ParsedSearchResult[]) {
        if (r.url && !seen.has(r.url)) {
          seen.add(r.url);
          discoveries.push(r);
        }
      }
    }
  }
  return discoveries;
}

export function DeepDivePanel({ deepDiveId, connectionType, onClose }: DeepDivePanelProps) {
  const { status, results, toolCalls, error } = useDeepDiveStream(deepDiveId);

  const isSearching = status === "queued" || status === "searching";
  const latestToolCall = toolCalls.length > 0 ? toolCalls[toolCalls.length - 1] : null;
  const discoveries = useMemo(() => collectDiscoveries(toolCalls), [toolCalls]);

  return (
    <div className={`space-y-4 p-5 transition-colors duration-500 ${isSearching ? "bg-gold/5" : "bg-surface-low"}`}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {isSearching && <Spinner size="sm" />}
          <h3 className="label-md">
            Deep Dive: {connectionType}
          </h3>
          {isSearching && discoveries.length > 0 && (
            <span className="text-[10px] text-ink-muted">{discoveries.length} sources found</span>
          )}
        </div>
        {onClose && (
          <button onClick={onClose} className="text-xs text-ink-muted hover:text-ink transition-colors">
            Close
          </button>
        )}
      </div>

      {/* Current activity */}
      {isSearching && latestToolCall && (
        <div className="text-xs text-ink-muted bg-surface-bright p-2">
          {latestToolCall.toolName === "web_search" ? (
            <span>Searching: {(latestToolCall.input as Record<string, unknown>).query as string}</span>
          ) : latestToolCall.toolName === "fetch_url" ? (
            <span>Reading: {((latestToolCall.input as Record<string, unknown>).url as string)?.slice(0, 60)}...</span>
          ) : latestToolCall.toolName === "run_shell" ? (
            <span>Running: {((latestToolCall.input as Record<string, unknown>).command as string)?.slice(0, 60)}...</span>
          ) : (
            <span>{latestToolCall.toolName}...</span>
          )}
        </div>
      )}

      {/* Live discoveries — parsed search results streaming in as agent searches */}
      {isSearching && discoveries.length > 0 && results.length === 0 && (
        <div className="space-y-1">
          <span className="text-[10px] text-ink-muted uppercase tracking-wider">Sources discovered</span>
          <AnimatePresence>
            {discoveries.slice(-6).map((d, i) => (
              <motion.div
                key={d.url}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.03 }}
                className="text-xs bg-surface-bright p-2 flex items-start gap-2"
              >
                <span className="text-gold flex-shrink-0">&#9702;</span>
                <div className="min-w-0">
                  <span className="text-ink font-medium truncate block">{d.title}</span>
                  {d.snippet && (
                    <span className="text-ink-muted line-clamp-1">{d.snippet}</span>
                  )}
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="text-xs text-crimson bg-crimson/5 p-3">
          {error}
        </div>
      )}

      {/* Final results */}
      {results.length > 0 && (
        <div className="space-y-2">
          {results.map((result, i) => (
            <DeepDiveResultCard key={i} result={result} />
          ))}
        </div>
      )}

      {/* Empty state */}
      {status === "completed" && results.length === 0 && (
        <p className="text-xs text-ink-muted text-center py-4">
          No specific findings for this connection intersection.
        </p>
      )}
    </div>
  );
}
