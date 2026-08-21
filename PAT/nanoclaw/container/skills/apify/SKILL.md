---
name: apify
description: Run any of Apify's 20,000+ Actors — TikTok scrapers, Instagram scrapers, Google Search, site crawlers, social-media monitors, e-commerce extractors, and a long tail of specialized tools. Use whenever a task suggests an experiment that an off-the-shelf scraper could do better than rolling your own — picking a specific Actor for the job IS the point.
---

# apify — the 20k-Actor marketplace

Apify is exposed as a remote MCP server. The `mcp__apify__*` tools appear in your tool list once the container's `apify` server is wired (it is, by default). Auth is handled by the OneCLI gateway — you don't see or pass an API token.

## What's there

20k+ Actors. Off-the-shelf scrapers for:

- **Social**: `apify/tiktok-scraper`, `apify/instagram-scraper`, `apidojo/twitter-scraper-lite`, `apify/youtube-scraper`, `apify/reddit-scraper`
- **Search**: `apify/google-search-scraper`, `apify/bing-search-scraper`, `apify/duckduckgo-search-scraper`
- **Sites**: `apify/website-content-crawler` (general purpose, well-tuned), `apify/rag-web-browser` (LLM-friendly summarizer)
- **E-commerce**: `apify/amazon-product-scraper`, `apify/aliexpress-scraper`, the eBay / Walmart / Etsy family
- **Specialty**: `apify/google-maps-scraper`, `apify/booking-scraper`, `apify/linkedin-jobs-scraper`, `lukaskrivka/google-trends`, `apify/twitter-following-scraper`

…and a long tail. **Browse the Actor library before settling on a generic scraper** — there's almost always a purpose-built one.

## How to use it

The Apify MCP server discovers Actors at runtime; the exact tool names you'll see depend on what the server exposes that session. Typical flow:

1. **Discover**: list the available Apify tools (they all start with `mcp__apify__`). You'll see meta-tools for browsing Actors and per-Actor run tools.
2. **Pick an Actor**: prefer specific over generic. `apify/tiktok-scraper` beats `apify/website-content-crawler` for a TikTok URL, every time.
3. **Read the Actor's input schema**: each Actor takes a different input shape. The MCP tool's parameter description will spell it out, or you can hit `https://api.apify.com/v2/acts/<actor-id>/input-schema` directly (also pre-authed via OneCLI).
4. **Run**: call the Actor's `mcp__apify__run-actor` (or similar) tool with the input. Output is the dataset of items the Actor scraped — JSON, ready to read.
5. **Cost-check**: each Actor costs Apify compute units (CUs). Most are pennies per run, but high-volume scrapers can add up. Check the Actor's listing on `apify.com/store` if you're unsure.

## Example tasks where apify shines

- "Get the last 20 TikTok videos from @user" → `apify/tiktok-scraper` with `{"profiles": ["@user"], "resultsLimit": 20}`
- "Top 5 Google results for `<query>`" → `apify/google-search-scraper`
- "Reviews of a product on Amazon" → `apify/amazon-product-scraper`
- "All event listings on a page" → `apify/website-content-crawler` with the right `startUrls` + `pseudoUrls`
- "Trending searches in Japan this week" → `lukaskrivka/google-trends`

## When NOT to use apify

- **One page, just the Markdown**: use `firecrawl` instead. Apify's `rag-web-browser` is overkill for a single page.
- **Real-time interactions** (click this, fill that, watch a SPA respond): use `agent-browser`.
- **Already have the data via a public API**: e.g. don't scrape Reddit when you can hit reddit.com/r/foo/.json. Apify is for cases where there's no clean API or the API is locked behind expensive tiers.

## Discovery hint

When picking an Actor:

- Read the description. Most Actor descriptions are good. Pick the one whose input shape best matches your data.
- Look at `runs` count on apify.com/store — battle-tested Actors have thousands. Brand-new ones might be flaky.
- Prefer Actors authored by `apify` (their own) or other well-known authors (`apidojo`, `lukaskrivka`, `epctex`) over random one-offs unless the Actor is exactly what you need.

## Auth

OneCLI gateway handles auth for both `mcp.apify.com` (the MCP control plane) and `api.apify.com` (when you hit the REST endpoints directly). You don't need to set `APIFY_API_KEY` or pass any `Authorization` header.

## No `?tools=` lockdown

This deployment exposes the full Apify MCP — no `?tools=apify/foo,apify/bar` filter — by design. The point is experimentation across the whole marketplace. If a session ends up consistently using the same 3-5 Actors, that's fine; pick what fits the task.

Reference: <https://docs.apify.com/platform/integrations/ai/mcp>
