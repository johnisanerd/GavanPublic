/**
 * Agent runner script — runs inside E2B sandbox.
 *
 * Connects to Railway via WebSocket, runs an Anthropic agent loop,
 * and streams all events (tool calls, thinking, nominations, results) back.
 *
 * Usage: ANTHROPIC_API_KEY=... WS_URL=ws://host:port/ws/agent AGENT_CONFIG='{}' npx tsx agent-runner.ts
 */

import Anthropic from "@anthropic-ai/sdk";
import WebSocket from "ws";

// ── Config from env ──
const WS_URL = process.env.WS_URL!;
const AGENT_CONFIG = JSON.parse(process.env.AGENT_CONFIG || "{}");
const MODEL = process.env.AGENT_MODEL || "claude-sonnet-4-6";
const MAX_ITERATIONS = parseInt(process.env.MAX_ITERATIONS || "15", 10);

const anthropic = new Anthropic();

// ── WebSocket connection to Railway ──
const ws = new WebSocket(WS_URL);

function send(type: string, data: Record<string, unknown>) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, agentId: AGENT_CONFIG.id, agentType: AGENT_CONFIG.agentType, ...data }));
  }
}

// ── Tool definitions ──
const tools: Anthropic.Messages.Tool[] = [
  {
    name: "web_search",
    description: "Search the web. Returns titles, URLs, and content snippets.",
    input_schema: {
      type: "object" as const,
      required: ["query"],
      properties: {
        query: { type: "string", description: "Search query" },
        max_results: { type: "number", description: "Max results 1-10. Default: 5" },
      },
    },
  },
  {
    name: "fetch_url",
    description: "Fetch a URL and return its text content.",
    input_schema: {
      type: "object" as const,
      required: ["url"],
      properties: {
        url: { type: "string", description: "URL to fetch" },
      },
    },
  },
  {
    name: "run_shell",
    description: "Execute a shell command. Use for Python scripts, data processing, API calls.",
    input_schema: {
      type: "object" as const,
      required: ["command"],
      properties: {
        command: { type: "string", description: "Shell command to execute" },
      },
    },
  },
  {
    name: "nominate_candidate",
    description: "Nominate a cross-party ally you've found. Call this IMMEDIATELY when you find evidence of alignment — don't wait until the end.",
    input_schema: {
      type: "object" as const,
      required: ["name", "party", "state", "chamber", "score", "evidence"],
      properties: {
        name: { type: "string", description: "Full name" },
        party: { type: "string", enum: ["R", "D", "I"] },
        state: { type: "string", description: "Two-letter state code" },
        chamber: { type: "string", enum: ["senate", "house"] },
        score: { type: "number", description: "0-100 alignment score" },
        evidence: { type: "string", description: "One sentence of why they're a match" },
      },
    },
  },
];

// ── Tool execution ──
async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "web_search": {
      const apiKey = process.env.TAVILY_API_KEY;
      if (!apiKey) return "ERROR: TAVILY_API_KEY not set";
      const resp = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          query: input.query,
          max_results: input.max_results || 5,
          include_answer: true,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) return `Search failed: ${resp.status}`;
      const data = await resp.json() as { answer?: string; results?: Array<{ title: string; url: string; content?: string }> };
      let output = data.answer ? `Answer: ${data.answer}\n\n` : "";
      for (const r of data.results || []) {
        output += `Title: ${r.title}\nURL: ${r.url}\nSnippet: ${r.content?.slice(0, 500) || "(none)"}\n\n`;
      }
      return output || "No results.";
    }

    case "fetch_url": {
      const resp = await fetch(input.url as string, {
        headers: { "User-Agent": "Mozilla/5.0 AisleCrosser Research Bot" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) return `Fetch failed: ${resp.status}`;
      const html = await resp.text();
      // Strip HTML tags for plain text
      return html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 10_000);
    }

    case "run_shell": {
      const { exec } = await import("child_process");
      const { promisify } = await import("util");
      const execAsync = promisify(exec);
      try {
        const { stdout, stderr } = await execAsync(input.command as string, {
          timeout: 30_000,
          maxBuffer: 2 * 1024 * 1024,
        });
        return (stdout + (stderr ? `\n[stderr] ${stderr}` : "")).slice(0, 15_000) || "(no output)";
      } catch (err) {
        const e = err as { message?: string; stdout?: string; stderr?: string };
        return `Error: ${e.message}\n${e.stdout || ""}\n${e.stderr || ""}`.slice(0, 5000);
      }
    }

    case "nominate_candidate": {
      send("nomination", { candidate: input });
      return `Nominated ${input.name} (${input.party}-${input.state}) with score ${input.score}.`;
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

// ── Agent loop ──
async function runAgent() {
  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: AGENT_CONFIG.prompt },
  ];

  send("status", { status: "running", message: `${AGENT_CONFIG.displayName} starting...` });

  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: AGENT_CONFIG.systemPrompt || `You are a ${AGENT_CONFIG.displayName} for the Aisle Crosser bipartisan strategy platform.\n\n${AGENT_CONFIG.description}\n\nUse nominate_candidate tool IMMEDIATELY when you find a potential cross-party ally. Don't wait until the end.`,
      tools,
      messages,
    });

    // Process response content
    const assistantContent = response.content;
    messages.push({ role: "assistant", content: assistantContent });

    // Extract text and tool uses
    const textBlocks = assistantContent.filter((b) => b.type === "text");
    const toolUseBlocks = assistantContent.filter((b) => b.type === "tool_use");

    // Stream thinking
    for (const block of textBlocks) {
      if (block.type === "text" && block.text) {
        send("thinking", { thought: block.text.slice(0, 500) });
      }
    }

    // No tool calls = done
    if (toolUseBlocks.length === 0 || response.stop_reason === "end_turn") {
      const finalText = textBlocks.map((b) => b.type === "text" ? b.text : "").join("\n");
      send("result", { output: finalText });
      break;
    }

    // Execute tools
    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      if (block.type !== "tool_use") continue;

      send("tool_call", {
        toolName: block.name,
        toolInput: block.input,
        status: "started",
      });

      const output = await executeTool(block.name, block.input as Record<string, unknown>);

      send("tool_call", {
        toolName: block.name,
        toolInput: block.input,
        toolOutput: output.slice(0, 200),
        status: "completed",
      });

      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: output,
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  send("complete", { iterations });
}

// ── Main ──
ws.on("open", () => {
  console.log(`[agent-runner] Connected to ${WS_URL}`);
  runAgent()
    .catch((err) => {
      send("error", { error: err.message || String(err) });
      console.error("[agent-runner] Fatal:", err);
    })
    .finally(() => {
      setTimeout(() => {
        ws.close();
        process.exit(0);
      }, 1000);
    });
});

ws.on("error", (err) => {
  console.error("[agent-runner] WS error:", err.message);
  process.exit(1);
});
