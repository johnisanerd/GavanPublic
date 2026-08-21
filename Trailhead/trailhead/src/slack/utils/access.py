"""Access control utilities for experiment ownership."""

from typing import Any

from src.trailrun.store import get_trailrun
from src.trailrun.types import Trailrun


async def verify_experiment_owner(
    trailrun_id: str,
    clicking_user: str,
    client: Any,
    channel_id: str,
    action_name: str = "perform this action",
) -> Trailrun | None:
    """Verify user owns the experiment.

    Sends ephemeral error message if not authorized or not found.

    Args:
        trailrun_id: Experiment/trailrun ID
        clicking_user: User ID attempting the action
        client: Slack WebClient
        channel_id: Channel ID for ephemeral messages
        action_name: Description of action for error message

    Returns:
        Trailrun if authorized and found, None otherwise
    """
    trailrun = get_trailrun(trailrun_id)
    if not trailrun:
        await client.chat_postEphemeral(
            channel=channel_id,
            user=clicking_user,
            text=f"❌ Experiment not found (ID: {trailrun_id})\n\n"
            "Server may have restarted. Mention me to create a new experiment!",
        )
        return None

    if not trailrun.config:
        await client.chat_postEphemeral(
            channel=channel_id,
            user=clicking_user,
            text="❌ Experiment config not initialized.\n\nMention me to create a new experiment!",
        )
        return None

    if clicking_user != trailrun.user_id:
        await client.chat_postEphemeral(
            channel=channel_id,
            user=clicking_user,
            text=f"❌ Only <@{trailrun.user_id}> can {action_name}.\n\n"
            "Want to run your own? Mention me with your experiment idea!",
        )
        return None

    return trailrun
