import Anthropic from "@anthropic-ai/sdk";
import { exec } from "child_process";
import { promisify } from "util";

const anthropic = new Anthropic();
const execAsync = promisify(exec);

// ─────────────────────────────────────────────────────
// Tool definition interface — each tool has a schema
// and an execute function
// ─────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<string>;
}

export interface ToolLoopOptions {
  model?: string;
  systemPrompt: string;
  userMessage: string;
  tools: ToolDefinition[];
  maxIterations?: number;
  maxTokens?: number;
  /** Force this tool on the final iteration if not yet called */
  forceToolOnLast?: string;
  /** Called each time a tool is invoked — use for streaming/logging */
  onToolCall?: (toolName: string, input: Record<string, unknown>, output: string) => void;
}

export interface ToolLoopResult {
  finalText: string;
  toolCalls: Array<{ name: string; input: Record<string, unknown>; output: string }>;
  iterations: number;
}

// ─────────────────────────────────────────────────────
// Built-in tool factories
// ─────────────────────────────────────────────────────

/** Tavily web search — general + news */
export function createWebSearchTool(): ToolDefinition {
  return {
    name: "web_search",
    description:
      "Search the web using Tavily. Returns titles, URLs, and content snippets. Use specific, detailed queries for best results. Set topic='news' for recent news coverage.",
    input_schema: {
      type: "object" as const,
      required: ["query"],
      properties: {
        query: { type: "string", description: "Search query — be specific and detailed" },
        search_depth: {
          type: "string",
          enum: ["basic", "advanced"],
          description: "basic (fast) or advanced (thorough, more results). Default: basic",
        },
        topic: {
          type: "string",
          enum: ["general", "news"],
          description: "general web or news articles. Default: general",
        },
        max_results: { type: "number", description: "Max results 1-10. Default: 5" },
      },
    },
    execute: async (input) => {
      const apiKey = process.env.TAVILY_API_KEY;
      if (!apiKey) return "ERROR: TAVILY_API_KEY not set. Cannot search.";

      try {
        const resp = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: apiKey,
            query: input.query,
            search_depth: input.search_depth || "basic",
            topic: input.topic || "general",
            max_results: input.max_results || 5,
            include_answer: true,
          }),
          signal: AbortSignal.timeout(15_000),
        });

        if (!resp.ok) return `Search failed: ${resp.status} ${resp.statusText}`;

        const data = (await resp.json()) as {
          answer?: string;
          results?: Array<{ title: string; url: string; content?: string; score?: number }>;
        };

        let output = "";
        if (data.answer) output += `Answer: ${data.answer}\n\n`;
        for (const r of data.results || []) {
          output += `Title: ${r.title}\nURL: ${r.url}\nSnippet: ${r.content?.slice(0, 500) || "(no snippet)"}\n\n`;
        }
        return output || "No results found.";
      } catch (err) {
        return `Search error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/** HTTP GET with HTML-to-text conversion */
export function createFetchUrlTool(): ToolDefinition {
  return {
    name: "fetch_url",
    description:
      "Fetch a URL and return its text content. HTML is stripped to plain text. Use to read full articles, bios, Wikipedia pages, government sites, etc.",
    input_schema: {
      type: "object" as const,
      required: ["url"],
      properties: {
        url: { type: "string", description: "The URL to fetch" },
        max_chars: { type: "number", description: "Max chars to return (default 8000)" },
      },
    },
    execute: async (input) => {
      try {
        const resp = await fetch(input.url as string, {
          headers: {
            "User-Agent": "AisleCrosser/1.0 (congressional research tool)",
            Accept: "text/html,application/xhtml+xml,application/json,text/plain",
          },
          signal: AbortSignal.timeout(15_000),
        });

        if (!resp.ok) return `Fetch failed: ${resp.status} ${resp.statusText}`;

        const contentType = resp.headers.get("content-type") || "";
        const body = await resp.text();

        // Return JSON/plain text as-is
        if (contentType.includes("json") || contentType.includes("text/plain")) {
          const maxChars = (input.max_chars as number) || 8000;
          return body.slice(0, maxChars);
        }

        // Convert HTML to text
        const text = htmlToText(body);
        const maxChars = (input.max_chars as number) || 8000;
        return text.slice(0, maxChars) || "(empty page)";
      } catch (err) {
        return `Fetch error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/** Shell command execution — Python, bash, curl, jq, anything */
export function createRunShellTool(): ToolDefinition {
  return {
    name: "run_shell",
    description:
      "Execute a shell command. Use for: Python scripts (python3 -c '...'), data processing (jq, awk), API calls (curl), file operations, or any command-line tool. Commands run with a 30-second timeout.",
    input_schema: {
      type: "object" as const,
      required: ["command"],
      properties: {
        command: {
          type: "string",
          description: "Shell command to execute. For multi-line Python: python3 -c 'code here'",
        },
      },
    },
    execute: async (input) => {
      try {
        const { stdout, stderr } = await execAsync(input.command as string, {
          timeout: 30_000,
          maxBuffer: 2 * 1024 * 1024, // 2MB
          cwd: "/tmp",
          env: {
            ...process.env,
            // Don't leak sensitive keys to shell commands
            ANTHROPIC_API_KEY: "",
            TAVILY_API_KEY: "",
            E2B_API_KEY: "",
          },
        });

        let output = "";
        if (stdout) output += stdout;
        if (stderr) output += `\n[stderr] ${stderr}`;
        return output.slice(0, 15_000) || "(no output)";
      } catch (err) {
        const error = err as { stdout?: string; stderr?: string; message?: string };
        return `Command failed: ${error.message || "unknown error"}\n${error.stdout?.slice(0, 5000) || ""}\n${error.stderr?.slice(0, 2000) || ""}`.trim();
      }
    },
  };
}

/** Apify Google Search — structured results, deeper than Tavily */
export function createApifySearchTool(): ToolDefinition {
  return {
    name: "google_search",
    description:
      "Search Google via Apify for structured results including titles, URLs, and snippets. Better for finding specific pages about legislators (bios, press releases, news). Takes ~15-30s.",
    input_schema: {
      type: "object" as const,
      required: ["query"],
      properties: {
        query: { type: "string", description: "Google search query" },
        maxResults: { type: "number", description: "Max results 1-10. Default: 5" },
      },
    },
    execute: async (input) => {
      const apiKey = process.env.APIFY_API_KEY;
      if (!apiKey) return "ERROR: APIFY_API_KEY not set.";

      try {
        // Start the run and wait for completion
        const resp = await fetch(
          "https://api.apify.com/v2/acts/apify~google-search-scraper/runs?waitForFinish=30",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              queries: input.query as string,
              maxPagesPerQuery: 1,
              resultsPerPage: (input.maxResults as number) || 5,
            }),
            signal: AbortSignal.timeout(45_000),
          }
        );

        if (!resp.ok) return `Apify error: ${resp.status}`;
        const run = (await resp.json()) as { data?: { defaultDatasetId?: string; status?: string } };

        if (!run.data?.defaultDatasetId || run.data.status !== "SUCCEEDED") {
          return `Search didn't complete: ${run.data?.status || "unknown"}`;
        }

        // Fetch results
        const dataResp = await fetch(
          `https://api.apify.com/v2/datasets/${run.data.defaultDatasetId}/items?limit=10`,
          { headers: { Authorization: `Bearer ${apiKey}` } }
        );

        const items = (await dataResp.json()) as Array<{
          searchQuery?: { term: string };
          organicResults?: Array<{ title: string; url: string; description?: string }>;
        }>;

        let output = "";
        for (const item of items) {
          for (const r of item.organicResults || []) {
            output += `Title: ${r.title}\nURL: ${r.url}\nSnippet: ${r.description || "(no snippet)"}\n\n`;
          }
        }
        return output || "No results found.";
      } catch (err) {
        return `Google search error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/** Apify website crawler — crawl a senator's site for press releases, bio info */
export function createApifyCrawlerTool(): ToolDefinition {
  return {
    name: "crawl_website",
    description:
      "Crawl a website and extract text content from multiple pages. Great for senator websites (press releases, about pages, committee pages). Crawls up to 5 pages from the start URL. Takes ~20-40s.",
    input_schema: {
      type: "object" as const,
      required: ["url"],
      properties: {
        url: { type: "string", description: "Start URL to crawl (e.g. https://www.murkowski.senate.gov/press)" },
        maxPages: { type: "number", description: "Max pages to crawl (1-5). Default: 3" },
      },
    },
    execute: async (input) => {
      const apiKey = process.env.APIFY_API_KEY;
      if (!apiKey) return "ERROR: APIFY_API_KEY not set.";

      try {
        const resp = await fetch(
          "https://api.apify.com/v2/acts/apify~website-content-crawler/runs?waitForFinish=60",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              startUrls: [{ url: input.url as string }],
              maxCrawlPages: Math.min((input.maxPages as number) || 3, 5),
              crawlerType: "cheerio",
            }),
            signal: AbortSignal.timeout(75_000),
          }
        );

        if (!resp.ok) return `Apify error: ${resp.status}`;
        const run = (await resp.json()) as { data?: { defaultDatasetId?: string; status?: string } };

        if (!run.data?.defaultDatasetId || run.data.status !== "SUCCEEDED") {
          return `Crawl didn't complete: ${run.data?.status || "unknown"}`;
        }

        const dataResp = await fetch(
          `https://api.apify.com/v2/datasets/${run.data.defaultDatasetId}/items?limit=5`,
          { headers: { Authorization: `Bearer ${apiKey}` } }
        );

        const items = (await dataResp.json()) as Array<{
          url: string;
          text?: string;
          metadata?: { title?: string };
        }>;

        let output = "";
        for (const item of items) {
          output += `--- ${item.metadata?.title || item.url} ---\n`;
          output += `URL: ${item.url}\n`;
          output += `${(item.text || "").slice(0, 2000)}\n\n`;
        }
        return output || "No content extracted.";
      } catch (err) {
        return `Crawl error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/** Apify Instagram scraper — find personal interests from a legislator's posts */
export function createInstagramTool(): ToolDefinition {
  return {
    name: "instagram_posts",
    description:
      "Scrape recent Instagram posts from a legislator. Pass their FULL NAME (e.g. 'Lisa Murkowski') — the tool will find their account automatically. Returns captions and engagement. Best source for personal interests, hobbies, and causes. Takes ~30-40s.",
    input_schema: {
      type: "object" as const,
      required: ["name"],
      properties: {
        name: { type: "string", description: "Full name of the person (e.g. 'Lisa Murkowski')" },
        maxPosts: { type: "number", description: "Max posts to fetch (1-10). Default: 5" },
      },
    },
    execute: async (input) => {
      const apiKey = process.env.APIFY_API_KEY;
      if (!apiKey) return "ERROR: APIFY_API_KEY not set.";

      try {
        // Step 1: Find Instagram handle via Google
        const name = input.name as string;
        const searchResp = await fetch(
          "https://api.apify.com/v2/acts/apify~google-search-scraper/runs?waitForFinish=30",
          {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ queries: `${name} instagram.com official`, maxPagesPerQuery: 1, resultsPerPage: 3 }),
            signal: AbortSignal.timeout(35_000),
          }
        );
        if (!searchResp.ok) return `Handle lookup failed: ${searchResp.status}`;
        const searchRun = (await searchResp.json()) as { data?: { defaultDatasetId?: string; status?: string } };
        if (!searchRun.data?.defaultDatasetId) return "Handle lookup failed";

        const searchData = await fetch(
          `https://api.apify.com/v2/datasets/${searchRun.data.defaultDatasetId}/items?limit=3`,
          { headers: { Authorization: `Bearer ${apiKey}` } }
        );
        const searchItems = (await searchData.json()) as Array<{
          organicResults?: Array<{ url: string; title: string }>;
        }>;

        // Extract Instagram username from Google results
        let username = "";
        for (const item of searchItems) {
          for (const r of item.organicResults || []) {
            const match = r.url.match(/instagram\.com\/([a-zA-Z0-9_.]+)/);
            if (match && match[1] !== "p" && match[1] !== "explore" && match[1] !== "accounts") {
              username = match[1];
              break;
            }
          }
          if (username) break;
        }

        if (!username) return `Could not find Instagram account for "${name}". No Instagram URL found in Google results.`;
        console.log(`[instagram] Resolved "${name}" → @${username}`);

        // Step 2: Scrape posts
        const resp = await fetch(
          "https://api.apify.com/v2/acts/apify~instagram-scraper/runs?waitForFinish=60",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              directUrls: [`https://www.instagram.com/${username}/`],
              resultsType: "posts",
              resultsLimit: Math.min((input.maxPosts as number) || 5, 10),
            }),
            signal: AbortSignal.timeout(75_000),
          }
        );

        if (!resp.ok) return `Apify error: ${resp.status}`;
        const run = (await resp.json()) as { data?: { defaultDatasetId?: string; status?: string } };

        if (!run.data?.defaultDatasetId || run.data.status !== "SUCCEEDED") {
          return `Instagram scrape didn't complete: ${run.data?.status || "unknown"}`;
        }

        const dataResp = await fetch(
          `https://api.apify.com/v2/datasets/${run.data.defaultDatasetId}/items?limit=10`,
          { headers: { Authorization: `Bearer ${apiKey}` } }
        );

        const items = (await dataResp.json()) as Array<{
          caption?: string;
          timestamp?: string;
          likesCount?: number;
          commentsCount?: number;
          url?: string;
        }>;

        if (items.length === 0) return `Found @${username} for "${name}" but no posts returned. Account may be private.`;

        let output = `Instagram posts from @${username} (${items.length} posts):\n\n`;
        for (const post of items) {
          output += `Date: ${post.timestamp || "unknown"}\n`;
          output += `Caption: ${post.caption?.slice(0, 500) || "(no caption)"}\n`;
          output += `Engagement: ${post.likesCount || 0} likes, ${post.commentsCount || 0} comments\n\n`;
        }
        return output;
      } catch (err) {
        return `Instagram error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/** Apify Twitter/X scraper — recent tweets for a legislator */
export function createTwitterTool(): ToolDefinition {
  return {
    name: "twitter_posts",
    description:
      "Scrape recent tweets from a legislator's X/Twitter account. Pass their FULL NAME — the tool finds their handle automatically. Returns tweet text, dates, and engagement. Takes ~20-30s.",
    input_schema: {
      type: "object" as const,
      required: ["name"],
      properties: {
        name: { type: "string", description: "Full name of the person (e.g. 'Elizabeth Warren')" },
        maxTweets: { type: "number", description: "Max tweets to fetch (1-10). Default: 5" },
      },
    },
    execute: async (input) => {
      const apiKey = process.env.APIFY_API_KEY;
      if (!apiKey) return "ERROR: APIFY_API_KEY not set.";

      try {
        const name = input.name as string;

        // Resolve Twitter handle via Google
        const searchResp = await fetch(
          "https://api.apify.com/v2/acts/apify~google-search-scraper/runs?waitForFinish=30",
          {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ queries: `${name} site:x.com OR site:twitter.com senator`, maxPagesPerQuery: 1, resultsPerPage: 3 }),
            signal: AbortSignal.timeout(35_000),
          }
        );
        if (!searchResp.ok) return `Handle lookup failed: ${searchResp.status}`;
        const searchRun = (await searchResp.json()) as { data?: { defaultDatasetId?: string } };
        if (!searchRun.data?.defaultDatasetId) return "Handle lookup failed";

        const searchData = await fetch(
          `https://api.apify.com/v2/datasets/${searchRun.data.defaultDatasetId}/items?limit=3`,
          { headers: { Authorization: `Bearer ${apiKey}` } }
        );
        const searchItems = (await searchData.json()) as Array<{
          organicResults?: Array<{ url: string }>;
        }>;

        let handle = "";
        for (const item of searchItems) {
          for (const r of item.organicResults || []) {
            const match = r.url.match(/(?:twitter\.com|x\.com)\/([a-zA-Z0-9_]+)/);
            if (match && !["search", "explore", "i", "hashtag", "intent"].includes(match[1])) {
              handle = match[1];
              break;
            }
          }
          if (handle) break;
        }
        if (!handle) return `Could not find X/Twitter account for "${name}".`;
        console.log(`[twitter] Resolved "${name}" → @${handle}`);

        // Scrape tweets
        const resp = await fetch(
          "https://api.apify.com/v2/acts/apidojo~twitter-scraper-lite/runs?waitForFinish=60",
          {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              searchTerms: [`from:${handle}`],
              maxTweets: Math.min((input.maxTweets as number) || 5, 10),
            }),
            signal: AbortSignal.timeout(75_000),
          }
        );
        if (!resp.ok) return `Twitter scrape failed: ${resp.status}`;
        const run = (await resp.json()) as { data?: { defaultDatasetId?: string; status?: string } };
        if (!run.data?.defaultDatasetId || run.data.status !== "SUCCEEDED") {
          return `Twitter scrape didn't complete: ${run.data?.status || "unknown"}`;
        }

        const dataResp = await fetch(
          `https://api.apify.com/v2/datasets/${run.data.defaultDatasetId}/items?limit=10`,
          { headers: { Authorization: `Bearer ${apiKey}` } }
        );
        const items = (await dataResp.json()) as Array<{
          text?: string; createdAt?: string; likeCount?: number; retweetCount?: number;
          author?: { userName?: string };
        }>;

        if (items.length === 0) return `Found @${handle} but no tweets returned.`;

        let output = `Tweets from @${handle} (${items.length} tweets):\n\n`;
        for (const t of items) {
          output += `Date: ${t.createdAt || "unknown"}\n`;
          output += `${t.text?.slice(0, 500) || "(empty)"}\n`;
          output += `Likes: ${t.likeCount || 0} | Retweets: ${t.retweetCount || 0}\n\n`;
        }
        return output;
      } catch (err) {
        return `Twitter error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/** Apify Facebook posts scraper — recent posts from a legislator's page */
export function createFacebookTool(): ToolDefinition {
  return {
    name: "facebook_posts",
    description:
      "Scrape recent Facebook posts from a legislator's page. Pass their FULL NAME — the tool finds their page automatically. Returns post text, dates, and engagement. Takes ~20-30s.",
    input_schema: {
      type: "object" as const,
      required: ["name"],
      properties: {
        name: { type: "string", description: "Full name of the person (e.g. 'Elizabeth Warren')" },
        maxPosts: { type: "number", description: "Max posts to fetch (1-10). Default: 5" },
      },
    },
    execute: async (input) => {
      const apiKey = process.env.APIFY_API_KEY;
      if (!apiKey) return "ERROR: APIFY_API_KEY not set.";

      try {
        const name = input.name as string;

        // Resolve Facebook page URL via Google
        const searchResp = await fetch(
          "https://api.apify.com/v2/acts/apify~google-search-scraper/runs?waitForFinish=30",
          {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ queries: `${name} site:facebook.com senator official`, maxPagesPerQuery: 1, resultsPerPage: 3 }),
            signal: AbortSignal.timeout(35_000),
          }
        );
        if (!searchResp.ok) return `Page lookup failed: ${searchResp.status}`;
        const searchRun = (await searchResp.json()) as { data?: { defaultDatasetId?: string } };
        if (!searchRun.data?.defaultDatasetId) return "Page lookup failed";

        const searchData = await fetch(
          `https://api.apify.com/v2/datasets/${searchRun.data.defaultDatasetId}/items?limit=3`,
          { headers: { Authorization: `Bearer ${apiKey}` } }
        );
        const searchItems = (await searchData.json()) as Array<{
          organicResults?: Array<{ url: string }>;
        }>;

        let fbUrl = "";
        for (const item of searchItems) {
          for (const r of item.organicResults || []) {
            if (r.url.includes("facebook.com/") && !r.url.includes("/posts/") && !r.url.includes("/photos/")) {
              fbUrl = r.url.split("?")[0];
              break;
            }
          }
          if (fbUrl) break;
        }
        if (!fbUrl) return `Could not find Facebook page for "${name}".`;
        console.log(`[facebook] Resolved "${name}" → ${fbUrl}`);

        // Scrape posts
        const resp = await fetch(
          "https://api.apify.com/v2/acts/apify~facebook-posts-scraper/runs?waitForFinish=60",
          {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              startUrls: [{ url: fbUrl }],
              resultsLimit: Math.min((input.maxPosts as number) || 5, 10),
            }),
            signal: AbortSignal.timeout(75_000),
          }
        );
        if (!resp.ok) return `Facebook scrape failed: ${resp.status}`;
        const run = (await resp.json()) as { data?: { defaultDatasetId?: string; status?: string } };
        if (!run.data?.defaultDatasetId || run.data.status !== "SUCCEEDED") {
          return `Facebook scrape didn't complete: ${run.data?.status || "unknown"}`;
        }

        const dataResp = await fetch(
          `https://api.apify.com/v2/datasets/${run.data.defaultDatasetId}/items?limit=10`,
          { headers: { Authorization: `Bearer ${apiKey}` } }
        );
        const items = (await dataResp.json()) as Array<{
          text?: string; time?: string; likes?: number; comments?: number; shares?: number;
        }>;

        if (items.length === 0) return `Found Facebook page but no posts returned.`;

        let output = `Facebook posts from ${fbUrl} (${items.length} posts):\n\n`;
        for (const post of items) {
          output += `Date: ${post.time || "unknown"}\n`;
          output += `${post.text?.slice(0, 500) || "(empty)"}\n`;
          output += `Likes: ${post.likes || 0} | Comments: ${post.comments || 0} | Shares: ${post.shares || 0}\n\n`;
        }
        return output;
      } catch (err) {
        return `Facebook error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/** Incremental connection reporting (for connection search) */
export function createReportConnectionTool(): ToolDefinition {
  return {
    name: "report_connection",
    description:
      "Report a personal connection you've found. Call this IMMEDIATELY as you discover each connection — don't wait until the end. Each call streams the connection to the user in real-time.",
    input_schema: {
      type: "object" as const,
      required: ["type", "detail", "shared_with", "source", "confidence"],
      properties: {
        type: {
          type: "string",
          description:
            "Freeform connection type — be creative and specific (e.g., 'golf', 'Yale Law School', 'cancer survivor', 'Navy veteran', 'rescue dog owner', 'bluegrass music')",
        },
        icon_suggestion: {
          type: "string",
          description: "Single emoji that represents this connection type (e.g., '⛳', '🎓', '🎗️', '🐕', '🎸')",
        },
        detail: { type: "string", description: "What the candidate's connection/interest is" },
        shared_with: { type: "string", description: "How the requesting legislator shares this connection" },
        source: { type: "string", description: "URL or specific citation (required — no hallucinating)" },
        confidence: { type: "number", description: "0-1 confidence this is accurate and verifiable" },
      },
    },
    execute: async () => "Connection recorded and streamed to the user. Keep searching for more!",
  };
}

/** Final findings submission (for deep-dive) */
export function createSubmitFindingsTool(): ToolDefinition {
  return {
    name: "submit_findings",
    description:
      "Submit your final research findings. Call this once when you've completed your deep-dive research.",
    input_schema: {
      type: "object" as const,
      required: ["findings"],
      properties: {
        findings: {
          type: "array",
          items: {
            type: "object",
            required: ["title", "summary", "relevance", "type"],
            properties: {
              title: { type: "string", description: "Title of the finding" },
              summary: { type: "string", description: "2-3 sentence summary" },
              url: { type: "string", description: "Source URL if available" },
              date: { type: "string", description: "Date if known (YYYY-MM-DD or description)" },
              relevance: {
                type: "string",
                description: "How this connects the personal connection to the legislative initiative",
              },
              type: {
                type: "string",
                enum: ["report", "event", "article", "speech", "organization", "other"],
              },
            },
          },
        },
      },
    },
    execute: async () => "Findings submitted successfully.",
  };
}

// ─────────────────────────────────────────────────────
// HTML to text — strip tags, scripts, styles, nav
// ─────────────────────────────────────────────────────

function htmlToText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|h[1-6]|li|tr|td|th|blockquote|pre|section|article)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n/g, "\n\n")
    .trim();
}

// ─────────────────────────────────────────────────────
// Tool Loop Engine — call Anthropic with tools,
// execute server-side, feed results back, repeat
// ─────────────────────────────────────────────────────

export async function runToolLoop(options: ToolLoopOptions): Promise<ToolLoopResult> {
  const {
    model = process.env.AI_MODEL || "claude-haiku-4-5-20251001",
    systemPrompt,
    userMessage,
    tools,
    maxIterations = 10,
    maxTokens = 4096,
    forceToolOnLast,
    onToolCall,
  } = options;

  const anthropicTools: Anthropic.Messages.Tool[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Messages.Tool.InputSchema,
  }));

  const toolMap = new Map(tools.map((t) => [t.name, t]));

  const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: userMessage }];

  const allToolCalls: Array<{ name: string; input: Record<string, unknown>; output: string }> = [];
  let finalText = "";
  let iterations = 0;
  const calledTools = new Set<string>();

  while (iterations < maxIterations) {
    iterations++;

    // On the last iteration, if forceToolOnLast is set and hasn't been called yet, force it
    const isLastIteration = iterations === maxIterations;
    const shouldForce = isLastIteration && forceToolOnLast && !calledTools.has(forceToolOnLast);

    const response = await anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      system: shouldForce
        ? `${systemPrompt}\n\nIMPORTANT: This is your FINAL turn. You MUST call ${forceToolOnLast} now with all findings gathered so far.`
        : systemPrompt,
      tools: anthropicTools,
      messages,
      ...(shouldForce ? { tool_choice: { type: "tool" as const, name: forceToolOnLast } } : {}),
    });

    // Collect text blocks
    const textBlocks = response.content.filter((b) => b.type === "text");
    if (textBlocks.length > 0) {
      finalText = textBlocks.map((b) => (b as { text: string }).text).join("\n");
    }

    // Find tool_use blocks
    const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");

    // No tools called or end_turn → we're done
    if (toolUseBlocks.length === 0 || response.stop_reason === "end_turn") {
      break;
    }

    // Add assistant message with full content
    messages.push({ role: "assistant", content: response.content });

    // Execute all tools in parallel
    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = await Promise.all(
      toolUseBlocks
        .filter((block): block is Anthropic.Messages.ToolUseBlock => block.type === "tool_use")
        .map(async (block) => {
          const tool = toolMap.get(block.name);
          const input = block.input as Record<string, unknown>;
          let output: string;

          if (tool) {
            try {
              console.log(`[tool-loop] Calling ${block.name}(${JSON.stringify(input).slice(0, 80)})`);
              output = await tool.execute(input);
            } catch (err) {
              output = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
            }
          } else {
            output = `Unknown tool: ${block.name}`;
          }

          allToolCalls.push({ name: block.name, input, output });
          calledTools.add(block.name);
          onToolCall?.(block.name, input, output);

          return {
            type: "tool_result" as const,
            tool_use_id: block.id,
            content: output,
          };
        })
    );

    messages.push({ role: "user", content: toolResults });
  }

  return { finalText, toolCalls: allToolCalls, iterations };
}
