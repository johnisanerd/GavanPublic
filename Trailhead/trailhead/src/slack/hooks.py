"""Slack hook for trailrun events.

Posts updates to Slack thread as trailrun progresses through phases.
Register per-trailrun (not globally) since it needs channel/thread context.
"""

import asyncio
import logging
from typing import Any

from src.slack.progress_constants import ANALYZING, ERROR, RUNNING, SUCCESS

logger = logging.getLogger(__name__)
from src.slack.utils.fallback import post_summary_with_fallback
from src.trailrun.blocks import build_config_blocks
from src.trailrun.events import EventType, TrailrunEvent
from src.trailrun.store import get_trailrun
from src.utils.progress_indicator import ProgressIndicator


class SlackTrailrunHook:
    """Posts updates to Slack thread. Register per-trailrun."""

    def __init__(
        self,
        client: Any,
        channel_id: str,
        thread_ts: str,
    ) -> None:
        """Initialize Slack hook.

        Args:
            client: Slack WebClient (async)
            channel_id: Channel to post to
            thread_ts: Thread timestamp to update/reply to
        """
        self.client = client
        self.channel_id = channel_id
        self.thread_ts = thread_ts
        self._spinner: ProgressIndicator | None = None
        self._spinner_lock = asyncio.Lock()  # Protects spinner state from race conditions
        self._finished = False  # Set when COMPLETED/FAILED/CANCELLED received

    async def on_event(self, event: TrailrunEvent) -> None:
        """Handle trailrun event by updating Slack."""
        logger.debug(f"[SlackHook] Received event: {event.type.value}")

        # Mark finished on terminal events only (lock now prevents race conditions)
        if event.type in (EventType.COMPLETED, EventType.FAILED, EventType.CANCELLED):
            logger.debug(f"[SlackHook] Setting _finished=True for {event.type.value}")
            self._finished = True

        # Stop spinner on any non-progress event
        if event.type != EventType.PROGRESS:
            logger.debug(f"[SlackHook] Stopping spinner for {event.type.value}")
            await self._stop_spinner()

        match event.type:
            case EventType.CONFIG_READY:
                await self._post_config(event)
            case EventType.PROGRESS:
                if not self._finished:  # Ignore progress after finish
                    await self._start_spinner(event)
            case EventType.SUMMARY_READY:
                await self._post_summary(event)
            case EventType.COMPLETED:
                await self._mark_complete(event)
            case EventType.FAILED:
                await self._post_error(event)
            case EventType.CANCELLED:
                pass  # Slack message already updated by action handler
            # RESULT_READY doesn't need a Slack update - progress handles it

    async def _post_config(self, event: TrailrunEvent) -> None:
        """Post or update config blocks when CONFIG_READY fires."""
        trailrun = get_trailrun(event.trailrun_id)
        if not trailrun or not trailrun.config:
            return

        blocks = build_config_blocks(trailrun.config, f"{ANALYZING} Config generated")
        status_text = f"{ANALYZING} {trailrun.config.title}"
        logger.debug(f"[Slack] chat_update: {status_text}")
        await self.client.chat_update(
            channel=self.channel_id,
            ts=self.thread_ts,
            blocks=blocks,
            text=status_text,
        )

    async def _start_spinner(self, event: TrailrunEvent) -> None:
        """Start or update animated spinner for progress updates."""
        trailrun = get_trailrun(event.trailrun_id)
        if not trailrun or not trailrun.config:
            return

        detail = event.data.get("detail", "Processing...")
        logger.debug(
            f"[SlackHook] _start_spinner called (detail={detail}, _finished={self._finished})"
        )

        async with self._spinner_lock:
            # Double-check _finished under lock (may have changed while waiting)
            if self._finished:
                logger.debug("[SlackHook] _start_spinner: _finished=True, skipping")
                return

            # Stop existing spinner if text changed
            if self._spinner and self._spinner.text != detail:
                logger.debug(
                    f"[SlackHook] Text changed from '{self._spinner.text}' to '{detail}', stopping"
                )
                await self._stop_spinner_unlocked()

            # Start new spinner if not running
            if not self._spinner:
                config = trailrun.config  # Capture for closure

                async def update_fn(text: str) -> None:
                    blocks = build_config_blocks(config, text)
                    logger.debug(f"[Slack] chat_update (spinner): {text}")
                    await self.client.chat_update(
                        channel=self.channel_id,
                        ts=self.thread_ts,
                        blocks=blocks,
                        text=f"{RUNNING} {config.title}",
                    )

                self._spinner = ProgressIndicator(update_fn, text=detail)
                await self._spinner.__aenter__()

    async def _stop_spinner(self) -> None:
        """Stop the animated spinner if running (acquires lock)."""
        async with self._spinner_lock:
            await self._stop_spinner_unlocked()

    async def _stop_spinner_unlocked(self) -> None:
        """Stop the animated spinner if running (caller must hold lock)."""
        if self._spinner:
            logger.debug(f"[SlackHook] Stopping spinner (text={self._spinner.text})")
            await self._spinner.__aexit__(None, None, None)
            self._spinner = None
            logger.debug("[SlackHook] Spinner stopped")
        else:
            logger.debug("[SlackHook] No spinner to stop")

    async def _post_summary(self, event: TrailrunEvent) -> None:
        """Post summary as thread reply when SUMMARY_READY fires."""
        from src.config import settings
        from src.types import SummarizerResponse

        trailrun = get_trailrun(event.trailrun_id)
        if not trailrun or not trailrun.summary:
            return

        # Reconstruct SummarizerResponse from stored dict
        summary_result = SummarizerResponse.model_validate(trailrun.summary)

        # Build bundle URL
        bundle_url = None
        if trailrun.static_inspect_viewer_path:
            bundle_url = f"{settings.app_base_url}/data-inspector/{event.trailrun_id}"

        # Post with fallback handling
        await post_summary_with_fallback(
            client=self.client,
            channel_id=self.channel_id,
            message_ts=self.thread_ts,
            summary_result=summary_result,
            content=trailrun.research_content or "",
            bundle_url=bundle_url,
            trailrun_id=event.trailrun_id,
        )

    async def _mark_complete(self, event: TrailrunEvent) -> None:
        """Update main message to show completion."""
        trailrun = get_trailrun(event.trailrun_id)
        if not trailrun or not trailrun.config:
            return

        blocks = build_config_blocks(trailrun.config, f"{SUCCESS} Experiment complete")
        status_text = f"{SUCCESS} {trailrun.config.title}"
        logger.debug(f"[Slack] chat_update: {status_text}")
        await self.client.chat_update(
            channel=self.channel_id,
            ts=self.thread_ts,
            blocks=blocks,
            text=status_text,
        )

    async def _post_error(self, event: TrailrunEvent) -> None:
        """Post error message to thread."""
        error = event.data.get("error", "Unknown error")
        error_text = f"{ERROR} Trailrun failed: {error}"
        logger.debug(f"[Slack] chat_postMessage: {error_text}")
        await self.client.chat_postMessage(
            channel=self.channel_id,
            thread_ts=self.thread_ts,
            text=error_text,
        )
