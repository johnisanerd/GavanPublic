"""Slack Block Kit builders for trailrun UI."""

from typing import Any

from src.runner.types import ExperimentConfig


def build_config_blocks(config: ExperimentConfig, status_text: str) -> list[dict[str, Any]]:
    """Build Slack blocks for experiment config with status footer.

    Args:
        config: Experiment configuration
        status_text: Status text for context footer (e.g., "🔄 Running...")

    Returns:
        List of Slack Block Kit blocks
    """
    return [
        {"type": "header", "text": {"type": "plain_text", "text": config.title}},
        {"type": "divider"},
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": (
                    f"*Prompts ({len(config.prompts)})*\n"
                    + "\n".join(f"• {p}" for p in config.prompts)
                ),
            },
        },
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": (
                    f"*Models ({len(config.models)})*\n"
                    + "\n".join(f"• `{m}`" for m in config.models)
                ),
            },
        },
        {"type": "section", "text": {"type": "mrkdwn", "text": f"*Repetitions:* {config.n}"}},
        {"type": "divider"},
        {"type": "context", "elements": [{"type": "mrkdwn", "text": status_text}]},
    ]
