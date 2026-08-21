"""URL input action handler for log file summarization."""

import asyncio
import logging
from typing import Any

from src.slack.progress_constants import ERROR, RUNNING
from src.trailrun.generate_experiment import process_summarization

logger = logging.getLogger(__name__)


async def handle_url_input_submit(
    ack: Any, action: dict[str, Any], body: dict[str, Any], client: Any
) -> None:
    """Handle URL input submission via dispatch action.

    Triggered when user presses Enter in the URL input field.

    Args:
        ack: Function to acknowledge the action
        action: Action data containing the input value
        body: Request body with message context
        client: Slack WebClient
    """
    await ack()

    raw_url = action.get("value", "").strip()
    # Slack wraps URLs in <angle brackets>, strip them
    url = raw_url.strip("<>")
    channel_id = body["channel"]["id"]
    user_id = body["user"]["id"]
    message_ts = body["message"]["ts"]

    logger.info(f"URL input submitted: url='{url}' (user={user_id}, channel={channel_id})")

    # Validate URL - if invalid, delete the input message and show ephemeral error
    if not url or not url.startswith("http"):
        logger.warning(f"Invalid URL in input field: '{url}' (user={user_id})")
        # Delete the input field message
        logger.debug("[Slack] chat_delete: invalid URL input message")
        await client.chat_delete(channel=channel_id, ts=message_ts)
        # Show ephemeral error - input validation failed
        await client.chat_postEphemeral(
            channel=channel_id,
            user=user_id,
            text=f"{ERROR} Please provide a valid URL starting with http:// or https://",
        )
        return

    # Update message to remove input field and show public processing message
    processing_text = f"{RUNNING} Processing your log file..."
    logger.debug(f"[Slack] chat_update: {processing_text}")
    await client.chat_update(channel=channel_id, ts=message_ts, text=processing_text, blocks=[])

    # Process in background
    task = asyncio.create_task(process_summarization(client, channel_id, message_ts, url))
    # Store task reference to prevent garbage collection
    task.add_done_callback(lambda t: None)
