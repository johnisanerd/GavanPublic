"""Slack Block Kit format summarizer.

Two-step architecture:
1. Generate markdown via summarize_to_markdown() (LLM)
2. Convert to Slack blocks via markdown_to_slack_blocks() (algorithmic)

Quote sanitization happens in step 1 (before format fork) to keep it DRY.
"""

from typing import Any

from src.orchestration.analysis.summarizers.markdown import summarize_to_markdown
from src.orchestration.analysis.summarizers.markdown_to_slack import (
    markdown_to_slack_blocks,
)
from src.orchestration.analysis.summarizers.shared import SummarizerOptions
from src.types import SummarizerResponse


def _build_metadata_block(options: SummarizerOptions) -> dict[str, Any] | None:
    """Build metadata context block if models or sample info provided."""
    if not (options.models or options.samples_included or options.samples_total):
        return None

    metadata_parts = []
    if options.models:
        # Strip "openrouter/" prefix for cleaner display
        models_str = ", ".join(f"`{m.removeprefix('openrouter/')}`" for m in options.models)
        metadata_parts.append(f"*Models:* {models_str}")
    if options.samples_included and options.samples_total:
        metadata_parts.append(f"*Samples:* {options.samples_included} of {options.samples_total}")

    metadata_text = " | ".join(metadata_parts)
    return {
        "type": "context",
        "elements": [{"type": "mrkdwn", "text": metadata_text}],
    }


async def summarize_to_slack(
    research_content: str,
    model: str,
    timeout: float = 30.0,
    options: SummarizerOptions | None = None,
) -> SummarizerResponse:
    """Summarize research content to Slack Block Kit format.

    Two-step process:
    1. LLM generates markdown with [[quote:N]] tags
    2. Algorithmic conversion to Slack blocks

    Args:
        research_content: Raw research text to summarize
        model: Model name to use
        timeout: Request timeout in seconds
        options: Optional summarizer options

    Returns:
        SummarizerResponse with Slack Block Kit blocks

    Raises:
        ValueError: If summarization fails
    """
    options = options or SummarizerOptions()

    # Step 1: Generate markdown via LLM (includes quote sanitization)
    # Keep [[quote:N]] tags for Slack block conversion
    markdown = await summarize_to_markdown(
        research_content=research_content,
        model=model,
        timeout=timeout,
        options=options,
        expand_quotes=False,  # Slack handles quote tags specially
    )

    # Step 2: Convert markdown to Slack blocks
    blocks = markdown_to_slack_blocks(
        markdown_text=markdown,
        highlights=options.highlights,
    )

    # Append metadata context block if provided
    metadata_block = _build_metadata_block(options)
    if metadata_block:
        blocks.append(metadata_block)

    # Return with processed blocks as dicts (Slack accepts raw dicts)
    # Use model_construct to skip validation - blocks include rich_text/context
    # which aren't in Block schema but are valid for Slack
    return SummarizerResponse.model_construct(blocks=blocks)
