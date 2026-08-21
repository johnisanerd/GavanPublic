"""Rate limiter for AI API calls using aiolimiter."""

import logging
from collections.abc import Callable, Coroutine
from typing import Any, TypeVar

from aiolimiter import AsyncLimiter

logger = logging.getLogger(__name__)

T = TypeVar("T")


class RateLimitError(Exception):
    """Raised when rate limit queue is exceeded."""

    pass


class RateLimiter:
    """Rate limiter wrapper around aiolimiter.AsyncLimiter.

    Limits API calls to a specified rate per second using a leaky bucket
    algorithm. When the rate limit is reached, requests wait. If too many
    requests are waiting (queue full), a RateLimitError is raised.
    """

    def __init__(self, calls_per_second: int, max_queue_size: int = 50):
        """Initialize the rate limiter.

        Args:
            calls_per_second: Maximum number of calls allowed per second
            max_queue_size: Maximum number of requests that can be queued
        """
        self.calls_per_second = calls_per_second
        self.max_queue_size = max_queue_size
        # AsyncLimiter uses (max_rate, time_period) where time_period is in seconds
        self._limiter = AsyncLimiter(max_rate=calls_per_second, time_period=1.0)

    async def execute(
        self, func: Callable[..., Coroutine[Any, Any, T]], *args: Any, **kwargs: Any
    ) -> T:
        """Execute a function with rate limiting.

        Args:
            func: Async function to execute
            *args: Positional arguments for func
            **kwargs: Keyword arguments for func

        Returns:
            Result from func

        Raises:
            RateLimitError: If queue size exceeds max_queue_size
        """
        # Check if queue is too full (accessing internal state is necessary for queue management)
        waiters = getattr(self._limiter, "_waiters", [])
        if len(waiters) >= self.max_queue_size:
            raise RateLimitError(
                f"Rate limit queue exceeded: {len(waiters)} >= {self.max_queue_size}"
            )

        # Log warning if we're at the rate limit
        if self._limiter.has_capacity() is False:
            logger.warning(
                f"Rate limit reached ({self.calls_per_second}/sec). Request will be queued."
            )

        # Acquire a token from the limiter (waits if necessary)
        async with self._limiter:
            return await func(*args, **kwargs)

    def get_current_capacity(self) -> bool:
        """Check if there is current capacity for a request.

        Returns:
            True if a request can be made immediately, False otherwise
        """
        return self._limiter.has_capacity()
