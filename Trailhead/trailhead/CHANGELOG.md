# Changelog

## [Unreleased] - Staging (2025-12-17)

### Major Features

#### 🔗 Citation System with Deep Links
A complete citation system that verifies quotes from model responses and links them directly to the source:
- Two-step analysis: extract highlights first, then write summary referencing verified quotes
- Deep links open the exact message in Inspect viewer (click citation → see original response)
- Fuzzy matching with 30% error tolerance for quote verification
- Citations embedded in summaries: `"quoted text" [Model, e1]`
- Block quotes include attribution on a new line inside the quote

#### 🤖 MCP Server for Claude Code
Run experiments directly from Claude Code via Model Context Protocol:
- 8 tools: `trailhead_create`, `trailhead_design`, `trailhead_run`, `trailhead_summarize`, `trailhead_ask`, `trailhead_results`, `trailhead_status`, `trailhead_cancel`
- New `trailhead_list` tool to see past experiments and avoid repeating work
- Install script: `./scripts/install-mcp.sh` registers with Claude Code
- Supports both local (stdio) and cloud (HTTP) transports
- Bearer token auth for cloud deployments (`TRAILHEAD_SECRET` env var)

#### 🛡️ Resilient Config Generation
- Automatic fallback to backup model (GPT-5.2) when primary (Opus 4.5) fails
- Retries on all failures including refusals and content filters
- User-friendly error messages in Slack: refusals, content filters, empty responses

#### 🏗️ Two-Step Summarization Architecture
LLM generates markdown → algorithmic conversion to Slack Block Kit:
- Quote verification happens once, before format fork (DRY)
- `sanitize_quotes()` verifies quoted text against source, converts to `[[quote:N]]` tags
- `markdown_to_slack.py` converts markdown AST to Slack blocks algorithmically
- All output formats (Slack, prose, bullets) now share the same verified quotes
- Removed old direct LLM-to-Slack-JSON approach

#### 🎯 Unified TrailRunner with Event Hooks
Replaced duplicated execution code with composable phases:
- `phases/`: design, run, summarize, ask - discrete building blocks
- `HookRegistry` with global/per-trailrun event subscription
- `SlackTrailrunHook` handles all Slack UI updates via events
- New REST API endpoints: `/trailrun/{id}/design`, `/run`, `/summarize`, `/ask`
- Removed 4 redundant endpoints, deleted `slack_trailrunner.py`

#### 💬 Thread Q&A with Citations
Follow-up questions in experiment threads now have the same citation system as summaries:
- Answers can reference `[[quote:N]]` tags with deep links to Inspect viewer
- Shared highlight extraction between summarizer and answerer (DRY)
- Uses two-step architecture: markdown → Slack blocks (same as summarizers)

### Improvements

- **Progress animations** during summarization phase
- **Better citation format**: Full attribution (Model, epoch) instead of just 🔗
- **Concise summaries**: 200-400 words, less filler
- **Deep link fixes**: Multi-model experiments now link to correct eval file
- **Model guidance**: Reasoning models (o3-pro, gpt-5-pro) separated from flagship tier - prevents config generator from selecting expensive reasoning models for simple tasks

### Internal Improvements

- **Centralized logging**: Replaced ~140 print statements with Python logging module
- **Environment control**: `LOG_LEVEL=DEBUG` and `LOG_DEBUG=module.name` for filtered debugging
- **Consolidated output formats**: Reduced to `slack` + `markdown` only
- **Vendored Petri framework**: Citation extraction and fuzzy matching from red-team auditing tool

### Bug Fixes

- Fixed spinner getting stuck or overwriting final messages (race condition)
- Fixed duplicate Slack button clicks causing issues (idempotency guard)
- Fixed table citations rendering as plain text (Slack limitation)
- Fixed missing space between quote and citation tag
- Fixed infographics generating for text-only questions (tools now only provided when visual explicitly requested)

### Image Generation

- Infographics only generate when user explicitly asks for visuals (chart, graph, image, etc.)
- Escape hatch for creative requests: asking for "oil painting", "illustration", etc. will use image generation with creative freedom rather than strict data viz format
