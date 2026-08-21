# Unified Refactor Plan

**Sources**: `HUMAN__CODE_REVIEW_PASS.md` (1-hour timebox review) + `REFACTOR_PLAN.md` (dictated improvements)

---

## Phase 1: Root Directory Cleanup

### 1.1 Remove Legacy Directories
| Directory | Action | Reason |
|-----------|--------|--------|
| `evals/` | Delete | Unused until we define Trailhead evaluation strategy |
| `research/` | Delete | Legacy folder, no longer needed |
| `summaries/` | Delete | Legacy folder, should be removed |

### 1.2 Investigate Directories
| Directory | Action |
|-----------|--------|
| `inspect_testing/logs/` | Investigate purpose, likely legacy |
| `logs/` | Clarify purpose, may need cleanup |

### 1.3 Public Folder
- `trailhead-icon-evidence.png` - Remove (half-finished feature)

---

## Phase 2: Documentation Updates

### 2.1 `.env` File
- Reorder for better grouping
- Remove `runner_naming_model` (wrong model)

### 2.2 `ARCHITECTURE.md`
- Fix "2 services" claim (incorrect)
- Remove: bot personas, slash commands
- Replace slash commands with @-tagging docs
- Rebuild data contracts section
- Improve JSON insurance docs
- Review: standardization in Slack (causes bugs)
- Review: file path ingestion (remove if unused)
- Rebuild project layout section

### 2.3 `CLAUDE.md`
- Remove "Clear data flow" section
- Remove project structure section (duplicate of ARCHITECTURE)
- Rewrite model names section
- Remove references section
- Add story numbering system
- Split sprint docs from README content
- Documentation = current snapshot, not history

### 2.4 `README.md`
- Complete rebuild to reflect current state

---

## Phase 3: Testing Structure

### 3.1 Test Organization
- Split tests into:
  1. Tests that call LLMs (use rate limiter)
  2. Tests that don't call LLMs

### 3.2 One-Off Tests
- Rename to `tests/one_off/` (underscore)
- Add to `.gitignore`
- Add note to `CLAUDE.md`: agents use this for temporary Python tests
- These tests are fragile, shouldn't persist

### 3.3 `conftest.py` Fixes
- Review token spoofing
- Update outdated model names

---

## Phase 4: Delete Legacy Code

### 4.1 Delete `trailrun/design.py`
- **Status**: Legacy, not used
- **Reason**: Modal-based YAML config replaced by inline generation
- **Action**: Delete file, verify no remaining imports

### 4.2 Remove "bot evidence" persona
- **Files**: `slack/utils/personas.py`, `config.py`
- **Reason**: Single persona for foreseeable future
- **Action**:
  - Simplify `personas.py` to single persona
  - Remove from settings: `bot_evidence_name`, `bot_evidence_icon_url`
  - Remove `message_type` parameter from `get_bot_persona()`

---

## Phase 5: Create New Directories

### 5.1 `src/app/cli/`
Create CLI folder and merge entry points:
- `runner_cli.py` → `cli/runner.py`
- `summarizer_cli.py` → `cli/summarizer.py`
- Create unified entry point (separate implementation files OK)

### 5.2 `src/app/utils/`
Create top-level utils folder:
- `orchestration/file_utils.py` → `utils/file_utils.py`
- `orchestration/progress.py` → `utils/progress_indicator.py`
- `orchestration/rate_limiter.py` → `utils/rate_limiter.py`
- `orchestration/sanitize.py` → `utils/sanitize.py`

### 5.3 `src/app/endpoints/`
Create endpoints folder (mirror `slack/` structure):
- Extract routes from `main.py`
- Clean HTML generation (find Python library)
- Remove mock client code
- Nest non-Slack access under approved URL paths

### 5.4 `src/app/orchestration/client/`
Break up `ai_client.py` (~400+ lines):
- `client/__init__.py` - exports
- `client/llm.py` - `call_llm()` function
- `client/image.py` - `generate_image()` function
- `client/providers.py` - provider-specific logic (OpenRouter, Gemini, etc.)

---

## Phase 6: Move Files

### 6.1 Slack-Related Moves
| From | To | Reason |
|------|-----|--------|
| `slack_app.py` | `slack/app.py` | Group with Slack code |
| `orchestration/slack_fallback.py` | `slack/utils/fallback.py` | Slack-specific logic |

### 6.2 Utility Moves
| From | To | Reason |
|------|-----|--------|
| `model_repository.py` | `utils/model_repository.py` | General utility for fetching OpenRouter models |

---

## Phase 7: Rename Files

### 7.1 `models.py` → `types.py`
Rename in all locations (NOT a types folder):
- `src/app/models.py` → `src/app/types.py`
- `src/app/trailrun/models.py` → `src/app/trailrun/types.py`
- `src/app/runner/models.py` → `src/app/runner/types.py`

### 7.2 `constants.py` → `slack/progress_constants.py`
- **Current**: `src/app/constants.py`
- **Target**: `src/app/slack/progress_constants.py`
- **Reason**: Progress animation frames and status emojis are Slack-specific

---

## Phase 8: Break Up Large Files

### 8.1 `trailrun/orchestrator.py`
Extract into:
```
trailrun/
  orchestrator.py     - main orchestration flow
  blocks.py           - Slack block building (build_config_blocks, etc.)
  phases.py           - phase-specific logic (run, report)
```

### 8.2 `main.py`
- Extract routes to `endpoints/` folder
- Update FastAPI description
- Clean up HTML generation
- Remove mock client

---

## Phase 9: Feature Improvements

### 9.1 Literal Prompt Detection
- **Location**: `slack/utils/config_gen.py`
- **Requirement**: Detect explicit delimiters, use content literally
- **Delimiters**:
  - Backticks: `` `hello world` ``
  - Code blocks: ``` ```hello world``` ```
  - Quotes: `"hello world"` or `'hello world'`
- **Behavior**: Content inside delimiters = exact prompt text
- **Example**: User says "test with `What is 2+2?`" → prompt is exactly "What is 2+2?"

---

## Phase 10: Other Fixes

### 10.1 Source Directory
- Clarify `src/app/` structure: either rename to `src/` or document as server (if separate frontend planned)

### 10.2 Configuration
- Review streaming config (might remove)
- Review structured outputs usage

### 10.3 Environment
- Fix or replace direnv (unreliable with Claude)
- Remove "Avoid logging full user content" guidance
- Clarify public hosting: assets are open because server is public

---

## Execution Order Summary

1. **Root cleanup** - Delete legacy dirs, fix docs
2. **Test structure** - Split tests, fix one_off, update conftest
3. **Delete legacy code** - design.py, evidence persona
4. **Create directories** - cli/, utils/, endpoints/, client/
5. **Move files** - Slack moves, runner moves
6. **Rename files** - models→types, constants→progress_constants
7. **Break up files** - orchestrator, main, ai_client
8. **Features** - Literal prompt detection
9. **Other fixes** - src/app clarity, config review, env fixes

---

## Items Not Yet Reviewed

The following directories need code review (not completed in original 1-hour timebox):
- `src/app/orchestration/` (beyond file moves)
- `src/app/runner/` (beyond file moves)
- `src/app/slack/` (beyond file moves)
- `src/app/trailrun/` (beyond file moves)

---

## IMPORTANT: Decouple Orchestrator from Slack

**Context**: The `/generate-run-summarize` API endpoint currently works around tight Slack coupling:
- Orchestrator generates Slack blocks and posts to Slack
- API endpoint then re-summarizes in prose format from cached research_content
- This is wasteful (two LLM calls for the same summary)

**Required fix** (part of Phase 8):
- Extract core run/report logic from Slack-specific posting
- Orchestrator should return summary data, not post it
- Let callers (Slack handler, API endpoint) decide format and destination
- Single summarization call, format chosen by caller
