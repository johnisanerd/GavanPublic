"""Shared utilities and types for all summarizers."""

import logging
import re
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from src.orchestration.analysis.highlighter import Highlight

logger = logging.getLogger(__name__)


# Pattern for [[quote:N]] quote tags
QUOTE_TAG_PATTERN = re.compile(r"\[\[quote:(\d+)\]\]")


@dataclass
class SummarizerOptions:
    """Common options for all summarizer formats."""

    research_type: Literal["inspect_eval", "generic_log"] = "generic_log"
    max_length: int | None = None
    include_metadata: bool = True
    # Experiment metadata (programmatically provided)
    models: list[str] | None = None  # Model names evaluated
    samples_included: int | None = None  # Samples included in summary
    samples_total: int | None = None  # Total samples in eval
    # Citation highlights (from highlighter)
    highlights: "list[Highlight] | None" = None
    # Source content for quote verification (optional)
    source_content: str | None = None


def truncate_research(research: str, max_chars: int = 10000) -> str:
    """Truncate research content to prevent huge inputs.

    Args:
        research: Research content to truncate
        max_chars: Maximum characters to keep

    Returns:
        Truncated research content with warning if truncated
    """
    if len(research) <= max_chars:
        return research

    truncated = research[:max_chars]
    warning = f"\n\n[Research truncated at {max_chars} characters]"
    return truncated + warning


def build_highlight_map(highlights: "list[Highlight] | None") -> dict[int, "Highlight"]:
    """Build lookup from highlight index to highlight object."""
    if not highlights:
        return {}
    return {h.index: h for h in highlights}


def format_highlights_for_prompt(highlights: "list[Highlight] | None") -> str:
    """Format highlights as text for inclusion in summarizer prompts.

    Args:
        highlights: List of highlights from the highlighter

    Returns:
        Formatted string for prompt, or empty string if no highlights
    """
    if not highlights:
        return ""

    lines = ["Key highlights from the transcript:", ""]
    for h in highlights:
        quote = h.quoted_text[:150] + "..." if len(h.quoted_text) > 150 else h.quoted_text
        lines.append(f"[{h.index}] {h.description}")
        lines.append(f'    "{quote}"')
        lines.append("")

    return "\n".join(lines)


def _build_highlight_attribution(highlight: "Highlight") -> str:
    """Build attribution string like 'GPT 4o, c1.e1.t2' from highlight metadata."""
    from src.utils.model_repository import get_model_name

    parts = []

    # Model display name
    if highlight.model:
        parts.append(get_model_name(highlight.model))

    # Location parts
    location_parts = []
    if highlight.case is not None and highlight.case > 1:
        location_parts.append(f"s{highlight.case}")
    if highlight.epoch is not None:
        location_parts.append(f"e{highlight.epoch}")
    if highlight.turn is not None and highlight.turn != 2:
        location_parts.append(f"t{highlight.turn}")

    if location_parts:
        parts.append(".".join(location_parts))

    return ", ".join(parts) if parts else "source"


def process_quote_tags(
    text: str,
    highlights: "list[Highlight] | None",
) -> str:
    """Replace [[quote:N]] with markdown quotes (matching Slack style).

    Block-level quotes (on their own line or in blockquote):
        > quote text
        > *(attribution)*

    Inline quotes (within text):
        "quote text"[🔗](link)

    Args:
        text: Text containing [[quote:N]] tags
        highlights: List of highlights with verified quotes

    Returns:
        Text with quote tags replaced by markdown quotes
    """
    highlight_map = build_highlight_map(highlights)

    if not highlight_map:
        # No highlights - remove quote tags
        return QUOTE_TAG_PATTERN.sub("", text)

    # Use pattern that captures optional leading blockquote marker
    block_quote_pattern = re.compile(r"(^[ \t]*>[ \t]*)?\[\[quote:(\d+)\]\]", re.MULTILINE)

    def replace_quote(match: re.Match[str]) -> str:
        blockquote_prefix = match.group(1)  # "> " if in blockquote, else None
        quote_index = int(match.group(2))
        highlight = highlight_map.get(quote_index)
        if not highlight:
            return ""

        quote = highlight.quoted_text or "(no quote)"
        if len(quote) > 200:
            quote = quote[:197] + "..."

        attribution = _build_highlight_attribution(highlight)

        # Check if this is a block-level quote (in blockquote or on its own line)
        is_block = (
            blockquote_prefix is not None or match.start() == 0 or text[match.start() - 1] == "\n"
        )

        if is_block:
            # Block quote style: blockquote with attribution (Option E)
            if highlight.deep_link:
                return f"> {quote}\n> *([{attribution}]({highlight.deep_link}))*"
            return f"> {quote}\n> *({attribution})*"
        else:
            # Inline style: "quote"[🔗](link)
            if highlight.deep_link:
                return f'"{quote}"[🔗]({highlight.deep_link})'
            return f'"{quote}"'

    return block_quote_pattern.sub(replace_quote, text)


# Pattern for double-quoted text: "..." (but not already linked quotes)
DOUBLE_QUOTE_PATTERN = re.compile(r'"([^"]+)"(?!\[)')


def verify_quotes(
    text: str,
    source_content: str,
    highlights: "list[Highlight] | None" = None,
    match_threshold: float = 0.8,
) -> str:
    """Verify quoted text against source content.

    For each "..." quote found:
    - If text matches source content: keep double quotes, add [🔗] if deep link available
    - If no match found: convert to single quotes '...' and warn

    Args:
        text: Text containing quotes to verify
        source_content: Original research content to match against
        highlights: Optional highlights with deep links for matched quotes
        match_threshold: Fuzzy match ratio threshold (0-1)

    Returns:
        Text with verified quotes linked and unverified quotes converted to single quotes
    """
    from difflib import SequenceMatcher

    if not source_content:
        return text

    # Build searchable content from source + highlight quotes
    searchable = source_content.lower()

    # Also add highlight quotes to searchable content
    for h in highlights or []:
        if h.quoted_text:
            searchable += " " + h.quoted_text.lower()

    def find_best_match(quote: str) -> tuple[float, "Highlight | None"]:
        """Find best match ratio and associated highlight if any."""
        quote_lower = quote.lower()

        # First check for exact substring match
        if quote_lower in searchable:
            # Try to find which highlight this matches
            for h in highlights or []:
                if h.quoted_text and quote_lower in h.quoted_text.lower():
                    return 1.0, h
            return 1.0, None

        # Fuzzy match against each highlight
        best_ratio = 0.0
        best_highlight = None
        for h in highlights or []:
            if h.quoted_text:
                ratio = SequenceMatcher(None, quote_lower, h.quoted_text.lower()).ratio()
                if ratio > best_ratio:
                    best_ratio = ratio
                    best_highlight = h

        # Also try fuzzy match against source content windows
        # (sliding window of quote length)
        quote_len = len(quote_lower)
        for i in range(0, len(searchable) - quote_len, quote_len // 2):
            window = searchable[i : i + quote_len + 20]  # Add some buffer
            ratio = SequenceMatcher(None, quote_lower, window).ratio()
            if ratio > best_ratio:
                best_ratio = ratio
                best_highlight = None

        return best_ratio, best_highlight

    def replace_quote(match: re.Match[str]) -> str:
        quote_text = match.group(1)
        ratio, highlight = find_best_match(quote_text)

        if ratio >= match_threshold:
            # Verified - keep double quotes
            if highlight and highlight.deep_link:
                return f'"{quote_text}"<{highlight.deep_link}|[🔗]>'
            return f'"{quote_text}"'
        else:
            # Not verified - convert to single quotes and warn
            logger.warning(
                f"[verify_quotes] Unverified quote converted to single quotes: "
                f'"{quote_text[:50]}{"..." if len(quote_text) > 50 else ""}" '
                f"(best match: {ratio:.0%})"
            )
            return f"'{quote_text}'"

    return DOUBLE_QUOTE_PATTERN.sub(replace_quote, text)


def sanitize_quotes(
    markdown: str,
    source_content: str,
    highlights: "list[Highlight] | None" = None,
    match_threshold: float = 0.8,
) -> tuple[str, "list[Highlight]"]:
    """Sanitize quotes in markdown, converting verified ones to [[quote:N]].

    This function runs BEFORE the Slack/Markdown fork to keep the pipeline DRY.

    Processing:
    1. [[quote:N]] tags are kept as-is (already verified)
    2. "..." quotes are verified against source content:
       - If matches existing highlight: convert to [[quote:N]]
       - If matches source (not highlight): keep double quotes (verified)
       - If no match: convert to '...' single quotes + warn

    Args:
        markdown: LLM-generated markdown with [[quote:N]] and/or "..." quotes
        source_content: Original research content for verification
        highlights: Existing highlights from highlighter
        match_threshold: Fuzzy match threshold (0-1)

    Returns:
        (sanitized_markdown, highlights) - highlights unchanged for now,
        but returned for future extension
    """
    highlights = highlights or []

    if not source_content:
        return markdown, highlights

    # Build searchable content
    searchable = source_content.lower()
    for h in highlights:
        if h.quoted_text:
            searchable += " " + h.quoted_text.lower()

    def find_best_match(quote: str) -> tuple[float, "Highlight | None"]:
        """Find best match ratio and associated highlight if any."""
        quote_lower = quote.lower()

        # Check for exact substring match
        if quote_lower in searchable:
            # Try to find which highlight this matches
            for h in highlights:
                if h.quoted_text and quote_lower in h.quoted_text.lower():
                    return 1.0, h
            return 1.0, None

        # Fuzzy match against each highlight
        best_ratio = 0.0
        best_highlight: Highlight | None = None
        for h in highlights:
            if h.quoted_text:
                ratio = SequenceMatcher(None, quote_lower, h.quoted_text.lower()).ratio()
                if ratio > best_ratio:
                    best_ratio = ratio
                    best_highlight = h

        # Also try fuzzy match against source content windows
        quote_len = len(quote_lower)
        for i in range(0, len(searchable) - quote_len, max(1, quote_len // 2)):
            window = searchable[i : i + quote_len + 20]
            ratio = SequenceMatcher(None, quote_lower, window).ratio()
            if ratio > best_ratio:
                best_ratio = ratio
                best_highlight = None

        return best_ratio, best_highlight

    def replace_quote(match: re.Match[str]) -> str:
        quote_text = match.group(1)
        ratio, highlight = find_best_match(quote_text)

        if ratio >= match_threshold:
            # Verified quote
            if highlight:
                # Matches a highlight - use its index
                return f"[[quote:{highlight.index}]]"
            else:
                # Verified against source but no highlight - keep double quotes
                return f'"{quote_text}"'
        else:
            # Not verified - convert to single quotes and warn
            logger.warning(
                f"[sanitize_quotes] Unverified quote converted to single quotes: "
                f'"{quote_text[:50]}{"..." if len(quote_text) > 50 else ""}" '
                f"(best match: {ratio:.0%})"
            )
            return f"'{quote_text}'"

    # Process double-quoted text not already in [[quote:N]]
    sanitized = DOUBLE_QUOTE_PATTERN.sub(replace_quote, markdown)

    return sanitized, highlights
