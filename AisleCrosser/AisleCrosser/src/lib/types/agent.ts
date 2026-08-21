export type AgentType =
  | "speech_analyzer"
  | "voting_analyzer"
  | "constituency_analyzer"
  | "interest_analyzer"
  | "connection_finder"
  | "synthesizer";

export type AgentStatus =
  | "pending"
  | "starting_sandbox"
  | "running"
  | "tool_calling"
  | "thinking"
  | "completed"
  | "failed";

export interface AgentRun {
  id: string;
  researchId: string;
  agentType: AgentType;
  status: AgentStatus;
  displayName: string;
  description: string;
  events: AgentEvent[];
  result?: AgentResult;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export type AgentEvent =
  | AgentStatusEvent
  | AgentToolCallEvent
  | AgentThinkingEvent
  | AgentFindingEvent
  | AgentErrorEvent;

export interface AgentStatusEvent {
  type: "status";
  agentId: string;
  agentType: AgentType;
  status: AgentStatus;
  message: string;
  timestamp: string;
}

export interface AgentToolCallEvent {
  type: "tool_call";
  agentId: string;
  agentType: AgentType;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolOutput?: string;
  summary?: string;
  status: "started" | "completed" | "failed";
  timestamp: string;
}

export interface AgentThinkingEvent {
  type: "thinking";
  agentId: string;
  agentType: AgentType;
  thought: string;
  timestamp: string;
}

export interface AgentFindingEvent {
  type: "finding";
  agentId: string;
  agentType: AgentType;
  finding: string;
  confidence: number;
  relatedLegislatorId?: string;
  timestamp: string;
}

export interface AgentErrorEvent {
  type: "error";
  agentId: string;
  agentType: AgentType;
  error: string;
  recoverable: boolean;
  timestamp: string;
}

export interface AgentResult {
  findings: ReasoningStep[];
  candidateLegislators: string[];
  rawData?: Record<string, unknown>;
}

export interface ReasoningStep {
  id: string;
  agentType: AgentType;
  category: string;
  title: string;
  evidence: string;
  confidence: number;
  sources: Source[];
}

export interface Source {
  title: string;
  url?: string;
  type: "vote" | "speech" | "bill" | "article" | "committee" | "other";
  date?: string;
}

// ─────────────────────────────────────────────────────
// Intermediary candidates — nominated by agents as they
// complete, enriched with personal connections later
// ─────────────────────────────────────────────────────

export interface Candidate {
  id: string;
  name: string;
  party: "R" | "D" | "I";
  state: string;
  chamber: "senate" | "house";
  /** Preliminary alignment score (0-100), refined as more agents report */
  score: number;
  /** Which agent types nominated this candidate */
  nominatedBy: AgentType[];
  /** Key evidence snippets per agent */
  evidence: CandidateEvidence[];
  /** Personal connections found by connection_finder agents */
  connections: PersonalConnection[];
  /** Status: nominated → researching_connections → enriched → synthesized */
  status: "nominated" | "researching_connections" | "enriched" | "synthesized";
  nominatedAt: string;
  /** Per-candidate synthesis (lazy — only for top candidates or on click) */
  approachStrategy?: string;
  talkingPoints?: string[];
  sharedInterests?: string[];
}

export interface CandidateEvidence {
  agentType: AgentType;
  category: string;
  summary: string;
  confidence: number;
}

export interface PersonalConnection {
  /** Freeform connection type — not a restricted enum (e.g., "golf", "Yale Law School", "cancer survivor") */
  type: string;
  /** Agent-suggested emoji for this connection type */
  iconSuggestion?: string;
  detail: string;
  /** How the requesting legislator shares this connection */
  sharedWith: string;
  /** URL or citation — required for verified connections */
  source: string;
  confidence: number;
}

export type ResearchStreamEvent =
  | { type: "research_status"; data: { researchId: string; status: string } }
  | { type: "agent_event"; data: AgentEvent }
  | { type: "candidate"; data: Candidate }
  | { type: "candidate_update"; data: { candidateId: string; connections: PersonalConnection[]; status: Candidate["status"] } }
  | { type: "connection_search_activity"; data: { candidateId: string; toolName: string; input: Record<string, unknown>; timestamp: string } }
  | { type: "recommendation"; data: Recommendation }
  | { type: "complete"; data: { researchId: string } }
  | { type: "error"; data: { researchId: string; error: string } };

export interface Recommendation {
  id: string;
  targetLegislatorId: string;
  targetLegislatorName: string;
  targetLegislatorParty: string;
  targetLegislatorState: string;
  targetLegislatorChamber: string;
  alignmentScore: number;
  summary: string;
  reasoningChain: ReasoningStep[];
  approachStrategy: string;
  sharedInterests: string[];
  personalConnections?: PersonalConnection[];
  feedback?: FeedbackState;
}

export interface FeedbackState {
  value: "up" | "down" | null;
  comment?: string;
  submittedAt: string;
}
