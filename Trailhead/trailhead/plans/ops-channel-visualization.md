# Plan: MCP/API Slack Visualization (Ops Channel)

## Goal
When experiments run via MCP or REST API (not Slack), post progress and results to a designated Slack ops channel. This gives visibility into non-Slack experiment runs using the same UI.

## Key Decisions
- Each experiment gets its own thread (new top-level message)
- Distinguish MCP (🔌) vs API (📡) in the message
- Read-only for progress/results (no Start/Cancel buttons)
- **Can @mention bot in thread for follow-up Q&A** (reuses existing infrastructure)
- Optional - skip gracefully if `SLACK_OPS_CHANNEL` not configured

## Implementation Steps

### 1. Add Configuration
**File: `src/config.py`**
- Add `slack_ops_channel: str | None = None` to Settings
- Maps to `SLACK_OPS_CHANNEL` env var

### 2. Add MCP Source Type
**File: `src/trailrun/types.py`**
- Add `MCP = "mcp"` to `TrailrunSource` enum (currently has SLACK, API, CLI)

### 3. Create Ops Channel Helper
**File: `src/slack/ops_channel.py`** (new file)
```python
async def create_ops_thread(
    trailrun_id: str,
    source: TrailrunSource,  # MCP or API
    config: ExperimentConfig,
) -> str | None:
    """Create initial message in ops channel, return thread_ts or None if not configured."""
```
- Initialize Slack WebClient using existing credentials
- Post message with source icon (🔌 MCP / 📡 API) and config display
- Return thread_ts for hook registration
- Gracefully handle: no env var, bot not in channel, Slack errors

### 4. Register Hook for MCP/API Trailruns
**File: `src/trailrun/phases/run.py`** (or wherever run phase starts)
- Before running experiment, check if source is MCP/API
- If so, call `create_ops_thread()` to create Slack thread
- Store `thread_ts` and `channel_id` on trailrun
- Register `SlackTrailrunHook` for that thread
- Hook handles all subsequent events (progress, summary, complete/fail)

### 5. Update MCP/API Entry Points
**Files:**
- `src/mcp_server.py` - set `source=TrailrunSource.MCP` on create
- `src/endpoints/trailrun/create.py` - set `source=TrailrunSource.API`

### 6. Config Display Without Buttons
**File: `src/trailrun/blocks.py`**
- `build_config_blocks()` already exists
- Either add `show_buttons=False` param, or create variant for ops channel
- Ops channel shows config info but no Start/Cancel buttons

## Files to Modify
1. `src/config.py` - add `slack_ops_channel`
2. `src/trailrun/types.py` - add `MCP` to TrailrunSource
3. `src/slack/ops_channel.py` - new helper file
4. `src/trailrun/phases/run.py` - hook registration for MCP/API
5. `src/mcp_server.py` - set source=MCP
6. `src/endpoints/trailrun/create.py` - set source=API
7. `src/trailrun/blocks.py` - optional button param

## Edge Cases Handled
- **No ops channel configured**: Skip silently (no error)
- **Bot not in channel**: Log warning, continue without Slack updates
- **Concurrent experiments**: Each gets own thread via unique thread_ts
- **Q&A support**: Works automatically - trailrun has thread_ts, `app_mention` handler finds it
