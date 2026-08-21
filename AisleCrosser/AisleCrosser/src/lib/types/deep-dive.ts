export interface DeepDive {
  id: string; // "dive_XXXXXXXXXXXX"
  researchId: string;
  recommendationId: string;
  connectionIndex: number;
  connectionType: string;
  connectionDetail: string;
  targetLegislatorName: string;
  initiativeTitle: string;
  status: "queued" | "searching" | "completed" | "failed";
  results: DeepDiveResult[];
  toolCalls: DeepDiveToolCall[];
  startedAt: string;
  completedAt?: string;
  error?: string;
}

export interface DeepDiveResult {
  title: string;
  summary: string;
  url?: string;
  date?: string;
  relevance: string;
  type: "report" | "event" | "article" | "speech" | "organization" | "other";
}

export interface DeepDiveToolCall {
  toolName: string;
  input: Record<string, unknown>;
  /** Parsed tool output for rich UI display (e.g., search result titles/URLs) */
  output?: unknown;
  timestamp: string;
}

export type DeepDiveStreamEvent =
  | { type: "status"; data: { deepDiveId: string; status: DeepDive["status"] } }
  | { type: "tool_call"; data: DeepDiveToolCall }
  | { type: "results"; data: { deepDiveId: string; results: DeepDiveResult[] } }
  | { type: "complete"; data: { deepDiveId: string } }
  | { type: "error"; data: { deepDiveId: string; error: string } };
