import type { AgentRun, Recommendation, Candidate } from "./agent";

export type ResearchStatus =
  | "queued"
  | "agents_starting"
  | "agents_running"
  | "finding_connections"
  | "synthesizing"
  | "completed"
  | "failed";

export interface Research {
  id: string;
  initiativeId: string;
  legislatorId: string;
  status: ResearchStatus;
  agents: AgentRun[];
  candidates: Candidate[];
  recommendations: Recommendation[];
  synthesis?: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
}
