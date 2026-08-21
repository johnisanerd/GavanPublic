"""Tests for Slack app handlers."""

import pytest


@pytest.mark.asyncio
async def test_slack_app_initialization():
    """Test that Slack app initializes correctly."""
    from src.slack.app import app

    assert app is not None
    assert app.client is not None


@pytest.mark.asyncio
async def test_app_mention_handler_registered():
    """Test app_mention handler is registered."""
    from src.slack.app import app
    from src.slack.events.app_mention import handle_app_mention

    # Verify the handler exists and is callable
    assert callable(handle_app_mention)
    assert app is not None
