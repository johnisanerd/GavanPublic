# Unified TrailRunner with Event Hooks

## Goal

Refactor the trailrun system to have a unified execution pipeline with an event/hook system that supports multiple observers per trailrun. Enable both human-driven (Slack) and LLM-driven (automated) orchestration.

**Key requirements:**
1. Phase functions (design, run, summarize, ask) as core building blocks
2. Multiple hooks can observe the same trailrun (Slack + logging + persistence + webhooks)
3. Any interface can query any trailrun (API answers questions about Slack experiments)
4. Hooks are in-memory (running experiments fail on restart - resume is future work)
5. Clean separation: core execution knows nothing about Slack/API
6. **LLM-ready**: Phase functions can be orchestrated by an LLM controller for automated experimentation

## Current State

- **Duplication**: ~100 lines identical between `slack_trailrunner.py` and `generate_run_summarize.py`
- **Tight coupling**: Slack fields (`channel_id`, `thread_ts`, `user_id`) required on Trailrun model
- **No cross-interface**: API can't answer questions about Slack trailruns easily
- **Callbacks exist**: `run_and_parse()` already has `on_progress` callback pattern
- **All-or-nothing**: Current flow runs design→run→summarize as monolithic operation

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  Orchestrators (decide WHEN to call phases)             │
│  - Slack: waits for button clicks, posts to thread      │
│  - LLM Controller: evaluates results, decides next step │
│  - Simple script: just calls design→run→summarize       │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│  Thin Wrappers                                          │
│  - API Endpoints: POST /trailrun, /trailrun/{id}/design │
│  - Slack handlers: on_start_clicked()                   │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│  Core Phase Functions (src/trailrun/phases/)            │
│  - design.py: design_trailrun(id, description) → config │
│  - run.py: run_trailrun(id) → result                    │
│  - summarize.py: summarize_trailrun(id, format) → sum   │
│  - ask.py: ask_trailrun(id, question) → answer          │
│                                                         │
│  (emit PROGRESS events, call update_trailrun())         │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│  State Machine (src/trailrun/state.py)                  │
│  - update_trailrun() handles transitions + emits events │
│  - Async: awaits hook completion before returning       │
└─────────────────────────────────────────────────────────┘
                          │
          ┌───────────────┴───────────────┐
          ▼                               ▼
┌─────────────────────────┐   ┌───────────────────────────┐
│  Store (store.py)       │   │  HookRegistry (hooks.py)  │
│  - Pure CRUD operations │   │  - Global: Persistence,   │
│  - _get, _set, _save    │   │    Logging                │
│  - No event knowledge   │   │  - Per-run: SlackHook     │
└─────────────────────────┘   └───────────────────────────┘
```

**Key design: No circular imports.** Store and hooks don't know about each other. State machine imports from both.

## Recommended Approach: Phase Functions + Hybrid Event Emission

### Architectural Decision: Where Events Fire

**This is a key architectural decision that may need refinement.**

- **State transition events** (CONFIG_READY, RESULT_READY, COMPLETED, FAILED) → Emitted by `update_trailrun()` in store
- **Progress events** (PROGRESS during long operations) → Emitted by phase functions

Rationale:
- Store IS the state machine - state events are centralized, can't be forgotten
- Progress events must fire DURING execution (inside phase functions)
- Clean separation of concerns

### Core Design: Events + Hook Registry

```python
# src/trailrun/events.py

class EventType(str, Enum):
    # State transition events (emitted by store)
    PHASE_CHANGED = "trailrun.phase_changed"
    CONFIG_READY = "trailrun.config_ready"   # After design phase
    RESULT_READY = "trailrun.result_ready"   # After run phase
    SUMMARY_READY = "trailrun.summary_ready" # After summarize phase
    COMPLETED = "trailrun.completed"
    FAILED = "trailrun.failed"

    # Progress events (emitted by phase functions)
    PROGRESS = "trailrun.progress"

@dataclass
class TrailrunEvent:
    type: EventType
    trailrun_id: str
    data: dict[str, Any] = field(default_factory=dict)
```

```python
# src/trailrun/hooks.py

class TrailrunHook(Protocol):
    async def on_event(self, event: TrailrunEvent) -> None: ...

class HookRegistry:
    """Registry for trailrun event hooks."""

    def register_global(self, hook: TrailrunHook) -> None:
        """Register hook for ALL trailruns (persistence, logging)."""

    def register(self, hook: TrailrunHook, trailrun_id: str) -> None:
        """Register hook for specific trailrun (Slack)."""

    def unregister(self, hook: TrailrunHook, trailrun_id: str) -> None: ...

    async def emit(self, event: TrailrunEvent) -> None:
        """Emit to global hooks + hooks for this trailrun. Errors logged but don't fail."""

# Global singleton
_registry = HookRegistry()
def get_registry() -> HookRegistry: return _registry
```

### Hook Implementations

```python
# src/trailrun/hooks.py

class LoggingHook:
    """Logs all events to stdout. Register globally."""
    async def on_event(self, event: TrailrunEvent) -> None:
        print(f"[{event.trailrun_id}] {event.type}: {event.data}")

class PersistenceHook:
    """Flushes trailrun state to JSON on state changes. Register globally."""
    async def on_event(self, event: TrailrunEvent) -> None:
        if event.type != EventType.PROGRESS:  # Don't flush on every progress tick
            _save()  # Flush JSON file
```

```python
# src/slack/hooks.py

class SlackTrailrunHook:
    """Posts updates to Slack thread. Register per-trailrun."""
    def __init__(self, client, channel_id, thread_ts): ...

    async def on_event(self, event: TrailrunEvent) -> None:
        match event.type:
            case EventType.CONFIG_READY: await self._post_config_blocks(event)
            case EventType.PROGRESS: await self._update_progress(event)
            case EventType.SUMMARY_READY: await self._post_summary(event)
            case EventType.COMPLETED: await self._mark_complete(event)
            case EventType.FAILED: await self._post_error(event)
```

### Phase Functions (Core Building Blocks)

Each phase function gets its own file for clarity and maintainability.

```python
# src/trailrun/phases/design.py

async def design_trailrun(trailrun_id: str, description: str) -> ExperimentConfig:
    """Generate experiment config from description. Can be called multiple times to iterate."""
    registry = get_registry()

    await registry.emit(TrailrunEvent(PROGRESS, trailrun_id, {"detail": "Generating config..."}))
    config = await generate_experiment_yaml(description)

    update_trailrun(trailrun_id, config=config, phase=Phase.DESIGN)
    # → Store emits CONFIG_READY
    return config


# src/trailrun/phases/run.py

async def run_trailrun(trailrun_id: str) -> ResearchResult:
    """Execute experiment. Requires config from design phase."""
    registry = get_registry()
    trailrun = get_trailrun(trailrun_id)

    update_trailrun(trailrun_id, phase=Phase.RUN)
    # → Store emits PHASE_CHANGED

    result = await run_and_parse(
        trailrun.config,
        on_progress=lambda p, d: registry.emit(
            TrailrunEvent(PROGRESS, trailrun_id, {"phase": p, "detail": d})
        )
    )

    update_trailrun(trailrun_id, result=result.experiment_result, research_content=result.research_content)
    # → Store emits RESULT_READY
    return result


# src/trailrun/phases/summarize.py

async def summarize_trailrun(trailrun_id: str, format: str = "slack") -> Any:
    """Generate summary from results. Requires result from run phase."""
    registry = get_registry()
    trailrun = get_trailrun(trailrun_id)

    update_trailrun(trailrun_id, phase=Phase.REPORT)

    await registry.emit(TrailrunEvent(PROGRESS, trailrun_id, {"detail": "Generating summary..."}))
    summary = await _generate_summary(trailrun, format)

    update_trailrun(trailrun_id, summary=summary, status="completed")
    # → Store emits SUMMARY_READY, then COMPLETED
    return summary


# src/trailrun/phases/ask.py

async def ask_trailrun(trailrun_id: str, question: str) -> str:
    """Answer question about trailrun results."""
    trailrun = get_trailrun(trailrun_id)
    return await answer_to_markdown(trailrun.research_content, question, ...)
```

```python
# src/trailrun/phases/__init__.py

from .design import design_trailrun
from .run import run_trailrun
from .summarize import summarize_trailrun
from .ask import ask_trailrun

__all__ = ["design_trailrun", "run_trailrun", "summarize_trailrun", "ask_trailrun"]
```

### State Machine (Emits Events)

```python
# src/trailrun/state.py
# Imports from both store.py and hooks.py - breaks circular dependency

from .store import _get_trailrun, _set_trailrun, save
from .hooks import get_registry
from .events import EventType, TrailrunEvent

async def update_trailrun(trailrun_id: str, **updates) -> Trailrun:
    """Update trailrun state and emit events. Awaits hook completion."""
    registry = get_registry()

    # Update state (sync, immediate)
    trailrun = _get_trailrun(trailrun_id)
    for key, value in updates.items():
        setattr(trailrun, key, value)
    _set_trailrun(trailrun_id, trailrun)

    # Emit events and WAIT for hooks (ensures ordering)
    if "config" in updates:
        await registry.emit(TrailrunEvent(EventType.CONFIG_READY, trailrun_id, {"config": updates["config"]}))
    if "result" in updates:
        await registry.emit(TrailrunEvent(EventType.RESULT_READY, trailrun_id))
    if "summary" in updates:
        await registry.emit(TrailrunEvent(EventType.SUMMARY_READY, trailrun_id))
    if updates.get("status") == "completed":
        await registry.emit(TrailrunEvent(EventType.COMPLETED, trailrun_id))
    if updates.get("status") == "failed":
        await registry.emit(TrailrunEvent(EventType.FAILED, trailrun_id, {"error": updates.get("error")}))

    return trailrun
```

```python
# src/trailrun/store.py - Pure CRUD, no event knowledge

def _get_trailrun(trailrun_id: str) -> Trailrun: ...
def _set_trailrun(trailrun_id: str, trailrun: Trailrun) -> None: ...
def save() -> None:
    """Flush current state to JSON file."""
    ...
def load() -> None:
    """Load state from JSON file."""
    ...
```

### API Endpoints (Thin Wrappers)

```python
# src/endpoints/trailrun_phases.py

@router.post("/trailrun")
async def create_trailrun_endpoint(
    source: TrailrunSource = TrailrunSource.API,
    clone_from: str | None = None,  # Optional trailrun_id to clone config from
) -> dict:
    """Create a new trailrun. Optionally clone ExperimentConfig from existing trailrun."""
    config = None
    if clone_from:
        existing = get_trailrun(clone_from)
        config = existing.config  # Clone ExperimentConfig only, not results

    trailrun = create_trailrun(source=source, config=config)
    return {"trailrun_id": trailrun.id, "cloned_from": clone_from}

@router.post("/trailrun/{trailrun_id}/design")
async def design_endpoint(trailrun_id: str, description: str) -> dict:
    config = await design_trailrun(trailrun_id, description)
    return {"config": config.model_dump()}

@router.post("/trailrun/{trailrun_id}/run")
async def run_endpoint(trailrun_id: str) -> dict:
    result = await run_trailrun(trailrun_id)
    return {"experiment_name": result.experiment_result.experiment_name}

@router.post("/trailrun/{trailrun_id}/summarize")
async def summarize_endpoint(trailrun_id: str, format: str = "markdown") -> dict:
    summary = await summarize_trailrun(trailrun_id, format)
    return {"summary": summary}

@router.post("/trailrun/{trailrun_id}/ask")
async def ask_endpoint(trailrun_id: str, question: str) -> dict:
    answer = await ask_trailrun(trailrun_id, question)
    return {"answer": answer}
```

## Data Model Changes

### Add `source` field, make Slack fields optional

```python
# src/trailrun/types.py

class TrailrunSource(str, Enum):
    SLACK = "slack"
    API = "api"
    CLI = "cli"

class Trailrun(BaseModel):
    # ... existing fields ...
    source: TrailrunSource = TrailrunSource.SLACK

    # Make Slack fields optional
    channel_id: str | None = None  # Was: str (required)
    user_id: str | None = None     # Was: str (required)
    thread_ts: str | None = None   # Already optional

    # Store interface metadata for later retrieval
    interface_metadata: dict[str, Any] | None = None
```

### Update store for cross-interface queries

```python
# src/trailrun/store.py

def create_trailrun(source: TrailrunSource = TrailrunSource.SLACK, **kwargs) -> Trailrun:
    """Create trailrun with explicit source."""
    ...

# Add schema migration for existing trailruns
SCHEMA_VERSION = 2  # Bump from 1
```

## Implementation Plan

### Phase 1: Core Infrastructure (New Files)

1. **Create `src/trailrun/events.py`**
   - `EventType` enum (state transitions + progress)
   - `TrailrunEvent` dataclass

2. **Create `src/trailrun/hooks.py`**
   - `TrailrunHook` protocol
   - `HookRegistry` class with register_global/register/unregister/emit
   - `LoggingHook` for stdout output
   - `PersistenceHook` for JSON flushing (imports `save()` from store)
   - Global `get_registry()` singleton

3. **Create `src/trailrun/state.py`** (breaks circular imports)
   - Imports from store.py and hooks.py
   - `async update_trailrun()` - handles state transitions + emits events
   - `create_trailrun()` - creates new trailrun with optional config

4. **Create `src/trailrun/phases/` module**
   - `__init__.py` - exports all phase functions
   - `design.py` - `design_trailrun(id, description)` → config
   - `run.py` - `run_trailrun(id)` → result
   - `summarize.py` - `summarize_trailrun(id, format)` → summary
   - `ask.py` - `ask_trailrun(id, question)` → answer

5. **Create `src/slack/hooks.py`**
   - `SlackTrailrunHook` - handles Slack-specific event responses

### Phase 2: Data Model Updates

6. **Update `src/trailrun/types.py`**
   - Add `TrailrunSource` enum (SLACK, API, CLI)
   - Add `source` field to `Trailrun`
   - Make `channel_id`, `user_id` optional

7. **Update `src/trailrun/store.py`**
   - Bump `SCHEMA_VERSION` to 2
   - Add migration for `source` field
   - Refactor to pure CRUD: `_get_trailrun`, `_set_trailrun`, `save`, `load`
   - Remove event emission (moved to state.py)

### Phase 3: API Endpoints

8. **Create `src/endpoints/trailrun_phases.py`**
   - `POST /trailrun` - create trailrun (with optional `clone_from`)
   - `POST /trailrun/{id}/design`
   - `POST /trailrun/{id}/run`
   - `POST /trailrun/{id}/summarize`
   - `POST /trailrun/{id}/ask`

### Phase 4: Migrate Integrations

9. **Update `src/slack/actions/experiment_start.py`**
   - Create `SlackTrailrunHook`, register with registry
   - Call phase functions instead of old executor

10. **Update `src/endpoints/generate_run_summarize.py`**
    - Register `LoggingHook`
    - Call phase functions in sequence
    - Remove duplicated code (~80 lines)

11. **Update `src/endpoints/followup.py`**
    - Add `trailrun_id` parameter support
    - Allow querying any trailrun regardless of source

### Phase 5: Cleanup

12. **Delete `src/trailrun/slack_trailrunner.py`**
    - Logic moved to `phases/` + `SlackTrailrunHook`

13. **Update exports in `src/trailrun/__init__.py`**

## File Changes Summary

| File | Action | Description |
|------|--------|-------------|
| `src/trailrun/events.py` | **Create** | EventType enum + TrailrunEvent |
| `src/trailrun/hooks.py` | **Create** | HookRegistry + LoggingHook + PersistenceHook |
| `src/trailrun/state.py` | **Create** | State machine: async update_trailrun(), create_trailrun() |
| `src/trailrun/phases/__init__.py` | **Create** | Exports phase functions |
| `src/trailrun/phases/design.py` | **Create** | design_trailrun() |
| `src/trailrun/phases/run.py` | **Create** | run_trailrun() |
| `src/trailrun/phases/summarize.py` | **Create** | summarize_trailrun() |
| `src/trailrun/phases/ask.py` | **Create** | ask_trailrun() |
| `src/slack/hooks.py` | **Create** | SlackTrailrunHook |
| `src/endpoints/trailrun_phases.py` | **Create** | POST /trailrun + phase endpoints |
| `src/trailrun/types.py` | Modify | Add source enum, optional Slack fields |
| `src/trailrun/store.py` | Modify | Pure CRUD only, no events |
| `src/slack/actions/experiment_start.py` | Modify | Register hook + call phases |
| `src/endpoints/generate_run_summarize.py` | Modify | Use phases (-80 lines) |
| `src/endpoints/followup.py` | Modify | Add trailrun_id support |
| `src/trailrun/slack_trailrunner.py` | **Delete** | Replaced by phases/ + hooks |

## Critical Files to Read Before Implementation

1. `src/trailrun/slack_trailrunner.py` - Current Slack flow to extract
2. `src/trailrun/core.py` - Existing `run_and_parse()` with callback pattern
3. `src/trailrun/generate_experiment.py` - Config generation (DESIGN phase)
4. `src/endpoints/generate_run_summarize.py` - Current API flow to simplify
5. `src/trailrun/store.py` - Schema migration patterns
6. `src/slack/events/app_mention.py` - Slack entry point (creates trailrun, handles Q&A)
7. `src/slack/actions/experiment_start.py` - Start button handler

## Future Work (Backlog)

- Resume interrupted trailruns on server restart
- Webhook hook for external notifications
- SSE/WebSocket hook for real-time browser updates
- LLM controller orchestrator for automated experimentation
