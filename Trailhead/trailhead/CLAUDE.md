# Coding Principles for Claude Code

This document outlines the coding philosophy and principles for this project.

## Core Principles

### 1. No Legacy Support (Unless Explicitly Requested)

**Default behavior: Clean breaks over backward compatibility.**

- When refactoring, delete old code - don't leave deprecated functions
- No migration paths, no warnings, no compatibility layers
- If the user wants backward compatibility, they will explicitly ask for it
- Document breaking changes clearly in commit messages and PRs

**Example:**
```python
# ❌ DON'T do this
@deprecated("Use new_function() instead")
def old_function():
    return new_function()

# ✅ DO this
# Just delete old_function() and update all callers
```

### 2. Functional > Object-Oriented

**Prefer functions over classes when state isn't needed.**

- Use functions for stateless transformations
- Use classes only when:
  - Managing mutable state (e.g., RateLimiter)
  - Multiple related methods needed
  - Framework requirement (FastAPI, Pydantic)

**Example:**
```python
# ✅ Good - stateless transformation
async def summarize_to_slack(log: str, options: Options) -> dict:
    return process(log)

# ❌ Avoid - unnecessary class wrapper
class SlackSummarizer:
    def summarize(self, log: str) -> dict:
        return process(log)
```

### 3. Clear Data Flow

**Separate data from behavior.**

- Pydantic models are dumb containers (data validation only)
- Functions transform data (pure when possible)
- Keep side effects at the edges (I/O, API calls)

**Pattern: "Functional Core, Imperative Shell"**
```
Input → Pure Functions → Output
  ↑                        ↓
  └── Side Effects (I/O) ──┘
```

### 4. Explicit Over Implicit

- Type hints on all public functions
- Clear function names that describe behavior
- Document non-obvious behavior in docstrings
- No magic - prefer boring, explicit code

### 5. Testing Strategy

- Test public interfaces, not implementation details
- Prefer pure functions (easy to test)
- Mock external dependencies (API calls, I/O)
- One test file per module

## Code Style

### Type Hints
```python
# Use modern type hints (3.12+)
from collections.abc import Callable
def process(items: list[str]) -> dict[str, int]: ...
```

### Async/Await
```python
# Always use async for I/O operations
async def fetch_data() -> dict: ...
await fetch_data()  # Don't block!
```

### Error Handling
```python
# Fail fast, be explicit
if not valid_input:
    raise ValueError("Clear error message")
```

## Project Structure

@ARCHITECTURE.md

### Prompts in `src/prompts/`

**All LLM prompts must live in `src/prompts/`.**

Prompts are centralized for easier review, iteration, and consistency. Never inline prompts in business logic files.

**Structure:**
```
src/prompts/
├── shared.py                    # Common components (MODEL_BEHAVIOR_FOCUS, etc.)
├── slack_formatting.py          # Slack Block Kit formatting guidance
├── media.py                     # Image generation tool + template
├── summarizers/
│   ├── slack.py, prose.py, bullets.py
├── answerers/
│   ├── slack.py, prose.py, bullets.py
├── experiment/
│   └── generate.py
└── utils/
    └── blockkit_fix.py
```

**Format:**
- System prompts: `UPPERCASE_CONSTANT` strings
- User prompts with variables: `UPPERCASE_FUNCTION(params)` returning f-strings
- Start and end with newlines for clean formatting
- No docstrings needed - names are self-explanatory

**Example:**
```python
PROSE_SUMMARIZER_INSTRUCTIONS = """
You are a research analyst writing conversational insights about experiments.

Focus on MODEL BEHAVIOR - what the model actually said or did...
"""


def PROSE_SUMMARIZER_TASK(research_content: str) -> str:
    return f"""
Analyze this experiment and write a conversational narrative:

{research_content}

Tell the story of what the MODEL DID...
"""
```

**Usage:**
```python
from src.prompts.summarizers.prose import PROSE_SUMMARIZER_INSTRUCTIONS, PROSE_SUMMARIZER_TASK

messages=[
    {"role": "system", "content": PROSE_SUMMARIZER_INSTRUCTIONS},
    {"role": "user", "content": PROSE_SUMMARIZER_TASK(research_content)},
]
```

### One Endpoint Per File

**Prefer one endpoint per file in `endpoints/`.**

Each endpoint file should:
- Have a clear, single-purpose name (e.g., `summarize.py`, `followup.py`)
- Contain one router with one endpoint
- Keep request/response models local if only used by that endpoint
- Import shared models from `types.py`

**Why:**
- Easy to find where an endpoint is defined
- Simpler diffs when changing endpoints
- No decision fatigue about grouping
- Encourages keeping endpoints focused

**Example:**
```python
# endpoints/summarize.py
"""POST /summarize - Summarize research content."""

from fastapi import APIRouter
router = APIRouter()

@router.post("/summarize")
async def summarize(...): ...
```

## When to Break These Rules

These are guidelines, not laws. Break them when:
- Framework requires it (FastAPI dependency injection)
- External library design dictates otherwise
- Performance requires optimization
- Team explicitly agrees on an exception

But document why you're breaking the rule!

## Placeholder Values

### Model Names

When inventing placeholder model names in examples, tests, or documentation, use **`gpt-5-nano`**.

**Example:**
```python
# ✅ Good - consistent placeholder
config = ExperimentConfig(
    prompts=["test"],
    models=["gpt-5-nano"],
    n=1
)

# ❌ Avoid - inventing random model names
models=["gpt-4-turbo"], models=["claude-3-opus"], etc.
```

This maintains consistency across the codebase and makes it clear when a model name is a placeholder vs. a real model identifier.

### Trust User Model References

**Never second-guess the user about model names or versions.**

If a user references a model that seems newer than your training data (e.g., "gpt-5-nano", "claude-4", "gemini-3-pro"), **trust them and use it**. Do not:
- Question whether the model exists
- Suggest alternative models from your training data
- Assume the user made a mistake

**Why:**
- Models are released frequently after training data cutoffs
- Users may have access to beta/preview models
- Custom or internal model names may exist
- It's better to attempt using the specified model than to incorrectly "correct" the user

**Example:**
```python
# User says: "Use gpt-5-nano for the summarizer"
# ✅ Correct response: "I'll configure the summarizer to use gpt-5-nano"
# ❌ Wrong response: "Did you mean gpt-4o? I'm not aware of gpt-5-nano"
```

## Library API Research

### Always Research Before Coding

When writing code that uses external libraries, **always research the library's API first** using available documentation tools:

1. **Use Context7** (`mcp__context7__resolve-library-id` and `mcp__context7__get-library-docs`) for library documentation
2. **Use WebFetch** or **WebSearch** if Context7 doesn't have the library or for supplementary information
3. **Never guess** API signatures, return types, or behavior

**Why this matters:**
- Prevents assumptions about data structures (e.g., assuming samples contain transcripts)
- Reveals performance characteristics (e.g., transcript data being 200x larger than needed)
- Discovers built-in features (e.g., `read_eval_log()` supporting URLs directly)

**Example from this project:**
```python
# ❌ Wrong - assumed we needed to download .eval files ourselves
content = await fetch_url_content(url)
log = parse_content(content)

# ✅ Correct - researched Inspect AI SDK and found read_eval_log() handles URLs
log = read_eval_log(url)  # Already supports HTTP, S3, etc.
```

**Research revealed:**
- `read_eval_log()` supports URLs directly (no manual download needed)
- EvalSample contains massive `transcript` field (200x larger than useful data)
- Samples are independent, not cumulative (no n^2 growth)

This research saved us from both over-engineering (manual downloads) and performance issues (including transcripts).

## Sprint Workflow

### Project Management Files

We use three markdown files to track work:

1. **CURRENT_SPRINT.md** - Active work in progress
2. **COMPLETED.md** - Historical record of finished stories
3. **BACKLOG.md** - Future work not yet started

### Story Format

All stories follow this structure:

```markdown
## Story: [Title] ✅
Description: [What and why]

Acceptance criteria:
- ✅ [Specific, testable requirement]
- ✅ [Another requirement]
- [ ] [Incomplete item]

Implementation:
- [Key technical decisions]
- [Architecture changes]
- [Code locations with file:line references]
- [Tradeoffs and alternatives considered]

Benefits/Result:
- [Why this matters]
- [What improved]
```

### Workflow

**1. Active work (CURRENT_SPRINT.md)**
- Contains stories currently being worked on
- May have multiple stories if working in parallel
- Cleared to "(Empty - all current work completed)" when sprint is done
- Acts as a scratchpad - it's okay to have incomplete stories here

**2. Completing work (move to COMPLETED.md)**
- When a story is finished, move it from CURRENT_SPRINT to COMPLETED
- Add ✅ to the title
- Fill in implementation details while context is fresh
- Include specific file paths, functions, and line numbers
- Document tradeoffs and why we chose this approach
- Explain benefits and what improved

**3. Backlog cleanup**
- BACKLOG.md should only contain **pending** work
- Periodically review and move completed items to COMPLETED.md
- Remove items marked with ✅ from BACKLOG
- Keep BACKLOG lean and actionable

**4. Commit messages**
- Descriptive and explain the "why" not just the "what"
- Include context about the problem being solved
- Reference related files or systems affected
- Use multi-line format for complex changes:

```bash
git commit -m "$(cat <<'EOF'
Short summary line (what)

Detailed explanation:
- Why this change was needed
- What problem it solves
- How it works
- Any tradeoffs or alternatives considered
EOF
)"
```

### Documentation Discipline

**Always document when:**
- A story is completed (move to COMPLETED.md)
- A major feature is shipped
- Architecture changes
- Breaking changes occur
- Non-obvious decisions are made

**Include in documentation:**
- **What** changed (code paths, files, functions)
- **Why** it changed (problem, motivation, requirements)
- **How** it works (approach, algorithm, pattern)
- **Tradeoffs** considered (alternatives, why we chose this)
- **Benefits** delivered (performance, UX, maintainability)

**Example:**
```markdown
## Story: Thread-based Q&A with answerers architecture ✅

Implementation:
- Moved orchestration/summarizers/ → orchestration/analysis/summarizers/
- Created orchestration/analysis/answerers/ (slack.py, prose.py, bullets.py)
- Created orchestration/analysis/prompts/shared.py with common templates

Benefits:
- DRY prompt engineering with shared templates
- Consistent answering across all output formats
- Same data (same random seed) used for both summary and answers
```

### References During Sessions

At the start of each session, check:
1. **CURRENT_SPRINT.md** - What's in progress?
2. **COMPLETED.md** - Recent work for context
3. **Git log** - Recent commits

At the end of each session, update:
1. **CURRENT_SPRINT.md** - Remove finished work
2. **COMPLETED.md** - Add finished stories with full details
3. **BACKLOG.md** - Clean up completed items if any

## Deployment

### Railway Staging

- Pushes to `staging` branch auto-deploy to Railway
- **Deployments take ~5 minutes** - wait before testing changes
- Health check: `curl https://trailhead-staging.example.railway.app/health`

### Checking Railway Deployment Status

Use `railway status --json` to check deployment progress:

```bash
# Check deployment status for Trailhead service
railway status --json | jq '.environments.edges[0].node.serviceInstances.edges[] | select(.node.serviceName == "Trailhead") | .node.latestDeployment | {status, createdAt}'
```

Wait ~1 minute between checks. Deployment status values:
- `BUILDING` - Build in progress
- `DEPLOYING` - Deploying to infrastructure
- `SUCCESS` - Deployment complete
- `FAILED` - Check logs with `railway logs`

### Viewing Railway Logs

**IMPORTANT**: `railway logs` streams continuously and won't exit on its own. Always use a timeout:

```bash
# View recent logs (auto-kills after 10 seconds)
gtimeout 10 railway logs 2>&1 | head -100

# On macOS without coreutils, use perl timeout
perl -e 'alarm 10; exec @ARGV' railway logs 2>&1 | head -100
```

Never run `railway logs` without a timeout - it will hang indefinitely.

