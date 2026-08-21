---
name: firecrawl
description: Fetch any web page as clean Markdown via Firecrawl. This is the DEFAULT way to read a URL — articles, docs, JS-heavy SPAs, dashboards behind client-side routing, anything with rendered HTML. Returns Markdown ready to read or feed into a downstream prompt. Prefer this over WebFetch for everything except raw JSON APIs and raw .md/plaintext files.
---

# firecrawl — web pages as Markdown

Firecrawl is your default web-fetch tool. There are two ways to reach it; prefer
whichever is wired into this session:

1. **MCP tools** (`mcp__firecrawl__*`) — `firecrawl_scrape` (single page),
   `firecrawl_search` (web search + content), `firecrawl_crawl`, `firecrawl_extract`.
   Use these when present.
2. **This skill's `curl` recipe** (below) — a dependable fallback that hits the
   REST API directly. Use it if the MCP tools error or aren't registered.

Either way it runs a real browser, so React / Vue / Next.js / dynamic-content
pages come back fully populated — not the empty shell `WebFetch` sees.

## When to use firecrawl vs other tools

| Use case | Tool |
|---|---|
| **Any web page with rendered HTML** (articles, docs, SPAs, dashboards) | **firecrawl** (default) |
| Raw JSON API response | `WebFetch` — there's no HTML to render |
| Raw `.md` / `.txt` / plaintext file | `WebFetch` — already plain text |
| Search the web for a topic | `firecrawl_search`, or `WebSearch` then firecrawl the top hit |
| Interact with a page (click, fill, screenshot) | `agent-browser` skill |
| Crawl an entire site / many pages | `firecrawl_crawl` (MCP) or the `/crawl` endpoint |
| Scrape a marketplace category (TikTok, IG, Google, etc.) | `apify` skill — battle-tested actors |

**Rule of thumb:** if it's a website, use firecrawl. Only fall back to `WebFetch`
for things that are already machine-readable (JSON, raw markdown/text). Almost
never use `WebFetch` on an HTML page — it returns the un-rendered shell.

## curl recipe (the fallback path)

Auth is handled by OneCLI — no `Authorization` header needed. `api.firecrawl.dev`
is a pre-authenticated host; the gateway injects the real bearer.

```bash
curl -sX POST https://api.firecrawl.dev/v1/scrape \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://www.nytimes.com/", "formats": ["markdown"]}' \
  | jq -r '.data.markdown'
```

Response shape (Firecrawl `/v1/scrape`):

```json
{
  "success": true,
  "data": {
    "markdown": "# Page title\n\nBody text…",
    "metadata": { "title": "NYT homepage", "sourceURL": "https://www.nytimes.com/", "statusCode": 200 }
  }
}
```

## Parameters

| Param | Default | Notes |
|---|---|---|
| `url` | required | Any public URL. HTTPS only in practice. |
| `formats` | `["markdown"]` | Other options: `["markdown", "html", "links", "screenshot"]`. Keep to `markdown` unless you need the others — bigger payloads. |
| `onlyMainContent` | `true` (server default) | Strips nav / footer / ads. Set `false` for the full page. |
| `waitFor` | none | Milliseconds to wait after load before scraping. Use ~1000-3000 for slow SPAs. |
| `extract` (with `prompt`) | off | LLM-assisted structured extraction — pass `{"prompt": "Extract the headline and author"}` to get a `data.extract` object. Costs more credits. |
| `ignoreRobotsTxt` | `true` here by default | See note below. |

### `ignoreRobotsTxt: true` — the consequentialist default

Default `true` for single on-demand fetches. Justification:

- `robots.txt` is a crawler convention — it governs polite bulk indexing, not a single user-directed fetch. Pulling one URL the user asked for is not crawling.
- The Firecrawl `/v1/scrape` endpoint today doesn't gate single-URL fetches on robots.txt (that gating lives in `/crawl`). So the param is currently a no-op on `/scrape` — harmless, and load-bearing if Firecrawl ever backports the gating.
- Flip to `false` ONLY when the user explicitly wants robots.txt honored (rare — usually archival/academic crawls of an entire site, where you'd use `/crawl` anyway).

### When to add a `prompt` (extraction mode)

Pass `extract.prompt` when you want a *structured* fact (price, headline, author, date) or a one-line summary instead of the whole article, or you're feeding the result into a step that needs JSON. When you just want to *read* the page, leave it off — pure Markdown is cheaper and faster.

```bash
curl -sX POST https://api.firecrawl.dev/v1/scrape \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "https://www.nytimes.com/2026/05/11/world/example.html",
    "formats": ["markdown"],
    "extract": {"prompt": "Return the headline, byline, and publish date as JSON."}
  }' \
  | jq '.data'
```

## Common pitfalls

- **Don't pass your own `Authorization` header on the curl path.** OneCLI injects (and overwrites) it at the proxy boundary; an explicit real-looking header just gets replaced. If you're getting 401s, that's a gateway issue, not a key issue — report it.
- **JS rendering takes time.** For slow SPAs, add `"waitFor": 2000` (or higher).
- **Cookie walls / login walls.** Firecrawl can sometimes bypass with `"actions": [{"type": "click", "selector": "#accept-cookies"}]`. For real login, use `agent-browser`.
- **Multi-MB pages.** `data.markdown` can be large. Pipe through `head -200` for a glance, or use `extract` to summarize at fetch time.

## API endpoint version

The curl recipe targets `/v1/scrape`, which is stable. Firecrawl has `/v2/scrape` with a richer `formats` shape — migrate when we want change-tracking, screenshots, and PDF parsing in one call. For now, plain Markdown is what we need.

Reference: <https://docs.firecrawl.dev>
