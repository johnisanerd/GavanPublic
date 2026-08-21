"""App mention event handler."""

import logging
import re
from typing import Any

from src.config import settings

logger = logging.getLogger(__name__)
from src.orchestration.analysis.answerers import get_answerer
from src.orchestration.analysis.summarizers import SummarizerOptions
from src.slack.progress_constants import ANALYZING, ERROR, RUNNING
from src.slack.utils.blocks import format_experiment_config_blocks
from src.slack.utils.fallback import post_summary_with_fallback
from src.slack.utils.personas import get_bot_persona
from src.trailrun.generate_experiment import ConfigGenerationError
from src.trailrun.highlights import extract_highlights_for_trailrun
from src.trailrun.phases import design_trailrun
from src.trailrun.state import create_trailrun
from src.trailrun.store import get_trailrun_by_thread
from src.utils.progress_indicator import ProgressIndicator


async def handle_app_mention(event: dict[str, Any], say: Any, client: Any) -> None:
    """Handle @bot mentions in Slack channels.

    Two behaviors:
    1. In experiment thread: Answer questions about the data
    2. Elsewhere: Generate new experiment config

    Args:
        event: The app_mention event data from Slack
        say: Function to send a message to the channel
        client: Slack WebClient
    """
    user_id = event.get("user", "unknown")
    channel_id = event.get("channel", "unknown")
    text = event.get("text", "")
    thread_ts = event.get("thread_ts")  # Check if in a thread

    # Remove bot mention from text to get the actual content
    # Mentions are formatted as <@U123456>
    content = re.sub(r"<@[A-Z0-9]+>", "", text).strip()

    # Check if this is in an experiment thread
    if thread_ts:
        trailrun = get_trailrun_by_thread(thread_ts)
        if trailrun:
            # This is an experiment thread
            if trailrun.status == "completed" and trailrun.research_content:
                # Answer the question
                await _handle_thread_question(
                    client=client,
                    channel_id=channel_id,
                    thread_ts=thread_ts,
                    question=content,
                    trailrun=trailrun,
                )
                return
            elif trailrun.status != "completed":
                # Experiment not ready yet - give user feedback
                logger.info(
                    f"@mention in thread {thread_ts} but experiment not completed (status: {trailrun.status})"
                )
                status_messages = {
                    "running": "⏳ This experiment is still running. I'll be ready to answer questions once it's complete!",
                    "cancelled": "❌ This experiment was cancelled.",
                    "failed": "❌ This experiment failed to complete.",
                }
                message = status_messages.get(
                    trailrun.status,
                    f"⏳ This experiment isn't ready yet (status: {trailrun.status}).",
                )
                await client.chat_postEphemeral(
                    channel=channel_id,
                    user=user_id,
                    text=message,
                )
                return

    # Not in experiment thread - treat as new experiment request
    if not content:
        # No description provided - show help
        persona = get_bot_persona()
        await say(
            f"Hello <@{user_id}>! Mention me with an experiment description to get started.\n\n"
            f"Example: `@Trailhead test if the model can solve basic math problems`",
            **persona,
        )
        return

    logger.info(f"@mention from user={user_id}: '{content}'")

    # Post initial message with progress animation
    initial_text = f"{RUNNING} Generating experiment configuration..."
    logger.debug(f"[Slack] chat_postMessage: {initial_text}")
    response = await client.chat_postMessage(
        channel=channel_id,
        text=initial_text,
    )
    message_ts = response["ts"]

    # Create trailrun first (design_trailrun requires existing trailrun)
    trailrun = create_trailrun(channel_id=channel_id, user_id=user_id)

    # Generate config using design phase with progress indicator
    try:
        async with ProgressIndicator(
            client.chat_update,
            text="Generating experiment configuration...",
            channel=channel_id,
            ts=message_ts,
        ):
            config = await design_trailrun(trailrun.id, content)
    except ConfigGenerationError as e:
        # User-friendly error message from config generation
        error_text = f"❌ {e}"
        logger.debug(f"[Slack] chat_update: {error_text}")
        await client.chat_update(
            channel=channel_id,
            ts=message_ts,
            text=error_text,
        )
        logger.error(f"Config generation failed for trailrun {trailrun.id}: {e}")
        return
    except Exception as e:
        error_text = "❌ Failed to generate config"
        logger.debug(f"[Slack] chat_update: {error_text}")
        await client.chat_update(
            channel=channel_id,
            ts=message_ts,
            text=error_text,
        )
        logger.error(f"Unexpected error in config generation for trailrun {trailrun.id}: {e}")
        return

    # Update message with config and interactive controls
    blocks = format_experiment_config_blocks(config, trailrun.id)
    logger.debug("[Slack] chat_update: Review your experiment configuration")
    await client.chat_update(
        channel=channel_id,
        ts=message_ts,
        text="Review your experiment configuration",
        blocks=blocks,
    )

    logger.info(f"Trailrun {trailrun.id} config sent to user from @mention, waiting for start")


async def _handle_thread_question(
    client: Any,
    channel_id: str,
    thread_ts: str,
    question: str,
    trailrun: Any,
) -> None:
    """Answer a question in an experiment thread.

    Args:
        client: Slack WebClient
        channel_id: Slack channel ID
        thread_ts: Thread timestamp
        question: The question to answer
        trailrun: Trailrun with research_content
    """
    if not question:
        return

    logger.info(f"@mention question in trailrun {trailrun.id} thread: '{question}'")

    # Post initial message in thread with progress animation
    analyzing_text = f"{ANALYZING} Analyzing data to answer your question..."
    logger.debug(f"[Slack] chat_postMessage: {analyzing_text}")
    response = await client.chat_postMessage(
        channel=channel_id,
        thread_ts=thread_ts,
        text=analyzing_text,
    )
    temp_ts = response["ts"]

    try:
        # Extract highlights for the answer (same as summarizer)
        highlights = None
        if trailrun.messages:
            highlights = await extract_highlights_for_trailrun(trailrun)

        # Answer the question using cached research content with progress animation
        answerer = get_answerer("slack")

        async with ProgressIndicator(
            client.chat_update,
            text="Analyzing data to answer your question...",
            channel=channel_id,
            ts=temp_ts,
        ):
            answer_result = await answerer(
                research_content=trailrun.research_content,
                question=question,
                model=settings.utility_model,
                timeout=settings.timeout_s,
                options=SummarizerOptions(
                    research_type="inspect_eval",
                    models=trailrun.models,
                    highlights=highlights,
                    samples_included=trailrun.samples_included,
                    samples_total=trailrun.samples_total,
                ),
                slack_client=client,
                channel_id=channel_id,
                thread_ts=thread_ts,
            )

        # Delete the temp message after getting answer
        logger.debug("[Slack] chat_delete: temp progress message")
        await client.chat_delete(
            channel=channel_id,
            ts=temp_ts,
        )

        # If blocks are empty, image was uploaded directly - don't post anything else
        if not answer_result.blocks:
            logger.info(f"Image uploaded for trailrun {trailrun.id} - no text response needed")
            return

        # Post answer in thread with fallbacks
        await post_summary_with_fallback(
            client=client,
            channel_id=channel_id,
            message_ts=thread_ts,
            summary_result=answer_result,
            content=trailrun.research_content,
            bundle_url=None,  # No bundle button for answers
            trailrun_id=trailrun.id,
        )

        logger.info(f"Posted answer in trailrun {trailrun.id} thread")

    except Exception as e:
        error_msg = str(e)
        logger.error(f"Error answering question in trailrun {trailrun.id}: {error_msg}")
        # Update temp message with error
        error_text = f"{ERROR} Failed to answer question: {error_msg}"
        logger.debug(f"[Slack] chat_update: {error_text}")
        await client.chat_update(
            channel=channel_id,
            ts=temp_ts,
            text=error_text,
        )
