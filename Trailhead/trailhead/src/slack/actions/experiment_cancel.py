"""Experiment cancel action handler."""

import logging
from typing import Any

from src.slack.progress_constants import ERROR

logger = logging.getLogger(__name__)
from src.slack.utils.access import verify_experiment_owner
from src.trailrun.state import update_trailrun
from src.trailrun.tasks import cancel_trailrun


async def handle_experiment_cancel(
    ack: Any, action: dict[str, Any], body: dict[str, Any], client: Any
) -> None:
    """Handle Cancel button click to cancel experiment.

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

    logger.info(f"Canceling trailrun {trailrun_id}")

    # Verify ownership and get trailrun
    trailrun = await verify_experiment_owner(
        trailrun_id, clicking_user, client, channel_id, action_name="cancel this experiment"
    )
    if not trailrun:
        # Update status even if not found (for safety)
        await update_trailrun(trailrun_id, status="cancelled")
        return

    # Update message with config + cancelled status (remove input/buttons)
    config_blocks = [
        {"type": "header", "text": {"type": "plain_text", "text": trailrun.config.title}},
        {"type": "divider"},
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": (
                    f"*Prompts ({len(trailrun.config.prompts)})*\n"
                    + "\n".join(f"• {p}" for p in trailrun.config.prompts)
                ),
            },
        },
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": (
                    f"*Models ({len(trailrun.config.models)})*\n"
                    + "\n".join(f"• `{m}`" for m in trailrun.config.models)
                ),
            },
        },
        {
            "type": "section",
            "text": {"type": "mrkdwn", "text": f"*Repetitions:* {trailrun.config.n}"},
        },
        {"type": "divider"},
        {
            "type": "context",
            "elements": [{"type": "mrkdwn", "text": f"{ERROR} Experiment cancelled"}],
        },
    ]

    cancel_text = f"❌ {trailrun.config.title} (cancelled)"
    logger.debug(f"[Slack] chat_update: {cancel_text}")
    await client.chat_update(
        channel=channel_id,
        ts=message_ts,
        blocks=config_blocks,
        text=cancel_text,
    )

    # Cancel the running task and update status only if cancellation succeeded
    if cancel_trailrun(trailrun_id):
        await update_trailrun(trailrun_id, status="cancelled")
