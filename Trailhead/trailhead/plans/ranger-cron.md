# Ranger Integration Plan

## Overview

Ranger is an autonomous research agent that runs daily via Railway cron, spawning Claude Code in an E2B sandbox to design and execute novel experiments using Trailhead's MCP tools.

## Current State (Verified)

### Infrastructure Already Complete
- **Hooks infrastructure**: `src/trailrun/hooks.py` with `HookRegistry`, `LoggingHook`, `PersistenceHook`
- **Slack hook**: `src/slack/hooks.py` with `SlackTrailrunHook`
- **Events system**: `src/trailrun/events.py` with `EventType` enum and `TrailrunEvent`
- **Phase functions**: `src/trailrun/phases/` with `design_trailrun`, `run_trailrun`, `summarize_trailrun`, `ask_trailrun`
- **State machine**: `src/trailrun/state.py` with `create_trailrun`, `update_trailrun`, `emit_progress`
- **TrailrunSource enum**: Already has SLACK, API, CLI - just need to add RANGER
- **MCP server**: Already has `StaticTokenVerifier` for `TRAILHEAD_SECRET`

### Key Design Decisions (from user)
1. **Hooks infrastructure is ready** - can proceed directly
2. **Separate Ranger channel** - not using ops channel approach (that's an old plan)
3. **Separate persistence** - `rangers` array in `trailruns.json`, not query-by-source

---

## Architecture Flowchart

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            RANGER FLOW                                       │
└─────────────────────────────────────────────────────────────────────────────┘

┌──────────────┐      POST /ranger/run        ┌──────────────────────────────┐
│              │      (TRAILHEAD_SECRET)      │                              │
│  Railway     │ ───────────────────────────► │  Trailhead                   │
│  Cron        │                              │  (FastAPI)                   │
│              │                              │                              │
└──────────────┘                              └──────────────┬───────────────┘
   (noon PST)                                                │
                                                             │ spawns
                                                             ▼
                                              ┌──────────────────────────────┐
                                              │                              │
                                              │  E2B Sandbox                 │
                                              │  ┌────────────────────────┐  │
                                              │  │                        │  │
                                              │  │  Claude Code           │  │
                                              │  │                        │  │
                                              │  └───────────┬────────────┘  │
                                              │              │               │
                                              └──────────────┼───────────────┘
                                                             │
                                                             │ MCP calls
                                                             │ (RANGER_SECRET)
                                                             ▼
┌──────────────┐                              ┌──────────────────────────────┐
│              │                              │                              │
│  Slack       │ ◄─────────────────────────── │  Trailhead MCP               │
│  #ranger     │      posts updates           │                              │
│              │                              │  sees RANGER_SECRET          │
└──────────────┘                              │  → client_id = "ranger"      │
                                              │  → auto-post to Slack        │
                                              │  → tag source = "ranger"     │
                                              └──────────────────────────────┘
```

## Two Secrets, Two Purposes

| Secret | Used by | For what |
|--------|---------|----------|
| `TRAILHEAD_SECRET` | Cron → Trailhead REST API | "Start a Ranger run" |
| `RANGER_SECRET` | Claude Code → Trailhead MCP | "I'm Ranger, post to Slack" |

---

## Implementation Plan

### Step 1: Configuration (`src/config.py`)

Add new settings:
```python
e2b_api_key: str | None = Field(default=None, alias="E2B_API_KEY")
anthropic_api_key: str | None = Field(default=None, alias="ANTHROPIC_API_KEY")
ranger_secret: str | None = Field(default=None, alias="RANGER_SECRET")
ranger_slack_channel: str | None = Field(default=None, alias="RANGER_SLACK_CHANNEL")
```

### Step 2: TrailrunSource Enum + Trailrun Model (`src/trailrun/types.py`)

Add RANGER source and `ranger_id` field:
```python
class TrailrunSource(str, Enum):
    SLACK = "slack"
    API = "api"
    CLI = "cli"
    RANGER = "ranger"  # Created by Ranger autonomous agent

class Trailrun(BaseModel):
    # ... existing fields ...

    # Ranger linkage (only set when source == RANGER)
    ranger_id: str | None = Field(
        default=None,
        description="ID of the Ranger session that created this trailrun"
    )
```

### Step 3: MCP Auth Update (`src/mcp_server.py`)

Modify auth to support both secrets:
```python
tokens = {}
if TRAILHEAD_SECRET:
    tokens[TRAILHEAD_SECRET] = {"client_id": "trailhead-mcp"}
if RANGER_SECRET:
    tokens[RANGER_SECRET] = {"client_id": "ranger"}

auth = StaticTokenVerifier(tokens=tokens) if tokens else None
```

### Step 4: Ranger Prompts (`src/prompts/ranger.py`)

Date-based prompt generation:
- Pacific timezone date calculation
- Odd days → "Novel Investigation" mode (explore new categories)
- Even days → "Deep Dive" mode (go deeper on existing work)
- **Holiday theming**: Include full date string (e.g., "December 25, 2024") in prompt so Claude can detect holidays and incorporate thematic elements (Halloween = spooky/deceptive AI, Valentine's = emotions/relationships, July 4th = freedom/autonomy)

**7-Stage Research Workflow:**

1. **Review Previous Experiments** (ALWAYS - not just deep dive)
   - Use `trailhead_list` to see all past experiments
   - Categorize them by category → subcategory
   - Count experiments in each
   - Write out the categorization before proceeding

2. **Identify Opportunities**
   - Pick 2 EXISTING subcategories worth deeper exploration
   - Brainstorm 2 NEW subcategories that haven't been explored
   - Write 1-2 sentences about what makes each interesting

3. **Choose Direction**
   - Pick ONE option to explore today
   - Explain why it's interesting and what you hope to learn

4. **Brainstorm Experiment Ideas**
   - Within the chosen direction, brainstorm 5 specific ideas
   - Describe model TYPES not versions ("flagship from OpenAI vs Anthropic")

5. **Run the Best Experiment**
   - `trailhead_create` → `trailhead_design` → `trailhead_run` → `trailhead_summarize`

6. **Investigate**
   - Ask 2-3 follow-up questions using `trailhead_ask`
   - Dig into surprising results, model differences, edge cases

7. **Summary with Structured Output**
   - Write brief summary of category, findings, remaining questions
   - Output JSON block with structured data:

```json
{
  "trailruns": ["tr_xxx", "tr_yyy"],
  "category": "What broad category you explored",
  "subcategory": "Specific subcategory",
  "is_new_category": true,
  "conclusions": ["Key finding 1", "Key finding 2"],
  "open_questions": ["Question for future exploration"]
}
```

### Step 5: Ranger Runner (`src/ranger/runner.py`)

E2B orchestration:
- `SANDBOX_TEMPLATE = "anthropic-claude-code"`
- `SANDBOX_TIMEOUT = 30 minutes`
- Write MCP config to `/home/user/.claude.json` with `RANGER_SECRET`
- Stream stdout line-by-line
- Parse structured JSON output

MCP config written to sandbox (includes ranger_id in headers for reliable linking):
```json
{
  "mcpServers": {
    "trailhead": {
      "type": "http",
      "url": "https://trailhead.example.railway.app/mcp",
      "headers": {
        "Authorization": "Bearer <RANGER_SECRET>",
        "X-Ranger-ID": "ranger_20241217"
      }
    }
  }
}
```

The `X-Ranger-ID` header is set by the runner before spawning the sandbox, ensuring all MCP calls from this session are reliably linked to the ranger.

### Step 6: Ranger Store (`src/ranger/store.py`)

**Two-Level Persistence Model:**

1. **`rangers`** - Ranger session metadata (the orchestration layer):
   - E2B sandbox session info
   - Structured JSON output (end summary from Claude Code)
   - List of `trailrun_ids` created during this session
   - Date, mode (novel/deep dive), status
   - **Stdout stored separately** in `logs/rangers/<ranger_id>.log`

2. **Regular `trailruns`** - The actual experiments:
   - Normal trailruns in the existing `trailruns` dict
   - Tagged with `source: "ranger"` to identify origin
   - Each includes `ranger_id` field to link back to the session

```python
# trailruns.json structure
{
    "version": 3,  # Bump schema version
    "trailruns": {
        "tr_xxx": {
            "id": "tr_xxx",
            "source": "ranger",           # Identifies this came from Ranger
            "ranger_id": "ranger_20241217",  # Links to parent session
            # ... normal trailrun fields
        },
        "tr_yyy": { ... }
    },
    "rangers": [
        {
            "id": "ranger_20241217",
            "date": "2024-12-17",
            "mode": "novel",              # "novel" (odd days) or "deep_dive" (even days)
            "status": "running|success|failed",
            "trailrun_ids": ["tr_xxx", "tr_yyy"],  # All experiments from this session
            "structured": {               # End summary JSON from Claude Code
                "trailruns": ["tr_xxx"],
                "category": "Reasoning",
                "subcategory": "Arithmetic",
                "is_new_category": false,
                "conclusions": ["..."],
                "open_questions": ["..."]
            },
            "log_path": "logs/rangers/ranger_20241217.log",  # Full stdout stored here
            "slack_thread_ts": "...",     # Slack thread for this session
            "created_at": "2024-12-17T12:00:00Z",
            "completed_at": "2024-12-17T12:45:00Z"
        }
    ]
}
```

**Linking Strategy:**
- Ranger ID is passed via MCP config header (not prompt-based)
- When Ranger creates a trailrun via MCP, the `ranger_id` header is extracted
- The trailrun gets `source: "ranger"` and `ranger_id: <from_header>`
- The ranger's `trailrun_ids` array is updated to include the new trailrun
- Bidirectional querying:
  - "Show me all trailruns from this Ranger session" → query by `ranger_id`
  - "What session created this trailrun?" → look up `ranger_id`

### Step 7: Ranger Endpoints

**`src/endpoints/ranger/run.py`**:
```python
@router.post("/ranger/run")
async def ranger_run(authorization: str = Header(...)):
    # Verify bearer token against settings.trailhead_secret
    # Start background task
    # Return {"status": "started"}
```

**`src/endpoints/ranger/list.py`**:
```python
@router.get("/ranger/list")
async def ranger_list(limit: int = 20):
    # Return past Ranger runs from rangers array
```

### Step 8: MCP Tool Modifications

**Header-Based Ranger Identification:**

Claude Code automatically includes all headers from the MCP config on every request. This is standard MCP HTTP transport behavior - no prompting required.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  RANGER SESSION FLOW                                                     │
└─────────────────────────────────────────────────────────────────────────┘

1. POST /ranger/run triggered (Railway cron)
   │
   ▼
2. Create ranger record: { id: "ranger_20241217", status: "running", ... }
   │
   ▼
3. Write MCP config to E2B sandbox with ranger_id baked into headers:
   │
   │  /home/user/.claude.json:
   │  {
   │    "mcpServers": {
   │      "trailhead": {
   │        "headers": {
   │          "Authorization": "Bearer <RANGER_SECRET>",
   │          "X-Ranger-ID": "ranger_20241217"    ◄── SET BY RUNNER
   │        }
   │      }
   │    }
   │  }
   │
   ▼
4. Claude Code starts, calls trailhead_create()
   │
   │  HTTP Request includes:
   │    Authorization: Bearer <RANGER_SECRET>
   │    X-Ranger-ID: ranger_20241217              ◄── AUTOMATICALLY INCLUDED
   │
   ▼
5. MCP tool extracts headers:
   │
   │  from fastmcp.server.dependencies import get_http_headers
   │
   │  headers = get_http_headers()
   │  ranger_id = headers.get("x-ranger-id")  # "ranger_20241217"
   │
   │  # Also check client_id from auth
   │  # ctx.client_id == "ranger" (from RANGER_SECRET → StaticTokenVerifier)
   │
   ▼
6. Trailrun created with linkage:
   │
   │  trailrun = create_trailrun(
   │      source=TrailrunSource.RANGER,
   │      ranger_id="ranger_20241217"
   │  )
   │
   ▼
7. Ranger's trailrun_ids array updated:
   │
   │  ranger.trailrun_ids.append(trailrun.id)
   │
   ▼
8. Repeat for each trailhead_create() call in session
```

**MCP Tool Code:**

```python
from fastmcp import Context
from fastmcp.server.dependencies import get_http_headers

@mcp.tool
async def trailhead_create(ctx: Context) -> dict[str, Any]:
    """Create a new trailrun. Returns trailrun_id to use with other tools."""

    # Check if this is a Ranger client
    is_ranger = ctx.client_id == "ranger"

    # Extract ranger_id from custom header (set in MCP config by runner)
    headers = get_http_headers()
    ranger_id = headers.get("x-ranger-id") if is_ranger else None

    # Determine source
    source = TrailrunSource.RANGER if is_ranger else TrailrunSource.API

    # Create trailrun via REST API
    response = await _request(
        "POST",
        "/trailrun",
        json={
            "source": source.value,
            "ranger_id": ranger_id
        }
    )

    # If ranger, also update the ranger's trailrun_ids array
    if is_ranger and ranger_id:
        await _update_ranger_trailruns(ranger_id, response["trailrun_id"])

    # If ranger + Slack channel configured, register Slack hook
    if is_ranger and settings.ranger_slack_channel:
        await _register_ranger_slack_hook(
            trailrun_id=response["trailrun_id"],
            ranger_id=ranger_id
        )

    return response
```

**Why This Works:**
- MCP HTTP transport spec requires clients to include configured headers on all requests
- Claude Code follows this spec - headers in `.claude.json` are sent automatically
- No prompting or relying on Claude to "remember" to include the ID
- Guaranteed linkage for every trailrun created in the session

### Step 9: Dependencies (`pyproject.toml`)

Add:
```toml
e2b>=1.0
json-repair>=0.30
```

### Step 10: Environment Variables (`.env.example`)

Add:
```
E2B_API_KEY=
ANTHROPIC_API_KEY=
RANGER_SECRET=
RANGER_SLACK_CHANNEL=
```

---

## Files Summary

| File | Action | Description |
|------|--------|-------------|
| `src/config.py` | Modify | Add e2b_api_key, anthropic_api_key, ranger_secret, ranger_slack_channel |
| `src/trailrun/types.py` | Modify | Add RANGER to TrailrunSource enum, add ranger_id field |
| `src/trailrun/store.py` | Modify | Bump schema, add rangers migration |
| `src/mcp_server.py` | Modify | Add RANGER_SECRET auth, modify tools for Slack auto-posting |
| `src/prompts/ranger.py` | Create | Date-based prompt generation |
| `src/ranger/__init__.py` | Create | Empty init |
| `src/ranger/runner.py` | Create | E2B sandbox orchestration |
| `src/ranger/store.py` | Create | Ranger run persistence |
| `src/endpoints/ranger/run.py` | Create | POST /ranger/run endpoint |
| `src/endpoints/ranger/list.py` | Create | GET /ranger/list endpoint |
| `src/main.py` | Modify | Register ranger routers |
| `pyproject.toml` | Modify | Add e2b, json-repair deps |
| `.env.example` | Modify | Add new env vars |

---

## Research Findings (Resolved)

### FastMCP client_id Access
FastMCP provides `ctx.client_id` via the Context parameter:
```python
from fastmcp.server.context import Context

@mcp.tool
async def trailhead_create(ctx: Context) -> dict[str, Any]:
    client_id = ctx.client_id  # Returns "ranger" when using RANGER_SECRET
    ...
```

### FastMCP Header Access
FastMCP provides `get_http_headers()` from `fastmcp.server.dependencies` which returns request headers including custom ones like `X-Ranger-ID`.

### E2B Claude Code Setup
E2B has an official example: `e2b-dev/claude-code-fastapi`. Key findings:
- **Custom sandbox template required** - Build with `template/build.py`
- **Template aliases**: `claude-code-dev` (dev) or `claude-code` (prod)
- **MCP config format**:
```json
{
  "mcpServers": {
    "trailhead": {
      "type": "http",
      "url": "https://trailhead.example.railway.app/mcp",
      "headers": {
        "Authorization": "Bearer ${RANGER_SECRET}"
      }
    }
  }
}
```
- **Environment variables**: `ANTHROPIC_API_KEY`, `E2B_API_KEY`

### Slack Threading Strategy
When `client_id == "ranger"`:
1. `trailhead_create` posts initial message to `RANGER_SLACK_CHANNEL`
2. Store `thread_ts` in trailrun (new field: `ranger_thread_ts`)
3. Register `SlackTrailrunHook` with that thread
4. Subsequent trailruns in same Ranger session use same thread

---

## Schema Migration

When adding `rangers` to `trailruns.json`, bump version to 3 with migration that adds empty `rangers: []` array. Existing trailruns remain unchanged.

---

## Known Issues / Future Backlog

1. **Server restart during ranger execution**: If the server restarts while a ranger is running, the E2B sandbox continues but we lose connection. The ranger will be stuck in "running" status. Future: store E2B sandbox ID, attempt reconnect or mark as failed on startup.

2. **Race condition in trailrun_ids array**: If Claude Code creates trailruns very rapidly, concurrent updates to the ranger's `trailrun_ids` array could cause lost writes. Likely not an issue since MCP calls are serialized, but monitor and add locking if needed.

---

## Appendix: Full Prompt Template

Reference implementation from `cron/cronima.py`:

```python
def build_prompt(research_focus: str | None = None) -> str:
    """Build the prompt for Claude Code."""
    today = get_today_pacific()
    date_str = today.strftime("%A, %B %d, %Y")  # e.g., "Tuesday, December 17, 2024"
    day = today.day
    is_odd = day % 2 == 1

    # Build date-based mode instruction
    if is_odd:
        mode_instruction = f"""
**Today's Date:** {date_str} (day {day} is ODD)

🔬 **MODE: NOVEL INVESTIGATION**
Today is an odd-numbered day, so your mission is to explore something NEW. Look for:
- Categories that have never been tested
- Completely fresh angles on AI behavior
- Creative experiments unlike anything done before

Push boundaries. Be innovative. Surprise us.
"""
    else:
        mode_instruction = f"""
**Today's Date:** {date_str} (day {day} is EVEN)

🔍 **MODE: DEEP DIVE INVESTIGATION**
Today is an even-numbered day, so your mission is to go DEEPER on existing work. Look for:
- An interesting experiment from the past that deserves follow-up
- Unanswered questions from previous results
- Variations that could reveal more nuance

Build on what we've learned. Dig deeper. Find the details.
"""

    # Add holiday theming hint
    holiday_instruction = f"""
**Holiday Check:** If today ({date_str}) is or is near a notable US holiday, consider
theming your experiment around it! Halloween = spooky/deceptive AI, Valentine's = emotions/relationships,
July 4th = freedom/autonomy, etc. Be creative with the theme while still doing rigorous research.
"""

    focus_instruction = ""
    if research_focus:
        focus_instruction = f"""
**Research Focus:** {research_focus}
Design experiments that explore this area specifically.

"""

    return f"""\
You are an autonomous AI research agent. Your job is to design and run creative LLM experiments using Trailhead.

Work through these stages carefully. Take your time - this is a daily job, not a rush.
{mode_instruction}
{holiday_instruction}
{focus_instruction}
---

## Stage 1: Review Previous Experiments

Use `trailhead_list` to see what experiments have been run. Categorize them:

- List all categories that have been explored
- Under each category, list subcategories
- Note how many experiments fall into each

Example:
```
CATEGORIES EXPLORED:
- Reasoning (3 experiments)
  - Arithmetic (2)
  - Logic puzzles (1)
- Creativity (2 experiments)
  - Humor (1)
  - Analogies (1)
```

Write out your categorization before proceeding.

---

## Stage 2: Identify Opportunities

**A. Pick 2 EXISTING subcategories** worth deeper exploration:
- Only tested once and deserves more investigation
- Has interesting follow-up questions from previous results

**B. Brainstorm 2 NEW subcategories** that haven't been explored:
- Entirely new categories
- New angles within existing categories

For each of the 4 options, write 1-2 sentences about what makes it interesting.

---

## Stage 3: Choose Your Direction

Pick ONE option to explore today. Explain:
- What you chose
- Why it's interesting
- What you hope to learn

---

## Stage 4: Brainstorm Experiment Ideas

Within your chosen direction, brainstorm 5 specific experiment ideas.

Each idea should be a 2-3 sentence description. Don't specify exact model versions - describe what KIND of models:
- "Compare flagship models from OpenAI and Anthropic"
- "Test a fast/cheap model vs a capable reasoning model"
- "Compare an open-source model vs a closed model"

---

## Stage 5: Run the Best Experiment

Pick the most interesting idea. Run it:

1. `trailhead_create` - get a trailrun_id
2. `trailhead_design` - pass your experiment description
3. `trailhead_run` - execute it (takes 1-3 minutes)
4. `trailhead_summarize` - get results

---

## Stage 6: Investigate

Ask 2-3 follow-up questions using `trailhead_ask`:
- Dig into surprising results
- Ask about specific model differences
- Explore edge cases

---

## Stage 7: Summary

Write a brief summary:
1. What category/subcategory you explored
2. What you found
3. What questions remain for future exploration

---

## Final Output

At the very end, output a JSON block tagged with ```json that contains:

```json
{{
  "trailruns": ["tr_xxx", "tr_yyy"],
  "category": "What broad category you explored",
  "subcategory": "Specific subcategory",
  "is_new_category": true,
  "conclusions": [
    "Key finding 1",
    "Key finding 2"
  ],
  "open_questions": [
    "Question for future exploration 1"
  ]
}}
```

This structured output helps track research progress over time.

---

Now begin with Stage 1.
"""
```
