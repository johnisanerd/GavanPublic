"""LLM API calls via OpenRouter."""

import json
import logging
from collections.abc import Iterable
from typing import Any

from openai import AsyncOpenAI

logger = logging.getLogger(__name__)
from openai.types.chat import ChatCompletion, ChatCompletionMessage, ChatCompletionMessageParam
from openai.types.chat.chat_completion import Choice
from openai.types.completion_usage import CompletionUsage

from src.config import settings

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"


def _create_client(timeout: float) -> AsyncOpenAI:
    """Create OpenRouter client."""
    return AsyncOpenAI(
        api_key=settings.openrouter_api_key,
        base_url=OPENROUTER_BASE_URL,
        timeout=timeout,
    )


def _mock_response(
    model: str, messages: Iterable[ChatCompletionMessageParam], response_format: Any
) -> ChatCompletion:
    """Create mock response for dry run mode."""
    logger.info("=" * 80)
    logger.info("[DRY RUN] Would send the following to OpenRouter:")
    logger.info("=" * 80)
    logger.info(f"Model: {model}")
    if response_format:
        logger.info(f"Response Format: {json.dumps(response_format, indent=2)}")
    logger.info("Messages:")
    for i, msg in enumerate(messages):
        logger.info(f"--- Message {i + 1} ({msg.get('role', 'unknown')}) ---")
        content = msg.get("content", "")
        if len(str(content)) > 500:
            logger.info(f"{str(content)[:500]}...[truncated]")
        else:
            logger.info(str(content))
    logger.info("=" * 80)
    logger.info("[DRY RUN] Returning mock response")
    logger.info("=" * 80)

    mock_content = (
        '{"blocks": [{"type": "header", "text": {"type": "plain_text", '
        '"text": "Mock Summary"}}], "metadata": null}'
    )
    return ChatCompletion(
        id="mock-completion",
        choices=[
            Choice(
                finish_reason="stop",
                index=0,
                message=ChatCompletionMessage(content=mock_content, role="assistant"),
            )
        ],
        created=0,
        model=model,
        object="chat.completion",
        usage=CompletionUsage(completion_tokens=0, prompt_tokens=0, total_tokens=0),
    )


async def _call_streaming(
    client: AsyncOpenAI,
    model: str,
    messages: Iterable[ChatCompletionMessageParam],
    response_format: Any,
) -> ChatCompletion:
    """Make streaming LLM call."""
    logger.debug("Using streaming mode")

    if response_format:
        stream = await client.chat.completions.create(
            model=model,
            messages=messages,
            response_format=response_format,
            stream=True,
        )
    else:
        stream = await client.chat.completions.create(
            model=model,
            messages=messages,
            stream=True,
        )

    logger.debug("Streaming response...")
    accumulated_content = ""
    finish_reason = None
    last_chunk = None

    async for chunk in stream:
        last_chunk = chunk
        if chunk.choices:
            delta = chunk.choices[0].delta
            if delta.content:
                accumulated_content += delta.content
                # Print streaming content to stdout for user visibility
                print(delta.content, end="", flush=True)
            if chunk.choices[0].finish_reason:
                finish_reason = chunk.choices[0].finish_reason

    print()  # Newline after streaming content
    logger.debug("Response complete")

    return ChatCompletion(
        id=last_chunk.id if last_chunk else "unknown",
        choices=[
            Choice(
                finish_reason=finish_reason or "stop",
                index=0,
                message=ChatCompletionMessage(content=accumulated_content, role="assistant"),
            )
        ],
        created=last_chunk.created if last_chunk else 0,
        model=model,
        object="chat.completion",
        usage=CompletionUsage(completion_tokens=0, prompt_tokens=0, total_tokens=0),
    )


async def _call_non_streaming(
    client: AsyncOpenAI,
    model: str,
    messages: Iterable[ChatCompletionMessageParam],
    response_format: Any,
) -> ChatCompletion:
    """Make non-streaming LLM call."""
    logger.debug("Using non-streaming mode")

    if response_format:
        result = await client.chat.completions.create(
            model=model,
            messages=messages,
            response_format=response_format,
        )
    else:
        result = await client.chat.completions.create(
            model=model,
            messages=messages,
        )

    logger.debug("Response received")
    if result.choices:
        choice = result.choices[0]
        if choice.message.content:
            logger.debug(f"Response content: {choice.message.content[:500]}...")
        else:
            # Log details when content is empty - could be refusal, content filter, etc.
            logger.warning(
                f"LLM returned empty content. "
                f"finish_reason={choice.finish_reason}, "
                f"refusal={getattr(choice.message, 'refusal', None)}"
            )

    return result


async def call_llm(
    model: str,
    messages: Iterable[ChatCompletionMessageParam],
    response_format: Any = None,
    timeout: float = 30.0,
) -> ChatCompletion:
    """Make a rate-limited LLM API call via OpenRouter.

    This is the ONLY function that should call LLM APIs.
    It handles API key access and rate limiting internally.

    Args:
        model: Model name (e.g., "anthropic/claude-sonnet-4", "openai/gpt-4o")
        messages: Chat message parameters
        response_format: Optional response format (for structured outputs)
        timeout: Request timeout in seconds

    Returns:
        ChatCompletion response

    Raises:
        RateLimitError: If rate limit queue is full
        ValueError: If API call fails
    """
    if settings.dry_run:
        return _mock_response(model, messages, response_format)

    client = _create_client(timeout)

    async def make_call() -> ChatCompletion:
        try:
            logger.debug(f"Calling OpenRouter with model {model}...")

            if settings.use_streaming:
                return await _call_streaming(client, model, messages, response_format)
            else:
                return await _call_non_streaming(client, model, messages, response_format)

        except Exception as e:
            logger.error(f"{type(e).__name__}: {e}")
            raise ValueError(f"LLM API call failed: {e}") from e

    from src.orchestration.client import rate_limiter

    logger.debug("Waiting for rate limiter...")
    return await rate_limiter.execute(make_call)
