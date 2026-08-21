"use client";

import { useState } from "react";
import { AgentPanel } from "./agent-panel";
import type { AgentState } from "@/hooks/use-research-stream";

interface AgentGridProps {
  agents: AgentState[];
  isComplete?: boolean;
}

export function AgentGrid({ agents, isComplete }: AgentGridProps) {
  const [expanded, setExpanded] = useState(true);

  if (agents.length === 0) {
    return (
      <div className="text-center py-4 bg-surface-low">
        <p className="text-sm text-ink-muted">
          {isComplete ? "Agents completed." : "Starting agents..."}
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
      {agents.map((agent) => (
        <AgentPanel
          key={agent.id}
          agent={agent}
          expanded={expanded}
          onToggleExpand={() => setExpanded(!expanded)}
        />
      ))}
    </div>
  );
}
