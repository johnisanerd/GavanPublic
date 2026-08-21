"""State machine for trailrun lifecycle transitions.

This module breaks the circular import between store and hooks by importing
from both. It handles state transitions and emits events to hooks.

The key functions are:
- create_trailrun(): Create a new trailrun with optional cloned config
- update_trailrun(): Update state and emit events (async, awaits hooks)
- get_trailrun(): Get trailrun by ID (pass-through to store)
"""

from datetime import UTC, datetime
from typing import Any

from src.trailrun.events import EventType, TrailrunEvent
from src.trailrun.hooks import get_registry
from src.trailrun.store import (
    _store,
    generate_id,
    get_trailrun,
    get_trailrun_by_thread,
    list_trailruns,
    save,
)
from src.trailrun.types import Phase, Trailrun, TrailrunSource

# Re-export read-only functions for convenience
__all__ = [
    "create_trailrun",
    "get_trailrun",
    "get_trailrun_by_thread",
    "list_trailruns",
    "update_trailrun",
]


def create_trailrun(
    source: TrailrunSource = TrailrunSource.API,
    channel_id: str | None = None,
    user_id: str | None = None,
    thread_ts: str | None = None,
    config: Any | None = None,
    ranger_id: str | None = None,
) -> Trailrun:
    """Create a new trailrun.

    Args:
        source: Where this trailrun originated (SLACK, API, CLI, RANGER)
        channel_id: Slack channel ID (required for SLACK source)
        user_id: Slack user ID (required for SLACK source)
        thread_ts: Optional Slack thread timestamp
        config: Optional ExperimentConfig to clone from another trailrun
        ranger_id: Optional Ranger session ID (required for RANGER source)

    Returns:
        Created Trailrun instance
    """
    trailrun_id = generate_id()
    trailrun = Trailrun(
        id=trailrun_id,
        phase=Phase.DESIGN,
        source=source,
        channel_id=channel_id,
        user_id=user_id,
        thread_ts=thread_ts,
        config=config,
        ranger_id=ranger_id,
    )
    _store[trailrun_id] = trailrun
    save()
    return trailrun


async def update_trailrun(trailrun_id: str, **updates: Any) -> Trailrun:
    """Update trailrun state and emit events. Awaits hook completion.

    This is the core state transition function. It:
    1. Updates the trailrun state (sync, immediate)
    2. Emits appropriate events based on what changed
    3. Awaits all hooks to complete (ensures ordering)

    Args:
        trailrun_id: Trailrun ID
        **updates: Field name -> value mappings

    Returns:
        Updated Trailrun instance

    Raises:
        KeyError: If trailrun not found
    """
    trailrun = _store.get(trailrun_id)
    if not trailrun:
        raise KeyError(f"Trailrun not found: {trailrun_id}")

    registry = get_registry()

    # Update fields
    updated_data = trailrun.model_dump()
    updated_data.update(updates)
    updated_data["updated_at"] = datetime.now(UTC)

    # Validate and reconstruct
    updated_trailrun = Trailrun(**updated_data)
    _store[trailrun_id] = updated_trailrun

    # Emit events based on what changed (and await hooks)
    if "config" in updates:
        await registry.emit(
            TrailrunEvent(
                EventType.CONFIG_READY,
                trailrun_id,
                {"config": updates["config"]},
            )
        )

    if "result" in updates:
        await registry.emit(TrailrunEvent(EventType.RESULT_READY, trailrun_id))

    if "summary" in updates:
        await registry.emit(TrailrunEvent(EventType.SUMMARY_READY, trailrun_id))

    if updates.get("status") == "completed":
        await registry.emit(TrailrunEvent(EventType.COMPLETED, trailrun_id))

    if updates.get("status") == "failed":
        await registry.emit(
            TrailrunEvent(
                EventType.FAILED,
                trailrun_id,
                {"error": updates.get("error")},
            )
        )

    if updates.get("status") == "cancelled":
        await registry.emit(TrailrunEvent(EventType.CANCELLED, trailrun_id))

    return updated_trailrun


async def emit_progress(trailrun_id: str, detail: str, phase: str | None = None) -> None:
    """Emit a progress event for a trailrun.

    Progress events are emitted during long-running operations
    (design, run, summarize) to provide feedback to hooks (Slack, logging).

    Args:
        trailrun_id: Trailrun ID
        detail: Human-readable progress message
        phase: Optional phase name (e.g., "run", "parse", "summarize")
    """
    registry = get_registry()
    data: dict[str, Any] = {"detail": detail}
    if phase:
        data["phase"] = phase
    await registry.emit(TrailrunEvent(EventType.PROGRESS, trailrun_id, data))
