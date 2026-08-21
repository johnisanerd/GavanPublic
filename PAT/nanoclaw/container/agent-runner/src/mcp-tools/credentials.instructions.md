<!-- Standalone capability fragment — no sibling .ts module. Auto-discovered
by claude-md-compose. -->

## Capabilities & pre-authenticated hosts

Your container runs behind a credential gateway (OneCLI). Every outbound HTTPS request you make is intercepted, matched against host-patterns, and the right auth header is injected before the request leaves. **You never see the raw keys — and you don't need to.** Just call the hosts below without any auth header. Curl, Python `requests`, JS `fetch`, a fresh `pip install some-sdk`, a Python script you write on the fly — all the same. The gateway handles it.

This means you can write code freely and experimentally. Reach for any path on these hosts. Try unfamiliar models. Spin up sub-scripts. The gateway authenticates you.

### Curated paths (use the skill — golden path with sensible defaults)

- **`api.firecrawl.dev`** → `firecrawl` skill / `mcp__firecrawl__*` tools. Modern web scrape with JS rendering. Defaults to ignoring robots.txt for single on-demand fetches.
- **`mcp.apify.com` / `api.apify.com`** → `apify` skill. 20k-actor marketplace (Google search, IG/Twitter/TikTok scrapers, site crawlers, etc). Browse first, then run.
- **`openrouter.ai`** (image gen) → `generate_image` skill. Routes to `openai/gpt-5.4-image-2` with quality dial + pre-warn protocol.

### Open-ended hosts (no skill — write whatever code you need)

- **`openrouter.ai`** for *everything else*: 365+ models on one endpoint. Image gen (any of `openai/gpt-5.4-image-2`, `google/gemini-3-pro-image-preview`, `google/gemini-2.5-flash-image`), video gen, TTS, Gemini flagship, open-source alternatives, embeddings. POST `https://openrouter.ai/api/v1/chat/completions` with `modalities` for multimodal. Reach for this when an experiment calls for a non-Anthropic model.
- **`api.onkernel.com`** → kernel.sh remote Chromium. POST `/browsers` returns a CDP WebSocket URL you can drive with Playwright/Puppeteer. Real headed browser — for logins, complex JS, screenshot capture beyond what Firecrawl handles.
- **`api.cartesia.ai`** → Cartesia's direct API. The phone-call path already uses Cartesia upstream, but you can use it yourself: generate ad-hoc TTS clips in any voice (Sonic), transcribe audio files (Ink), clone a voice, ship a custom utterance via `send_file`. Don't route conversational replies through this — those go through the normal `send_message` flow.
- **`api.anthropic.com`** → call Claude directly when you want sub-agents outside your SDK runner, batch operations, or a model the runner doesn't expose.

### How to verify a target is pre-authenticated

If you're unsure whether a host is registered: just try it. A registered host will work; an unregistered one returns 401/403. The host doesn't have to be in this list — if it's been added to the gateway, it's authenticated. The gateway's vault is what's authoritative.

### Spirit

The toolkit is broad on purpose. When a task suggests an experiment outside the wrapped skills, write the code, hit the host, see what happens. The gateway has your back on auth; you have latitude to ship something interesting.
