"""Convert markdown to Slack Block Kit blocks.

Uses mistune for structure parsing and markdown-to-mrkdwn for text formatting.

Handles:
- Headers → header blocks
- Paragraphs → section blocks with mrkdwn
- Tables → table blocks (not text tables)
- Blockquotes → rich_text_quote blocks
- Dividers (---) → divider blocks
- Quote tags [[quote:N]] → inline or block quotes with attribution
"""

import logging
import re
from typing import TYPE_CHECKING, Any

import mistune
from markdown_to_mrkdwn import SlackMarkdownConverter

if TYPE_CHECKING:
    from src.orchestration.analysis.highlighter import Highlight

logger = logging.getLogger(__name__)


# Pattern for quote tags: [[quote:N]]
QUOTE_TAG_PATTERN = re.compile(r"\[\[quote:(\d+)\]\]")

# Converter for text formatting (bold, italic, links, etc.)
_mrkdwn_converter = SlackMarkdownConverter()


def _convert_inline_formatting(text: str) -> str:
    """Convert markdown inline formatting to Slack mrkdwn.

    Handles: **bold** → *bold*, *italic* → _italic_, [link](url) → <url|link>
    Does NOT handle block-level elements (those are handled separately).
    """
    # The library handles most conversions, but also converts headers/lists
    # which we don't want here. We'll do targeted replacements instead.

    # Bold: **text** → *text*
    text = re.sub(r"\*\*(.+?)\*\*", r"*\1*", text)

    # Italic: *text* → _text_ (but not if already converted bold)
    # This is tricky - we need to handle *text* that isn't **text**
    # Actually, let's use the library for simple cases

    # Links: [text](url) → <url|text>
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"<\2|\1>", text)

    # Strikethrough: ~~text~~ → ~text~
    text = re.sub(r"~~(.+?)~~", r"~\1~", text)

    # Code: `text` stays as `text`

    return text


def _has_multiline_quote(index: int, highlight_map: dict[int, "Highlight"]) -> bool:
    """Check if a highlight's quote text contains line breaks."""
    highlight = highlight_map.get(index)
    if not highlight or not highlight.quoted_text:
        return False
    return "\n" in highlight.quoted_text


def _process_inline_citations(
    text: str,
    highlight_map: dict[int, "Highlight"],
    skip_multiline: bool = False,
    plain_text: bool = False,
) -> str:
    """Replace [[quote:N]] with inline quote format: "quote" [source]

    Args:
        text: Text containing [[quote:N]] tags
        highlight_map: Map of index to Highlight
        skip_multiline: If True, leave multiline quotes as [[quote:N]] for block processing
        plain_text: If True, don't include links (for table cells that don't support mrkdwn)
    """

    def replace_citation(match: re.Match) -> str:
        index = int(match.group(1))
        highlight = highlight_map.get(index)
        if not highlight:
            return match.group(0)  # Leave as-is if not found

        # Skip multiline quotes - they'll be converted to block quotes
        if skip_multiline and _has_multiline_quote(index, highlight_map):
            return match.group(0)

        quote = highlight.quoted_text or ""
        if len(quote) > 100:
            quote = quote[:97] + "..."

        attribution = _build_highlight_attribution(highlight)
        # Don't include links in plain_text mode (e.g., table cells)
        # Use italic (_text_) for attribution in Slack mrkdwn
        if highlight.deep_link and not plain_text:
            return f'"{quote}" _<{highlight.deep_link}|[{attribution}]>_'
        return f'"{quote}" _[{attribution}]_'

    return QUOTE_TAG_PATTERN.sub(replace_citation, text)


def _is_block_citation(text: str) -> tuple[bool, int | None]:
    """Check if text is just a citation reference."""
    text = text.strip()
    match = QUOTE_TAG_PATTERN.fullmatch(text)
    if match:
        return True, int(match.group(1))
    return False, None


def _split_multiline_quotes(
    text: str,
    highlight_map: dict[int, "Highlight"],
) -> list[tuple[str, int | None]]:
    """Split text around multiline quote tags.

    Returns list of (text, quote_index) tuples.
    - If quote_index is None, it's regular text
    - If quote_index is an int, it's a multiline quote that should be a block

    Example: "Before [[quote:1]] after" with multiline quote 1 becomes:
    [("Before ", None), ("", 1), (" after", None)]
    """
    segments: list[tuple[str, int | None]] = []
    last_end = 0

    for match in QUOTE_TAG_PATTERN.finditer(text):
        index = int(match.group(1))

        # Check if this quote is multiline
        if _has_multiline_quote(index, highlight_map):
            # Add text before this quote
            before = text[last_end : match.start()]
            if before:
                segments.append((before, None))

            # Add the quote as a block marker
            segments.append(("", index))
            last_end = match.end()

    # Add remaining text
    remaining = text[last_end:]
    if remaining:
        segments.append((remaining, None))

    # If no multiline quotes found, return original text
    if not segments:
        return [(text, None)]

    return segments


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


def _build_citation_blocks(
    index: int,
    highlight_map: dict[int, "Highlight"],
) -> list[dict[str, Any]]:
    """Build rich_text_quote block with embedded attribution."""
    highlight = highlight_map.get(index)
    if not highlight:
        return []

    quote = highlight.quoted_text or "(no quote)"
    if len(quote) > 200:
        quote = quote[:197] + "..."

    attribution = _build_highlight_attribution(highlight)

    # Build quote elements: quote text + newline + attribution
    quote_elements: list[dict[str, Any]] = [
        {"type": "text", "text": quote},
        {"type": "text", "text": "\n"},
    ]

    # Attribution as link or plain text, in square brackets
    if highlight.deep_link:
        quote_elements.append(
            {
                "type": "link",
                "url": highlight.deep_link,
                "text": f"[{attribution}]",
                "style": {"italic": True},
            }
        )
    else:
        quote_elements.append(
            {
                "type": "text",
                "text": f"[{attribution}]",
                "style": {"italic": True},
            }
        )

    return [
        {
            "type": "rich_text",
            "elements": [
                {
                    "type": "rich_text_quote",
                    "elements": quote_elements,
                }
            ],
        }
    ]


def _parse_table(token: dict) -> list[list[str]]:
    """Extract table rows from mistune token."""
    rows: list[list[str]] = []

    for child in token.get("children", []):
        if child["type"] == "table_head":
            # Header row
            cells = []
            for cell in child.get("children", []):
                if cell["type"] == "table_cell":
                    cell_text = _extract_text(cell)
                    cells.append(cell_text)
            if cells:
                rows.append(cells)

        elif child["type"] == "table_body":
            # Data rows
            for row in child.get("children", []):
                if row["type"] == "table_row":
                    cells = []
                    for cell in row.get("children", []):
                        if cell["type"] == "table_cell":
                            cell_text = _extract_text(cell)
                            cells.append(cell_text)
                    if cells:
                        rows.append(cells)

    return rows


def _extract_text(token: dict) -> str:
    """Recursively extract text from a token, preserving markdown formatting."""
    token_type = token.get("type", "")

    if token_type == "text":
        return token.get("raw", "")

    if token_type == "strong":
        # Bold - wrap in **
        inner = ""
        for child in token.get("children", []):
            inner += _extract_text(child)
        return f"**{inner}**"

    if token_type == "emphasis":
        # Italic - wrap in *
        inner = ""
        for child in token.get("children", []):
            inner += _extract_text(child)
        return f"*{inner}*"

    if token_type == "codespan":
        return f"`{token.get('raw', '')}`"

    if token_type == "softbreak":
        return " "

    if "children" in token:
        parts = []
        for child in token["children"]:
            parts.append(_extract_text(child))
        return "".join(parts)

    if "raw" in token:
        return token["raw"]

    return ""


def _build_table_block(
    rows: list[list[str]],
    highlight_map: dict[int, "Highlight"],
) -> dict[str, Any]:
    """Build a Slack table block from rows."""
    slack_rows: list[list[dict[str, Any]]] = []

    for row_idx, row in enumerate(rows):
        slack_cells: list[dict[str, Any]] = []
        is_header = row_idx == 0

        for cell_text in row:
            # Process citations in cell (plain_text=True to skip links in tables)
            cell_text = _process_inline_citations(cell_text, highlight_map, plain_text=True)
            # Convert formatting
            cell_text = _convert_inline_formatting(cell_text)

            # Check if cell has bold markers (from markdown **text**)
            is_bold = cell_text.startswith("*") and cell_text.endswith("*") and len(cell_text) > 2
            if is_bold:
                cell_text = cell_text[1:-1]  # Strip * markers

            if is_header or is_bold:
                # Rich text cell with bold
                slack_cells.append(
                    {
                        "type": "rich_text",
                        "elements": [
                            {
                                "type": "rich_text_section",
                                "elements": [
                                    {
                                        "type": "text",
                                        "text": cell_text,
                                        "style": {"bold": True},
                                    }
                                ],
                            }
                        ],
                    }
                )
            else:
                # Plain raw_text cell
                slack_cells.append({"type": "raw_text", "text": cell_text})

        slack_rows.append(slack_cells)

    return {"type": "table", "rows": slack_rows}


def markdown_to_slack_blocks(
    markdown_text: str,
    highlights: "list[Highlight] | None" = None,
) -> list[dict[str, Any]]:
    """Convert markdown text to Slack Block Kit blocks.

    Args:
        markdown_text: Markdown formatted text
        highlights: Optional list of highlights for citation expansion

    Returns:
        List of Slack Block Kit block dicts
    """
    highlights = highlights or []
    highlight_map = {h.index: h for h in highlights}

    # Parse markdown to AST (enable table plugin for table support)
    md = mistune.create_markdown(renderer=None, plugins=["table"])
    result = md.parse(markdown_text)
    # mistune.parse returns (tokens_list, state) - we want the first element
    tokens: list[dict[str, Any]] = result[0] if isinstance(result, tuple) else result  # type: ignore[assignment]

    blocks: list[dict[str, Any]] = []
    current_text = ""

    def flush_text() -> None:
        nonlocal current_text
        if current_text.strip():
            # Convert formatting and citations
            text = _convert_inline_formatting(current_text.strip())
            text = _process_inline_citations(text, highlight_map)
            blocks.append(
                {
                    "type": "section",
                    "text": {"type": "mrkdwn", "text": text},
                }
            )
        current_text = ""

    for token in tokens:
        token_type: str = token["type"]

        if token_type == "heading":
            flush_text()
            heading_text = _extract_text(token)
            # Strip any formatting for plain_text header
            heading_text = re.sub(r"[*_~`]", "", heading_text)
            blocks.append(
                {
                    "type": "header",
                    "text": {"type": "plain_text", "text": heading_text.strip()},
                }
            )

        elif token_type == "paragraph":
            para_text = _extract_text(token)

            # Check if paragraph is just a citation
            is_cite, cite_index = _is_block_citation(para_text)
            if is_cite and cite_index is not None:
                flush_text()
                blocks.extend(_build_citation_blocks(cite_index, highlight_map))
            else:
                # Check for multiline quotes that need to become block quotes
                segments = _split_multiline_quotes(para_text, highlight_map)
                has_multiline = any(idx is not None for _, idx in segments)

                if has_multiline:
                    # Process each segment: text becomes section, quote becomes block
                    flush_text()
                    for segment_text, quote_idx in segments:
                        if quote_idx is not None:
                            # Multiline quote → block quote
                            blocks.extend(_build_citation_blocks(quote_idx, highlight_map))
                        elif segment_text.strip():
                            # Regular text → section (process remaining inline citations)
                            text = _convert_inline_formatting(segment_text.strip())
                            text = _process_inline_citations(text, highlight_map)
                            blocks.append(
                                {
                                    "type": "section",
                                    "text": {"type": "mrkdwn", "text": text},
                                }
                            )
                else:
                    # No multiline quotes, accumulate text normally
                    current_text += para_text + "\n\n"

        elif token_type == "thematic_break":
            flush_text()
            blocks.append({"type": "divider"})

        elif token_type == "block_quote":
            quote_text = _extract_text(token).strip()

            # Check if it's a citation - only citations become blockquotes
            # (prevents LLM from generating unverified quotes)
            is_cite, cite_index = _is_block_citation(quote_text)
            if is_cite and cite_index is not None:
                flush_text()
                blocks.extend(_build_citation_blocks(cite_index, highlight_map))
            else:
                # Non-citation blockquotes are DELETED - only verified citations allowed
                # This preserves "algorithmic only blockquotes" from verified highlights
                logger.warning(
                    f"Deleted non-citation blockquote: "
                    f"{quote_text[:50]}{'...' if len(quote_text) > 50 else ''}"
                )

        elif token_type == "list":
            flush_text()
            items = []
            for child in token.get("children", []):
                if child["type"] == "list_item":
                    item_text = _extract_text(child).strip()
                    item_text = _convert_inline_formatting(item_text)
                    item_text = _process_inline_citations(item_text, highlight_map)
                    items.append(f"• {item_text}")

            if items:
                blocks.append(
                    {
                        "type": "section",
                        "text": {"type": "mrkdwn", "text": "\n".join(items)},
                    }
                )

        elif token_type == "table":
            flush_text()
            rows = _parse_table(token)
            if rows:
                blocks.append(_build_table_block(rows, highlight_map))

        elif token_type == "block_code":
            flush_text()
            code = token.get("raw", "")
            blocks.append(
                {
                    "type": "section",
                    "text": {"type": "mrkdwn", "text": f"```\n{code}```"},
                }
            )

    flush_text()
    return blocks
