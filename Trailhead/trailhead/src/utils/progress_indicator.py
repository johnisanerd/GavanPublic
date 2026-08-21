"""Reusable progress indicator utilities for Slack messages."""

import asyncio
import logging
from collections.abc import Callable
from typing import Any

from src.slack.progress_constants import PROGRESS_FRAMES

logger = logging.getLogger(__name__)


class ProgressIndicator:
    """Animated progress indicator for long-running operations.

    Usage:
        async with ProgressIndicator(
            client.chat_update,
            channel=channel_id,
            ts=message_ts,
            text="Processing..."
        ):
            # Your long-running operation
            result = await some_long_operation()
    """

    def __init__(
        self, update_fn: Callable, text: str = "Working...", interval: float = 1.0, **kwargs: Any
    ):
        """Initialize progress indicator.

        Args:
            update_fn: Async function to call for updates (e.g., client.chat_update)
            text: Status text to show after the spinner
            interval: Seconds between animation frames
            **kwargs: Additional arguments to pass to update_fn (e.g., channel, ts)
        """
        self.update_fn = update_fn
        self.text = text
        self.interval = interval
        self.kwargs = kwargs
        self._task: asyncio.Task | None = None
        self._idx = 0
        self._direction = 1
        self._stopped = False  # Flag to prevent updates after stop

    async def _animate(self) -> None:
        """Run animation loop."""
        frames = PROGRESS_FRAMES
        while True:
            await asyncio.sleep(self.interval)
            # Check stopped flag before updating
            if self._stopped:
                break
            try:
                update_text = f"`{frames[self._idx]}` {self.text}"
                logger.debug(f"[Slack] ProgressIndicator update: {update_text}")
                await self.update_fn(text=update_text, **self.kwargs)
            except Exception as e:
                # Stop if update fails (message might be deleted)
                logger.warning(f"Progress update failed: {type(e).__name__}: {e}")
                break

            # Move index back and forth
            self._idx += self._direction
            if self._idx >= len(frames) - 1:
                self._direction = -1
            elif self._idx <= 0:
                self._direction = 1

    async def __aenter__(self):
        """Start animation."""
        self._task = asyncio.create_task(self._animate())
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: object,
    ) -> None:
        """Stop animation."""
        # Set stopped flag first to prevent any in-flight updates
        self._stopped = True
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass


async def with_progress(update_fn: Callable, text: str, operation: Callable, **kwargs: Any) -> Any:
    """Run operation with animated progress indicator.

    Example:
        result = await with_progress(
            client.chat_update,
            "Analyzing results...",
            lambda: summarizer(content),
            channel=channel_id,
            ts=message_ts
        )

    Args:
        update_fn: Async function to call for updates
        text: Status text to show
        operation: Async callable to execute
        **kwargs: Additional arguments for update_fn

    Returns:
        Result of operation
    """
    async with ProgressIndicator(update_fn, text, **kwargs):
        return await operation()
