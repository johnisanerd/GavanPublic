# Refactor Plan

## Overview

This document outlines planned refactoring to improve code organization, reduce file sizes, and clean up legacy code.

---

## 1. Remove Legacy Code

### 1.1 Delete `trailrun/design.py`
- **Status**: Legacy, not used
- **Reason**: Uses modal-based YAML config input flow that's been replaced by inline config generation
- **Action**: Delete file, verify no remaining imports

### 1.2 Remove "bot evidence" persona support
- **Files**: `slack/utils/personas.py`, `config.py`
- **Reason**: Only using single persona for foreseeable future
- **Action**:
  - Simplify `personas.py` to single persona
  - Remove `bot_evidence_name`, `bot_evidence_icon_url` from settings
  - Remove `message_type` parameter from `get_bot_persona()`

### 1.3 `_register_task` status
- **File**: `trailrun/tasks.py`
- **Status**: Still actively used in `main.py:354`
- **Action**: Keep as-is (only the `design.py` usage is legacy)

---

## 2. Rename Files

### 2.1 `models.py` → `types.py`
- **Files affected**:
  - `src/app/models.py` → `src/app/types.py`
  - `src/app/trailrun/models.py` → `src/app/trailrun/types.py`
  - `src/app/runner/models.py` → `src/app/runner/types.py`
- **Reason**: Better describes purpose (type definitions, not data models)

### 2.2 `constants.py` → `slack/progress_constants.py`
- **Current**: `src/app/constants.py`
- **Target**: `src/app/slack/progress_constants.py`
- **Reason**: Contains progress animation frames and status emojis - Slack-specific

### 2.3 `progress.py` → `progress_indicator.py`
- **Current**: `src/app/orchestration/progress.py`
- **Target**: `src/app/utils/progress_indicator.py`
- **Reason**: More descriptive name, generic utility

---

## 3. Create New Directories

### 3.1 `src/app/cli/`
Create CLI folder and move:
- `runner_cli.py` → `cli/runner.py`
- `summarizer_cli.py` → `cli/summarizer.py`

### 3.2 `src/app/utils/`
Create top-level utils folder and move:
- `orchestration/file_utils.py` → `utils/file_utils.py`
- `orchestration/progress.py` → `utils/progress_indicator.py`
- `orchestration/rate_limiter.py` → `utils/rate_limiter.py`
- `orchestration/sanitize.py` → `utils/sanitize.py`

### 3.3 `src/app/orchestration/client/`
Break up `ai_client.py` into:
- `client/__init__.py` - exports
- `client/llm.py` - `call_llm()` function
- `client/image.py` - `generate_image()` function
- `client/providers.py` - provider-specific logic (OpenRouter, Gemini, etc.)

---

## 4. Move Files

### 4.1 `slack_app.py` → `slack/app.py`
- **Reason**: Should be under the Slack folder with other Slack code

### 4.2 `slack_fallback.py` → `slack/utils/fallback.py`
- **Current**: `src/app/orchestration/slack_fallback.py`
- **Target**: `src/app/slack/utils/fallback.py`
- **Reason**: Slack-specific fallback logic

### 4.3 `model_repository.py` → `runner/model_repository.py`
- **Reason**: Used primarily by runner for model selection

---

## 5. Break Up Large Files

### 5.1 `orchestrator.py` (trailrun)
- **Problem**: File is doing too much
- **Action**: Extract `build_config_blocks()` into separate module
- **Potential structure**:
  ```
  trailrun/
    orchestrator.py     - main orchestration flow
    blocks.py           - Slack block building (build_config_blocks, etc.)
    phases.py           - phase-specific logic (run, report)
  ```

### 5.2 `ai_client.py`
- **Problem**: ~400+ lines, multiple responsibilities
- **Action**: See section 3.3 above

---

## 6. Feature Improvements

### 6.1 Literal prompt detection
- **Location**: Config generation logic (`slack/utils/config_gen.py`)
- **Requirement**: When users suggest experiment ideas, detect explicit delimiters and treat content as literal
- **Delimiters to detect**:
  - Backticks: `` `hello world` ``
  - Code blocks: ``` ```hello world``` ```
  - Quotes: `"hello world"` or `'hello world'`
- **Behavior**: Content inside delimiters should be used as-is for prompts, not paraphrased or modified
- **Example**: User says "test the model with `What is 2+2?`" → prompt is exactly "What is 2+2?"

---

## Execution Order

Suggested order to minimize breakage:

1. **Phase 1 - Cleanup**
   - Delete `trailrun/design.py`
   - Remove evidence persona code
   - Audit `_register_task`

2. **Phase 2 - New directories**
   - Create `utils/`, `cli/`, `orchestration/client/`

3. **Phase 3 - Moves (utilities first)**
   - Move files to `utils/` (file_utils, progress, rate_limiter, sanitize)
   - Move files to `cli/`
   - Move `slack_app.py`, `slack_fallback.py`
   - Move `model_repository.py`

4. **Phase 4 - Renames**
   - `models.py` → `types.py` (all locations)
   - `constants.py` → `slack/progress_constants.py`

5. **Phase 5 - Break up large files**
   - Split `ai_client.py`
   - Extract from `orchestrator.py`

6. **Phase 6 - Features**
   - Implement backtick literal prompts
