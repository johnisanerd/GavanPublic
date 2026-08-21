# Manual Code Review - Project Documentation and Structure

**Time-boxed**: 1 hour
**Approach**: Breadth-first review of project structure, then focused review of `src/app/` directory. Dictated, AI-transcribed, then hand-edited.

## Project Root - Structure Issues

### Directories to Remove
- **`evals/`** - Should be removed until we figure out what it means to evaluate Trailhead's performance
- **`research/`** - Legacy folder, no longer needed
- **`summaries/`** - Legacy folder, should be removed

### Directories to Investigate
- **`inspect_testing/logs/`** - Unknown purpose, might be legacy
- **`logs/`** - Purpose unclear, needs investigation

### Testing Structure Changes Needed
- **Split testing into two parts:**
  1. Tests that call LLMs (should go through rate limiter)
  2. Tests that don't call LLMs
- **`tests/one_off/`** - Should have underscore in name: `one_off`
  - Consider `.gitignore`-ing this folder
  - Add note to `CLAUDE.md` about agents using it for one-off Python tests
  - These tests are fragile and shouldn't be persisted
- **`conftest.py`** - Weird name if not standard, should change
  - Spoofing tokens (shouldn't be doing this)
  - Using outdated model names

### Public Folder
- **`trailhead-icon-evidence.png`** - Not implemented yet, half-finished feature

### Source Directory Architecture
- **`src/app/`** - Unclear why we have separate app directory
  - Either rename to just `src/` or clarify it's the server (if planning separate frontend)

## Documentation Files

### `.env` File
- Reorder contents - grouping is weird
- **`runner_naming_model`** - Should be removed, wrong model to use

### `ARCHITECTURE.md`
- **Incorrect**: Says "2 services" - this is wrong
- **Non-existent features documented:**
  - Bot personas
  - Slash commands (should be removed and replaced with @-tagging)
- **Data contracts section**: Wrong, needs rebuild
- **JSON insurance**: Should be improved, not working well
- **Standardization in Slack**: Might not be needed, causes bugs
- **File path ingestion**: Check if still needed, otherwise remove
- **Project layout section**: Needs complete rebuild

### `CLAUDE.md`
- **"Clear data flow"** - Seems like nonsense, should remove
- **Project structure section** - Should be removed
- **Model names section** - Needs rewrite
- **References section** - Should be removed
- Add story numbering system
- No need for "Why it changed" in documentation
- Documentation should be current snapshot, not historical record
- Split into sprint documentation vs README

### `README.md`
- Needs complete rebuild
- Update to current project state

### Other  Issues
- **Direnv** - Not working reliably with Claude, either fix or switch to something else
- **"Avoid logging full user content"** - Should be removed
- **Public hosting note** - Should clarify that assets are open to web because server is public

## Source Code Review - `src/app/` Directory

### CLI Architecture Issues
- **Merge CLIs**: `runner_cli.py` and `summarizer_cli.py` should merge into same entry point
  - Can keep separate implementation files

### File Organization

#### `models.py`
- "Models" is a weird name
- Should create `types/` folder with `block_kit_types.py`
- Review if we actually want structured outputs

#### `constants.py`
- Should rename to `progress_animations.py`
- Move under `slack/` folder

#### `config.py`
- Using Pydantic settings (that's fine)
- Streaming config might be removed

#### `main.py`
- **FastAPI description** should change
- **HTML generation**: Built with templated f-strings - need cleaner solution
  - Look for Python library
- **Import inside functions**: Why? Might be fine.
- **Split this file**: Create `endpoints/` folder, mirror structure from `slack/` folder
- **Mock client**: Remove mock client code

### Specific Code Issues
- **Non-Slack access**: Should nest under approved URL path instead of random one-offs
- **`post_test_trailrun`**: Weird function, needs review

### Pending Reviews (Not Completed in 1-Hour Timebox)

**The following directories require code review but were not completed:**
- `src/app/orchestration/`
- `src/app/runner/`
- `src/app/slack/`
- `src/app/trailrun/`

**Note**: This was a time-boxed 1-hour review focusing on breadth-first analysis of project structure followed by initial review of `src/app/`. Detailed code review of subdirectories remains pending.