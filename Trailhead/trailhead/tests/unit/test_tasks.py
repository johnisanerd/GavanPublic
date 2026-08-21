"""Tests for trailrun task management (create, cancel, list)."""

import asyncio

import pytest

from src.trailrun.tasks import cancel_trailrun, create_trailrun_task, list_active_trailruns


@pytest.fixture(autouse=True)
def clear_tasks():
    """Clear task registry before and after each test."""
    from src.trailrun import tasks

    tasks._tasks.clear()
    yield
    tasks._tasks.clear()


async def test_create_trailrun_task_registers():
    """Task is registered and appears in active list."""

    async def slow_task():
        await asyncio.sleep(10)

    task = create_trailrun_task("tr_test123", slow_task())

    assert "tr_test123" in list_active_trailruns()
    assert not task.done()

    # Cleanup
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


async def test_cancel_trailrun_works():
    """cancel_trailrun() finds and cancels registered task."""

    async def cancellable_task():
        await asyncio.sleep(10)

    task = create_trailrun_task("tr_cancel", cancellable_task())

    # Let the task start running
    await asyncio.sleep(0)

    # Cancel via the API
    result = cancel_trailrun("tr_cancel")
    assert result is True

    # Await to let cancellation complete
    with pytest.raises(asyncio.CancelledError):
        await task

    assert task.cancelled()


async def test_cancel_trailrun_returns_false_for_unknown():
    """cancel_trailrun() returns False for unknown trailrun ID."""
    result = cancel_trailrun("tr_nonexistent")
    assert result is False


async def test_task_auto_cleanup_on_completion():
    """Completed tasks are automatically removed from registry."""

    async def quick_task():
        return "done"

    task = create_trailrun_task("tr_quick", quick_task())

    # Wait for completion
    await task

    # Give the done callback a chance to run
    await asyncio.sleep(0)

    assert "tr_quick" not in list_active_trailruns()


async def test_task_auto_cleanup_on_cancel():
    """Cancelled tasks are automatically removed from registry."""

    async def slow_task():
        await asyncio.sleep(10)

    task = create_trailrun_task("tr_slow", slow_task())
    assert "tr_slow" in list_active_trailruns()

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    # Give the done callback a chance to run
    await asyncio.sleep(0)

    assert "tr_slow" not in list_active_trailruns()


async def test_list_active_trailruns_multiple():
    """list_active_trailruns() returns all active task IDs."""

    async def slow_task():
        await asyncio.sleep(10)

    task1 = create_trailrun_task("tr_one", slow_task())
    task2 = create_trailrun_task("tr_two", slow_task())
    task3 = create_trailrun_task("tr_three", slow_task())

    active = list_active_trailruns()
    assert set(active) == {"tr_one", "tr_two", "tr_three"}

    # Cleanup
    for task in [task1, task2, task3]:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
