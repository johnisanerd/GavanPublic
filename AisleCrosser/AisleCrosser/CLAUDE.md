@AGENTS.md

# Aisle Crosser

## Progress Tracking (REQUIRED)
- **Always** read `~/.claude/projects/-Users-user-Projects-aisle-crosser/memory/PROGRESS.md` before starting work
- **Always** update PROGRESS.md when completing tasks, fixing bugs, or changing status of features
- Design system spec: `DESIGN.md`

## Tech Stack
- Next.js 15 (App Router), React 19, TypeScript, Tailwind CSS
- Package manager: **pnpm** (never npm/yarn)
- E2B base SDK (`import { Sandbox } from "e2b"`) with `claude-code-latest` template
- Anthropic SDK for tool summarization (Haiku)
- JSON file storage in `data/`

## Key Patterns
- E2B sandbox: use base `e2b` SDK, NOT `@e2b/code-interpreter` (it doesn't support custom templates)
- Claude Code CLI in sandbox: `claude -p --dangerously-skip-permissions --verbose --output-format stream-json --model claude-sonnet-4-6`
- Always update Claude Code to latest before running in sandbox
- Pass ALL API keys to sandbox: ANTHROPIC_API_KEY, CONGRESS_API_KEY, APIFY_API_KEY, E2B_API_KEY
- CommandExitError from e2b SDK has `.stdout`/`.stderr` — always recover output from thrown errors
- NDJSON parsing: look for `{"type":"result","result":"..."}` line for final output
- SSE via ReadableStream with EventBus replay
- Zod v4 validation (use `zod/v4` import)
- Tool summaries: `claude-haiku-4-5-20251001` for complex tools, templates for common ones

## Design System: Editorial Statesman
- Fonts: Noto Serif (display) + Public Sans (UI)
- Colors: Midnight Navy (#002147), Parchment (#F8F5F2), Gold (#B1976B)
- 0px corner radius everywhere
- No borders — use tonal surface layering
- See DESIGN.md for full spec

## Testing
- Use puppeteer for visual testing (installed as dev dep)
- Screenshots go to `/tmp/aisle-*.png`
- Dev server: `pnpm dev` on localhost:3000
