/**
 * WebSocket server for agent communication.
 *
 * Runs on Railway alongside the Hono API server.
 * E2B sandbox agents connect here to stream events back.
 */

import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { getEventBus } from "./event-bus";
import { generateId } from "../utils/ids";
import type { AgentType, Candidate } from "../types/agent";

interface AgentMessage {
  type: "status" | "thinking" | "tool_call" | "nomination" | "result" | "complete" | "error";
  agentId: string;
  agentType: AgentType;
  [key: string]: unknown;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function emitBusEvent(researchId: string, type: string, data: any) {
  getEventBus(researchId).emit({ type, data } as any);
}

// Track pending agents waiting for sandbox connections
const pendingAgents = new Map<string, {
  researchId: string;
  resolve: (ws: WebSocket) => void;
  reject: (err: Error) => void;
}>();

let wss: WebSocketServer | null = null;

export function startAgentWsServer(server: Server): WebSocketServer {
  wss = new WebSocketServer({ server, path: "/ws/agent" });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const agentId = url.searchParams.get("agentId");

    if (!agentId) {
      ws.close(1008, "Missing agentId");
      return;
    }

    console.log(`[agent-ws] Agent connected: ${agentId}`);

    const pending = pendingAgents.get(agentId);
    if (pending) {
      pending.resolve(ws);
      pendingAgents.delete(agentId);
    }

    ws.on("message", (data) => {
      try {
        const msg: AgentMessage = JSON.parse(data.toString());
        handleAgentMessage(msg);
      } catch (err) {
        console.error("[agent-ws] Bad message:", err);
      }
    });

    ws.on("close", () => {
      console.log(`[agent-ws] Agent disconnected: ${agentId}`);
    });
  });

  console.log("[agent-ws] WebSocket server started on /ws/agent");
  return wss;
}

function handleAgentMessage(msg: AgentMessage) {
  const { type, agentId, agentType } = msg;

  // Find the research ID for this agent
  const researchId = agentResearchMap.get(agentId);
  if (!researchId) {
    console.warn(`[agent-ws] No research ID for agent ${agentId}`);
    return;
  }

  const now = new Date().toISOString();

  switch (type) {
    case "status":
      emitBusEvent(researchId, "agent_event", {
        type: "status", agentId, agentType,
        status: msg.status, message: msg.message, timestamp: now,
      });
      break;

    case "thinking":
      emitBusEvent(researchId, "agent_event", {
        type: "thinking", agentId, agentType,
        thought: (msg.thought as string)?.slice(0, 500), timestamp: now,
      });
      break;

    case "tool_call":
      emitBusEvent(researchId, "agent_event", {
        type: "tool_call", agentId, agentType,
        toolName: msg.toolName, toolInput: msg.toolInput || {},
        toolOutput: msg.toolOutput,
        summary: summarizeToolCall(msg.toolName as string, msg.toolInput as Record<string, unknown>),
        status: msg.status, timestamp: now,
      });
      break;

    case "nomination": {
      const cand = msg.candidate as Record<string, unknown>;
      emitBusEvent(researchId, "candidate", {
        id: generateId("cand"),
        name: (cand.name as string) || "Unknown",
        party: (cand.party as string) || "R",
        state: (cand.state as string) || "??",
        chamber: (cand.chamber as string) || "senate",
        score: (cand.score as number) || 50,
        nominatedBy: [agentType],
        evidence: [{
          agentType,
          category: agentType.replace("_analyzer", ""),
          summary: (cand.evidence as string) || "",
          confidence: ((cand.score as number) || 50) / 100,
        }],
        connections: [],
        status: "nominated",
        nominatedAt: now,
      });
      break;
    }

    case "result":
      emitBusEvent(researchId, "agent_event", {
        type: "finding", agentId, agentType,
        finding: (msg.output as string)?.slice(0, 1000),
        confidence: 0.85, timestamp: now,
      });
      break;

    case "complete":
      emitBusEvent(researchId, "agent_event", {
        type: "status", agentId, agentType,
        status: "completed", message: `Completed in ${msg.iterations} iterations`,
        timestamp: now,
      });
      break;

    case "error":
      emitBusEvent(researchId, "agent_event", {
        type: "status", agentId, agentType,
        status: "failed", message: (msg.error as string) || "Unknown error",
        timestamp: now,
      });
      break;
  }
}

/** Quick tool call summary (no LLM needed) */
function summarizeToolCall(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "web_search": return (input.query as string)?.slice(0, 60) || "searching...";
    case "fetch_url": {
      try { return `Reading ${new URL(input.url as string).hostname}`; } catch { return "Reading URL"; }
    }
    case "run_shell": return `Running: ${(input.command as string)?.slice(0, 40)}`;
    case "nominate_candidate": return `Nominated ${input.name}`;
    default: return toolName;
  }
}

// ── Agent ↔ Research mapping ──
const agentResearchMap = new Map<string, string>();

export function registerAgent(agentId: string, researchId: string) {
  agentResearchMap.set(agentId, researchId);
}

export function unregisterAgent(agentId: string) {
  agentResearchMap.delete(agentId);
}

/** Wait for an agent to connect via WebSocket */
export function waitForAgentConnection(agentId: string, timeoutMs = 30_000): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingAgents.delete(agentId);
      reject(new Error(`Agent ${agentId} didn't connect within ${timeoutMs}ms`));
    }, timeoutMs);

    pendingAgents.set(agentId, {
      researchId: agentResearchMap.get(agentId) || "",
      resolve: (ws) => {
        clearTimeout(timer);
        resolve(ws);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
  });
}
