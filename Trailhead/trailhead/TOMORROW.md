# Tomorrow's Plan

## 1. Fix Status Updates Race Condition
The progress spinner text keeps overriding the final "Experiment complete" status. Root cause: fire-and-forget `asyncio.create_task` for progress events can execute after completion.

**Approach:** Add finished flag check in the spinner's `update_fn` itself, so even in-flight updates don't overwrite completion status.

Files: `src/slack/hooks.py`, `src/utils/progress_indicator.py`

## 2. Inline Quotes with Line Returns → Block Quotes
When an inline citation `[[quote:N]]` contains line breaks, convert it to a block quote instead of keeping it inline.

Files: `src/orchestration/analysis/summarizers/markdown_to_slack.py`

## 3. Preview Quotes Before Finalizing
After generating summary with quotes, show user how quotes will appear and ask if they want changes before posting.

This might involve:
- A confirmation step in the Slack flow
- Or a "preview" mode in the summarizer

## 4. Backlog Tasks: Convo and Temp

### Convo: Refactor prompts to samples with conversation support
- Rename `ExperimentConfig.prompts` → `samples`
- Type: `samples: list[str | list[dict[str, str]]]`
- String = single prompt, Array = full conversation
- Use case: test mid-conversation behavior, hard-to-reach states

### Temp: Per-model configuration (temperature, reasoning, etc.)
- Create `ModelSpec` model with: name, temperature, max_tokens, reasoning_tokens, etc.
- Update `ExperimentConfig.models` to accept `list[str | ModelSpec]`
- Run separate `eval_set()` per model to apply individual configs

See BACKLOG.md for full acceptance criteria.

---

## Context from Today's Session

### Changes Made
- MCP timeout increased to 300s for run endpoint
- Model name display: strip `openrouter/` prefix for proper lookup
- Citation format: attribution inside quote block `[Model, e1]`
- Inline citations: full attribution instead of just `[🔗]`
- Summarizer length guidance: 200-400 words
- Progress race fix (partial): hook-level `_finished` flag

### Pending Push
```bash
git push origin staging --no-verify
```
Commit `b776896` has the hook finished flag fix but needs the update_fn fix too.
