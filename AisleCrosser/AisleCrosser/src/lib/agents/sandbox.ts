import { Sandbox } from "e2b";
import type { AgentType, AgentEvent, Candidate } from "../types/agent";
import { getEventBus } from "./event-bus";
import { generateId } from "../utils/ids";
import { summarizeToolCall } from "./tool-summarizer";
import { jsonrepair } from "jsonrepair";

// ─────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────

export interface AgentConfig {
  id: string;
  researchId: string;
  agentType: AgentType;
  prompt: string;
  displayName: string;
  description: string;
  model?: string;
  /** Filter inline nominations to this chamber */
  chamberFilter?: string;
  /** Called periodically with accumulated stdout so callers can extract partial results */
  onPartialOutput?: (output: string) => void;
}

export interface SandboxResult {
  agentId: string;
  agentType: AgentType;
  output: string;
  success: boolean;
  error?: string;
}

// ─────────────────────────────────────────────────────
// Claude Code NDJSON stream message types
// ─────────────────────────────────────────────────────

interface ClaudeStreamMessage {
  type: "assistant" | "user" | "system" | "result";
  subtype?: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
    model?: string;
  };
  // result fields
  result?: string;
  cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  is_error?: boolean;
  total_cost_usd?: number;
  session_id?: string;
}

interface ContentBlock {
  type: "text" | "tool_use" | "tool_result";
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string | ContentBlock[];
  tool_use_id?: string;
}

// ─────────────────────────────────────────────────────
// Event emission helper
// ─────────────────────────────────────────────────────

function emitAgentEvent(researchId: string, event: AgentEvent): void {
  const bus = getEventBus(researchId);
  bus.emit({ type: "agent_event", data: event });
}

// ─────────────────────────────────────────────────────
// NDJSON parser — extracts meaningful events from
// Claude Code's stream-json output
// ─────────────────────────────────────────────────────

// Per-agent dedup: Claude Code stream-json emits incremental
// assistant turns (partial updates + final), each repeating all
// content blocks seen so far. Deduplicate at two levels:
// 1. Line-level: skip exact byte-identical NDJSON lines
// 2. Block-level: key tool_use by id or name:input prefix
interface AgentDedupState {
  seenLines: Set<string>;
  seenBlocks: Set<string>;
}
const agentDedupMap = new Map<string, AgentDedupState>();
const agentChamberFilter = new Map<string, string>();

function getAgentDedup(agentId: string): AgentDedupState {
  if (!agentDedupMap.has(agentId)) {
    agentDedupMap.set(agentId, { seenLines: new Set(), seenBlocks: new Set() });
  }
  return agentDedupMap.get(agentId)!;
}

/**
 * Scan text for inline nomination JSON objects.
 * Agents are instructed to output: {"action":"nominate_candidate","name":"...","party":"R","state":"XX","chamber":"senate","score":75,"evidence":"..."}
 * We parse these and emit them as candidate events on the bus.
 */
function extractInlineNominations(
  text: string,
  agentId: string,
  agentType: AgentType,
  researchId: string,
  dedup: AgentDedupState,
  chamberFilter?: string
): void {
  // Strip markdown code fences — agents sometimes wrap JSON in ```json ... ```
  const cleaned = text.replace(/```(?:json)?\s*/g, "").replace(/```/g, "");

  // Match JSON-like objects containing nominate_candidate (generous match)
  const pattern = /\{[^{}]*nominate_candidate[^{}]*\}/g;
  let match;
  while ((match = pattern.exec(cleaned)) !== null) {
    try {
      // Use jsonrepair to handle truncated/malformed JSON from streaming
      const repaired = jsonrepair(match[0]);
      const nom = JSON.parse(repaired);
      if (!nom.name || !nom.party) continue;

      // Filter by chamber if specified
      if (chamberFilter && nom.chamber && nom.chamber !== chamberFilter) continue;

      // Dedup by candidate name
      const nomKey = `nom:${nom.name.toLowerCase()}`;
      if (dedup.seenBlocks.has(nomKey)) continue;
      dedup.seenBlocks.add(nomKey);

      const candidate: Candidate = {
        id: generateId("cand"),
        name: nom.name,
        party: nom.party || "R",
        state: nom.state || "??",
        chamber: nom.chamber || "senate",
        score: nom.score || 50,
        nominatedBy: [agentType],
        evidence: [{
          agentType,
          category: agentType.replace("_analyzer", ""),
          summary: nom.evidence || "",
          confidence: (nom.score || 50) / 100,
        }],
        connections: [],
        status: "nominated",
        nominatedAt: new Date().toISOString(),
      };

      console.log(`[sandbox] Inline nomination from ${agentType}: ${candidate.name} (${candidate.party}-${candidate.state})`);

      const bus = getEventBus(researchId);
      bus.emit({ type: "candidate", data: candidate });
    } catch {
      // jsonrepair couldn't fix it or not valid nomination, skip
    }
  }
}

function parseClaudeStreamLine(
  line: string,
  agentId: string,
  agentType: AgentType,
  researchId: string
): void {
  const trimmed = line.trim();
  if (!trimmed) return;

  const now = new Date().toISOString();
  const dedup = getAgentDedup(agentId);

  // Level 1: Line-level dedup — skip exact byte-identical NDJSON lines
  if (dedup.seenLines.has(trimmed)) return;
  dedup.seenLines.add(trimmed);

  let msg: ClaudeStreamMessage;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    // Non-JSON line — emit as raw thinking
    emitAgentEvent(researchId, {
      type: "thinking",
      agentId,
      agentType,
      thought: trimmed.slice(0, 500),
      timestamp: now,
    });
    return;
  }

  // Handle different Claude Code message types
  if (msg.type === "assistant" && msg.message?.content) {
    const content = msg.message.content;

    if (typeof content === "string") {
      // Skip if this text starts with something we've already seen
      const textPrefix = content.slice(0, 200);
      const isDupText = Array.from(dedup.seenBlocks).some(
        (k) => k.startsWith("text:") && (textPrefix.startsWith(k.slice(5)) || k.slice(5).startsWith(textPrefix))
      );
      if (isDupText) return;
      dedup.seenBlocks.add(`text:${textPrefix}`);
      emitAgentEvent(researchId, {
        type: "thinking",
        agentId,
        agentType,
        thought: content.slice(0, 500),
        timestamp: now,
      });
      return;
    }

    // Level 2: Block-level dedup for content arrays
    for (const block of content) {
      if (block.type === "text" && block.text) {
        // Skip if this text starts with something we've already seen (incremental updates)
        const textPrefix = block.text.slice(0, 200);
        const isDupText = Array.from(dedup.seenBlocks).some(
          (k) => k.startsWith("text:") && (textPrefix.startsWith(k.slice(5)) || k.slice(5).startsWith(textPrefix))
        );
        if (isDupText) continue;
        dedup.seenBlocks.add(`text:${textPrefix}`);

        // Detect inline candidate nominations from agent text
        extractInlineNominations(block.text, agentId, agentType, researchId, dedup, agentChamberFilter.get(agentId));

        // Strip nomination JSON from thought text so it doesn't show in the UI
        const cleanedText = block.text
          .replace(/```(?:json)?\s*/g, "")
          .replace(/```/g, "")
          .replace(/\{[^{}]*nominate_candidate[^{}]*\}/g, "")
          .trim();
        if (!cleanedText) continue;

        emitAgentEvent(researchId, {
          type: "thinking",
          agentId,
          agentType,
          thought: cleanedText.slice(0, 500),
          timestamp: now,
        });
      } else if (block.type === "tool_use" && block.name) {
        // Require tool_use_id for dedup — skip partial blocks without one
        // For blocks without id, use name + stringified input as fallback
        // but only if the input looks complete (has content beyond {})
        const inputStr = JSON.stringify(block.input || {});
        // Use full input string for dedup — prefix truncation causes false negatives
        const toolKey = block.tool_use_id || `${block.name}:${inputStr}`;
        if (inputStr.length <= 2 && !block.tool_use_id) continue; // skip empty input partials
        if (dedup.seenBlocks.has(toolKey)) continue;
        dedup.seenBlocks.add(toolKey);

        const toolInput = block.input || {};
        summarizeToolCall(block.name, toolInput as Record<string, unknown>).then((summary) => {
          // Final dedup: skip if we already emitted this exact summary
          const summaryKey = `summary:${block.name}:${(summary || "").slice(0, 80)}`;
          if (dedup.seenBlocks.has(summaryKey)) return;
          dedup.seenBlocks.add(summaryKey);
          emitAgentEvent(researchId, {
            type: "tool_call",
            agentId,
            agentType,
            toolName: block.name!,
            toolInput,
            summary,
            status: "started",
            timestamp: now,
          });
        }).catch(() => {
          emitAgentEvent(researchId, {
            type: "tool_call",
            agentId,
            agentType,
            toolName: block.name!,
            toolInput,
            status: "started",
            timestamp: now,
          });
        });
      } else if (block.type === "tool_result") {
        const resultKey = `result:${block.tool_use_id || block.content?.toString().slice(0, 100)}`;
        if (dedup.seenBlocks.has(resultKey)) continue;
        dedup.seenBlocks.add(resultKey);

        const resultText =
          typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? block.content
                  .map((b) => b.text || "")
                  .join("")
              : "";

        emitAgentEvent(researchId, {
          type: "tool_call",
          agentId,
          agentType,
          toolName: "tool_result",
          toolInput: {},
          toolOutput: resultText.slice(0, 500),
          status: "completed",
          timestamp: now,
        });
      }
    }
  } else if (msg.type === "result") {
    // Final result from Claude Code
    if (msg.result) {
      emitAgentEvent(researchId, {
        type: "finding",
        agentId,
        agentType,
        finding: msg.result.slice(0, 1000),
        confidence: msg.is_error ? 0.1 : 0.85,
        timestamp: now,
      });
    }
  } else if (msg.type === "system") {
    emitAgentEvent(researchId, {
      type: "status",
      agentId,
      agentType,
      status: "running",
      message: msg.subtype || "system",
      timestamp: now,
    });
  }
}

// ─────────────────────────────────────────────────────
// Main sandbox runner — launches Claude Code CLI
// inside an E2B sandbox with stream-json output
// ─────────────────────────────────────────────────────

export async function runAgentInSandbox(config: AgentConfig): Promise<SandboxResult> {
  const { id: agentId, researchId, agentType } = config;
  const now = () => new Date().toISOString();
  const { getSandboxModel, getAgentTimeoutMs, getMaxBudget } = await import("@/lib/config");
  const model = config.model || getSandboxModel();

  if (config.chamberFilter) agentChamberFilter.set(agentId, config.chamberFilter);

  emitAgentEvent(researchId, {
    type: "status",
    agentId,
    agentType,
    status: "starting_sandbox",
    message: `Launching E2B sandbox for ${config.displayName}...`,
    timestamp: now(),
  });

  let sandbox: Sandbox | null = null;
  let fullOutput = "";
  let resultText = "";

  try {
    // Create sandbox using custom template with Claude Code pre-installed
    console.log(`[sandbox] Creating E2B sandbox for ${agentType} (key: ${process.env.E2B_API_KEY?.slice(0, 10)}...)`);
    const createStart = Date.now();

    // Race with a 60s timeout so we get an error instead of a silent hang
    const createPromise = Sandbox.create("aisle-crosser-agent", {
      apiKey: process.env.E2B_API_KEY,
      timeoutMs: 300_000,
      metadata: {
        aisle_crosser: "true",
        agent_type: agentType,
        research_id: researchId,
      },
    });
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("E2B sandbox creation timed out after 60s")), 60_000)
    );
    sandbox = await Promise.race([createPromise, timeoutPromise]);
    console.log(`[sandbox] Sandbox created for ${agentType} in ${Date.now() - createStart}ms (id: ${sandbox.sandboxId})`);

    emitAgentEvent(researchId, {
      type: "status",
      agentId,
      agentType,
      status: "running",
      message: `${config.displayName} sandbox ready, launching Claude Code...`,
      timestamp: now(),
    });

    // Write the prompt file into the sandbox
    await sandbox.files.write("/home/user/research-prompt.md", config.prompt);

    // Also write a CLAUDE.md with research-specific instructions
    const claudeMd = `# Aisle Crosser Research Agent

You are a ${config.displayName} for the Aisle Crosser bipartisan strategy platform.

## Your Role
${config.description}

## Instructions
- Be AGGRESSIVELY creative in your research. Use web search, fetch URLs, read documents.
- Search for non-obvious connections and unlikely allies.
- Look at voting records, speeches, press releases, news articles, Wikipedia, think tank reports.
- Think like a sophisticated senior staffer who understands congressional politics deeply.
- Find data from wild and unexpected sources — local newspapers, university studies, industry reports.
- Always cite your sources with URLs when possible.
- Output your final analysis as structured JSON.

## CRITICAL: Stream Nominations DURING Research
Your workflow MUST be: research → find someone → IMMEDIATELY nominate → keep researching → find another → IMMEDIATELY nominate → etc.

DO NOT batch nominations. DO NOT save them for the end. After EACH web search or data lookup that reveals a potential ally, output this JSON on its own line BEFORE doing your next search:

{"action":"nominate_candidate","name":"Full Name","party":"R","state":"XX","chamber":"senate","score":75,"evidence":"One sentence of why"}

Example workflow:
1. Search for voting records on tech regulation
2. Find that Sen. John Thune voted for a tech bill → IMMEDIATELY output nomination JSON
3. Search for more allies
4. Find Rep. Cathy McMorris Rodgers on a committee → IMMEDIATELY output nomination JSON
5. Continue researching...

You MUST nominate at least your first candidate within your first 2-3 tool calls. Do not wait.

## Available API Keys
All API keys are available as environment variables. Use $CONGRESS_API_KEY with api.congress.gov.

## Output Format
Your final output MUST be valid JSON with this structure:
\`\`\`json
{
  "allies": [
    {
      "name": "Full Name",
      "party": "R or D",
      "state": "XX",
      "chamber": "senate or house",
      "alignmentScore": 85,
      "summary": "Why they're a match",
      "evidence": [{"type": "vote|speech|bill|article", "title": "...", "detail": "...", "url": "..."}],
      "approachStrategy": "How to approach them",
      "talkingPoints": ["point 1", "point 2"],
      "sharedInterests": ["interest 1", "interest 2"],
      "reasoningChain": [
        {"category": "voting|speech|constituency|personal", "title": "...", "evidence": "...", "confidence": 0.85}
      ]
    }
  ],
  "summary": "Overall analysis"
}
\`\`\`
`;
    await sandbox.files.write("/home/user/CLAUDE.md", claudeMd);

    // Claude Code is pre-installed in the aisle-crosser-agent template — no update needed

    // Run Claude Code CLI with stream-json output
    let lineBuffer = "";
    let lastPartialLength = 0;

    // Periodic partial output callback — lets orchestrator extract candidates mid-run
    const partialInterval = config.onPartialOutput ? setInterval(() => {
      if (fullOutput.length > lastPartialLength + 500) {
        lastPartialLength = fullOutput.length;
        config.onPartialOutput!(fullOutput);
      }
    }, 20_000) : null;

    console.log(`[sandbox] Running Claude Code CLI for ${agentType}...`);
    const cmdResult = await sandbox.commands.run(
      `claude -p --dangerously-skip-permissions --verbose --output-format stream-json --max-budget-usd ${getMaxBudget()} --model ${model} < /home/user/research-prompt.md`,
      {
        timeoutMs: getAgentTimeoutMs(),
        envs: {
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "",
          CONGRESS_API_KEY: process.env.CONGRESS_API_KEY || "",
          APIFY_API_KEY: process.env.APIFY_API_KEY || "",
          E2B_API_KEY: process.env.E2B_API_KEY || "",
        },
        onStdout: (data: string) => {
          fullOutput += data;
          lineBuffer += data;

          // Process complete lines (NDJSON = one JSON object per line)
          const lines = lineBuffer.split("\n");
          // Keep the last partial line in the buffer
          lineBuffer = lines.pop() || "";

          for (const line of lines) {
            if (line.trim()) {
              // Extract the final result text from NDJSON
              try {
                const msg = JSON.parse(line);
                if (msg.type === "result" && msg.result) {
                  resultText = msg.result;
                }
              } catch { /* not JSON */ }
              parseClaudeStreamLine(line, agentId, agentType, researchId);
            }
          }
        },
        onStderr: (data: string) => {
          // Stderr from Claude Code — usually progress info
          if (data.trim() && !data.includes("npm") && !data.includes("WARN")) {
            emitAgentEvent(researchId, {
              type: "thinking",
              agentId,
              agentType,
              thought: `[stderr] ${data.trim().slice(0, 200)}`,
              timestamp: now(),
            });
          }
        },
      }
    );

    if (partialInterval) clearInterval(partialInterval);
    console.log(`[sandbox] Claude Code finished for ${agentType}: exit=${cmdResult.exitCode} stdout=${fullOutput.length} chars resultText=${resultText.length} chars cmdStdout=${cmdResult.stdout?.length || 0}`);
    console.log(`[sandbox] ${agentType} cmdResult keys: ${Object.keys(cmdResult).join(", ")}`);
    if (cmdResult.stdout && cmdResult.stdout.length > 0 && fullOutput.length === 0) {
      // onStdout didn't capture — use cmdResult.stdout instead
      fullOutput = cmdResult.stdout;
      // Try to extract result from the full stdout
      const lines = fullOutput.split("\n");
      for (const line of lines) {
        if (line.trim()) {
          try {
            const msg = JSON.parse(line);
            if (msg.type === "result" && msg.result) {
              resultText = msg.result;
            }
          } catch { /* not JSON */ }
        }
      }
      console.log(`[sandbox] ${agentType} recovered from cmdResult.stdout: ${fullOutput.length} chars, resultText=${resultText.length} chars`);
    }
    if (cmdResult.exitCode !== 0) {
      console.log(`[sandbox] ${agentType} stderr: ${cmdResult.stderr?.slice(0, 500)}`);
    }

    // Process any remaining buffered data
    if (lineBuffer.trim()) {
      parseClaudeStreamLine(lineBuffer, agentId, agentType, researchId);
    }

    emitAgentEvent(researchId, {
      type: "status",
      agentId,
      agentType,
      status: "completed",
      message: `${config.displayName} completed analysis`,
      timestamp: now(),
    });

    // Use resultText (from NDJSON "result" message) as the primary output,
    // fall back to fullOutput (raw NDJSON) if no result message found
    const output = resultText || fullOutput;

    return {
      agentId,
      agentType,
      output,
      success: cmdResult.exitCode === 0 || resultText.length > 0,
      error: cmdResult.exitCode !== 0 && !resultText ? `Claude Code exited with code ${cmdResult.exitCode}` : undefined,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    // CommandExitError has stdout/stderr — extract the result even on non-zero exit
    const errAny = err as { stdout?: string; stderr?: string; exitCode?: number };
    let recoveredOutput = "";
    if (errAny.stdout) {
      console.log(`[sandbox] ${agentType} threw CommandExitError (exit=${errAny.exitCode}), recovering stdout (${errAny.stdout.length} chars)`);
      // Parse NDJSON to find the result message — but DON'T re-emit events
      // (onStdout already emitted them; re-emitting causes duplicates in the UI)
      const lines = errAny.stdout.split("\n");
      for (const line of lines) {
        if (line.trim()) {
          try {
            const msg = JSON.parse(line);
            if (msg.type === "result" && msg.result) {
              recoveredOutput = msg.result;
            }
          } catch { /* not JSON */ }
        }
      }
      if (!recoveredOutput) recoveredOutput = errAny.stdout;

      // Only emit events if onStdout never fired (fullOutput is empty)
      if (!fullOutput) {
        for (const line of lines) {
          if (line.trim()) {
            parseClaudeStreamLine(line, agentId, agentType, researchId);
          }
        }
      }
    }
    // Also include anything captured via onStdout
    if (!recoveredOutput && resultText) recoveredOutput = resultText;
    if (!recoveredOutput && fullOutput) recoveredOutput = fullOutput;

    if (recoveredOutput) {
      console.log(`[sandbox] ${agentType} recovered output: ${recoveredOutput.length} chars`);
      emitAgentEvent(researchId, {
        type: "status",
        agentId,
        agentType,
        status: "completed",
        message: `${config.displayName} completed (exit code ${errAny.exitCode || "?"})`,
        timestamp: now(),
      });

      return {
        agentId,
        agentType,
        output: recoveredOutput,
        success: true,
      };
    }

    emitAgentEvent(researchId, {
      type: "status",
      agentId,
      agentType,
      status: "failed",
      message: `${config.displayName} failed: ${errorMsg}`,
      timestamp: now(),
    });

    return {
      agentId,
      agentType,
      output: "",
      success: false,
      error: errorMsg,
    };
  } finally {
    if (sandbox) {
      try {
        await sandbox.kill();
      } catch {
        /* ignore cleanup errors */
      }
    }
  }
}

// ─────────────────────────────────────────────────────
// Agent config factory
// ─────────────────────────────────────────────────────

export function createAgentConfig(
  researchId: string,
  agentType: AgentType,
  prompt: string
): AgentConfig {
  const displayNames: Record<AgentType, string> = {
    speech_analyzer: "Speech Analyzer",
    voting_analyzer: "Voting Record Analyzer",
    constituency_analyzer: "Constituency Analyzer",
    interest_analyzer: "Interest & Committee Analyzer",
    connection_finder: "Connection Finder",
    synthesizer: "Strategic Synthesizer",
  };

  const descriptions: Record<AgentType, string> = {
    speech_analyzer:
      "Analyzing Congressional Record speeches, floor statements, and press releases for policy alignment",
    voting_analyzer:
      "Examining voting patterns, co-sponsorship history, and legislative priorities across party lines",
    constituency_analyzer:
      "Researching district demographics, economic interests, and constituent priorities to find shared concerns",
    interest_analyzer:
      "Mapping committee memberships, caucus affiliations, personal backgrounds, and shared interests",
    connection_finder:
      "Researching personal connections, hobbies, sports, pets, alma maters, and shared life experiences",
    synthesizer:
      "Combining all research findings into ranked strategic recommendations with approach strategies",
  };

  return {
    id: generateId("agent"),
    researchId,
    agentType,
    prompt,
    displayName: displayNames[agentType],
    description: descriptions[agentType],
  };
}
