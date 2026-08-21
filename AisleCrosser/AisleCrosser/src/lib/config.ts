/**
 * Central configuration for AI models and research effort.
 *
 * AI_MODEL   — override ALL model calls (e.g. "haiku", "sonnet", "claude-haiku-4-5-20251001")
 * EFFORT     — "low" | "medium" | "high" — controls models, timeouts, turn limits
 *
 * Low effort:  haiku everywhere, 60s timeout, 8 turns — for testing
 * Medium:      sonnet agents, sonnet synthesis, 90s timeout, 14 turns
 * High:        sonnet agents, sonnet synthesis, 240s timeout, 25 turns — production
 */

type Effort = "low" | "medium" | "high";

function getEffort(): Effort {
  const e = (process.env.EFFORT || "high").toLowerCase();
  if (e === "low" || e === "medium") return e;
  return "high";
}

const EFFORT_PRESETS = {
  low: {
    sandboxModel: "claude-haiku-4-5-20251001",
    apiModel: "claude-haiku-4-5-20251001",
    synthesisModel: "claude-haiku-4-5-20251001",
    agentTimeoutMs: 60_000,
    maxBudgetUsd: 0.05,
    maxIterations: 5,
    connectionIterations: 3,
    topCandidates: 3,
  },
  medium: {
    sandboxModel: "claude-sonnet-4-6",
    apiModel: "claude-haiku-4-5-20251001",
    synthesisModel: "claude-sonnet-4-6",
    agentTimeoutMs: 90_000,
    maxBudgetUsd: 0.15,
    maxIterations: 8,
    connectionIterations: 5,
    topCandidates: 4,
  },
  high: {
    sandboxModel: "claude-sonnet-4-6",
    apiModel: "claude-haiku-4-5-20251001",
    synthesisModel: "claude-sonnet-4-6",
    agentTimeoutMs: 240_000,
    maxBudgetUsd: 0.50,
    maxIterations: 15,
    connectionIterations: 15,
    topCandidates: 8,
  },
} as const;

function preset() {
  return EFFORT_PRESETS[getEffort()];
}

/** Model for Claude Code CLI inside E2B sandboxes */
export function getSandboxModel(): string {
  return process.env.AI_MODEL || process.env.SANDBOX_MODEL || preset().sandboxModel;
}

/** Model for direct Anthropic API calls (extraction, condensing) */
export function getApiModel(): string {
  return process.env.AI_MODEL || preset().apiModel;
}

/** Model for final synthesis */
export function getSynthesisModel(): string {
  return process.env.AI_MODEL || preset().synthesisModel;
}

/** Timeout for sandbox agent execution */
export function getAgentTimeoutMs(): number {
  return parseInt(process.env.AGENT_TIMEOUT_MS || String(preset().agentTimeoutMs), 10);
}

/** Max budget per sandbox agent in USD (--max-budget-usd flag) */
export function getMaxBudget(): number {
  return parseFloat(process.env.AGENT_MAX_BUDGET_USD || String(preset().maxBudgetUsd));
}

/** Max tool loop iterations */
export function getMaxIterations(): number {
  return parseInt(process.env.AGENT_MAX_ITERATIONS || String(preset().maxIterations), 10);
}

/** Max connection search iterations */
export function getConnectionIterations(): number {
  return parseInt(process.env.AGENT_MAX_ITERATIONS || String(preset().connectionIterations), 10);
}

/** How many top candidates get connection searches */
export function getTopCandidates(): number {
  return preset().topCandidates;
}
