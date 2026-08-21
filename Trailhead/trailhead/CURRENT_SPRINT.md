# Current Sprint: Ranger Integration ✅

Ranger is an autonomous research agent that runs daily via Railway cron, spawning Claude Code in an E2B sandbox to design and execute novel experiments using Trailhead's MCP tools.

**Plan file**: `plans/ranger-cron.md`
**Implementation notes**: `RANGER_IMPLEMENTATION_NOTES.md`

---

## Story: Add RANGER source and ranger_id to Trailrun ✅

Description: Extend TrailrunSource enum with RANGER value and add ranger_id field to Trailrun model for linking experiments to Ranger sessions.

Acceptance criteria:
- ✅ Add `RANGER = "ranger"` to `TrailrunSource` enum in `src/trailrun/types.py`
- ✅ Add `ranger_id: str | None` field to `Trailrun` model
- ✅ Field description: "ID of the Ranger session that created this trailrun"
- ✅ Only set when `source == RANGER`

---

## Story: Dual-secret MCP authentication ✅

Description: Update MCP server authentication to support both TRAILHEAD_SECRET (general MCP access) and RANGER_SECRET (Ranger-specific access with auto-Slack posting).

Acceptance criteria:
- ✅ Modify `src/mcp_server.py` auth setup to accept multiple tokens
- ✅ TRAILHEAD_SECRET → client_id: "trailhead-mcp"
- ✅ RANGER_SECRET → client_id: "ranger"
- ✅ Auth works when either or both secrets are configured
- ✅ Auth disabled when neither secret is set (local dev)

---

## Story: Ranger date-based prompts ✅

Description: Create prompt generator for Ranger that varies by date - odd days for novel investigation, even days for deep dives, with holiday theming.

Acceptance criteria:
- ✅ Create `src/prompts/ranger.py` with `build_prompt()` function
- ✅ Use Pacific timezone for date calculation
- ✅ Odd days → "Novel Investigation" mode (explore new categories)
- ✅ Even days → "Deep Dive" mode (go deeper on existing work)
- ✅ Include full date string for holiday detection by Claude
- ✅ 7-stage research workflow in prompt (review → identify → choose → brainstorm → run → investigate → summarize)
- ✅ Structured JSON output format at end

---

## Story: Ranger E2B runner ✅

Description: Create runner that spawns Claude Code in E2B sandbox with Trailhead MCP configuration.

Acceptance criteria:
- ✅ Create `src/ranger/__init__.py` (empty)
- ✅ Create `src/ranger/runner.py` with `run_ranger_session()` function
- ✅ Use E2B sandbox template: `anthropic-claude-code`
- ✅ Sandbox timeout: 30 minutes
- ✅ Write MCP config to `/home/user/.claude.json` with RANGER_SECRET
- ✅ Include `X-Ranger-ID` header in MCP config for session linking
- ✅ Stream stdout line-by-line
- ✅ Parse structured JSON output from Claude Code
- ✅ Handle sandbox errors gracefully

---

## Story: Ranger store and persistence ✅

Description: Create storage layer for Ranger sessions with two-level persistence model - ranger metadata separate from trailruns.

Acceptance criteria:
- ✅ Create `src/ranger/store.py` with `RangerSession` model
- ✅ RangerSession fields: id, date, mode, status, trailrun_ids, structured, log_path, slack_thread_ts, created_at, completed_at
- ✅ Store ranger stdout in `logs/rangers/<ranger_id>.log`
- ✅ Add `rangers: []` array to trailruns.json schema
- ✅ Bump schema version to 3
- ✅ Migration: add empty `rangers` array to existing data
- ✅ Functions: `create_ranger()`, `get_ranger()`, `update_ranger()`, `list_rangers()`
- ✅ Link trailruns to rangers via `ranger_id` field

---

## Story: Ranger REST endpoints ✅

Description: Create REST API endpoints for triggering and listing Ranger sessions.

Acceptance criteria:
- ✅ Create `src/endpoints/ranger/__init__.py`
- ✅ Create `src/endpoints/ranger/run.py` with `POST /ranger/run`
  - Verify bearer token against TRAILHEAD_SECRET
  - Start background task for ranger execution
  - Return `{"status": "started", "ranger_id": "ranger_..."}`
- ✅ Create `src/endpoints/ranger/list.py` with `GET /ranger/list`
  - Return past ranger runs from rangers array
  - Support `limit` parameter (default 20)
- ✅ Register routers in `src/main.py`

---

## Story: MCP tool header-based Ranger identification ✅

Description: Modify MCP tools to extract ranger_id from X-Ranger-ID header and automatically link trailruns to Ranger sessions.

Acceptance criteria:
- ✅ Use `get_http_headers()` from `fastmcp.server.dependencies`
- ✅ Extract `x-ranger-id` header when `ctx.client_id == "ranger"`
- ✅ Pass `source=TrailrunSource.RANGER` and `ranger_id` to trailrun creation
- ✅ Update ranger's `trailrun_ids` array when trailrun is created
- ⚠️ SlackTrailrunHook registration simplified (session-level messages only)
- ✅ Update `/trailrun` POST endpoint to accept `source` and `ranger_id` params

**WORKAROUND NOTE**: `ctx.client_id` was returning None despite valid auth.
Current workaround checks Authorization header directly against
`settings.ranger_secret`. Root cause unknown - may be related to
`stateless_http=True` or FastMCP version. Needs further investigation.

---

## Story: Ranger Slack integration ✅

Description: When Ranger creates trailruns, automatically post progress and results to a dedicated Slack channel.

Acceptance criteria:
- ✅ Use `RANGER_SLACK_CHANNEL` from config for posting
- ✅ Create thread for each Ranger session (post initial "Ranger starting..." message)
- ✅ Store `slack_thread_ts` in RangerSession
- ⚠️ Simplified: Session-level Slack messages only (no per-trailrun hooks)
- ✅ Final summary includes ranger session metadata (mode, trailrun count, conclusions)

---

## Story: Add Ranger dependencies ✅

Description: Add required Python packages for Ranger functionality.

Acceptance criteria:
- ✅ Add `e2b-code-interpreter>=1.0` to pyproject.toml
- ✅ Add `json-repair>=0.30` to pyproject.toml (for parsing Claude's JSON output)
- ✅ Run `uv sync` to update lockfile
- ✅ Verify imports work

---

## Story: Update environment configuration ✅

Description: Document new environment variables for Ranger in .env.example.

Acceptance criteria:
- ✅ Add `E2B_API_KEY=` to .env.example
- ✅ Add `ANTHROPIC_API_KEY=` to .env.example
- ✅ Add `RANGER_SECRET=` to .env.example
- ✅ Add `RANGER_SLACK_CHANNEL=` to .env.example
- ✅ Add comments explaining each variable's purpose

---

## Story: Render Ranger structured JSON as Block Kit

Description: Parse the final structured JSON output from Ranger and render it as Slack Block Kit instead of a raw code block.

Acceptance criteria:
- [ ] Extract `structured` field from completed Ranger session
- [ ] Build Block Kit blocks for each field:
  - Category/subcategory as header
  - `is_new_category` as emoji indicator (✨ new vs 📚 existing)
  - `conclusions` as bullet list
  - `open_questions` as quoted list
  - `trailruns` as linked list (viewer URLs)
- [ ] Post formatted blocks to ranger channel on completion
- [ ] Fallback to JSON code block if parsing fails

---

## Story: Pretty Ranger Slack Output ✅

Description: Improve Ranger stdout streaming to Slack with better formatting, markdown conversion, and DRY utilities.

Acceptance criteria:
- ✅ Tool names formatted as `Title()` with params (e.g., `Create()`, `Design("description...")`)
- ✅ Strip MCP prefix from trailhead tools (`mcp__trailhead__trailhead_create` → `Create`)
- ✅ All messages prefixed with ⏺ (filled circle) except completion/failure
- ✅ Convert markdown to Slack mrkdwn (`**bold**` → `*bold*`, `## headers` → `*headers*`)
- ✅ Remove text truncation (let Slack handle "see more")
- ✅ Format trailhead tool results:
  - `create` → `→ tr_ABC123`
  - `design` → Block Kit config card via `build_config_blocks()`
  - `run` → `✅ Experiment complete (N samples)`
  - `summarize/ask` → markdown converted to mrkdwn
- ✅ Completion shows elapsed time instead of cost
- ✅ Use existing `_convert_inline_formatting()` from summarizers
- ✅ MCP tools silent for Ranger unless `RANGER_TRAILHEAD_SLACK_CHANNEL` is set

Implementation:
- `src/endpoints/ranger/run.py`: `_markdown_to_mrkdwn()`, `_format_tool_name()`, `_format_tool_params()`, `_format_trailhead_result()`
- `src/config.py`: Added `ranger_trailhead_slack_channel` setting
- `src/mcp_server.py`: Conditional Slack posting based on new setting

---

## Story: Improve Slack output for tool calls

Description: Currently tool_use and tool_result events are streamed separately. Improve the display by nesting tool results inside their tool calls for cleaner output.

**Future approach** (not implementing yet):
- Track `tool_use_id` from tool_use events
- When tool_result arrives, look up the corresponding tool_use
- Format as nested display:
  ```
  🔧 Using tool: Bash
     → Command: ls -la
     → Result: total 64...
  ```
- Skip displaying tool_result separately

**Current behavior**: Shows tool_use and tool_result as separate lines. This is simpler but more verbose.
