"""Summarizers for different output formats."""

from collections.abc import Awaitable, Callable
from typing import Any

from .markdown import summarize_to_markdown
from .markdown_to_slack import markdown_to_slack_blocks
from .shared import SummarizerOptions, process_quote_tags
from .slack import summarize_to_slack

# Type alias for summarizer functions
SummarizerFunc = Callable[..., Awaitable[Any]]

# Registry of available summarizers
SUMMARIZERS: dict[str, SummarizerFunc] = {
    "slack": summarize_to_slack,
    "markdown": summarize_to_markdown,
}


def get_summarizer(format_type: str) -> SummarizerFunc:
    """Get summarizer function by format type.

    Args:
        format_type: Format type ("slack", "markdown")

    Returns:
        Summarizer function

    Raises:
        ValueError: If format_type is not recognized
    """
    if format_type not in SUMMARIZERS:
        available = ", ".join(SUMMARIZERS.keys())
        raise ValueError(f"Unknown format: {format_type}. Available: {available}")
    return SUMMARIZERS[format_type]


def list_formats() -> list[str]:
    """Get list of available summarizer formats.

    Returns:
        List of format names
    """
    return list(SUMMARIZERS.keys())


# Export public API
__all__ = [
    "SummarizerFunc",
    "SummarizerOptions",
    "get_summarizer",
    "list_formats",
    "markdown_to_slack_blocks",
    "process_quote_tags",
    "summarize_to_markdown",
    "summarize_to_slack",
]
