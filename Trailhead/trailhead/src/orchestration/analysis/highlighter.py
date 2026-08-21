"""Highlight extraction from experiment transcripts.

Extracts key highlights with citations from conversation transcripts.
The highlights can then be passed to summarizers for formatted output.
"""

import logging
import urllib.parse
from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING

from inspect_ai.model import ChatMessage

from src.config import settings

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from src.orchestration.parsers import MessageContext

from src.orchestration.citations import (
    Citation,
    extract_citations_from_text,
    format_messages_xml,
)
from src.orchestration.client import call_llm
from src.prompts.analysis.highlights import (
    HIGHLIGHT_EXTRACTION_SYSTEM,
    HIGHLIGHT_EXTRACTION_USER,
)


@dataclass
class ExperimentContext:
    """Context about the experiment being analyzed.

    Helps the highlighter focus on quotes relevant to what was being tested.
    """

    title: str  # Short descriptive title of the experiment
    prompts: list[str]  # The prompts/questions used in the experiment


@dataclass
class Highlight:
    """A highlight with optional deep link to the source message."""

    index: int
    description: str  # Why this moment was highlighted
    quoted_text: str
    message_id: str | None = None
    deep_link: str | None = None
    case: int | None = None  # Which test case (maps to sample.id)
    epoch: int | None = None  # Which run/iteration (1 to n)
    turn: int | None = None  # Which turn in the conversation (1-indexed)
    model: str | None = None  # Model ID (e.g., "openai/gpt-4o")


def build_inspect_deep_link(
    viewer_base_url: str,
    eval_filename: str,
    message_id: str,
    sample_id: str | None = None,
    epoch: int = 1,
) -> str:
    """Build a deep link to a specific message in the Inspect viewer.

    Helper for constructing build_link callbacks at call sites.

    Args:
        viewer_base_url: Base URL like "https://host/data-inspector/tr_xxx/index.html"
        eval_filename: The .eval filename (will be URL-encoded)
        message_id: The message ID to link to
        sample_id: The sample ID (e.g., "1", "2"). If None, links to samples list.
        epoch: The epoch number (usually 1)

    Returns:
        Full URL with hash path and message query param
    """
    encoded_filename = urllib.parse.quote(eval_filename, safe="")
    if sample_id:
        path = f"#/logs/{encoded_filename}/samples/sample/{sample_id}/{epoch}/messages"
        return f"{viewer_base_url}{path}?message={message_id}"
    else:
        path = f"#/logs/{encoded_filename}/samples/messages"
        return f"{viewer_base_url}{path}?message={message_id}"


async def extract_highlights(
    messages: list[ChatMessage],
    model: str | None = None,
    timeout: float = 60.0,
    build_link: Callable[[str, str | None, int, str | None], str | None] | None = None,
    experiment_context: ExperimentContext | None = None,
    message_context: "dict[str, MessageContext] | None" = None,
) -> list[Highlight]:
    """Extract highlights with citations from messages.

    Uses LLM to identify key moments in the conversation and extract
    them as highlights with verified quotes and optional deep links.

    Args:
        messages: Source messages to analyze
        model: Model to use for extraction (defaults to settings.utility_model)
        timeout: Request timeout in seconds
        build_link: Optional callback to build deep link from (message_id, sample_id, epoch, eval_file).
                    Signature: (message_id: str, sample_id: str | None, epoch: int, eval_file: str | None) -> str | None
        experiment_context: Optional context about the experiment (title, prompts)
                           to help focus on relevant highlights.
        message_context: Optional mapping from message_id to MessageContext
                        (sample_id, epoch, turn, eval_file) for deep links.

    Returns:
        List of highlights with verified citations and optional deep links.
    """
    model = model or settings.utility_model

    # Format messages as XML transcript with indices
    transcript_xml, index_to_id = format_messages_xml(list(messages))  # type: ignore[arg-type]

    # Extract highlights with citations
    logger.info("Extracting highlights...")
    user_content = HIGHLIGHT_EXTRACTION_USER(transcript_xml, experiment_context)
    response = await call_llm(
        model=model,
        messages=[
            {"role": "system", "content": HIGHLIGHT_EXTRACTION_SYSTEM},
            {"role": "user", "content": user_content},
        ],
        timeout=timeout,
    )

    raw_response = response.choices[0].message.content or ""

    # Parse and verify citations
    citations: list[Citation] = extract_citations_from_text(raw_response, messages, index_to_id)
    logger.info(f"Extracted {len(citations)} highlights")

    # Convert to Highlight objects with deep links
    highlights: list[Highlight] = []
    for i, citation in enumerate(citations):
        message_id = citation.parts[0].message_id if citation.parts else None
        quoted_text = citation.parts[0].quoted_text if citation.parts else ""

        # Look up context (case/epoch/turn)
        ctx = message_context.get(message_id) if message_context and message_id else None

        # Build deep link if callback provided and we have a message_id
        deep_link = None
        if build_link and message_id:
            sample_id = ctx.sample_id if ctx else None
            epoch = ctx.epoch if ctx else 1
            eval_file = ctx.eval_file if ctx else None
            deep_link = build_link(message_id, sample_id, epoch, eval_file)

        # case = sample_id as int (which test case/prompt)
        case = int(ctx.sample_id) if ctx and ctx.sample_id else None

        highlights.append(
            Highlight(
                index=citation.index or i + 1,
                description=citation.description,
                quoted_text=quoted_text,
                message_id=message_id,
                deep_link=deep_link,
                case=case,
                epoch=ctx.epoch if ctx else None,
                turn=ctx.turn if ctx else None,
                model=ctx.model if ctx else None,
            )
        )

    return highlights
