"""View Data button action handler."""

from typing import Any


async def handle_view_data(ack: Any, body: dict[str, Any]) -> None:
    """Handle View Data button click.

    This button has a URL, so Slack opens the link automatically.
    We just need to acknowledge the action to prevent warnings.

    Args:
        ack: Function to acknowledge the action
        body: Request body (unused, but sent by Slack)
    """
    await ack()
    # No further action needed - the URL opens automatically
