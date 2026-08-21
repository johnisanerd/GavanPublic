/**
 * Sandbox v2 — Agent SDK inside E2B, communicates via WebSocket.
 *
 * Instead of running Claude Code CLI and parsing NDJSON,
 * this uploads an agent-runner.ts script that uses the Anthropic SDK directly.
 * Events stream back via WebSocket in clean JSON.
 */

import { Sandbox } from "e2b";
import { readFileSync } from "fs";
import { join } from "path";
import type { AgentType } from "../types/agent";
import { getEventBus } from "./event-bus";
import { registerAgent, unregisterAgent } from "./agent-ws";
import { getSandboxModel, getAgentTimeoutMs, getMaxIterations } from "../config";

export interface AgentConfigV2 {
  id: string;
  researchId: string;
  agentType: AgentType;
  prompt: string;
  displayName: string;
  description: string;
  systemPrompt?: string;
  model?: string;
  chamberFilter?: string;
}

export interface SandboxResultV2 {
  agentId: string;
  agentType: AgentType;
  output: string;
  success: boolean;
  error?: string;
}

/** Get the public WS URL for the agent to connect back to */
function getWsUrl(agentId: string): string {
  const host = process.env.RAILWAY_PUBLIC_DOMAIN
    || process.env.WS_HOST
    || `localhost:${process.env.PORT || 3001}`;
  const protocol = host.includes("localhost") ? "ws" : "wss";
  return `${protocol}://${host}/ws/agent?agentId=${agentId}`;
}

export async function runAgentInSandboxV2(config: AgentConfigV2): Promise<SandboxResultV2> {
  const { id: agentId, researchId, agentType } = config;
  const model = config.model || getSandboxModel();
  const bus = getEventBus(researchId);
  const now = () => new Date().toISOString();

  // Register this agent so WS server knows where to route events
  registerAgent(agentId, researchId);

  bus.emit({
    type: "agent_event",
    data: { type: "status", agentId, agentType, status: "starting_sandbox", message: `Launching ${config.displayName}...`, timestamp: now() },
  });

  let sandbox: Sandbox | null = null;

  try {
    // Create sandbox
    console.log(`[sandbox-v2] Creating E2B sandbox for ${agentType}`);
    const createStart = Date.now();

    sandbox = await Promise.race([
      Sandbox.create("aisle-crosser-agent", {
        apiKey: process.env.E2B_API_KEY,
        timeoutMs: 300_000,
        metadata: { agent_type: agentType, research_id: researchId },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Sandbox creation timed out")), 60_000)
      ),
    ]);

    console.log(`[sandbox-v2] Sandbox ready for ${agentType} in ${Date.now() - createStart}ms`);

    bus.emit({
      type: "agent_event",
      data: { type: "status", agentId, agentType, status: "running", message: `${config.displayName} running...`, timestamp: now() },
    });

    // Upload agent runner script
    const runnerScript = readFileSync(
      join(process.cwd(), "src/lib/agents/runner/agent-runner.ts"),
      "utf-8"
    );
    await sandbox.files.write("/home/user/agent-runner.ts", runnerScript);

    // Agent config as JSON
    const agentConfig = JSON.stringify({
      id: agentId,
      agentType,
      prompt: config.prompt,
      displayName: config.displayName,
      description: config.description,
      systemPrompt: config.systemPrompt,
      chamberFilter: config.chamberFilter,
    });

    const wsUrl = getWsUrl(agentId);
    console.log(`[sandbox-v2] Agent ${agentType} connecting to ${wsUrl}`);

    // Write config + env to a launcher script to avoid shell escaping issues
    const envVars = [
      `export AGENT_CONFIG='${agentConfig.replace(/'/g, "'\\''")}'`,
      `export WS_URL='${wsUrl}'`,
      `export AGENT_MODEL='${model}'`,
      `export MAX_ITERATIONS='${getMaxIterations()}'`,
      `export ANTHROPIC_API_KEY='${process.env.ANTHROPIC_API_KEY || ""}'`,
      `export TAVILY_API_KEY='${process.env.TAVILY_API_KEY || ""}'`,
      `export CONGRESS_API_KEY='${process.env.CONGRESS_API_KEY || ""}'`,
      `export APIFY_API_KEY='${process.env.APIFY_API_KEY || ""}'`,
    ].join("\n");

    await sandbox.files.write("/home/user/run.sh", `#!/bin/bash
cd /home/user
npm install --silent @anthropic-ai/sdk ws tsx 2>/dev/null
${envVars}
npx tsx agent-runner.ts
`);

    const result = await sandbox.commands.run("bash /home/user/run.sh", {
        timeoutMs: getAgentTimeoutMs(),
        onStdout: (data: string) => {
          if (data.trim()) console.log(`[sandbox-v2:${agentType}] ${data.trim()}`);
        },
        onStderr: (data: string) => {
          if (data.trim() && !data.includes("npm") && !data.includes("WARN")) {
            console.log(`[sandbox-v2:${agentType}:stderr] ${data.trim()}`);
          }
        },
      }
    );

    console.log(`[sandbox-v2] ${agentType} finished: exit=${result.exitCode}`);

    return {
      agentId,
      agentType,
      output: result.stdout || "",
      success: result.exitCode === 0,
      error: result.exitCode !== 0 ? `Exit code ${result.exitCode}` : undefined,
    };

  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[sandbox-v2] ${agentType} failed:`, error);

    bus.emit({
      type: "agent_event",
      data: { type: "status", agentId, agentType, status: "failed", message: error, timestamp: now() },
    });

    return { agentId, agentType, output: "", success: false, error };
  } finally {
    unregisterAgent(agentId);
    if (sandbox) {
      try { await sandbox.kill(); } catch { /* ignore */ }
    }
  }
}
