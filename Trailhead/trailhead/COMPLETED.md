# Completed Stories

## Story 1: Slack bot skeleton ✅
Description: Create a minimal Slack Bolt AsyncApp mounted in FastAPI that responds to app_mention and slash command.

Acceptance criteria:
- ✅ Bot responds to @bot mentions with a static acknowledgment
- ✅ Slash command /compass returns static text
- ✅ Health endpoint returns ok
- ✅ Secrets loaded from .env via Pydantic Settings

## Story 2: Summarizer converts logs to multiple formats ✅
Description: Build a summarizer CLI and API endpoint that ingests logs and produces multiple output formats.

Acceptance criteria:
- ✅ Pydantic models define valid schemas for each format
- ✅ CLI with `uv run task summarize ./path` works
- ✅ Multiple output formats: bullets (default), prose, slack
- ✅ Slack output pastes cleanly into Block Kit Builder
- ✅ Unit tests assert schema validity and key fields

## Story 3: Structured Outputs enforcement ✅
Description: Use OpenAI Structured Outputs with Pydantic JSON Schema; validate and retry once on failure.

Acceptance criteria:
- ✅ Responses validated against schema (for Slack format)
- ✅ Invalid JSON retries once with corrective system note
- ✅ Clear error on repeated failure
- ✅ Streaming support with structured outputs

## Story 4: Inspect eval stub ✅
Description: Add a minimal Inspect task to check required fields and character budgets for the summary.

Acceptance criteria:
- ✅ evals/inspect.yaml contains task and dataset samples
- ✅ uv run task eval produces artifacts
- ✅ Pass/fail printed clearly
- ✅ README documents eval usage

## Story 5: Sanitization and limits ✅
Description: Add sanitization and clamping to ensure Slack-safe markdown and Block Kit limits.

Acceptance criteria:
- ✅ Control chars stripped and lengths clamped
- ✅ No hidden links or unsafe markdown patterns
- ✅ Null fields removed from Block Kit output
- ✅ Unit tests cover sanitization on adversarial inputs
- ✅ Limits documented in README

## Story 6: Rate limiting for AI calls ✅
Description: Implement rate limiting for OpenAI API calls with configurable requests per second and queue management.

Acceptance criteria:
- ✅ Configurable via AI_CALLS_PER_SECOND env var (default: 5)
- ✅ Requests queue up when rate limit is reached
- ✅ Error thrown when queue exceeds max queue size
- ✅ Rate limiter wraps all OpenAI API calls
- ✅ Rate limiter is completely internal (transparent to callers)
- ✅ Unit tests cover rate limiting, queueing, and queue overflow

## Story 7: Multi-format summarizers ✅
Description: Refactor summarization to support multiple output formats (Slack, prose, bullets) with format-specific orchestration.

Acceptance criteria:
- ✅ Three summarizers: bullets, prose, slack
- ✅ Each has format-specific prompts and orchestration
- ✅ CLI accepts `-of` / `--output_format` option
- ✅ CLI accepts `-if` / `--input_format` option
- ✅ CLI accepts `-o` / `--output` for explicit file path
- ✅ CLI accepts `-s` / `--save` for auto-generated filename in `summaries/`
- ✅ API accepts `format` query parameter
- ✅ Shared utilities in summarizers/shared.py
- ✅ Rate limiter completely internal (transparent to callers)
- ✅ Default format is bullets
- ✅ Bullets format outputs markdown bullets (3-7 main, 0-3 nested)

## Story 8: Streaming and error handling ✅
Description: Add streaming support and comprehensive error handling for AI API calls.

Acceptance criteria:
- ✅ Streaming enabled via USE_STREAMING env var
- ✅ Streaming works with structured outputs (for Slack format)
- ✅ Clear error messages printed to stderr
- ✅ Errors show request details and failure reason
- ✅ Timeout handling with configurable TIMEOUT_S

## Story 9: File output and organization ✅
Description: Add file output support and organize generated summaries.

Acceptance criteria:
- ✅ `summaries/` directory created and gitignored (except .gitkeep)
- ✅ `--save` flag auto-generates filename in summaries/ (overwrites by default)
- ✅ `--output` flag allows explicit file path
- ✅ Success message printed to stderr showing output location

## Story 10: Integrate runner configuration with config.py ✅
Description: Move runner from standalone script to use centralized configuration management via config.py.

Acceptance criteria:
- ✅ Runner uses AppSettings from config.py for configuration
- ✅ Add runner-specific settings to config.py (naming model, log directory path, etc.)
- ✅ Create Pydantic models for experiment config validation (YAML schema)
- ✅ Runner still uses Inspect AI's get_model() directly (not ai_client.py)
- ✅ Add clear warning comment in runner that it bypasses ai_client.py rate limiting
- ✅ Update .env.example with runner configuration options
- ✅ Tests validate runner config schema

## Story 11: Add API endpoint for running experiments ✅
Description: Create FastAPI endpoint in main.py to trigger experiments via HTTP, backed by the runner functionality.

Acceptance criteria:
- ✅ POST /run endpoint accepts experiment configuration (prompts, models, n)
- ✅ Endpoint validates config using Pydantic models
- ✅ Endpoint calls runner functionality to execute experiment
- ✅ Returns experiment name and log directory location
- ✅ Async execution (doesn't block the API while experiment runs)
- ✅ Add to taskipy tasks for CLI access: `uv run task run <config.yaml>`
- ✅ Document endpoint in README with example curl commands
- ✅ Tests cover endpoint validation and success responses

## Story 12: Project consolidation and cleanup ✅
Description: Consolidate gavan/ and jeremy/ subdirectories into root directory and complete the migration.

Acceptance criteria:
- ✅ Move all files from gavan/ and jeremy/ to root directory
- ✅ Clean up cache files (.venv, .pytest_cache, .ruff_cache, .direnv)
- ✅ Reinstall dependencies with uv sync
- ✅ Add all moved files to git
- ✅ Verify web server starts correctly

## Story 13: Slack slash command for summarization ✅
Description: Implement `/trailhead summarize [url]` slash command that accepts a log file URL via dispatch actions, updates message with progress, and displays summary.

Acceptance criteria:
- ✅ Register `/trailhead` slash command in Slack app config
- ✅ Command accepts URL directly (`/trailhead summarize <url>`) or shows input field
- ✅ Input field uses dispatch actions (submit on Enter key press)
- ✅ Updates same message to show progress ("Downloading..." → "Analyzing...")
- ✅ Calls existing summarizer with appropriate format (slack)
- ✅ Displays summary by updating the message (no threading in v1)
- ✅ Handles errors gracefully (invalid URL, timeout, file too large)
- ✅ Works in channels, DMs, and threads
- ✅ No `files:read` scope needed (external URLs only)
- ✅ Documentation added to README

Implementation:
- Uses dispatch action configuration with `on_enter_pressed` trigger
- Background asyncio task for summarization with message updates
- File download via httpx with size and timeout limits (10MB, 30s)
- Error handling with user-friendly messages
- Auto-detects research type from URL extension (.eval → inspect_eval)

## Story 14: Rename project from Compass to Trailhead ✅
Description: Update all references from "Compass" to "Trailhead" throughout the project to reflect the correct project name.

Acceptance criteria:
- ✅ Update pyproject.toml name and description
- ✅ Update all documentation (README.md, ARCHITECTURE.md, etc.)
- ✅ Update FastAPI app title and description in main.py
- ✅ Update module docstrings in __init__.py
- ✅ Update bot names and personas (BOT_NAME defaults, user-facing messages)
- ✅ Update Slack command documentation and examples
- ✅ Search codebase for any remaining "Compass" references and update
- ✅ Update environment variable documentation if applicable
- ✅ Ensure tests still pass after renaming
- ✅ Update .env.example with new defaults
- ✅ Remove old compass icon files

## Story 15: Clean up slack_app.py emoji usage ✅
Description: Remove redundant emoji definitions in slack_app.py and use constants from centralized location.

Acceptance criteria:
- ✅ Create src/app/constants.py with centralized emoji constants
- ✅ Remove hardcoded emojis (🔄⏳✅❌) from slack_app.py
- ✅ Import and use emoji constants throughout the app
- ✅ Move progress animation frames to constants.py
- ✅ Ensure all status messages use centralized emoji constants
- ✅ Update trailrun/orchestrator.py to use centralized constants

Implementation:
- Created src/app/constants.py at app level (not trailrun/) for wider accessibility
- Defined RUNNING, ANALYZING, SUCCESS, ERROR emoji constants
- Defined PROGRESS_FRAMES for animation
- Updated all emoji usage in slack_app.py and orchestrator.py
- Removed src/app/trailrun/utils.py (no longer needed)

## Story 18: Rename summarizer.py to summarizer_cli.py ✅
Description: Rename src/app/summarizer.py to src/app/summarizer_cli.py to better reflect its purpose as CLI entry point and match naming convention with runner_cli.py.

Acceptance criteria:
- ✅ Rename file: summarizer.py → summarizer_cli.py
- ✅ Update pyproject.toml task reference
- ✅ Update ARCHITECTURE.md documentation
- ✅ Verify CLI still works after rename

Implementation:
- Renamed to summarizer_cli.py for consistency with runner_cli.py
- Updated all references in pyproject.toml and documentation

## Story 17: Iteratively add samples until over budget ✅
Description: Update inspect_eval parser to add samples one at a time until max_chars is exceeded, instead of pre-calculating sample count.

Acceptance criteria:
- ✅ Remove pre-calculation of max_samples based on estimated chars per sample
- ✅ Iteratively format and add samples to output string
- ✅ Stop when next sample would exceed max_chars
- ✅ Ensure at least 1 sample is always included
- ✅ Update tests to verify budget enforcement

Implementation:
- Shuffle samples for random selection
- Add samples one-by-one, checking actual formatted size each time
- Stop when adding next sample would exceed budget (but we have at least 1)
- More accurate than estimation - no wasted token budget

## Story: Standardize progress indication across Slack commands ✅
Description: Replace manual progress animation with reusable ProgressIndicator context manager and add progress feedback to all long-running operations.

Acceptance criteria:
- ✅ Replace manual animation loop in process_summarization with ProgressIndicator
- ✅ Add progress to /trailhead generate during YAML generation
- ✅ Add progress to /trailhead new during YAML generation
- ✅ Add progress during bundle generation in orchestrator
- ✅ Remove PROGRESS_FRAMES from imports (now internal to ProgressIndicator)
- ✅ Consistent animated spinner across all operations

Implementation:
- Refactored 34 lines of manual animation code to 10 lines with context manager
- Added ProgressIndicator usage to YAML generation commands
- Added status update during bundle generation ("Generating data explorer...")
- All long-running operations now show progress - no more silent periods

## Story: Multi-model .eval analysis with stratified sampling ✅
Description: Parse all .eval files from multi-model experiments and ensure all questions are represented via stratified sampling.

Acceptance criteria:
- ✅ Parse ALL .eval files (one per model), not just the first
- ✅ Divide token budget proportionally across models
- ✅ Show progress: "Analyzing results (1/3)..." for each model
- ✅ Graceful error handling: continue if one model fails, only fail if ALL fail
- ✅ Combine results with clear separators for LLM comparison
- ✅ Stratified sampling by input to ensure all questions represented
- ✅ Round-robin across input groups to prevent missing questions

Implementation:
- Group samples by input (question/prompt)
- Round-robin selection: 1 sample per question in round 1, then repeat
- Shuffle within groups and randomize group order for randomness
- Prevents random sampling from missing entire questions
- Proportional budget: chars_per_model = max_chars / len(eval_files)
- Separator: "========..." between model results

## Story: Interactive experiment configuration UI ✅
Description: Replace raw YAML display with pretty-printed Slack blocks and add iterative refinement controls.

Acceptance criteria:
- ✅ Format config as Slack blocks (prompts, models, repetitions)
- ✅ Add "Make changes" input field for iterative refinement
- ✅ Add Cancel/Start buttons for explicit user control
- ✅ Don't auto-start experiments - wait for user confirmation
- ✅ Support iterative config updates via natural language
- ✅ @mention support generates config like /trailhead new
- ✅ Handle experiment_start, experiment_cancel, experiment_change actions

Implementation:
- format_experiment_config_blocks() creates pretty Slack layout
- Input field with dispatch_action for change requests
- LLM regenerates config based on current config + change request
- Can iterate multiple times before starting
- @Trailhead <description> generates config (same UX as slash command)
- Action handlers: experiment_start, experiment_cancel, experiment_change
- Clean separation: config generation → review/iterate → explicit start

## Story: Ephemeral config iteration and thread-based summaries ✅
Description: Make experiment configuration iteration ephemeral (private) and post summaries in thread while main message shows progress.

Acceptance criteria:
- ✅ Config generation and iteration uses ephemeral messages (only user sees)
- ✅ Start/Cancel post public config blocks to channel
- ✅ Progress updates happen on main message
- ✅ Summary posts as thread reply (not updating main message)
- ✅ Main message shows config + completion status
- ✅ Add title field to ExperimentConfig (generated by LLM)
- ✅ Display title in all config blocks

Implementation:
- Changed @mention and slash commands to use ephemeral messages during iteration
- Start button posts public message with config blocks
- Progress updates (Running, Analyzing, Generating bundle) update main message
- post_summary_with_fallback posts to thread using thread_ts parameter
- After summary posted, main message updates with config + "✅ Experiment complete"
- Added title: str field to ExperimentConfig model
- LLM generates descriptive 3-8 word titles for experiments

## Story: Thread-based Q&A with answerers architecture ✅
Description: Respond to any message in experiment threads with answers about the data, using DRY architecture that shares prompts between summarizers and answerers.

Acceptance criteria:
- ✅ Restructure into orchestration/analysis/ folder with summarizers, answerers, and prompts
- ✅ Extract common prompt templates (MODEL_BEHAVIOR_FOCUS, SLACK_FORMATTING_EXAMPLES, etc.)
- ✅ Create answerers for all three formats: slack, prose, bullets
- ✅ Cache research_content in Trailrun model after parsing
- ✅ Add @app.event("message") handler to respond to thread questions
- ✅ Respond to ANY message in experiment threads (not just @mentions)
- ✅ Use same 2-tier fallback as summaries (LLM correction → prose)
- ✅ Answerers use cached data (same random seed as summary)
- ✅ Slack answerer uses simplified Q&A-focused guidance (not full summary examples)

Implementation:
- Moved orchestration/summarizers/ → orchestration/analysis/summarizers/
- Created orchestration/analysis/answerers/ (slack.py, prose.py, bullets.py)
- Created orchestration/analysis/prompts/shared.py with common templates:
  - MODEL_BEHAVIOR_FOCUS (focus on model behavior, not infrastructure)
  - SLACK_FORMATTING_EXAMPLES (for full summaries)
  - SLACK_ANSWERER_GUIDANCE (simplified for Q&A)
- Added research_content: str | None to Trailrun model
- Orchestrator caches content after combining all model .eval files
- Added get_trailrun_by_thread(thread_ts) to store.py
- Message handler:
  - Ignores bot's own messages and non-thread messages
  - Looks up trailrun by thread_ts
  - Only responds if research_content is cached
  - Posts acknowledgment, calls answerer, uses post_summary_with_fallback
- Slack answerer uses SLACK_ANSWERER_GUIDANCE:
  - Section blocks for direct answers
  - Tables only when question asks for comparisons/collections
  - Dividers for readability
  - No ceremony (no headers, no metadata footers)
  - Simple, focused Q&A responses

## Story: Programmatic metadata footer for Slack summaries ✅
Description: Automatically append metadata (models, sample counts) to Slack summaries instead of having LLM discover and format it.

Acceptance criteria:
- ✅ Parser returns ParseResult with content, model_name, total_samples, included_samples
- ✅ Add metadata fields to SummarizerOptions (models, samples_included, samples_total)
- ✅ Slack summarizer auto-appends context block with metadata
- ✅ Update prompt to tell LLM not to include metadata
- ✅ Orchestrator passes metadata from parse results
- ✅ Slack command passes metadata for single .eval files

Implementation:
- Created ParseResult dataclass in parsers/inspect_eval.py
- parse_inspect_eval() returns ParseResult instead of raw string
- Extract model name from log.eval.model during parsing
- Added models, samples_included, samples_total to SummarizerOptions
- Slack summarizer appends context block: "*Models:* `model1`, `model2` | *Samples:* X of Y"
- Updated prompt: "DO NOT include models tested or sample counts (provided programmatically)"
- Orchestrator collects metadata from all parse results and aggregates
- Slack command extracts metadata from single file parse

Benefits:
- Consistent formatting (always same location/format)
- Saves LLM tokens (no need to "discover" metadata)
- No risk of LLM forgetting or misformatting
- Easy to update format later

## Story: Progress indicators for config generation/updates ✅
Description: Add animated progress indicators during config generation and updates, use single message throughout iteration.

Acceptance criteria:
- ✅ Fix missing get_trailrun import
- ✅ Show progress spinner during initial config generation (@mention)
- ✅ Show progress spinner during config updates (Make changes)
- ✅ Preserve config display during updates (don't clear message)
- ✅ Use same message throughout iteration flow

Implementation:
- Added get_trailrun to imports from trailrun.store (fixed NameError)
- @mention config generation:
  - Post regular message (not ephemeral) and capture message_ts
  - Wrap generate_experiment_yaml() with ProgressIndicator
  - Animate same message: 🔄 ⏳ 🔄 ⏳...
  - Update with config blocks on completion
  - Note: Initially tried ephemeral, but Slack API doesn't support updating ephemeral messages
- Config updates:
  - Show current config blocks with "Updating..." context footer
  - Preserve config display, remove input/buttons temporarily
  - Wrap regeneration with ProgressIndicator
  - Animate only the footer context block
  - Replace with full config (input/buttons) on completion

Result:
- Visual progress feedback during LLM calls
- Config stays visible during updates for context
- @mention configs now visible to channel (tradeoff for progress animation)

## Story: Access control for experiment actions ✅
Description: Prevent users from interfering with others' experiments by restricting Run/Cancel/Make changes to the creator.

Acceptance criteria:
- ✅ Only creator can click Run button
- ✅ Only creator can click Cancel button
- ✅ Only creator can submit Make changes input
- ✅ Helpful error message guides others to create their own experiment

Implementation:
- src/app/slack_app.py:807-814 - handle_experiment_start access check
- src/app/slack_app.py:897-904 - handle_experiment_cancel access check
- src/app/slack_app.py:992-1001 - handle_experiment_change access check
- Extract clicking_user from body["user"]["id"]
- Compare against trailrun.user_id (stored at creation)
- Show ephemeral error: "Only @creator can [action]. Want to run your own? Mention me!"

Result:
- Experiment creators have full control over their configs
- Other users can't accidentally interfere
- Clear guidance on how to create own experiment
- Maintains collaborative visibility while preventing conflicts

## Story: Update main message footer with progress ✅
Description: Remove separate thread status messages and show all progress updates on the main message's footer context block.

Acceptance criteria:
- ✅ No separate thread status message
- ✅ Progress updates on main message footer
- ✅ Cycling progress symbol animates footer
- ✅ Fix bundle generation error (variable collision)

Implementation:
- Removed thread message posting (orchestrator.py:95-100)
- Created build_config_blocks() helper function for DRY
- Use main message (trailrun.thread_ts) for all updates
- Parsing loop: Updates footer with "🔬 Analyzing (1/3)..."
- Summarization: Custom update function for ProgressIndicator to update blocks
- Bundle generation: Updates footer with "🔄 Generating data explorer..."
- Completion: Updates footer to "✅ Experiment complete"
- Fixed variable collision: renamed to experiment_result and parse_result
- Fixed bug: experiment_result.log_dir (was result.log_dir causing AttributeError)

Result:
- Cleaner UX: single message with live footer updates
- No separate status messages cluttering the thread
- Progress visible at bottom of config throughout execution
- Fixed bundle generation crash from variable name collision
- Summaries still post as thread replies (via post_summary_with_fallback)

## Story: Fix config update stalling + refactor slack_app.py into domain modules ✅
Description: Fix stalling during config updates and refactor monolithic 1119-line slack_app.py into organized domain modules with centralized handler registration.

Acceptance criteria:
- ✅ Fix config update stalling issue (progress stops mid-update)
- ✅ Add error logging to ProgressIndicator to catch silent failures
- ✅ Reduce slack_app.py to registry-only (all handlers visible at a glance)
- ✅ Extract implementations into domain-organized modules
- ✅ Centralize access control logic (DRY)
- ✅ All handlers testable in isolation

Implementation:

**Config Update Fix:**
- Added error logging to src/app/orchestration/progress.py:
  ```python
  except Exception as e:
      print(f"[Progress] Update failed: {type(e).__name__}: {e}",
            file=sys.stderr, flush=True)
      break
  ```
- Root cause: `respond()` doesn't reliably work with regular messages (only ephemeral)
- Solution: Replaced `respond()` with `client.chat_update()` in experiment_change handler
- Extract `message_ts = body["message"]["ts"]` for update calls

**Refactoring:**
Reduced slack_app.py from 1119 lines to 62 lines showing all handlers:
```python
# EVENT HANDLERS
app.event("app_mention")(handle_app_mention)
app.event("message")(handle_thread_question)

# COMMAND HANDLERS
app.command("/trailhead")(handle_trailhead_command)

# ACTION HANDLERS
app.action("log_url_input")(handle_url_input_submit)
app.action(re.compile(r"^experiment_start:"))(handle_experiment_start)
app.action(re.compile(r"^experiment_cancel:"))(handle_experiment_cancel)
app.action(re.compile(r"^experiment_change:"))(handle_experiment_change)

# MODAL HANDLERS
app.view(re.compile(r"^trailrun_config_submit:"))(handle_design_modal_submit)
```

Created organized module structure:
- **src/app/slack/utils/** - Shared utilities
  - `access.py` - `verify_experiment_owner()` helper (DRY access control)
  - `blocks.py` - `format_experiment_config_blocks()` (Slack Block Kit builder)
  - `config_gen.py` - `generate_experiment_yaml()`, `process_summarization()`
  - `personas.py` - `get_bot_persona()` (username/icon switching)

- **src/app/slack/actions/** - Action handlers
  - `url_input.py` - Log file URL input handler
  - `experiment_start.py` - Start button handler (uses verify_experiment_owner)
  - `experiment_cancel.py` - Cancel button handler (uses verify_experiment_owner)
  - `experiment_change.py` - Config change handler (uses verify_experiment_owner, uses chat_update)

- **src/app/slack/commands/** - Command handlers
  - `trailhead.py` - Main router (delegates to subcommands)
  - `summarize.py` - `/trailhead summarize [url]`
  - `yaml.py` - `/trailhead yaml` (design modal)
  - `generate.py` - `/trailhead generate <description>`
  - `new.py` - `/trailhead new <description>`

- **src/app/slack/events/** - Event handlers
  - `app_mention.py` - @mention handler (generates config)
  - `thread_questions.py` - Thread Q&A handler

**Access Control Pattern:**
Created centralized helper that sends ephemeral errors:
```python
# In slack/utils/access.py
async def verify_experiment_owner(
    trailrun_id: str,
    clicking_user: str,
    client: Any,
    channel_id: str,
    action_name: str = "perform this action"
) -> Trailrun | None:
    """Verify user owns experiment. Returns Trailrun if authorized, None otherwise."""
```

Used in all action handlers:
```python
trailrun = await verify_experiment_owner(
    trailrun_id, clicking_user, client, channel_id,
    action_name="start this experiment"
)
if not trailrun:
    return  # Error already sent
```

Benefits:
- **Visibility**: All Slack handlers visible in one 62-line file
- **Organization**: Clear domain separation (events, commands, actions, utils)
- **Testability**: Each handler can be tested in isolation
- **DRY**: Shared logic in utils/, no repetition
- **Maintainability**: Easy to add new handlers or modify existing ones
- **Debugging**: Error logging catches silent failures in progress updates
- **Reliability**: Fixed config update stalling with proper message update API

## Story: Trailrun persistence with versioned schema ✅
Description: Persist trailrun state to disk so experiments can be resumed after server restart, with proper schema versioning and migration support.

Acceptance criteria:
- ✅ Trailruns persist to JSON file in RUNNER_LOG_DIR
- ✅ Loaded on startup, saved on every create/update/delete
- ✅ Versioned file format for future migrations
- ✅ Auto-migrate legacy (unversioned) format
- ✅ Graceful handling of corrupted JSON (backup and continue)
- ✅ Fail loudly on schema mismatch (don't silently lose data)
- ✅ Ignore extra fields in old data (backward compat for removed fields)
- ✅ Reject future versions with clear error
- ✅ Backup files increment numerically (.corrupted, .corrupted.1, .corrupted.2)

Implementation:
- src/trailrun/store.py:
  - `SCHEMA_VERSION = 1` constant
  - File format: `{"version": 1, "trailruns": {...}}`
  - `_load()` handles corruption, migration, and validation
  - `_migrate_trailrun()` for adding migration logic
  - `SchemaMigrationError` raised on breaking changes
- src/trailrun/types.py:
  - Changed `extra = "forbid"` to `extra = "ignore"` for backward compat
- src/runner/runner.py and subprocess_runner.py:
  - Added `os.makedirs(log_dir, exist_ok=True)` for directory creation
- tests/unit/test_store_persistence.py: 12 tests covering all scenarios

Schema change handling:
- **Trivial (auto-handled)**: New optional fields, removed fields, legacy format
- **Breaking (fails loudly)**: New required fields without default, type changes, future version

Benefits:
- Experiments survive server restarts
- Clear migration path for schema changes
- No silent data loss on schema mismatch
- Corrupted files backed up, not lost

## Story: Add `trailhead_list` MCP tool ✅

Description: Add an MCP tool to list previous experiments so Claude Code (or other MCP clients) can see what's been run before and design novel experiments.

Acceptance criteria:
- ✅ Add `trailhead_list` tool to `src/mcp_server.py`
- ✅ Default output includes: trailrun_id, title, status, created_at
- ✅ `include_config=True` adds: model names, prompts, n
- ✅ `limit` parameter (default 20, max 100) to control how many results
- ✅ Returns most recent first (sorted by created_at desc)
- ✅ New `/trailruns/list` API endpoint to match MCP tool

Implementation:
- src/mcp_server.py: Added `trailhead_list()` MCP tool
- src/endpoints/trailruns_list.py: New endpoint with `limit` and `include_config` params
- Returns `{trailruns: [...], count: N, total: N}` structure

Benefits:
- Enables autonomous experiment agents to avoid repeating past work
- Pairs with existing `trailhead_status(trailrun_id)` for detailed single-run info
- Consistent output between MCP tool and REST API

## Story: Automatic quote citation matching with inline links ✅

Description: Any text wrapped in quotation marks (`"..."`) should be automatically fuzzy matched against source content and followed with a `[🔗]` citation link. The LLM can manually create these, but we need automated detection and verification as a safety net.

Acceptance criteria:
- ✅ Detect all `"..."` pairs in output content
- ✅ Fuzzy match quoted text against source samples/messages
- ✅ Append `[🔗]` deep link after each matched quote
- ✅ If no match found, convert to single quotes `'...'` and warn (instead of LLM loop)
- ✅ Configurable fuzzy match threshold (default 0.8)
- ✅ Works in Slack output format

Implementation:
- `verify_quotes()` in `shared.py` - fuzzy matches quotes against source content using `difflib.SequenceMatcher`
- `_verify_quotes_in_blocks()` in `slack.py` - processes all section block mrkdwn content
- Verified quotes: keep double quotes `"..."`, add `[🔗]` if highlight has deep link
- Unverified quotes: convert to single quotes `'...'` and print warning
- Uses sliding window fuzzy matching against source + highlight quotes

Benefits:
- Algorithmic approach chosen over LLM loop for speed and determinism
- Single quotes visually distinguish unverified quotes
- Threshold of 0.8 catches near-matches while avoiding false positives

## Story: Consolidate output formats to slack and markdown only ✅

Description: Remove redundant prose/bullets formats from both summarizers and answerers. The two-step architecture (LLM → markdown → format conversion) means prose/bullets are now identical to markdown output. Consolidate to just two formats: slack and markdown.

Acceptance criteria:
- ✅ Delete `summarizers/prose.py` and `summarizers/bullets.py`
- ✅ Update summarizers `__init__.py` to only export slack and markdown
- ✅ Export `process_quote_tags()` for callers that want final markdown
- ✅ Update fallback.py to use markdown + process_quote_tags instead of prose
- ✅ Create `answerers/markdown.py` as base answerer
- ✅ Update `answerers/slack.py` to use markdown base + markdown_to_slack_blocks
- ✅ Delete `answerers/prose.py` and `answerers/bullets.py`
- ✅ Update answerers `__init__.py` to only export slack and markdown
- ✅ Delete unused prompt files in `prompts/answerers/`
- ✅ Update followup endpoint to use markdown answerer

Implementation:
- Architecture: LLM generates markdown with `[[quote:N]]` tags
- For markdown output: `process_quote_tags()` converts to final markdown
- For Slack output: `markdown_to_slack_blocks()` converts to Block Kit
- Same pattern for both summarizers and answerers
- Deleted prose.py and bullets.py from both summarizers and answerers

Benefits:
- DRY architecture - single markdown generation path
- Consistent output quality across formats
- Simpler codebase with fewer files to maintain
