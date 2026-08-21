"use client";

import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import type { AgentState } from "@/hooks/use-research-stream";

const agentIcons: Record<string, string> = {
  speech_analyzer: "&#128483;",
  voting_analyzer: "&#9745;",
  constituency_analyzer: "&#127968;",
  interest_analyzer: "&#129309;",
  synthesizer: "&#129504;",
};

const toolIcons: Record<string, string> = {
  WebSearch: "\uD83D\uDD0D",
  WebFetch: "\uD83C\uDF10",
  Bash: "\u25B6\uFE0F",
  Read: "\uD83D\uDCC4",
  Write: "\u270F\uFE0F",
  Glob: "\uD83D\uDCC1",
  Grep: "\uD83D\uDD0E",
  TodoWrite: "\u2611\uFE0F",
};

function getToolIcon(toolName: string): string {
  return toolIcons[toolName] || "\u2699\uFE0F";
}

interface AgentPanelProps {
  agent: AgentState;
  expanded?: boolean;
  onToggleExpand?: () => void;
}

export function AgentPanel({ agent, expanded = true, onToggleExpand }: AgentPanelProps) {
  const isActive = ["running", "tool_calling", "thinking", "starting_sandbox"].includes(agent.status);
  const toolEvents = agent.events.filter((e) => e.type === "tool_call");

  return (
    <Card
      padding="sm"
      className={`${isActive ? "bg-surface-low" : ""}`}
    >
      {/* Header — always visible, click to expand details */}
      <button
        onClick={onToggleExpand}
        className="w-full flex items-center gap-3 text-left"
      >
        <span className="text-lg flex-shrink-0" dangerouslySetInnerHTML={{ __html: agentIcons[agent.agentType] || "&#129302;" }} />
        <div className="flex-1 min-w-0">
          <span className="text-sm font-semibold text-ink truncate block">{agent.displayName}</span>
          {isActive && agent.currentToolSummary ? (
            <span className="text-xs text-ink-muted truncate block">{agent.currentToolSummary}</span>
          ) : (
            <span className="text-xs text-ink-muted">{agent.status === "completed" ? "Complete" : agent.status.replace(/_/g, " ")}</span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {isActive && <Spinner size="sm" />}
          <div className={`h-2.5 w-2.5 ${
            agent.status === "completed" ? "bg-emerald-500" :
            agent.status === "failed" ? "bg-crimson" :
            isActive ? "bg-gold animate-pulse" : "bg-surface-high"
          }`} />
        </div>
      </button>

      {/* Expanded details — tool history, thoughts, findings */}
      {expanded && (
        <div className="mt-2 pt-2 border-t border-surface-high space-y-2">
          {/* Tool History — scrollable */}
          {toolEvents.length > 0 && (
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {toolEvents.map((event, i) => {
                if (event.type !== "tool_call") return null;
                const icon = event.status === "completed"
                  ? "\u2713"
                  : event.status === "failed"
                    ? "\u2717"
                    : getToolIcon(event.toolName);
                return (
                  <div key={i} className="flex items-start gap-1.5 text-xs">
                    <span className={`flex-shrink-0 ${
                      event.status === "completed" ? "text-emerald-600" :
                      event.status === "failed" ? "text-crimson" : "text-ink-muted"
                    }`}>
                      {icon}
                    </span>
                    <span className="text-ink-light leading-snug truncate">
                      {event.summary || event.toolName}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Latest Thought */}
          {agent.latestThought && (
            <p className="text-xs text-ink-light italic line-clamp-2">{agent.latestThought}</p>
          )}

          {/* Findings */}
          {agent.findings.length > 0 && (
            <div className="space-y-1">
              {agent.findings.slice(-2).map((finding, i) => (
                <p key={i} className="text-xs text-emerald-700 line-clamp-1">{finding}</p>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
