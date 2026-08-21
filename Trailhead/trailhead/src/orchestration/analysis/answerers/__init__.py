"""Answerers for responding to specific questions about experiment data."""

from collections.abc import Awaitable, Callable
from typing import Any

from src.orchestration.analysis.summarizers.shared import process_quote_tags

from .markdown import answer_to_markdown
from .slack import answer_to_slack

# Type alias for answerer functions
AnswererFunc = Callable[..., Awaitable[Any]]

# Registry of available answerers
ANSWERERS: dict[str, AnswererFunc] = {
    "slack": answer_to_slack,
    "markdown": answer_to_markdown,
}


def get_answerer(format_type: str) -> AnswererFunc:
    """Get answerer function by format type.

    Args:
        format_type: Format type ("slack", "markdown")

    Returns:
        Answerer function

    Raises:
        ValueError: If format_type is not recognized
    """
    if format_type not in ANSWERERS:
        available = ", ".join(ANSWERERS.keys())
        raise ValueError(f"Unknown format: {format_type}. Available: {available}")
    return ANSWERERS[format_type]


def list_formats() -> list[str]:
    """Get list of available answerer formats.

    Returns:
        List of format names
    """
    return list(ANSWERERS.keys())


# Export public API
__all__ = [
    "AnswererFunc",
    "answer_to_markdown",
    "answer_to_slack",
    "get_answerer",
    "list_formats",
    "process_quote_tags",
]
