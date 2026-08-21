"""Bot persona utilities."""

from typing import Any

from src.config import settings


def get_bot_persona() -> dict[str, Any]:
    """Get bot persona (username and icon_url) for Slack messages.

    Returns:
        Dict with optional username and icon_url keys for Slack API
    """
    persona: dict[str, Any] = {"username": settings.bot_name}
    if settings.bot_icon_url:
        persona["icon_url"] = settings.bot_icon_url
    return persona
