"use client";

import { useState, useEffect, useRef } from "react";
import type {
  AgentEvent,
  Recommendation,
  AgentType,
  AgentStatus,
  Candidate,
  PersonalConnection,
} from "@/lib/types/agent";
import type { ResearchStatus } from "@/lib/types/research";

export interface AgentState {
  id: string;
  agentType: AgentType;
  status: AgentStatus;
  displayName: string;
  events: AgentEvent[];
  currentTool?: string;
  currentToolSummary?: string;
  latestThought?: string;
  findings: string[];
}

export interface ConnectionSearchActivity {
  candidateId: string;
  toolName: string;
  input: Record<string, unknown>;
  timestamp: string;
}

export function useResearchStream(researchId: string | null) {
  const [agents, setAgents] = useState<Map<string, AgentState>>(new Map());
  const [candidates, setCandidates] = useState<Map<string, Candidate>>(new Map());
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [status, setStatus] = useState<ResearchStatus>("queued");
  const [error, setError] = useState<string | null>(null);
  const [connectionActivity, setConnectionActivity] = useState<Map<string, ConnectionSearchActivity[]>>(new Map());

  // Track highest processed SSE event ID to prevent duplicates
  // (React Strict Mode double-mounts, EventSource reconnects, etc.)
  const lastProcessedId = useRef(-1);

  const AGENT_NAMES: Record<AgentType, string> = {
    speech_analyzer: "Speech Analyzer",
    voting_analyzer: "Voting Analyzer",
    constituency_analyzer: "Constituency Analyzer",
    interest_analyzer: "Interest Analyzer",
    connection_finder: "Connection Finder",
    synthesizer: "Synthesizer",
  };

  // Reset dedup tracking when research changes
  useEffect(() => {
    lastProcessedId.current = -1;
  }, [researchId]);

  // Fetch initial state from REST API (for page loads after research completes)
  useEffect(() => {
    if (!researchId) return;

    fetch(`/api/research/${researchId}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.status) setStatus(data.status);
        if (data.recommendations?.length) {
          setRecommendations(data.recommendations);
        }
        if (data.candidates?.length) {
          setCandidates((prev) => {
            const next = new Map(prev);
            for (const c of data.candidates) {
              next.set(c.name.toLowerCase(), c);
            }
            return next;
          });
        }
        if (data.agents?.length) {
          setAgents((prev) => {
            const next = new Map(prev);
            for (const a of data.agents) {
              if (!next.has(a.id)) {
                next.set(a.id, {
                  id: a.id,
                  agentType: a.agentType,
                  status: a.status || "completed",
                  displayName: AGENT_NAMES[a.agentType as AgentType] || a.agentType,
                  events: [],
                  findings: [],
                });
              }
            }
            return next;
          });
        }
      })
      .catch(() => { /* SSE will handle it */ });
  }, [researchId]);

  useEffect(() => {
    if (!researchId) return;

    const eventSource = new EventSource(`/api/research/stream/${researchId}`);

    // Dedup helper: skip events we've already processed
    // SSE events have sequential numeric IDs from the server
    const isDuplicate = (e: MessageEvent): boolean => {
      const id = parseInt(e.lastEventId, 10);
      if (isNaN(id)) return false; // No ID (e.g., completed-research replay) — always process
      if (id <= lastProcessedId.current) return true;
      lastProcessedId.current = id;
      return false;
    };

    eventSource.addEventListener("research_status", (e) => {
      if (isDuplicate(e)) return;
      const data = JSON.parse(e.data);
      setStatus(data.status);
    });

    eventSource.addEventListener("agent_event", (e) => {
      if (isDuplicate(e)) return;
      const event: AgentEvent = JSON.parse(e.data);

      setAgents((prev) => {
        const next = new Map(prev);
        const existing = next.get(event.agentId);
        const agent: AgentState = existing || {
          id: event.agentId,
          agentType: event.agentType,
          status: "pending",
          displayName: AGENT_NAMES[event.agentType] || event.agentType,
          events: [],
          findings: [],
        };

        // Dedup: skip if we already have this exact event (React Strict Mode double-mount)
        if (event.type === "tool_call") {
          const isDupEvent = agent.events.some(
            (e) => e.type === "tool_call" && e.toolName === event.toolName && e.summary === event.summary && e.status === event.status
          );
          if (isDupEvent) return prev; // no change
        }
        agent.events = [...agent.events, event];

        if (event.type === "status") {
          agent.status = event.status;
        } else if (event.type === "tool_call") {
          if (event.status === "started") {
            agent.currentTool = event.toolName;
            agent.currentToolSummary = event.summary;
            agent.status = "tool_calling";
          } else {
            agent.currentTool = undefined;
            agent.currentToolSummary = undefined;
          }
        } else if (event.type === "thinking") {
          agent.latestThought = event.thought;
          agent.status = "thinking";
        } else if (event.type === "finding") {
          agent.findings = [...agent.findings, event.finding];
        }

        next.set(event.agentId, { ...agent });
        return next;
      });
    });

    eventSource.addEventListener("candidate", (e) => {
      if (isDuplicate(e)) return;
      const candidate: Candidate = JSON.parse(e.data);
      setCandidates((prev) => {
        const next = new Map(prev);
        const key = candidate.name.toLowerCase();
        const existing = next.get(key);
        if (existing) {
          // Merge: keep higher score, combine evidence and nominations
          next.set(key, {
            ...existing,
            score: Math.max(existing.score, candidate.score),
            nominatedBy: [...new Set([...existing.nominatedBy, ...candidate.nominatedBy])],
            evidence: [...existing.evidence, ...candidate.evidence.filter(
              (e2) => !existing.evidence.some((e1) => e1.summary === e2.summary)
            )],
            connections: candidate.connections.length > existing.connections.length ? candidate.connections : existing.connections,
            status: candidate.status === "enriched" ? "enriched" : existing.status,
          });
        } else {
          next.set(key, candidate);
        }
        return next;
      });
    });

    eventSource.addEventListener("candidate_update", (e) => {
      if (isDuplicate(e)) return;
      const update: { candidateId: string; connections: PersonalConnection[]; status: Candidate["status"] } =
        JSON.parse(e.data);
      setCandidates((prev) => {
        const next = new Map(prev);
        const existing = next.get(update.candidateId);
        if (existing) {
          next.set(update.candidateId, {
            ...existing,
            connections: update.connections,
            status: update.status,
          });
        }
        return next;
      });
      // Clear activity when enriched
      if (update.status === "enriched") {
        setConnectionActivity((prev) => {
          const next = new Map(prev);
          next.delete(update.candidateId);
          return next;
        });
      }
    });

    eventSource.addEventListener("connection_search_activity", (e) => {
      if (isDuplicate(e)) return;
      const activity: ConnectionSearchActivity = JSON.parse(e.data);
      setConnectionActivity((prev) => {
        const next = new Map(prev);
        const existing = next.get(activity.candidateId) || [];
        next.set(activity.candidateId, [...existing, activity]);
        return next;
      });
    });

    eventSource.addEventListener("recommendation", (e) => {
      if (isDuplicate(e)) return;
      const rec: Recommendation = JSON.parse(e.data);
      setRecommendations((prev) => {
        if (prev.some((r) => r.id === rec.id)) return prev;
        return [...prev, rec];
      });
    });

    eventSource.addEventListener("complete", () => {
      setStatus("completed");
      eventSource.close();
    });

    eventSource.addEventListener("error", () => {
      if (eventSource.readyState === EventSource.CLOSED) {
        setError("Connection closed");
      }
    });

    return () => eventSource.close();
  }, [researchId]);

  const agentList = Array.from(agents.values());
  const candidateList = Array.from(candidates.values()).sort((a, b) => b.score - a.score);
  const connectionActivityMap = Object.fromEntries(connectionActivity);

  return { agents: agentList, candidates: candidateList, recommendations, status, error, connectionActivity: connectionActivityMap };
}
