"""Slack Block Kit building utilities."""

from typing import Any

from src.runner.types import ExperimentConfig


def format_experiment_config_blocks(
    config: ExperimentConfig, trailrun_id: str
) -> list[dict[str, Any]]:
    """Format ExperimentConfig as Slack blocks with input field and action buttons.

    Args:
        config: The experiment configuration
        trailrun_id: Trailrun ID for action callbacks

    Returns:
        List of Slack Block Kit blocks
    """
    blocks: list[dict[str, Any]] = [
        {"type": "header", "text": {"type": "plain_text", "text": "Experiment Configuration"}},
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": f"*Prompts ({len(config.prompts)})*\n"
                + "\n".join(f"• {p}" for p in config.prompts),
            },
        },
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": f"*Models ({len(config.models)})*\n"
                + "\n".join(f"• `{m}`" for m in config.models),
            },
        },
        {"type": "section", "text": {"type": "mrkdwn", "text": f"*Repetitions:* {config.n}"}},
        {"type": "divider"},
        {
            "type": "input",
            "dispatch_action": True,
            "element": {
                "type": "plain_text_input",
                "action_id": f"experiment_change:{trailrun_id}",
                "placeholder": {
                    "type": "plain_text",
                    "text": "e.g., 'add another prompt' or 'use claude instead'",
                },
            },
            "label": {"type": "plain_text", "text": "Make changes (optional)"},
        },
        {"type": "divider"},
        {
            "type": "actions",
            "elements": [
                {
                    "type": "button",
                    "text": {"type": "plain_text", "text": "Cancel"},
                    "action_id": f"experiment_cancel:{trailrun_id}",
                    "value": trailrun_id,
                },
                {
                    "type": "button",
                    "text": {"type": "plain_text", "text": "Start"},
                    "style": "primary",
                    "action_id": f"experiment_start:{trailrun_id}",
                    "value": trailrun_id,
                },
            ],
        },
    ]
    return blocks
