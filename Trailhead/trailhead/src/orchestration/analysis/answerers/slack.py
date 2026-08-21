"""Slack Block Kit format answerer for specific questions about experiment data.

Two-step architecture (same as summarizers):
1. LLM generates markdown (with optional tool calls for images)
2. Convert markdown to Slack blocks via markdown_to_slack_blocks() (algorithmic)

Image generation uses tool calling - only available when Slack client is provided.
"""

import io
import json
import logging
from typing import Any

from openai import AsyncOpenAI

from src.config import settings

logger = logging.getLogger(__name__)
from src.orchestration.analysis.summarizers.markdown_to_slack import markdown_to_slack_blocks
from src.orchestration.analysis.summarizers.shared import (
    SummarizerOptions,
    sanitize_quotes,
    truncate_research,
)
from src.orchestration.client import generate_image
from src.prompts.answerers.slack import (
    SLACK_ANSWERER_INSTRUCTIONS,
    SLACK_ANSWERER_TASK,
    format_highlights_for_answerer_prompt,
)
from src.prompts.media import CREATE_MEDIA_TOOL, IMAGE_GENERATION
from src.types import SummarizerResponse

# OpenRouter base URL for direct API calls with tools
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"


async def answer_to_slack(
    research_content: str,
    question: str,
    model: str,
    timeout: float = 30.0,
    options: SummarizerOptions | None = None,
    slack_client: Any | None = None,
    channel_id: str | None = None,
    thread_ts: str | None = None,
) -> SummarizerResponse:
    """Answer a specific question about experiment data in Slack Block Kit format.

    Uses two-step architecture:
    1. LLM generates markdown text (with optional tool calls for images)
    2. Markdown is converted to Slack blocks algorithmically

    Args:
        research_content: Raw research data (same content used for summary)
        question: Specific question to answer
        model: Model name to use
        timeout: Request timeout in seconds
        options: Optional answerer options
        slack_client: Slack WebClient for uploading images (optional)
        channel_id: Channel ID for image uploads (required if slack_client provided)
        thread_ts: Thread timestamp for image uploads (required if slack_client provided)

    Returns:
        SummarizerResponse with Slack Block Kit blocks containing the answer

    Raises:
        ValueError: If answering fails
    """
    options = options or SummarizerOptions()

    # Check if we can use tools (need slack_client for image uploads)
    can_use_tools = slack_client is not None and channel_id is not None and thread_ts is not None

    # Truncate research content
    max_chars = settings.max_research_tokens * 4
    truncated_content = truncate_research(research_content, max_chars=max_chars)
    char_count = len(truncated_content)
    logger.info(f"Processing {char_count} chars (~{char_count // 4} tokens) for question")

    # Build prompts
    system_prompt = SLACK_ANSWERER_INSTRUCTIONS(can_use_tools=can_use_tools)
    user_prompt = SLACK_ANSWERER_TASK(truncated_content, question)

    # Add highlights if available
    if options.highlights:
        highlights_text = format_highlights_for_answerer_prompt(options.highlights)
        user_prompt += f"\n\n{highlights_text}"

    # Call LLM with optional tool support
    client = AsyncOpenAI(
        api_key=settings.openrouter_api_key,
        base_url=OPENROUTER_BASE_URL,
        timeout=timeout,
    )

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]

    # Make API call - with tools if Slack client available
    response = await client.chat.completions.create(
        model=model,
        messages=messages,
        tools=[CREATE_MEDIA_TOOL] if can_use_tools else None,
        tool_choice="auto" if can_use_tools else None,
    )

    assistant_message = response.choices[0].message

    # Handle tool calls (image generation)
    if assistant_message.tool_calls:
        for tool_call in assistant_message.tool_calls:
            if tool_call.function.name == "create_media":
                result = await _execute_create_media(
                    tool_call=tool_call,
                    slack_client=slack_client,
                    channel_id=channel_id,
                    thread_ts=thread_ts,
                )
                if "uploaded successfully" in result:
                    logger.info("Image uploaded - returning minimal response")
                    return SummarizerResponse(blocks=[])
                else:
                    logger.warning(f"Image generation failed: {result}")
                    # Fall through to text response

    # Get markdown content from response
    markdown = assistant_message.content
    if not markdown:
        raise ValueError("Empty response from model")

    markdown = markdown.strip()

    # Sanitize quotes: verify "..." against source, convert to [[quote:N]] or '...'
    source = options.source_content or research_content
    sanitized, _ = sanitize_quotes(
        markdown,
        source,
        options.highlights,
    )

    # Convert markdown to Slack blocks
    blocks = markdown_to_slack_blocks(
        markdown_text=sanitized,
        highlights=options.highlights,
    )

    return SummarizerResponse(blocks=blocks)


async def _execute_create_media(
    tool_call: Any,
    slack_client: Any,
    channel_id: str,
    thread_ts: str,
) -> str:
    """Execute the create_media tool: generate image and upload to Slack.

    Uses the IMAGE_GENERATION_TEMPLATE to build the final prompt for Gemini.
    """
    try:
        # Parse tool arguments (new format: visual_type, data, headline)
        args = json.loads(tool_call.function.arguments)
        visual_type = args.get("visual_type", "chart")
        data = args.get("data", "")
        headline = args.get("headline", "")

        if not data:
            return "Error: No data provided for image generation"

        # Build the prompt using our template
        prompt = IMAGE_GENERATION(visual_type, data, headline)

        logger.info(f"Generating {visual_type}: {headline}")
        logger.debug(f"Data: {data[:100]}...")

        # Generate the image
        image_bytes = await generate_image(
            prompt=prompt,
            model=settings.image_generation_model,
            timeout=60.0,
        )

        # Upload to Slack
        logger.info(f"Uploading image to Slack ({len(image_bytes)} bytes)")

        result = await slack_client.files_upload_v2(
            channel=channel_id,
            thread_ts=thread_ts,
            file=io.BytesIO(image_bytes),
            filename="infographic.png",
            title="Generated Infographic",
        )

        # Check if upload succeeded
        if result.get("ok"):
            return "Image generated and uploaded successfully. Reference it in your response."
        else:
            return f"Image generated but upload failed: {result.get('error', 'unknown error')}"

    except Exception as e:
        error_msg = f"Image generation failed: {e}"
        logger.error(error_msg)
        return error_msg
