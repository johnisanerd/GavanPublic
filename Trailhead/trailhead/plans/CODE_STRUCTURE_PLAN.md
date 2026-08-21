# Trailhead Refactoring Plan: Code Structure Improvements

## Overview
Focus on breaking up large functions, DRYing up duplicated code, and standardizing patterns.

---

## Part 1: Break Up Large Functions

### 1.1 `trailrun/orchestrator.py` - `execute_trailrun()` (158 lines)

**Current issues:**
- Single function handles run phase, report phase, progress updates, error handling, and Slack posting
- Hard to test individual phases
- Difficult to follow control flow

**Refactor into:**
```python
async def execute_trailrun(trailrun: Trailrun, client: SlackClient) -> None:
    """Main orchestration - coordinates phases."""
    try:
        await _execute_run_phase(trailrun, client)
        await _execute_report_phase(trailrun, client)
    except Exception as e:
        await _handle_execution_error(trailrun, client, e)

async def _execute_run_phase(trailrun: Trailrun, client: SlackClient) -> ExperimentResult:
    """Run the experiment subprocess."""
    # ~40 lines: subprocess execution, progress updates
    ...

async def _execute_report_phase(trailrun: Trailrun, client: SlackClient) -> None:
    """Parse results and post summary."""
    # ~50 lines: parse logs, summarize, post to Slack
    ...

async def _post_summary_with_fallback(
    blocks: list[Block],
    client: SlackClient,
    channel_id: str,
    thread_ts: str,
) -> None:
    """Post summary, falling back to text if blocks fail."""
    # ~30 lines: try blocks, fallback to text
    ...

async def _handle_execution_error(
    trailrun: Trailrun,
    client: SlackClient,
    error: Exception,
) -> None:
    """Handle and report execution errors."""
    # ~20 lines: error formatting, Slack notification
    ...
```

### 1.2 `slack/events/app_mention.py` - `handle_app_mention()` (135 lines)

**Current issues:**
- Single function classifies mention type, extracts context, and handles multiple flows
- Complex branching logic
- Repeated Slack API calls

**Refactor into:**
```python
class MentionType(Enum):
    QUESTION = "question"          # Q&A in experiment thread
    NEW_EXPERIMENT = "new"         # Request to start experiment
    UNKNOWN = "unknown"            # Unrecognized

async def handle_app_mention(event: dict, say: Say, client: AsyncWebClient) -> None:
    """Route @mention to appropriate handler."""
    context = await _extract_mention_context(event, client)
    mention_type = _classify_mention(context)

    match mention_type:
        case MentionType.QUESTION:
            await _handle_question(context, say, client)
        case MentionType.NEW_EXPERIMENT:
            await _handle_new_experiment(context, say, client)
        case MentionType.UNKNOWN:
            await _handle_unknown(context, say)

@dataclass
class MentionContext:
    user_id: str
    channel_id: str
    thread_ts: str | None
    text: str
    trailrun: Trailrun | None  # If in experiment thread

async def _extract_mention_context(event: dict, client: AsyncWebClient) -> MentionContext:
    """Extract and enrich context from mention event."""
    # ~25 lines: parse event, fetch thread info, look up trailrun
    ...

def _classify_mention(context: MentionContext) -> MentionType:
    """Determine what kind of mention this is."""
    # ~15 lines: check if in thread, check for keywords
    ...

async def _handle_question(context: MentionContext, say: Say, client: AsyncWebClient) -> None:
    """Handle Q&A in experiment threads."""
    # ~40 lines: get cached research, call answerer, post response
    ...
```

### 1.3 `main.py` - `trailruns_dashboard()` (61 lines inline HTML)

**Current issues:**
- HTML string template embedded in route handler
- No HTML escaping (security concern)
- Hard to modify styling

**Refactor:**
```python
# New file: src/app/templates/dashboard.py
from html import escape

DASHBOARD_TEMPLATE = """
<!DOCTYPE html>
<html>
<head>
    <title>Trailhead Dashboard</title>
    <style>
        body {{ font-family: system-ui, sans-serif; margin: 2rem; }}
        .trailrun {{ border: 1px solid #ddd; padding: 1rem; margin: 1rem 0; }}
        .phase {{ font-weight: bold; }}
        .cancel-btn {{ background: #dc3545; color: white; border: none; padding: 0.5rem; cursor: pointer; }}
    </style>
</head>
<body>
    <h1>Active Trailruns</h1>
    {trailruns_html}
</body>
</html>
"""

TRAILRUN_TEMPLATE = """
<div class="trailrun">
    <div class="phase">{phase}</div>
    <div>ID: {id}</div>
    <div>Channel: {channel}</div>
    {cancel_button}
</div>
"""

def render_dashboard(trailruns: list[Trailrun]) -> str:
    """Render dashboard HTML with proper escaping."""
    if not trailruns:
        return DASHBOARD_TEMPLATE.format(trailruns_html="<p>No active trailruns</p>")

    trailruns_html = "\n".join(
        _render_trailrun(tr) for tr in trailruns
    )
    return DASHBOARD_TEMPLATE.format(trailruns_html=trailruns_html)

def _render_trailrun(trailrun: Trailrun) -> str:
    """Render single trailrun with escaped values."""
    cancel_button = ""
    if trailrun.phase in (Phase.DESIGN, Phase.RUN):
        cancel_button = f'<form action="/trailrun/{escape(trailrun.id)}/cancel" method="POST"><button class="cancel-btn">Cancel</button></form>'

    return TRAILRUN_TEMPLATE.format(
        phase=escape(trailrun.phase.value),
        id=escape(trailrun.id),
        channel=escape(trailrun.channel_id),
        cancel_button=cancel_button,
    )
```

**Update main.py:**
```python
from src.app.templates.dashboard import render_dashboard

@app.get("/trailruns", response_class=HTMLResponse)
async def trailruns_dashboard() -> str:
    trailruns = list(trailrun_store.values())
    return render_dashboard(trailruns)
```

---

## Part 2: DRY Up Summarizers

### 2.1 Current Duplication

All 3 files (`slack.py`, `prose.py`, `bullets.py`) duplicate:
```python
# Duplicated in each file:
max_chars = settings.max_research_tokens * 4
research_content = truncate_research(research_content, max_chars)

# Similar system prompt structure in each
system_prompt = f"""You are an expert at analyzing LLM experiment results...
Focus on model behavior...
Ignore infrastructure metrics..."""
```

### 2.2 Create Shared Base

**New file:** `src/app/orchestration/analysis/summarizers/base.py`

```python
"""Shared summarization logic."""
from src.app.config import settings
from src.app.orchestration.analysis.summarizers.shared import SummarizerOptions, truncate_research

# Format-specific instructions
FORMAT_INSTRUCTIONS = {
    "slack": "Return a JSON object with 'blocks' array for Slack Block Kit.",
    "prose": "Write a narrative summary in 2-3 paragraphs.",
    "bullets": "Write a bulleted markdown summary with clear sections.",
}

def build_system_prompt(options: SummarizerOptions, format_type: str) -> str:
    """Build system prompt with format-specific instructions."""
    base = """You are an expert at analyzing LLM experiment results.

Focus on:
- Model behavior and response quality
- Accuracy and correctness patterns
- Notable successes and failures

Ignore:
- Infrastructure metrics (latency, tokens)
- Cost calculations
- Technical implementation details
"""
    return base + "\n\n" + FORMAT_INSTRUCTIONS[format_type]


def prepare_research_content(content: str) -> str:
    """Truncate research content to fit token budget."""
    max_chars = settings.max_research_tokens * 4
    return truncate_research(content, max_chars)


async def summarize(
    research_content: str,
    options: SummarizerOptions,
    format_type: str,
) -> SummarizerResponse:
    """Unified summarization with format dispatch."""
    truncated = prepare_research_content(research_content)
    system_prompt = build_system_prompt(options, format_type)

    if format_type == "slack":
        return await _summarize_structured(truncated, system_prompt, options)
    else:
        return await _summarize_text(truncated, system_prompt, format_type, options)


async def _summarize_structured(
    content: str,
    system_prompt: str,
    options: SummarizerOptions,
) -> SummarizerResponse:
    """Call AI with structured JSON output for Slack."""
    # Moved from slack.py
    ...


async def _summarize_text(
    content: str,
    system_prompt: str,
    format_type: str,
    options: SummarizerOptions,
) -> SummarizerResponse:
    """Call AI with text output for prose/bullets."""
    # Unified from prose.py and bullets.py
    ...
```

### 2.3 Simplify Individual Summarizers

**After refactor, each summarizer becomes minimal:**

```python
# src/app/orchestration/analysis/summarizers/slack.py
from .base import summarize
from .shared import SummarizerOptions, SummarizerResponse

async def summarize_to_slack(
    research_content: str,
    options: SummarizerOptions,
) -> SummarizerResponse:
    """Summarize to Slack Block Kit format."""
    return await summarize(research_content, options, "slack")
```

```python
# src/app/orchestration/analysis/summarizers/prose.py
from .base import summarize
from .shared import SummarizerOptions, SummarizerResponse

async def summarize_to_prose(
    research_content: str,
    options: SummarizerOptions,
) -> SummarizerResponse:
    """Summarize to prose narrative."""
    return await summarize(research_content, options, "prose")
```

---

## Part 3: Standardize Patterns

### 3.1 Convert SummarizerOptions to Pydantic

**Current (dataclass):**
```python
@dataclass
class SummarizerOptions:
    research_type: str
    max_length: int | None = None
    include_metadata: bool = True
```

**After (Pydantic):**
```python
from pydantic import BaseModel, ConfigDict

class SummarizerOptions(BaseModel):
    model_config = ConfigDict(extra="forbid")

    research_type: str
    max_length: int | None = None
    include_metadata: bool = True
```

**Rationale:** Consistent with rest of codebase, better validation, serialization support.

---

## Implementation Order

### Step 1: Extract Dashboard Template
1. Create `src/app/templates/dashboard.py`
2. Move HTML rendering logic with proper escaping
3. Update `main.py` to use new module
4. **Verify:** Dashboard still renders correctly

### Step 2: Refactor `execute_trailrun()`
1. Read `orchestrator.py` thoroughly
2. Extract `_execute_run_phase()`
3. Extract `_execute_report_phase()`
4. Extract `_post_summary_with_fallback()`
5. Extract `_handle_execution_error()`
6. **Verify:** Run existing tests, manual test trailrun flow

### Step 3: Refactor `handle_app_mention()`
1. Read `app_mention.py` thoroughly
2. Create `MentionContext` dataclass
3. Extract `_extract_mention_context()`
4. Extract `_classify_mention()`
5. Extract handler functions per type
6. **Verify:** Test @mentions in Slack

### Step 4: DRY Up Summarizers
1. Create `base.py` with shared logic
2. Move `build_system_prompt()`, `prepare_research_content()`
3. Refactor `slack.py` to use base
4. Refactor `prose.py` to use base
5. Refactor `bullets.py` to use base
6. **Verify:** Run summarizer tests

### Step 5: Standardize SummarizerOptions
1. Convert to Pydantic in `shared.py`
2. Update all call sites
3. **Verify:** Tests pass

---

## Critical Files to Read Before Implementation

| File | Why |
|------|-----|
| `src/app/trailrun/orchestrator.py` | Understand full execution flow before splitting |
| `src/app/slack/events/app_mention.py` | Understand branching logic and Slack API usage |
| `src/app/main.py` | See dashboard implementation and route structure |
| `src/app/orchestration/analysis/summarizers/slack.py` | Understand structured output pattern |
| `src/app/orchestration/analysis/summarizers/prose.py` | Compare with slack.py for duplication |
| `src/app/orchestration/analysis/summarizers/shared.py` | Current SummarizerOptions definition |

## Files to Create

- `src/app/templates/__init__.py`
- `src/app/templates/dashboard.py`
- `src/app/orchestration/analysis/summarizers/base.py`

## Files to Modify

- `src/app/main.py` - Use dashboard template
- `src/app/trailrun/orchestrator.py` - Extract functions
- `src/app/slack/events/app_mention.py` - Extract functions
- `src/app/orchestration/analysis/summarizers/slack.py` - Use base
- `src/app/orchestration/analysis/summarizers/prose.py` - Use base
- `src/app/orchestration/analysis/summarizers/bullets.py` - Use base
- `src/app/orchestration/analysis/summarizers/shared.py` - Pydantic conversion
