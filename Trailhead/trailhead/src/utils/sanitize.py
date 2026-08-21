"""Sanitization and safety utilities for Slack content."""

import re
from typing import Any

# Slack Block Kit limits (conservative estimates)
MAX_TEXT_LENGTH = 3000  # Per text block
MAX_BLOCKS = 50  # Maximum blocks in a message
MAX_FIELDS = 10  # Maximum fields in a section


def strip_control_characters(text: str) -> str:
    """Remove control characters from text except newlines and tabs.

    Args:
        text: Input text that may contain control characters

    Returns:
        Sanitized text with control characters removed
    """
    # Keep newlines and tabs, remove other control characters
    return re.sub(r"[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]", "", text)


def clamp_text_length(text: str, max_length: int = MAX_TEXT_LENGTH) -> str:
    """Clamp text to maximum length.

    Args:
        text: Input text to clamp
        max_length: Maximum allowed length (default: 3000)

    Returns:
        Text clamped to max_length with ellipsis if truncated
    """
    if len(text) <= max_length:
        return text
    return text[: max_length - 3] + "..."


def remove_unsafe_markdown(text: str) -> str:
    """Remove potentially unsafe markdown patterns.

    Prevents:
    - Hidden links with misleading text
    - Script-like patterns
    - Excessive nested formatting

    Args:
        text: Input markdown text

    Returns:
        Sanitized markdown text
    """
    # Remove hidden links (links with empty or whitespace-only text)
    text = re.sub(r"\[[\s]*\]\([^)]+\)", "", text)

    # Remove potential script tags (shouldn't render in Slack but be safe)
    text = re.sub(r"<script[^>]*>.*?</script>", "", text, flags=re.IGNORECASE | re.DOTALL)

    # Limit excessive nested formatting (more than 3 levels of bold/italic)
    for _ in range(10):  # Limit iterations to prevent infinite loops
        before = text
        text = re.sub(r"(\*{4,})", "***", text)  # Reduce excessive asterisks
        text = re.sub(r"(_{4,})", "___", text)  # Reduce excessive underscores
        if before == text:
            break

    return text


def sanitize_text(text: str, max_length: int = MAX_TEXT_LENGTH) -> str:
    """Apply all sanitization steps to text.

    Args:
        text: Input text to sanitize
        max_length: Maximum allowed length

    Returns:
        Fully sanitized text safe for Slack
    """
    text = strip_control_characters(text)
    text = remove_unsafe_markdown(text)
    text = clamp_text_length(text, max_length)
    return text


def sanitize_block_kit_response(response_data: dict[str, Any]) -> dict[str, Any]:
    """Sanitize a full Block Kit response.

    Args:
        response_data: Block Kit response dictionary

    Returns:
        Sanitized response with all text fields processed and null fields removed
    """
    blocks = response_data.get("blocks", [])

    # Limit number of blocks
    if len(blocks) > MAX_BLOCKS:
        blocks = blocks[:MAX_BLOCKS]

    sanitized_blocks: list[dict[str, Any]] = []
    for block in blocks:
        block_copy = block.copy()

        # Sanitize text in different block types
        if "text" in block_copy and isinstance(block_copy["text"], dict):
            if "text" in block_copy["text"]:
                block_copy["text"]["text"] = sanitize_text(block_copy["text"]["text"])

        if "fields" in block_copy and isinstance(block_copy["fields"], list):
            # Limit number of fields
            fields = block_copy["fields"][:MAX_FIELDS]
            block_copy["fields"] = [
                {**field, "text": sanitize_text(field.get("text", ""))}
                if "text" in field
                else field
                for field in fields
            ]

        if "elements" in block_copy and isinstance(block_copy["elements"], list):
            block_copy["elements"] = [
                {**elem, "text": sanitize_text(elem.get("text", ""))} if "text" in elem else elem
                for elem in block_copy["elements"]
            ]

        # Remove null fields to comply with Slack Block Kit validation
        # Each block type has specific allowed fields:
        # - header: type, text
        # - section: type, text, fields
        # - divider: type
        # - context: type, elements
        block_copy = {k: v for k, v in block_copy.items() if v is not None}

        sanitized_blocks.append(block_copy)

    return {**response_data, "blocks": sanitized_blocks}
