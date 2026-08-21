"""Hook system for observing trailrun lifecycle events.

Hooks are registered globally (all trailruns) or per-trailrun.
The state machine emits events and awaits hook completion.
"""

import logging
from collections import defaultdict
from typing import Protocol

from src.trailrun.events import EventType, TrailrunEvent

logger = logging.getLogger(__name__)


class TrailrunHook(Protocol):
    """Protocol for trailrun event hooks."""

    async def on_event(self, event: TrailrunEvent) -> None:
        """Handle a trailrun event.

        Implementations should handle errors internally - exceptions
        are logged but don't fail the trailrun.
        """
        ...


class HookRegistry:
    """Registry for trailrun event hooks.

    Supports both global hooks (fire for all trailruns) and
    per-trailrun hooks (fire only for specific trailrun).
    """

    def __init__(self) -> None:
        self._global_hooks: list[TrailrunHook] = []
        self._trailrun_hooks: dict[str, list[TrailrunHook]] = defaultdict(list)

    def register_global(self, hook: TrailrunHook) -> None:
        """Register hook for ALL trailruns (persistence, logging)."""
        self._global_hooks.append(hook)

    def register(self, hook: TrailrunHook, trailrun_id: str) -> None:
        """Register hook for specific trailrun (Slack).

        Replaces any existing hooks for this trailrun to prevent duplicates
        from double-clicks or Slack retries.
        """
        # Clear existing hooks for this trailrun to prevent duplicates
        self._trailrun_hooks[trailrun_id] = [hook]

    def unregister(self, hook: TrailrunHook, trailrun_id: str) -> None:
        """Unregister a per-trailrun hook."""
        if trailrun_id in self._trailrun_hooks:
            try:
                self._trailrun_hooks[trailrun_id].remove(hook)
            except ValueError:
                pass  # Hook wasn't registered

    def unregister_global(self, hook: TrailrunHook) -> None:
        """Unregister a global hook."""
        try:
            self._global_hooks.remove(hook)
        except ValueError:
            pass  # Hook wasn't registered

    async def emit(self, event: TrailrunEvent) -> None:
        """Emit event to global hooks + hooks for this trailrun.

        Errors are logged but don't fail - hooks should not break trailruns.
        """
        # Collect all applicable hooks
        hooks = list(self._global_hooks)
        if event.trailrun_id in self._trailrun_hooks:
            hooks.extend(self._trailrun_hooks[event.trailrun_id])

        # Call each hook, catching errors
        for hook in hooks:
            try:
                await hook.on_event(event)
            except Exception as e:
                hook_name = type(hook).__name__
                logger.error(f"Error in {hook_name} for {event.type}: {e}")


class LoggingHook:
    """Logs all events. Register globally."""

    def __init__(self) -> None:
        self._logger = logging.getLogger("src.trailrun.events")

    async def on_event(self, event: TrailrunEvent) -> None:
        """Log event."""
        if event.type == EventType.PROGRESS:
            detail = event.data.get("detail", "")
            self._logger.debug(f"[{event.trailrun_id}] {event.type.value}: {detail}")
        elif event.type == EventType.FAILED:
            error = event.data.get("error", "Unknown error")
            self._logger.error(f"[{event.trailrun_id}] {event.type.value}: {error}")
        else:
            self._logger.info(f"[{event.trailrun_id}] {event.type.value}")


class PersistenceHook:
    """Flushes trailrun state to JSON on state changes. Register globally.

    Imports save() from store to avoid circular imports - store doesn't
    know about hooks, this hook knows about store.
    """

    async def on_event(self, event: TrailrunEvent) -> None:
        """Flush state to disk on state changes (not progress events)."""
        if event.type != EventType.PROGRESS:
            # Import here to avoid circular import at module load time
            from src.trailrun.store import save

            save()


# Global singleton registry
_registry = HookRegistry()


def get_registry() -> HookRegistry:
    """Get the global hook registry singleton."""
    return _registry


def setup_default_hooks() -> None:
    """Register default global hooks (logging, persistence)."""
    registry = get_registry()
    registry.register_global(LoggingHook())
    registry.register_global(PersistenceHook())


def register_slack_hook_for_ranger(trailrun_id: str, channel_id: str, thread_ts: str) -> None:
    """Register a SlackTrailrunHook for a ranger-created trailrun.

    This allows ranger trailruns to post progress updates to the ranger's
    Slack thread, just like user-initiated trailruns.

    Args:
        trailrun_id: The trailrun ID to register the hook for
        channel_id: Slack channel ID (RANGER_SLACK_CHANNEL)
        thread_ts: Thread timestamp from the ranger session
    """
    # Import here to avoid circular imports
    from src.slack.app import app as slack_app
    from src.slack.hooks import SlackTrailrunHook

    hook = SlackTrailrunHook(
        client=slack_app.client,
        channel_id=channel_id,
        thread_ts=thread_ts,
    )
    registry = get_registry()
    registry.register(hook, trailrun_id)
    logger.info(f"Registered SlackTrailrunHook for ranger trailrun {trailrun_id}")
