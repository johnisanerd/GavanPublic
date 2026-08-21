# Aisle Crosser — Backlog

Future architecture explorations and feature ideas.

## More Agentic Connection Finding

The current connection finder uses a server-side tool loop (Sonnet + Tavily + shell).
These are potential upgrades for deeper, more creative research:

### E2B Sandbox Per Connection
- One E2B sandbox per candidate, running full Claude Code with web search
- Pros: Agents can install tools, write scripts, browse freely
- Cons: ~30s startup per sandbox, 8 sandboxes = significant cost/time
- Best for: High-value targets where depth matters more than speed

### Claude Code Agent Teams
- Single E2B sandbox with a team lead spawning connection sub-agents
- Team lead coordinates: "You search Wikipedia, you search news, you search social media"
- Pros: Shared context, parallel research within one sandbox
- Cons: Complex orchestration, single sandbox limits

### Custom Agent SDK Orchestrator
- Single E2B sandbox running a custom Agent SDK script
- The script commands multiple sub-agents internally
- Potentially the most efficient architecture: 1 sandbox, N agents, shared context
- Could use Claude's native tool use for coordination

## Deep-Dive Enhancements

### Multi-Turn Deep Dives
- Let users ask follow-up questions within a deep dive
- "Find more about their joint appearance at the 2023 summit"
- Requires maintaining conversation context in the tool loop

### Cross-Connection Analysis
- Automatically identify connections that reinforce each other
- "Both went to Yale AND both are cancer survivors → very strong bond"
- Could run a synthesis pass after all connections are found

### Connection Strength Scoring
- Use multiple signals to score connection strength
- Recency, specificity, emotional weight, public visibility
- Display as a heat map or ranked list

### Security: Remove API Keys from Sandbox
- Currently all API keys (Anthropic, Apify, Congress, E2B) are passed into E2B sandbox via env vars
- Keys are also written into the CLAUDE.md file inside the sandbox — DON'T do this
- Better: tools execute on Railway server, sandbox sends tool requests via WebSocket
- Sandbox only needs WS connection back to orchestrator, no external API keys
- Prevents key leakage if sandbox is compromised

## Infrastructure

### Database Migration
- Move from JSON file storage to SQLite or Postgres
- Enable full-text search across research findings
- Better concurrent access patterns

### Caching Layer
- Cache Tavily search results (same query within 1 hour)
- Cache fetched URLs (same URL within 24 hours)
- Reduces API costs significantly for repeated research

### Webhook Notifications
- Notify when research completes (Slack, email)
- Useful for long-running research (5-10 minutes)
