"""Citation extraction and verification for experiment summaries.

Re-exports types and utilities from vendored Petri, plus new extraction logic.
"""

# Types - stable Pydantic models
# New extraction utilities
from src.orchestration.citations.extractor import (
    extract_citations_from_text,
    verify_quote,
)

# XML formatting - works with standard ChatMessage[]
from src.vendor.petri.formatting.xml_messages import format_content, format_messages_xml
from src.vendor.petri.scorers.judge import (
    _create_citation_from_search as create_citation_from_search,
)
from src.vendor.petri.scorers.judge import (
    _extract_highlights_xml as extract_highlights_xml,
)

# Fuzzy matching utilities
from src.vendor.petri.scorers.judge import (
    _find_text_in_string as find_text_in_string,
)
from src.vendor.petri.scorers.judge import (
    _get_search_order as get_search_order,
)
from src.vendor.petri.scorers.judge import (
    _search_all_messages_for_part as search_all_messages,
)
from src.vendor.petri.scorers.judge import (
    _search_in_message_content_for_part as search_in_message_content,
)
from src.vendor.petri.scorers.judge import (
    _search_in_tool_calls_for_part as search_in_tool_calls,
)
from src.vendor.petri.transcript.transcript import Citation, CitationPart

__all__ = [
    # Types
    "Citation",
    "CitationPart",
    # XML formatting
    "format_messages_xml",
    "format_content",
    # Fuzzy matching
    "find_text_in_string",
    "search_all_messages",
    "get_search_order",
    "search_in_message_content",
    "search_in_tool_calls",
    # Citation creation
    "create_citation_from_search",
    "extract_highlights_xml",
    # High-level extraction
    "extract_citations_from_text",
    "verify_quote",
]
