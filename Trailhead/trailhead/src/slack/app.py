"""Slack Bolt app with centralized handler registration.

This file provides a complete view of all Slack event handlers and actions
in one place. All interaction is via @Trailhead mentions.

Required Slack bot token scopes:
- app_mentions:read - Receive @bot mention events
- chat:write - Send messages as the bot
- chat:write.customize - Customize username and avatar per message
"""

import re

from slack_bolt.async_app import AsyncApp

from src.config import settings

# Import handler implementations
from src.slack.actions.experiment_cancel import handle_experiment_cancel
from src.slack.actions.experiment_change import handle_experiment_change
from src.slack.actions.experiment_start import handle_experiment_start
from src.slack.actions.url_input import handle_url_input_submit
from src.slack.actions.view_data import handle_view_data
from src.slack.events.app_mention import handle_app_mention

# Initialize Slack Bolt AsyncApp
app = AsyncApp(
    token=settings.slack_bot_token,
    signing_secret=settings.slack_signing_secret,
)

# ============================================================================
# EVENT HANDLERS
# ============================================================================

app.event("app_mention")(handle_app_mention)

# ============================================================================
# ACTION HANDLERS
# ============================================================================

app.action("log_url_input")(handle_url_input_submit)
app.action("view_data_button")(handle_view_data)
app.action(re.compile(r"^experiment_start:"))(handle_experiment_start)
app.action(re.compile(r"^experiment_cancel:"))(handle_experiment_cancel)
app.action(re.compile(r"^experiment_change:"))(handle_experiment_change)
