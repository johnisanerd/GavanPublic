import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

// In-flight cache to avoid duplicate calls
const summaryCache = new Map<string, string>();

/**
 * Generate a brief human-readable summary of a tool call using Haiku.
 * Returns a 5–15 word description like "Searching Congress.gov for FCPA voting records"
 */
export async function summarizeToolCall(
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<string> {
  // Fast path: simple templates for common tools
  const quick = quickSummary(toolName, toolInput);
  if (quick) return quick;

  // Cache key
  const key = `${toolName}:${JSON.stringify(toolInput).slice(0, 200)}`;
  if (summaryCache.has(key)) return summaryCache.get(key)!;

  try {
    const inputStr = JSON.stringify(toolInput).slice(0, 300);
    const response = await client.messages.create({
      model: (await import("@/lib/config")).getApiModel(),
      max_tokens: 40,
      messages: [
        {
          role: "user",
          content: `Summarize this tool call in 5-12 words. Be specific about what's being done. No quotes or punctuation.\n\nTool: ${toolName}\nInput: ${inputStr}`,
        },
      ],
    });

    const summary =
      response.content[0].type === "text"
        ? response.content[0].text.trim()
        : toolName;

    summaryCache.set(key, summary);
    return summary;
  } catch {
    // Fall back to quick summary or tool name
    return quick || toolName;
  }
}

/** Fast template-based summaries for common tools (no LLM needed) */
function quickSummary(
  toolName: string,
  input: Record<string, unknown>
): string | null {
  switch (toolName) {
    case "WebSearch":
      return input.query ? String(input.query).slice(0, 60) : null;
    case "Read":
      if (input.file_path) {
        const p = String(input.file_path);
        return `Reading ${p.split("/").pop()}`;
      }
      return null;
    case "Write":
      if (input.file_path) {
        const p = String(input.file_path);
        return `Writing ${p.split("/").pop()}`;
      }
      return null;
    case "WebFetch":
      if (input.url) {
        try {
          const u = new URL(String(input.url));
          return `Fetching ${u.hostname}`;
        } catch {
          return `Fetching URL`;
        }
      }
      return null;
    case "Glob":
      return input.pattern ? `Finding files: ${String(input.pattern).slice(0, 40)}` : null;
    case "Grep":
      return input.pattern ? `Searching code: ${String(input.pattern).slice(0, 40)}` : null;
    case "TodoWrite":
      return "Updating task list";
    default:
      return null;
  }
}
