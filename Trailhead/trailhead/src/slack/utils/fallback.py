"""Slack message posting with intelligent fallbacks.

Handles Slack Block Kit validation errors with two-tier fallback:
1. LLM-based error correction
2. Prose fallback in code block
"""

import json
import logging
from typing import Any

from slack_sdk.errors import SlackApiError

from src.config import settings

logger = logging.getLogger(__name__)
from src.orchestration.analysis.summarizers import summarize_to_markdown
from src.orchestration.client import call_llm
from src.prompts.utils.blockkit_fix import (
    BLOCKKIT_FIX_INSTRUCTIONS,
    BLOCKKIT_FIX_TASK,
)
from src.slack.progress_constants import SUCCESS
from src.utils.sanitize import sanitize_block_kit_response


async def post_summary_with_fallback(
    client: Any,
    channel_id: str,
    message_ts: str,
    summary_result: Any,
    content: str,
    bundle_url: str | None = None,
    trailrun_id: str | None = None,
) -> None:
    """Post summary to Slack with intelligent fallbacks.

    Args:
        client: Slack WebClient
        channel_id: Slack channel ID
        message_ts: Message timestamp to update
        summary_result: SummarizerResponse with blocks
        content: Original research content (for prose fallback)
        bundle_url: Optional URL for View Data button
        trailrun_id: Optional trailrun ID for logging

    Raises:
        Exception: If all fallback attempts fail
    """
    log_context = f"[{trailrun_id}]" if trailrun_id else ""

    # Prepare blocks
    sanitized = sanitize_block_kit_response(summary_result.model_dump())

    # Add View Data button if provided
    if bundle_url:
        sanitized["blocks"].append(
            {
                "type": "actions",
                "elements": [
                    {
                        "type": "button",
                        "text": {"type": "plain_text", "text": "View Data"},
                        "url": bundle_url,
                        "action_id": "view_data_button",
                        "style": "primary",
                    }
                ],
            }
        )

    # Try posting the blocks as a thread reply
    try:
        logger.debug(f"{log_context} [Slack] chat_postMessage: {SUCCESS} Summary (thread reply)")
        await client.chat_postMessage(
            channel=channel_id,
            thread_ts=message_ts,  # Reply in thread
            blocks=sanitized["blocks"],
            text=f"{SUCCESS} Summary",
        )
        logger.info(f"{log_context} Posted Slack summary in thread successfully")
        return

    except SlackApiError as e:
        error_msg = str(e)
        logger.error(f"{log_context} Slack API error: {error_msg}")

        # FALLBACK 1: LLM-based error correction
        try:
            logger.info(f"{log_context} Attempting LLM-based error correction...")
            fixed_blocks = await _fix_blocks_with_llm(sanitized["blocks"], error_msg)

            logger.debug(
                f"{log_context} [Slack] chat_postMessage: {SUCCESS} Summary (corrected blocks)"
            )
            await client.chat_postMessage(
                channel=channel_id,
                thread_ts=message_ts,  # Reply in thread
                blocks=fixed_blocks,
                text=f"{SUCCESS} Summary",
            )
            logger.info(f"{log_context} Posted corrected Slack summary in thread")
            return

        except Exception as llm_error:
            logger.error(f"{log_context} LLM correction failed: {llm_error}")

        # FALLBACK 2: Markdown in code block
        try:
            logger.info(f"{log_context} Falling back to markdown summary...")
            # expand_quotes=True (default) for final markdown output
            markdown_summary = await summarize_to_markdown(
                research_content=content,
                model=settings.utility_model,
                timeout=settings.timeout_s,
            )

            # Post as simple markdown code block in thread
            logger.debug(
                f"{log_context} [Slack] chat_postMessage: markdown fallback (thread reply)"
            )
            await client.chat_postMessage(
                channel=channel_id,
                thread_ts=message_ts,  # Reply in thread
                text=f"```\n{markdown_summary}\n```",
            )
            logger.info(f"{log_context} Posted markdown fallback summary in thread")
            return

        except Exception as prose_error:
            logger.error(f"{log_context} Prose fallback failed: {prose_error}")
            raise ValueError(
                f"All Slack posting attempts failed. Original error: {error_msg}"
            ) from prose_error


async def _fix_blocks_with_llm(blocks: list[dict], error_msg: str) -> list[dict]:
    """Use LLM to fix invalid Slack blocks based on error message.

    Args:
        blocks: Original blocks that failed validation
        error_msg: Error message from Slack API

    Returns:
        Fixed blocks

    Raises:
        ValueError: If LLM correction fails
    """
    response = await call_llm(
        model=settings.utility_model,
        messages=[
            {"role": "system", "content": BLOCKKIT_FIX_INSTRUCTIONS},
            {"role": "user", "content": BLOCKKIT_FIX_TASK(json.dumps(blocks, indent=2), error_msg)},
        ],
        timeout=30.0,
    )

    content = response.choices[0].message.content
    if not content:
        raise ValueError("Empty response from LLM")

    # Try to parse the JSON response
    try:
        # Remove markdown code block if present
        if content.startswith("```"):
            content = content.split("```")[1]
            if content.startswith("json"):
                content = content[4:]

        fixed_blocks = json.loads(content.strip())

        if not isinstance(fixed_blocks, list):
            raise ValueError("LLM did not return a list of blocks")

        return fixed_blocks

    except json.JSONDecodeError as e:
        raise ValueError(f"LLM returned invalid JSON: {e}") from e
