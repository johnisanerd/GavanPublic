/**
 * Direct agent runner — runs tool loops on the server, no E2B sandbox.
 *
 * Same agent logic as the E2B runner but executes locally.
 * nominate_candidate is a real tool that emits to EventBus.
 * Switch to E2B later by swapping this for sandbox-v2.ts.
 */

import type { AgentType, Candidate } from "../types/agent";
import { getEventBus } from "./event-bus";
import { generateId } from "../utils/ids";
import { getSandboxModel, getMaxIterations } from "../config";
import {
  runToolLoop,
  createWebSearchTool,
  createFetchUrlTool,
  createApifySearchTool,
  createApifyCrawlerTool,
  createInstagramTool,
  createTwitterTool,
  createFacebookTool,
  type ToolDefinition,
} from "./tool-loop";

export interface AgentConfig {
  id: string;
  researchId: string;
  agentType: AgentType;
  prompt: string;
  displayName: string;
  description: string;
  model?: string;
  chamberFilter?: string;
}

export interface SandboxResult {
  agentId: string;
  agentType: AgentType;
  output: string;
  success: boolean;
  error?: string;
}

export async function runAgentDirect(config: AgentConfig): Promise<SandboxResult> {
  const { id: agentId, researchId, agentType } = config;
  const bus = getEventBus(researchId);
  const model = config.model || getSandboxModel();
  const now = () => new Date().toISOString();

  bus.emit({
    type: "agent_event",
    data: { type: "status", agentId, agentType, status: "running", message: `${config.displayName} starting...`, timestamp: now() },
  } as any);

  try {
    // nominate_candidate tool — emits directly to EventBus
    const nominateTool: ToolDefinition = {
      name: "nominate_candidate",
      description: "Nominate a cross-party ally you've found. Call IMMEDIATELY when you find evidence of alignment — don't wait until the end.",
      input_schema: {
        type: "object" as const,
        required: ["name", "party", "state", "chamber", "score", "evidence"],
        properties: {
          name: { type: "string", description: "Full name" },
          party: { type: "string", enum: ["R", "D", "I"] },
          state: { type: "string", description: "Two-letter state code" },
          chamber: { type: "string", enum: ["senate", "house"] },
          score: { type: "number", description: "0-100 alignment score" },
          evidence: { type: "string", description: "One sentence of why" },
        },
      },
      execute: async (input) => {
        // Filter by chamber if set
        if (config.chamberFilter && input.chamber && input.chamber !== config.chamberFilter) {
          return `Skipped ${input.name} — wrong chamber (${input.chamber} vs ${config.chamberFilter}).`;
        }

        const candidate: Candidate = {
          id: generateId("cand"),
          name: (input.name as string) || "Unknown",
          party: (input.party as "R" | "D" | "I") || "R",
          state: (input.state as string) || "??",
          chamber: (input.chamber as "senate" | "house") || "senate",
          score: (input.score as number) || 50,
          nominatedBy: [agentType],
          evidence: [{
            agentType,
            category: agentType.replace("_analyzer", ""),
            summary: (input.evidence as string) || "",
            confidence: ((input.score as number) || 50) / 100,
          }],
          connections: [],
          status: "nominated",
          nominatedAt: now(),
        };

        console.log(`[agent-direct] ${agentType} nominated: ${candidate.name} (${candidate.party}-${candidate.state})`);
        bus.emit({ type: "candidate", data: candidate } as any);
        return `Nominated ${input.name} (${input.party}-${input.state}) with score ${input.score}.`;
      },
    };

    // Build tool set
    const tools: ToolDefinition[] = [
      createWebSearchTool(),
      createFetchUrlTool(),
      ...(process.env.APIFY_API_KEY
        ? [createApifySearchTool(), createApifyCrawlerTool(), createInstagramTool(), createTwitterTool(), createFacebookTool()]
        : []),
      nominateTool,
    ];

    const systemPrompt = `You are a ${config.displayName} for the Aisle Crosser bipartisan strategy platform.

${config.description}

## CRITICAL RULES
1. After EVERY search, if you found ANY legislator who could be an ally, call nominate_candidate IMMEDIATELY. Do NOT wait for more evidence. Nominate early, nominate often.
2. A score of 50+ is enough to nominate. You're identifying POTENTIAL allies, not confirmed ones.
3. You MUST call nominate_candidate at least 3 times during your research. If you haven't nominated anyone after 2 searches, lower your threshold.
4. Be AGGRESSIVELY creative. Search for non-obvious connections and unlikely allies.`;

    const result = await runToolLoop({
      model,
      systemPrompt,
      userMessage: config.prompt,
      tools,
      maxIterations: getMaxIterations(),
      maxTokens: 4096,
      onToolCall: (toolName, input, output) => {
        // Stream tool calls to UI
        const summary = toolName === "web_search"
          ? (input.query as string)?.slice(0, 60)
          : toolName === "nominate_candidate"
            ? `Nominated ${input.name}`
            : toolName === "fetch_url"
              ? `Reading ${(input.url as string)?.split("/").slice(2, 3).join("")}`
              : toolName;

        bus.emit({
          type: "agent_event",
          data: {
            type: "tool_call", agentId, agentType,
            toolName, toolInput: input, summary,
            status: "completed", timestamp: now(),
          },
        } as any);
      },
    });

    // Stream final thinking
    if (result.finalText) {
      bus.emit({
        type: "agent_event",
        data: { type: "thinking", agentId, agentType, thought: result.finalText.slice(0, 500), timestamp: now() },
      } as any);
    }

    bus.emit({
      type: "agent_event",
      data: { type: "status", agentId, agentType, status: "completed", message: `Done in ${result.iterations} iterations`, timestamp: now() },
    } as any);

    console.log(`[agent-direct] ${agentType} completed: ${result.iterations} iterations, ${result.toolCalls.length} tool calls`);

    return {
      agentId,
      agentType,
      output: result.finalText || "",
      success: true,
    };

  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[agent-direct] ${agentType} failed:`, error);

    bus.emit({
      type: "agent_event",
      data: { type: "status", agentId, agentType, status: "failed", message: error, timestamp: now() },
    } as any);

    return { agentId, agentType, output: "", success: false, error };
  }
}
