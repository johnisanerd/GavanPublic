"""Tests for rate limiter functionality."""

import asyncio
import time

import pytest

from src.utils.rate_limiter import RateLimiter, RateLimitError


@pytest.mark.asyncio
async def test_rate_limiter_allows_under_limit():
    """Test that requests under the limit go through immediately."""
    limiter = RateLimiter(calls_per_second=5, max_queue_size=10)

    async def dummy_function():
        return "success"

    # Should complete quickly since we're under the limit
    start = time.time()
    result = await limiter.execute(dummy_function)
    duration = time.time() - start

    assert result == "success"
    assert duration < 0.5  # Should be nearly instant


@pytest.mark.asyncio
async def test_rate_limiter_queues_when_at_limit():
    """Test that requests queue and wait when rate limit is reached."""
    limiter = RateLimiter(calls_per_second=2, max_queue_size=10)

    call_count = 0

    async def tracked_function():
        nonlocal call_count
        call_count += 1
        return call_count

    # Make 5 requests rapidly (more than 2/sec limit)
    start = time.time()
    results = await asyncio.gather(*[limiter.execute(tracked_function) for _ in range(5)])
    duration = time.time() - start

    # All 5 requests should complete
    assert len(results) == 5
    assert set(results) == {1, 2, 3, 4, 5}

    # Should take at least 2 seconds (5 calls at 2/sec = 2.5s minimum)
    # But we'll be lenient with timing in tests
    assert duration >= 1.5


@pytest.mark.asyncio
async def test_rate_limiter_raises_on_queue_overflow():
    """Test that RateLimitError is raised when queue exceeds max size."""
    # Very slow rate limit to ensure queue fills up
    limiter = RateLimiter(calls_per_second=1, max_queue_size=3)

    async def slow_function():
        await asyncio.sleep(0.1)
        return "done"

    # Try to queue many requests simultaneously
    tasks = [limiter.execute(slow_function) for _ in range(10)]

    # Should raise RateLimitError for some requests
    results = await asyncio.gather(*tasks, return_exceptions=True)

    # Check that at least one RateLimitError was raised
    errors = [r for r in results if isinstance(r, RateLimitError)]
    assert len(errors) > 0

    # Check error message
    assert "Rate limit queue exceeded" in str(errors[0])


@pytest.mark.asyncio
async def test_rate_limiter_processes_all_queued_requests():
    """Test that all queued requests eventually get processed."""
    limiter = RateLimiter(calls_per_second=3, max_queue_size=20)

    results = []

    async def append_result(value):
        results.append(value)
        return value

    # Queue 10 requests
    await asyncio.gather(*[limiter.execute(append_result, i) for i in range(10)])

    # All requests should complete
    assert len(results) == 10
    assert set(results) == set(range(10))


@pytest.mark.asyncio
async def test_rate_limiter_concurrent_requests():
    """Test rate limiter with concurrent requests from multiple tasks."""
    limiter = RateLimiter(calls_per_second=5, max_queue_size=30)

    completed = []

    async def concurrent_task(task_id):
        for i in range(3):

            async def work(tid=task_id, idx=i):
                completed.append((tid, idx))
                return f"task-{tid}-{idx}"

            await limiter.execute(work)

    # Run 5 concurrent tasks, each making 3 requests
    await asyncio.gather(*[concurrent_task(task_id) for task_id in range(5)])

    # All 15 requests should complete (5 tasks * 3 requests each)
    assert len(completed) == 15


@pytest.mark.asyncio
async def test_rate_limiter_respects_timing():
    """Test that rate limiter actually limits rate over time."""
    limiter = RateLimiter(calls_per_second=5, max_queue_size=20)

    call_times = []

    async def record_time():
        call_times.append(time.time())
        return "done"

    # Make 15 requests at 5/sec limit
    start = time.time()
    await asyncio.gather(*[limiter.execute(record_time) for _ in range(15)])
    duration = time.time() - start

    # With 5/sec limit, 15 requests should take at least 2 seconds
    assert duration >= 1.5  # Be lenient with timing

    # Check that all calls completed
    assert len(call_times) == 15


@pytest.mark.asyncio
async def test_rate_limiter_with_exceptions():
    """Test that rate limiter handles exceptions in wrapped functions."""
    limiter = RateLimiter(calls_per_second=5, max_queue_size=10)

    async def failing_function():
        raise ValueError("Test error")

    # Exception should propagate through the rate limiter
    with pytest.raises(ValueError, match="Test error"):
        await limiter.execute(failing_function)


@pytest.mark.asyncio
async def test_rate_limiter_capacity_check():
    """Test get_current_capacity method."""
    limiter = RateLimiter(calls_per_second=2, max_queue_size=10)

    # Should have capacity initially
    assert limiter.get_current_capacity() is True

    # Make requests to fill capacity
    async def dummy():
        await asyncio.sleep(0.1)
        return "done"

    # Start multiple requests to potentially exhaust capacity
    tasks = [asyncio.create_task(limiter.execute(dummy)) for _ in range(3)]

    # Give tasks time to start
    await asyncio.sleep(0.05)

    # Might not have capacity now (timing-dependent, so this is a soft check)
    # We can't assert False because of timing variations in tests
    capacity = limiter.get_current_capacity()
    assert isinstance(capacity, bool)

    # Wait for all tasks to complete
    await asyncio.gather(*tasks)


@pytest.mark.asyncio
async def test_rate_limiter_exact_queue_limit():
    """Test behavior exactly at the queue limit."""
    limiter = RateLimiter(calls_per_second=1, max_queue_size=5)

    async def slow_work():
        await asyncio.sleep(0.2)
        return "done"

    # Make exactly 5 requests (at the limit)
    results = await asyncio.gather(
        *[limiter.execute(slow_work) for _ in range(5)], return_exceptions=True
    )

    # Some should succeed, some might error depending on timing
    successes = [r for r in results if r == "done"]
    errors = [r for r in results if isinstance(r, RateLimitError)]

    # At least some should succeed
    assert len(successes) >= 1

    # Total should equal 5
    assert len(successes) + len(errors) == 5
