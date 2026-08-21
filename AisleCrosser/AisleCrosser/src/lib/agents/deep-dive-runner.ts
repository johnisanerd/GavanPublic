import type { DeepDive, DeepDiveResult, DeepDiveStreamEvent } from "../types/deep-dive";
import { getEventBus } from "./event-bus";
import {
  runToolLoop,
  createWebSearchTool,
  createFetchUrlTool,
  createRunShellTool,
  createSubmitFindingsTool,
} from "./tool-loop";
import * as deepDiveStore from "../store/deep-dives";

// ─────────────────────────────────────────────────────
// Deep-dive: focused research at the intersection of
// a personal connection and a legislative initiative
// ─────────────────────────────────────────────────────

const DEEP_DIVE_SYSTEM_PROMPT = `You are researching the intersection of a personal connection and a legislative initiative.
Find real reports, articles, events, organizations, and speeches that connect these two topics.

Be specific — cite real documents with URLs and dates. Look for:
- Government reports and policy papers
- News articles about the intersection of these topics
- Events, conferences, or summits where both topics overlap
- Organizations working at this intersection
- Congressional speeches or testimony connecting the topics
- Academic research or think tank reports
- Local initiatives or success stories

Use web_search to find sources, fetch_url to read them, and run_shell for any data processing.
When you've gathered enough findings, call submit_findings with your results.

IMPORTANT: Every finding must have a real source. Do NOT fabricate URLs or citations.`;

export async function runDeepDive(deepDiveId: string): Promise<void> {
  const dive = await deepDiveStore.getDeepDive(deepDiveId);
  if (!dive) throw new Error(`DeepDive ${deepDiveId} not found`);

  const bus = getEventBus(deepDiveId);

  // Update status to searching
  await deepDiveStore.updateDeepDive(deepDiveId, { status: "searching" });
  bus.emit({ type: "status", data: { deepDiveId, status: "searching" } } as DeepDiveStreamEvent);

  const userMessage = `Research the intersection of this personal connection and legislative initiative:

PERSONAL CONNECTION:
- Type: ${dive.connectionType}
- Detail: ${dive.connectionDetail}
- Legislator: ${dive.targetLegislatorName}

LEGISLATIVE INITIATIVE:
- Title: ${dive.initiativeTitle}

Find real reports, articles, events, organizations, and speeches that connect "${dive.connectionType}" with "${dive.initiativeTitle}". Be thorough but focused.`;

  console.log(`[deep-dive] Starting: "${dive.connectionType}" × "${dive.initiativeTitle}"`);

  try {
    const result = await runToolLoop({
      model: (await import("@/lib/config")).getApiModel(),
      systemPrompt: DEEP_DIVE_SYSTEM_PROMPT,
      userMessage,
      tools: [
        createWebSearchTool(),
        createFetchUrlTool(),
        createRunShellTool(),
        createSubmitFindingsTool(),
      ],
      maxIterations: 8,
      maxTokens: 4096,
      forceToolOnLast: "submit_findings",
      onToolCall: (toolName, input, output) => {
        bus.emit({
          type: "tool_call",
          data: {
            toolName,
            input,
            // Include parsed output so the UI can show rich activity
            output: toolName === "web_search" ? parseSearchResults(output) : undefined,
            timestamp: new Date().toISOString(),
          },
        } as DeepDiveStreamEvent);
      },
    });

    // Extract findings from the submit_findings tool call
    const findingsCall = result.toolCalls.find((tc) => tc.name === "submit_findings");
    let results: DeepDiveResult[] = [];

    if (findingsCall) {
      const input = findingsCall.input as { findings?: Array<Record<string, unknown>> };
      results = (input.findings || []).map((f) => ({
        title: (f.title as string) || "",
        summary: (f.summary as string) || "",
        url: (f.url as string) || undefined,
        date: (f.date as string) || undefined,
        relevance: (f.relevance as string) || "",
        type: (f.type as DeepDiveResult["type"]) || "other",
      }));
    }

    await deepDiveStore.updateDeepDive(deepDiveId, {
      status: "completed",
      results,
      toolCalls: result.toolCalls.map((tc) => ({
        toolName: tc.name,
        input: tc.input,
        timestamp: new Date().toISOString(),
      })),
      completedAt: new Date().toISOString(),
    });

    bus.emit({ type: "results", data: { deepDiveId, results } } as DeepDiveStreamEvent);
    bus.emit({ type: "complete", data: { deepDiveId } } as DeepDiveStreamEvent);

    console.log(`[deep-dive] Completed: ${results.length} findings in ${result.iterations} iterations`);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[deep-dive] Failed:`, error);

    await deepDiveStore.updateDeepDive(deepDiveId, {
      status: "failed",
      error,
      completedAt: new Date().toISOString(),
    });

    bus.emit({ type: "error", data: { deepDiveId, error } } as DeepDiveStreamEvent);
  }
}

// ─────────────────────────────────────────────────────
// Parse raw Tavily output into structured search results
// for rich UI display without agent involvement
// ─────────────────────────────────────────────────────

interface ParsedSearchResult {
  title: string;
  url: string;
  snippet?: string;
}

function parseSearchResults(rawOutput: string): ParsedSearchResult[] {
  const results: ParsedSearchResult[] = [];
  const blocks = rawOutput.split("\n\n").filter(Boolean);
  for (const block of blocks) {
    const titleMatch = block.match(/^Title:\s*(.+)/m);
    const urlMatch = block.match(/^URL:\s*(.+)/m);
    const snippetMatch = block.match(/^Snippet:\s*(.+)/m);
    if (titleMatch && urlMatch) {
      results.push({
        title: titleMatch[1].trim(),
        url: urlMatch[1].trim(),
        snippet: snippetMatch?.[1]?.trim().slice(0, 150),
      });
    }
  }
  return results;
}
