import type { Candidate, PersonalConnection } from "../types/agent";
import type { Legislator } from "../types";
import {
  runToolLoop,
  createWebSearchTool,
  createFetchUrlTool,
  createRunShellTool,
  createReportConnectionTool,
  createApifySearchTool,
  createApifyCrawlerTool,
  createInstagramTool,
  createTwitterTool,
  createFacebookTool,
} from "./tool-loop";

// ─────────────────────────────────────────────────────
// Connection search using server-side tool loop
// Replaces the old hallucination-prone bare Sonnet call
// ─────────────────────────────────────────────────────

const CONNECTION_SYSTEM_PROMPT = `You are researching personal connections between two US legislators.
Find REAL, VERIFIABLE connections. Search broadly — examples include:
- Shared alma maters, degrees, academic honors
- Sports they play or follow (golf, basketball, running, etc.)
- Pets and animals they own or advocate for
- Military service branches and experiences
- Hobbies (cooking, music, woodworking, gardening, fishing, etc.)
- Family parallels (similar-age children, grandchildren, shared home states)
- Food and cuisine interests, restaurant ownership
- Faith communities, church/temple/mosque involvement
- Shared life experiences (cancer survivors, immigrant parents, single parents, etc.)
- Professional backgrounds before Congress (law, medicine, business, farming, teaching)
- Travel and vacation interests
- Book clubs, reading habits, authorship
- Charitable causes and nonprofit work
- Shared caucus memberships beyond policy (e.g., Congressional Wine Caucus, Bike Caucus)

Don't restrict yourself to these categories — be creative!

IMPORTANT RULES:
1. For EVERY connection, provide a source URL or specific citation. Do NOT hallucinate.
2. Call report_connection IMMEDIATELY as you find each one — don't wait.
3. Search multiple sources: Wikipedia, official websites, news articles, social media profiles, biographical databases.
4. Use web_search for quick lookups. Use google_search for deeper structured results. Use crawl_website on senator official sites. Use fetch_url to read specific pages.
5. If you find something interesting but can't verify it, skip it.
6. Search for at least 3-5 different angles before stopping.
8. TOOL STRATEGY — check social media FIRST, then web:
   a. Call instagram_posts for both legislators (pass full name — handle is auto-resolved)
   b. Call facebook_posts for both legislators
   c. Call twitter_posts if you need more
   d. Use google_search for biographical details (education, family, career)
   Social media reveals personal interests that web articles miss.
7. You can use run_shell for data processing if needed (e.g., python3 for parsing).`;

/** Pre-fetched social media data for a legislator (scraped once, reused across searches) */
export interface SocialMediaContext {
  instagram?: string;
  twitter?: string;
  facebook?: string;
}

export interface ConnectionSearchOptions {
  candidate: Candidate;
  legislator: Legislator;
  /** Pre-fetched social media for the requesting legislator */
  legislatorSocial?: SocialMediaContext;
  /** Called each time a new connection is discovered */
  onConnection?: (connection: PersonalConnection) => void;
  /** Called for each tool call (for SSE streaming of activity) */
  onToolCall?: (toolName: string, input: Record<string, unknown>, output: string) => void;
}

/** Pre-fetch social media for a legislator. Call once, pass result to all connection searches. */
export async function prefetchSocialMedia(name: string): Promise<SocialMediaContext> {
  if (!process.env.APIFY_API_KEY) return {};

  const { createInstagramTool, createTwitterTool, createFacebookTool } = await import("./tool-loop");
  const igTool = createInstagramTool();
  const twTool = createTwitterTool();
  const fbTool = createFacebookTool();

  console.log(`[social-prefetch] Fetching social media for ${name}...`);

  const [instagram, twitter, facebook] = await Promise.allSettled([
    igTool.execute({ name }),
    twTool.execute({ name }),
    fbTool.execute({ name }),
  ]);

  const result: SocialMediaContext = {};
  if (instagram.status === "fulfilled" && !instagram.value.startsWith("ERROR") && !instagram.value.includes("Could not find")) {
    result.instagram = instagram.value.slice(0, 3000);
  }
  if (twitter.status === "fulfilled" && !twitter.value.startsWith("ERROR") && !twitter.value.includes("Could not find")) {
    result.twitter = twitter.value.slice(0, 3000);
  }
  if (facebook.status === "fulfilled" && !facebook.value.startsWith("ERROR") && !facebook.value.includes("Could not find")) {
    result.facebook = facebook.value.slice(0, 3000);
  }

  const found = Object.keys(result).length;
  console.log(`[social-prefetch] ${name}: ${found} platforms found (${Object.keys(result).join(", ") || "none"})`);
  return result;
}

export async function runConnectionSearch(
  options: ConnectionSearchOptions
): Promise<PersonalConnection[]> {
  const { candidate, legislator, legislatorSocial, onConnection, onToolCall } = options;
  const connections: PersonalConnection[] = [];

  const reportConnectionTool = createReportConnectionTool();

  // Wrap the report_connection tool to intercept calls
  const interceptedReportTool = {
    ...reportConnectionTool,
    execute: async (input: Record<string, unknown>) => {
      const connection: PersonalConnection = {
        type: (input.type as string) || "other",
        iconSuggestion: (input.icon_suggestion as string) || undefined,
        detail: (input.detail as string) || "",
        sharedWith: (input.shared_with as string) || "",
        source: (input.source as string) || "",
        confidence: (input.confidence as number) || 0.5,
      };

      connections.push(connection);
      onConnection?.(connection);

      return reportConnectionTool.execute(input);
    },
  };

  // Build social media context section
  let socialContext = "";
  if (legislatorSocial) {
    const parts: string[] = [];
    if (legislatorSocial.instagram) parts.push(`INSTAGRAM POSTS:\n${legislatorSocial.instagram}`);
    if (legislatorSocial.facebook) parts.push(`FACEBOOK POSTS:\n${legislatorSocial.facebook}`);
    if (legislatorSocial.twitter) parts.push(`TWITTER/X POSTS:\n${legislatorSocial.twitter}`);
    if (parts.length > 0) {
      socialContext = `\n\n${legislator.name}'s SOCIAL MEDIA (already scraped — do NOT re-scrape):\n${parts.join("\n\n")}`;
    }
  }

  const userMessage = `Find personal connections between these two legislators:

REQUESTING LEGISLATOR:
- ${legislator.name} (${legislator.party}-${legislator.state}, ${legislator.chamber})${socialContext}

POTENTIAL ALLY:
- ${candidate.name} (${candidate.party}-${candidate.state}, ${candidate.chamber})

Evidence from research so far:
${candidate.evidence.map((e) => `- [${e.agentType}] ${e.summary}`).join("\n")}

${legislatorSocial ? `You already have ${legislator.name}'s social media above. Now scrape ${candidate.name}'s social media (instagram_posts, facebook_posts) and find shared interests. Then use google_search for biographical details.` : `Start by checking their Instagram posts (pass full name). Then use google_search for biographical details.`} Report each connection as you find it.`;

  console.log(`[connection-search] Starting search: ${legislator.name} <-> ${candidate.name}`);

  try {
    const result = await runToolLoop({
      model: (await import("@/lib/config")).getApiModel(),
      systemPrompt: CONNECTION_SYSTEM_PROMPT,
      userMessage,
      tools: [
        ...(process.env.APIFY_API_KEY
          ? [createInstagramTool(), createTwitterTool(), createFacebookTool(), createApifySearchTool(), createApifyCrawlerTool()]
          : [createWebSearchTool(), createFetchUrlTool()]),
        createRunShellTool(),
        interceptedReportTool,
      ],
      maxIterations: (await import("@/lib/config")).getConnectionIterations(),
      maxTokens: 4096,
      onToolCall,
    });

    console.log(
      `[connection-search] ${candidate.name}: found ${connections.length} connections in ${result.iterations} iterations (${result.toolCalls.length} tool calls)`
    );
  } catch (err) {
    console.error(`[connection-search] Error for ${candidate.name}:`, err);
  }

  return connections;
}
