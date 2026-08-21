# Aisle Crosser — Architecture

## Overview

Aisle Crosser helps US legislators find cross-party collaboration opportunities. A user (congressional staffer) selects a legislator, defines a legislative initiative, and launches an AI-powered research pipeline that:

1. Deploys 4 parallel research agents in cloud sandboxes
2. Extracts candidate allies as each agent completes
3. Researches personal connections for top candidates
4. Synthesizes everything into 5 ranked recommendations with icebreakers

The entire process streams to a real-time UI, making the AI's work visible — which is itself a demo of agentic AI for Congress.

---

## System Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│  Browser (React 19, Next.js App Router)                             │
│                                                                     │
│  Landing → Dashboard → Research Page                                │
│    │          │           │                                          │
│    │          │           ├─ AgentGrid (2×2 live panels)            │
│    │          │           ├─ CandidateList (grows live)             │
│    │          │           └─ RecommendationCards                     │
│    │          │                                                     │
│    │          │  REST ────────────────── SSE (EventSource) ──────── │
└────┼──────────┼──────────────────────────┼──────────────────────────┘
     │          │                          │
     ▼          ▼                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Next.js Server (Node.js, single process)                           │
│                                                                     │
│  /api/legislators     GET (search, seed data)                       │
│  /api/legislators/:id GET                                           │
│  /api/legislators/:id/bills GET (Congress.gov proxy, 10min cache)   │
│  /api/sessions        POST                                          │
│  /api/initiatives     GET, POST                                     │
│  /api/initiatives/:id GET, PUT, DELETE                               │
│  /api/research        POST → launches orchestrator (fire-and-forget)│
│  /api/research/:id    GET                                           │
│  /api/research/:id/feedback POST                                    │
│  /api/research/stream/:id GET (SSE)                                 │
│                                                                     │
│  ┌─ EventBus (globalThis singleton) ─────────────────────┐         │
│  │  Map<researchId, EventBus>                             │         │
│  │  .emit() → listeners + event log                       │         │
│  │  .subscribe(listener, fromIndex) → replay + live       │         │
│  └────────────────────────────────────────────────────────┘         │
│                                                                     │
│  ┌─ JSON File Store (data/) ─────────────────────────────┐         │
│  │  data/sessions/*.json                                  │         │
│  │  data/initiatives/*.json                               │         │
│  │  data/research/*.json     (includes candidates,        │         │
│  │                            recommendations, agents)    │         │
│  │  Atomic writes (write .tmp → rename)                   │         │
│  └────────────────────────────────────────────────────────┘         │
└─────────────────────────────────────────────────────────────────────┘
     │                                         │
     │ E2B API (Sandbox.create)                │ Anthropic API
     ▼                                         ▼
┌──────────────────────┐    ┌──────────────────────────────────────┐
│  E2B Cloud Sandboxes │    │  Anthropic Claude API (direct calls) │
│  (4 per research)    │    │                                      │
│                      │    │  • Haiku: candidate extraction       │
│  Template:           │    │  • Haiku: finding condensation       │
│  claude-code-latest  │    │  • Haiku: tool call summarization    │
│                      │    │  • Sonnet: personal connections ×8   │
│  Each runs:          │    │  • Sonnet: final synthesis           │
│  Claude Code CLI     │    │                                      │
│  (full agent with    │    │  All via tool_use (forced) for       │
│  web search, fetch,  │    │  structured output                   │
│  file I/O, bash)     │    └──────────────────────────────────────┘
└──────────────────────┘
```

---

## Research Pipeline (orchestrator.ts)

The pipeline runs in 4 phases. Total wall-clock time: ~3-5 minutes.

### Phase 1: agents_starting

**What**: Create 4 `AgentConfig` objects, persist to research record.

### Phase 2: agents_running → candidate extraction

**What**: 4 E2B sandboxes launch in parallel. As each completes, Haiku extracts candidates immediately.

```
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│ Speech Analyzer  │  │ Voting Analyzer  │  │ Constituency    │  │ Interest &      │
│                  │  │                  │  │ Analyzer        │  │ Committee       │
│ E2B SANDBOX      │  │ E2B SANDBOX      │  │ E2B SANDBOX     │  │ E2B SANDBOX     │
│ (Claude Code CLI)│  │ (Claude Code CLI)│  │ (Claude Code CLI│  │ (Claude Code CLI│
│                  │  │                  │  │                 │  │                 │
│ Tools: WebSearch │  │ Tools: WebSearch │  │ Tools: WebSearch│  │ Tools: WebSearch│
│ WebFetch, Bash,  │  │ WebFetch, Bash,  │  │ WebFetch, Bash, │  │ WebFetch, Bash, │
│ Read, Write, etc │  │ Read, Write, etc │  │ Read, Write,etc │  │ Read, Write,etc │
│                  │  │                  │  │                 │  │                 │
│ Model: Sonnet    │  │ Model: Sonnet    │  │ Model: Sonnet   │  │ Model: Sonnet   │
└────────┬────────┘  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘
         │ completes          │ completes           │ completes          │ completes
         ▼                    ▼                     ▼                    ▼
   ┌──────────┐        ┌──────────┐          ┌──────────┐        ┌──────────┐
   │ Haiku    │        │ Haiku    │          │ Haiku    │        │ Haiku    │
   │ extract  │        │ extract  │          │ extract  │        │ extract  │
   │ API CALL │        │ API CALL │          │ API CALL │        │ API CALL │
   └────┬─────┘        └────┬─────┘          └────┬─────┘        └────┬─────┘
        │                   │                      │                   │
        └───────────┬───────┴──────────┬───────────┘                   │
                    ▼                  ▼                                │
              candidateMap (merge by name, boost scores)  ◄────────────┘
              SSE → candidate events → UI
```

**Candidate merging**: When multiple agents nominate the same person, evidence arrays are concatenated and scores are averaged with a +5 bonus per additional nomination (capped at 100).

### Phase 3: finding_connections

**What**: Top 8 candidates (by score) get personal connection research via Sonnet API calls (parallel).

```
For each of top 8 candidates:
  ┌──────────────────────────────────┐
  │ Sonnet API CALL (direct)         │
  │                                  │
  │ System: "You are a congressional │
  │ staffer researching personal     │
  │ connections... Think about:      │
  │ sports, pets, alma maters,       │
  │ military, hobbies, family,       │
  │ food, travel, faith..."          │
  │                                  │
  │ Tool: submit_connections         │
  │ (forced via tool_choice)         │
  │                                  │
  │ Returns: PersonalConnection[]    │
  │ {type, detail, sharedWith,       │
  │  source, confidence}             │
  └──────────────────────────────────┘
```

Connection types: `hobby | sport | pet | alma_mater | family | food | travel | military | faith | other`

### Phase 4: synthesizing

**What**: Condense findings → final synthesis.

```
Step 1: Condense (parallel, 4× Haiku API calls)
  Each agent's raw output (100K-700K chars) → Haiku → ~6-12K chars
  Preserves: names, parties, states, votes, quotes, scores, evidence
  Drops: verbose explanations, repetition

Step 2: Synthesize (1× Sonnet API call)
  Input: condensed findings + candidate context with personal connections
  Model: claude-sonnet-4-6, max_tokens=16384
  Tool: submit_recommendations (forced)
  System: "You are a senior political strategist... approach strategies
           MUST incorporate personal connections as icebreakers..."
  Output: 5 Recommendations with:
    - alignmentScore (0-100)
    - summary
    - approachStrategy (uses personal connections)
    - sharedInterests[]
    - personalConnections[]
    - reasoningChain[]
    - talkingPoints[]
```

---

## Compute Execution Model

### E2B Sandboxes (full autonomous agents)

**What runs there**: The 4 research agents. Each is a full Claude Code instance with unrestricted tool access.

**Template**: `claude-code-latest` — a pre-built E2B template with Claude Code CLI installed.

**Lifecycle**:
1. `Sandbox.create("claude-code-latest", { timeoutMs: 300_000 })`
2. Write `research-prompt.md` (the agent's task) into sandbox
3. Write `CLAUDE.md` (agent instructions, API key docs, output format) into sandbox
4. `npm install -g @anthropic-ai/claude-code@latest` (update CLI)
5. Run: `claude -p --dangerously-skip-permissions --verbose --output-format stream-json --model claude-sonnet-4-6 < /home/user/research-prompt.md`
6. Parse NDJSON stdout line-by-line for streaming events
7. Extract `{"type":"result","result":"..."}` line for final output
8. Kill sandbox

**Environment variables passed to sandbox**:
- `ANTHROPIC_API_KEY` — for Claude Code's own LLM calls
- `CONGRESS_API_KEY` — for api.congress.gov
- `APIFY_API_KEY` — for web scraping actors
- `E2B_API_KEY` — sandbox infrastructure

**What agents can do** (Claude Code has full tool access):
- `WebSearch` — search the internet
- `WebFetch` — fetch and read any URL
- `Bash` — run arbitrary shell commands
- `Read` / `Write` / `Edit` — file operations
- `Glob` / `Grep` — file search
- Use `curl` to call Congress.gov API, GovTrack, Apify, or any other API

**Output format**: NDJSON (newline-delimited JSON). Each line is a Claude Code stream message:
```jsonl
{"type":"system","subtype":"init",...}
{"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"WebSearch","input":{...}}]}}
{"type":"assistant","message":{"content":[{"type":"tool_result","content":"..."}]}}
{"type":"result","result":"final output text","cost_usd":0.15}
```

**Error recovery**: If `sandbox.commands.run()` throws `CommandExitError`, the runner extracts `.stdout` from the error object and parses it for the result message. This is critical because Claude Code often exits non-zero but still produces useful output.

### Direct Anthropic API Calls (structured extraction)

**What runs there**: Everything else — candidate extraction, personal connections, finding condensation, final synthesis, tool call summarization.

| Call | Model | Purpose | Tool | max_tokens |
|------|-------|---------|------|------------|
| Candidate extraction (×4) | `claude-haiku-4-5-20251001` | Extract ally nominations from agent output | `nominate_candidates` (forced) | 2048 |
| Personal connections (×8) | `claude-sonnet-4-6` | Find personal icebreakers between legislators | `submit_connections` (forced) | 2048 |
| Finding condensation (×4) | `claude-haiku-4-5-20251001` | Reduce 100K-700K char outputs to ~12K | None (text) | 3000 |
| Final synthesis (×1) | `claude-sonnet-4-6` | Rank and recommend top 5 allies | `submit_recommendations` (forced) | 16384 |
| Tool summarization (per event) | `claude-haiku-4-5-20251001` | "Searching Congress.gov for FCPA voting records" | None (text) | 40 |

All structured extraction uses `tool_choice: { type: "tool", name: "..." }` to force JSON output through tool_use blocks.

**Tool summarization** has a fast path for common tools (no LLM needed):
- `WebSearch` → `"Searching: {query}"`
- `Read` → `"Reading {filename}"`
- `Write` → `"Writing {filename}"`
- `WebFetch` → `"Fetching {hostname}"`
- `Glob` → `"Finding files: {pattern}"`
- Everything else → Haiku generates a 5-12 word summary

---

## Agent Prompts

Each research agent receives two files in its sandbox:

### 1. `research-prompt.md` — The Task

Dynamically generated from `(initiative, legislator)`. Each prompt includes:
- Requesting legislator: name, party, state, chamber
- Initiative: title, description, policy area, goals
- Agent-specific task instructions
- Expected JSON output format

**Speech Analyzer** (`prompts/speech-analyzer.ts`):
```
Analyze public speeches, floor statements, and press releases from members
of the OPPOSING party to identify those who have expressed views aligned
with this initiative. Focus on finding 3-5 of the MOST promising cross-party
allies based on their public rhetoric.
```

**Voting Analyzer** (`prompts/voting-analyzer.ts`):
```
Analyze voting records and bill co-sponsorship patterns from members of the
OPPOSING party. Look for: votes where they broke with their party, bills
they've co-sponsored across the aisle, amendments in related policy areas,
committee positions on this topic.
```

**Constituency Analyzer** (`prompts/constituency-analyzer.ts`):
```
Analyze constituencies of members from the OPPOSING party to identify those
whose districts/states have strong overlap with this initiative's goals.
Consider: economic profile, demographic composition, local issues, recent
events, constituent support for related policies.
```

**Interest Analyzer** (`prompts/interest-analyzer.ts`):
```
Analyze personal interests, committee memberships, caucus affiliations, and
professional backgrounds of OPPOSING party members. Look for: committee
overlap, bipartisan caucus memberships, professional background alignment,
personal interests/hobbies, known bipartisan relationships, shared alma
maters or military service.
```

### 2. `CLAUDE.md` — Agent Instructions

Written into every sandbox. Contains:
- Role description and expected behavior
- "Be AGGRESSIVELY creative in your research"
- Available API keys and how to use them (Congress.gov, Apify, etc.)
- Required JSON output format with `allies[]` schema
- Instructions to cite sources with URLs

---

## Real-Time Streaming

### EventBus

In-memory pub/sub, one instance per research. Stored on `globalThis` to survive Next.js HMR.

```typescript
class EventBus {
  events: ResearchStreamEvent[]     // Full event log
  listeners: Set<Listener>          // Active SSE connections
  emit(event)                       // Push to log + notify listeners
  subscribe(listener, fromIndex)    // Replay from index + live
}

// globalThis singleton (survives HMR)
globalThis.__aisle_crosser_event_buses__ = Map<researchId, EventBus>
```

### Event Types

| Event | Source | Data |
|-------|--------|------|
| `research_status` | orchestrator | `{ researchId, status }` |
| `agent_event` | sandbox parser | `AgentStatusEvent \| AgentToolCallEvent \| AgentThinkingEvent \| AgentFindingEvent` |
| `candidate` | orchestrator (after Haiku extraction) | `Candidate` object |
| `candidate_update` | orchestrator (after Sonnet connections) | `{ candidateId, connections[], status }` |
| `recommendation` | orchestrator (after synthesis) | `Recommendation` object |
| `complete` | orchestrator | `{ researchId }` |
| `error` | orchestrator | `{ researchId, error }` |

### SSE Endpoint (`/api/research/stream/:id`)

**Live research**: Creates a `ReadableStream`, subscribes to EventBus. Each event becomes an SSE message with `id:`, `event:`, `data:` fields. 15-second heartbeat. Supports `Last-Event-ID` for reconnection.

**Completed research**: Returns a single static response replaying all stored data (agents, candidates, recommendations, completion event) then closes.

### Client Hook (`useResearchStream`)

`EventSource` connects to SSE endpoint. Maintains:
- `agents: Map<string, AgentState>` — updated per `agent_event`
- `candidates: Map<string, Candidate>` — updated per `candidate` and `candidate_update`
- `recommendations: Recommendation[]` — updated per `recommendation`
- `status: ResearchStatus` — updated per `research_status`

Also fetches REST `/api/research/:id` on mount for hydration (page loads after research completes).

---

## Data Model

### Legislator
```typescript
{ id, name, firstName, lastName, chamber, party, state, district?,
  imageUrl?, phone?, office?, committees[], termStart, termEnd }
```
37 seed legislators stored in `src/lib/congress/seed-data.ts`.

### Initiative
```typescript
{ id, sessionId, legislatorId, title, description, policyArea,
  goals[], existingBillIds?, status, createdAt, updatedAt }
```

### Research
```typescript
{ id, initiativeId, legislatorId, status, agents: AgentRun[],
  candidates: Candidate[], recommendations: Recommendation[],
  synthesis?, startedAt, completedAt?, error? }
```

Status lifecycle: `queued → agents_starting → agents_running → finding_connections → synthesizing → completed | failed`

### Candidate
```typescript
{ id, name, party, state, chamber, score, nominatedBy: AgentType[],
  evidence: CandidateEvidence[], connections: PersonalConnection[],
  status: "nominated" | "researching_connections" | "enriched",
  nominatedAt }
```

### Recommendation
```typescript
{ id, targetLegislatorName, targetLegislatorParty, targetLegislatorState,
  targetLegislatorChamber, alignmentScore, summary, reasoningChain[],
  approachStrategy, sharedInterests[], personalConnections[], feedback? }
```

---

## Storage

JSON files in `data/` with atomic writes:

```
data/
├── sessions/
│   └── sess_*.json
├── initiatives/
│   └── init_*.json
└── research/
    └── res_*.json   ← contains agents, candidates, recommendations
```

`store/base.ts` provides `readJSON`, `writeJSON`, `deleteJSON`, `listJSON`. Writes use `.tmp` → `rename()` for atomicity.

---

## REST API

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/legislators?q=&chamber=&party=&state=` | Search seed legislators |
| GET | `/api/legislators/:id` | Get legislator details |
| GET | `/api/legislators/:id/bills` | Congress.gov sponsored bills (10min cache) |
| POST | `/api/sessions` | Create session for a legislator |
| GET | `/api/sessions/:id` | Get session |
| GET | `/api/initiatives?legislatorId=` | List initiatives |
| POST | `/api/initiatives` | Create initiative (Zod validated) |
| GET | `/api/initiatives/:id` | Get initiative |
| PUT | `/api/initiatives/:id` | Update initiative |
| DELETE | `/api/initiatives/:id` | Delete initiative |
| POST | `/api/research` | Launch research (fire-and-forget orchestrator) |
| GET | `/api/research/:id` | Get research state |
| POST | `/api/research/:id/feedback` | Submit thumbs up/down on recommendations |
| GET | `/api/research/stream/:id` | SSE stream (live or replay) |

All input validation via Zod v4 schemas in `src/lib/utils/validation.ts`.

---

## UI Pages

### `/` — Landing
Legislator search with Senate/House autocomplete. On select → creates session → navigates to dashboard.

### `/dashboard/:legislatorId` — Dashboard
Two-column layout:
- **Left**: User initiatives with "Research This" buttons, initiative creation form
- **Right**: Auto-scraped sponsored bills from Congress.gov with "Research This" to convert to initiative

### `/research/:researchId` — Research Visualization
- **Status header**: Badge + message, spinner while running
- **Agent grid**: 2×2 layout showing each agent's current tool call (with Haiku-generated summary), thinking state, and completion status
- **Progress bar**: Phase-aware (5% queued → 55% agents → 65% connections → 85% synthesis → 100%)
- **Candidate list**: Grows live as agents nominate candidates. Shows score bars, nomination badges, and connection icons once enriched
- **Recommendation cards**: Rank badge, alignment score bar, summary, approach strategy, personal icebreakers with emoji icons, shared interest badges, reasoning chain (collapsible), feedback buttons

---

## External Dependencies

| Service | Usage | Auth |
|---------|-------|------|
| E2B | Cloud sandboxes for research agents | `E2B_API_KEY` |
| Anthropic API | Direct API calls (Haiku + Sonnet) | `ANTHROPIC_API_KEY` |
| Anthropic API (via sandbox) | Claude Code CLI inside E2B | `ANTHROPIC_API_KEY` (passed as env) |
| Congress.gov API | Member lookup, sponsored bills | `CONGRESS_API_KEY` (api.data.gov) |
| GovTrack | Voting records, cosponsorship (no auth) | None |
| Apify | Web scraping (available to sandbox agents) | `APIFY_API_KEY` (passed as env) |

---

## Cost Profile (per research run)

Rough estimates based on observed runs:

| Component | Model | Tokens (est.) | Cost (est.) |
|-----------|-------|---------------|-------------|
| 4× Research agents | Sonnet (via Claude Code) | ~200K input + ~50K output each | ~$4-8 |
| 4× Candidate extraction | Haiku | ~30K input each | ~$0.10 |
| 8× Personal connections | Sonnet | ~2K input each | ~$0.15 |
| 4× Finding condensation | Haiku | ~50K input each | ~$0.15 |
| 1× Final synthesis | Sonnet | ~30K input + ~8K output | ~$0.50 |
| ~100× Tool summaries | Haiku | ~100 tokens each | ~$0.02 |
| **Total** | | | **~$5-9** |

The research agents dominate cost because they're full Claude Code sessions with many tool calls each.
