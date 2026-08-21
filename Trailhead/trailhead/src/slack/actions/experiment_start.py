"""Experiment start action handler."""

import asyncio
import logging
from typing import Any

from src.slack.hooks import SlackTrailrunHook

logger = logging.getLogger(__name__)
from src.slack.progress_constants import RUNNING
from src.slack.utils.access import verify_experiment_owner
from src.trailrun.blocks import build_config_blocks
from src.trailrun.hooks import get_registry
from src.trailrun.phases import run_trailrun, summarize_trailrun
from src.trailrun.state import update_trailrun
from src.trailrun.tasks import create_trailrun_task


async def handle_experiment_start(
    ack: Any, action: dict[str, Any], body: dict[str, Any], client: Any
) -> None:
    """Handle Start button click to begin experiment execution.

    Args:
        ack: Function to acknowledge the action
        action: Action data
        body: Request body with message context
        client: Slack WebClient
    """
    await ack()

    trailrun_id = action["value"]
    channel_id = body["channel"]["id"]
    clicking_user = body["user"]["id"]
    message_ts = body["message"]["ts"]  # Update existing message

    logger.info(f"Starting trailrun {trailrun_id}")

    # Verify ownership and get trailrun
    trailrun = await verify_experiment_owner(
        trailrun_id, clicking_user, client, channel_id, action_name="start this experiment"
    )
    if not trailrun or not trailrun.config:
        return

    # Idempotency guard: Slack retries requests if ack() doesn't return within 3 seconds.
    # This can cause duplicate execution if our handler is slow. Check status to prevent this.
    # See: https://api.slack.com/events-api (retry behavior)
    if trailrun.status != "pending":
        logger.info(f"Ignoring duplicate start for {trailrun_id} (status={trailrun.status})")
        return

    config = trailrun.config  # Narrowed type for pyright

    # Immediately mark as running to prevent race condition with duplicate clicks
    # This must happen before any async calls to prevent duplicate execution
    await update_trailrun(trailrun_id, status="running", thread_ts=message_ts)

    # Update message with config + running status (remove input/buttons)
    config_blocks = build_config_blocks(config, f"{RUNNING} Running experiment...")
    status_text = f"{RUNNING} {config.title}"
    logger.debug(f"[Slack] chat_update: {status_text}")
    await client.chat_update(
        channel=channel_id,
        ts=message_ts,
        blocks=config_blocks,
        text=status_text,
    )

    # Register Slack hook for this trailrun
    slack_hook = SlackTrailrunHook(client=client, channel_id=channel_id, thread_ts=message_ts)
    get_registry().register(slack_hook, trailrun_id)

    # Execute phases in background (registered for cancellation)
    create_trailrun_task(trailrun_id, _execute_phases(trailrun_id))


async def _execute_phases(trailrun_id: str) -> None:
    """Execute run and summarize phases for a trailrun.

    Args:
        trailrun_id: Trailrun ID to execute

    Raises:
        Exception: If any phase fails
    """
    try:
        # Run phase
        await run_trailrun(trailrun_id)

        # Summarize phase (Slack format)
        await summarize_trailrun(trailrun_id, format="slack")

    except asyncio.CancelledError:
        logger.info(f"[Trailrun {trailrun_id}] Cancelled by user")
        # update_trailrun is called by cancel endpoint
        raise

    except Exception as e:
        logger.error(f"[Trailrun {trailrun_id}] {e}")
        # State update happens via update_trailrun which emits FAILED event
        await update_trailrun(trailrun_id, status="failed", error=str(e))
        raise
