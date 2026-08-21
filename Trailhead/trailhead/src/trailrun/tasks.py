"""Task tracker for managing background trailrun execution tasks."""

import asyncio
from collections.abc import Coroutine
from typing import Any

# Map of trailrun_id -> asyncio.Task
_tasks: dict[str, asyncio.Task[None]] = {}


def create_trailrun_task(
    trailrun_id: str,
    coro: Coroutine[Any, Any, None],
) -> asyncio.Task[None]:
    """Create and register a background task for a trailrun.

    Args:
        trailrun_id: Trailrun ID
        coro: Coroutine to run (e.g., execute_trailrun(...))

    Returns:
        The created task
    """
    task = asyncio.create_task(coro)
    _tasks[trailrun_id] = task
    # Auto-cleanup when task completes
    task.add_done_callback(lambda _: _tasks.pop(trailrun_id, None))
    return task


def cancel_trailrun(trailrun_id: str) -> bool:
    """Cancel a running trailrun.

    Args:
        trailrun_id: Trailrun ID

    Returns:
        True if task was found and cancelled, False otherwise
    """
    task = _tasks.get(trailrun_id)
    if task and not task.done():
        task.cancel()
        return True
    return False


def list_active_trailruns() -> list[str]:
    """List IDs of all active trailruns.

    Returns:
        List of trailrun IDs with active tasks
    """
    return list(_tasks.keys())
