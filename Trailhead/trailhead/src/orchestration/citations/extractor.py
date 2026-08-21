"""Citation extraction from LLM responses.

Parses <cite> tags from LLM output and verifies them against source messages.
"""

import re

from inspect_ai.model import ChatMessage

from src.vendor.petri.scorers.judge import (
    _create_citation_from_search as create_citation_from_search,
)
from src.vendor.petri.formatting.xml_messages import format_messages_xml
from src.vendor.petri.transcript.transcript import Citation, CitationPart


def extract_citations_from_text(
    text: str,
    messages: list[ChatMessage],
    index_to_id: dict[str, str] | None = None,
) -> list[Citation]:
    """Extract and verify citations from text containing <cite> tags.

    Parses citations in the format:
        <cite id="MESSAGE_INDEX" description="why selected">quoted text</cite>

    Each citation is verified against the source messages using fuzzy matching.
    Unverified citations are still returned but may have unknown message_id.

    Args:
        text: Text containing <cite> tags
        messages: Source messages to verify against
        index_to_id: Optional pre-computed index→id mapping. If not provided,
                     will be computed from messages using format_messages_xml().

    Returns:
        List of verified Citation objects
    """
    if index_to_id is None:
        _, index_to_id = format_messages_xml(messages)

    message_lookup = {msg.id: msg for msg in messages if hasattr(msg, "id")}

    citations = []

    # Pattern: <cite id="INDEX" description="...">quote</cite>
    # Also handles numbered format: 1. <cite ...>
    pattern = r'(?:(\d+)\.\s*)?<cite\s+id="([^"]+)"\s+description="([^"]+)">([^<]*)</cite>'

    for match in re.finditer(pattern, text, re.DOTALL):
        number = match.group(1)  # Optional number prefix
        message_index = match.group(2)
        description = match.group(3)
        quoted_text = match.group(4).strip()

        citation_index = int(number) if number else len(citations) + 1

        citation = create_citation_from_search(
            quoted_text=quoted_text,
            message_index=message_index,
            index_to_id=index_to_id,
            message_lookup=message_lookup,
            citation_index=citation_index,
            description=description,  # Citation model uses 'description' field
        )
        citations.append(citation)

    return citations


def verify_quote(
    quote: str,
    messages: list[ChatMessage],
    claimed_index: str | None = None,
) -> CitationPart | None:
    """Verify a single quote against source messages.

    Searches for the quote text in messages using fuzzy matching.
    If claimed_index is provided, searches that message first.

    Args:
        quote: Text to verify
        messages: Source messages to search
        claimed_index: Optional message index to search first

    Returns:
        CitationPart if found, None if quote cannot be verified
    """
    from src.orchestration.citations import search_all_messages

    _, index_to_id = format_messages_xml(messages)
    message_lookup = {msg.id: msg for msg in messages if hasattr(msg, "id")}

    # If no claimed index, start from "1"
    search_index = claimed_index or "1"

    return search_all_messages(
        quoted_text=quote,
        claimed_index=search_index,
        index_to_id=index_to_id,
        message_lookup=message_lookup,
        fuzzy=True,
        citation_index=0,  # Not used for single quote verification
    )
