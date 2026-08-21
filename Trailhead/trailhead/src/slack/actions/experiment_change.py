"""Experiment config change action handler."""

import json
import logging
from typing import Any

from src.slack.progress_constants import RUNNING

logger = logging.getLogger(__name__)
from src.slack.utils.access import verify_experiment_owner
from src.slack.utils.blocks import format_experiment_config_blocks
from src.trailrun.generate_experiment import ConfigGenerationError, generate_experiment
from src.trailrun.store import update_trailrun
from src.utils.progress_indicator import ProgressIndicator


async def handle_experiment_change(
    ack: Any, action: dict[str, Any], body: dict[str, Any], client: Any, respond: Any
) -> None:
    """Handle input field submission to regenerate config with changes.

    Args:
        ack: Function to acknowledge the action
        action: Action data containing the input value
        body: Request body with message context
        client: Slack WebClient
        respond: Function to update the ephemeral message
    """
    # Acknowledge immediately to prevent timeout
    await ack()

    # Extract trailrun_id from action_id (format: experiment_change:{trailrun_id})
    action_id = action["action_id"]
    trailrun_id = action_id.split(":", 1)[1]

    change_request = action.get("value", "").strip()

    if not change_request:
        # Empty input - ignore
        return

    logger.info(f"Regenerating config for trailrun {trailrun_id} with changes: '{change_request}'")

    # Extract context
    clicking_user = body["user"]["id"]
    channel_id = body["channel"]["id"]
    message_ts = body["message"]["ts"]

    # Verify ownership and get trailrun
    trailrun = await verify_experiment_owner(
        trailrun_id, clicking_user, client, channel_id, action_name="modify this experiment"
    )
    if not trailrun:
        return

    # Show current config with "Updating..." status (remove input/buttons)
    updating_blocks = [
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
                    f"*Models ({len(trailrun.config.prompts)})*\n"
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
            "elements": [{"type": "mrkdwn", "text": f"{RUNNING} Updating configuration..."}],
        },
    ]

    # Show updating state immediately (preserves config display)
    logger.debug("[Slack] chat_update: Updating configuration...")
    await client.chat_update(
        channel=channel_id,
        ts=message_ts,
        text="Updating configuration...",
        blocks=updating_blocks,
    )

    # Build prompt with current config and change request
    current_json = json.dumps(trailrun.config.model_dump(), indent=2)
    regeneration_prompt = f"""Current experiment configuration:
```json
{current_json}
```

Requested changes: {change_request}

Generate an updated configuration incorporating these changes."""

    # Generate new config with progress indicator
    async def update_progress(text: str) -> None:
        updating_blocks[-1] = {"type": "context", "elements": [{"type": "mrkdwn", "text": text}]}
        logger.debug(f"[Slack] chat_update (progress): {text}")
        await client.chat_update(
            channel=channel_id,
            ts=message_ts,
            text="Updating configuration...",
            blocks=updating_blocks,
        )

    try:
        async with ProgressIndicator(
            update_progress,
            text="Updating configuration...",
        ):
            new_config = await generate_experiment(regeneration_prompt)
    except ConfigGenerationError as e:
        # User-friendly error message from config generation
        error_text = f"❌ {e}"
        logger.debug(f"[Slack] chat_update: {error_text}")
        await client.chat_update(
            channel=channel_id,
            ts=message_ts,
            text=error_text,
        )
        return
    except Exception as e:
        logger.error(f"Unexpected error in config update for trailrun {trailrun_id}: {e}")
        await client.chat_update(
            channel=channel_id,
            ts=message_ts,
            text="❌ Failed to update config",
        )
        return

    # Update trailrun with new config
    update_trailrun(trailrun_id, config=new_config)

    # Update with new config
    blocks = format_experiment_config_blocks(new_config, trailrun_id)
    logger.debug("[Slack] chat_update: Review your updated experiment configuration")
    await client.chat_update(
        channel=channel_id,
        ts=message_ts,
        text="Review your updated experiment configuration",
        blocks=blocks,
    )

    logger.info(f"Trailrun {trailrun_id} config updated")
