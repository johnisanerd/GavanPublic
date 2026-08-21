"""Pydantic models for Slack Block Kit and summarizer responses.

Note: We define Pydantic versions of Slack Block Kit types (instead of using slack-sdk's
classes) because OpenAI Structured Outputs requires Pydantic models with JSON schema
validation. The slack-sdk classes are plain dataclasses without Pydantic validation.

These models match the structure defined in slack-sdk.models.blocks but use Pydantic
for JSON schema generation and validation.
"""

from typing import Annotated, Any, Literal

from pydantic import BaseModel, Discriminator, Field


class TextObject(BaseModel):
    """Slack text object (Pydantic version of slack_sdk.models.blocks.TextObject)."""

    type: Literal["plain_text", "mrkdwn"] = Field(...)
    text: str = Field(...)

    model_config = {"extra": "forbid"}


class HeaderBlock(BaseModel):
    """Slack header block (Pydantic version of slack_sdk.models.blocks.HeaderBlock)."""

    type: Literal["header"] = "header"
    text: TextObject = Field(...)

    model_config = {"extra": "forbid"}


class SectionBlock(BaseModel):
    """Slack section block (Pydantic version of slack_sdk.models.blocks.SectionBlock)."""

    type: Literal["section"] = "section"
    text: TextObject | None = None
    fields: list[TextObject] | None = None

    model_config = {"extra": "forbid"}


class DividerBlock(BaseModel):
    """Slack divider block (Pydantic version of slack_sdk.models.blocks.DividerBlock)."""

    type: Literal["divider"] = "divider"

    model_config = {"extra": "forbid"}


class ContextBlock(BaseModel):
    """Slack context block (Pydantic version of slack_sdk.models.blocks.ContextBlock)."""

    type: Literal["context"] = "context"
    elements: list[TextObject] = Field(...)

    model_config = {"extra": "forbid"}


# Simplified Block model for OpenAI strict mode compatibility
# Instead of discriminated union, use a single model with all possible fields
class TextStyle(BaseModel):
    """Text styling options for rich_text elements."""

    bold: bool | None = None
    italic: bool | None = None
    strike: bool | None = None
    code: bool | None = None

    model_config = {"extra": "forbid"}


class RichTextElement(BaseModel):
    """Text element inside a rich_text_section."""

    type: Literal["text"] = "text"
    text: str = Field(...)
    style: TextStyle | None = None

    model_config = {"extra": "forbid"}


class RichTextSection(BaseModel):
    """Section wrapper required by Slack for rich_text table cells.

    Slack requires: rich_text -> elements -> [rich_text_section -> elements -> [text]]
    Not just: rich_text -> elements -> [text]
    """

    type: Literal["rich_text_section"] = "rich_text_section"
    elements: list[RichTextElement] = Field(...)

    model_config = {"extra": "forbid"}


class TableCell(BaseModel):
    """Slack table cell - raw_text for plain, rich_text for formatted (bold headers).

    For rich_text cells, elements must contain rich_text_section wrappers:
    {"type": "rich_text", "elements": [{"type": "rich_text_section", "elements": [...]}]}
    """

    type: Literal["raw_text", "rich_text"] = Field(...)
    # For raw_text cells
    text: str | None = None
    # For rich_text cells - must use rich_text_section wrapper
    elements: list[RichTextSection] | None = None

    model_config = {"extra": "forbid"}


class Block(BaseModel):
    """Unified Slack block type for OpenAI structured outputs.

    LLM can generate: header, section, divider, table, cited_highlight
    LLM cannot generate: context, rich_text (added programmatically)
    """

    type: Literal["header", "section", "divider", "table", "cited_highlight"] = Field(...)
    # Header and Section fields
    text: TextObject | None = None
    # Section fields
    fields: list[TextObject] | None = None
    # Table fields (first row is headers, subsequent rows are data)
    rows: list[list[TableCell]] | None = None
    # cited_highlight fields (replaced with rich_text + context post-processing)
    highlight_index: int | None = None
    quote_text: str | None = None

    model_config = {"extra": "forbid"}


class SummaryMetadata(BaseModel):
    """Optional metadata about the summarized run."""

    run_id: str | None = None
    tool: str | None = None
    severity: str | None = None

    model_config = {"extra": "forbid"}


class SummarizerResponse(BaseModel):
    """Response from the summarizer service.

    Empty blocks list indicates image was uploaded directly (no text response needed).
    blocks is list[dict] rather than list[Block] because post-processing adds
    rich_text and context blocks that aren't in the LLM schema.
    """

    blocks: list[dict[str, Any]] = Field(default_factory=list)
    metadata: SummaryMetadata | None = None

    model_config = {"extra": "forbid"}


class InspectCitationRequest(BaseModel):
    """Citation request for Inspect eval logs."""

    research_type: Literal["inspect_eval"] = "inspect_eval"
    min_count: int = 0
    max_count: int = 0


class SpanCitationRequest(BaseModel):
    """Citation request for generic log spans."""

    research_type: Literal["generic_log"] = "generic_log"
    min_count: int = 0
    max_count: int = 0


# Discriminated union of citation request types
CitationRequest = Annotated[
    InspectCitationRequest | SpanCitationRequest,
    Discriminator("research_type"),
]


class SummarizeRequest(BaseModel):
    """Request to summarize research."""

    research_type: Literal["inspect_eval", "generic_log"]
    raw_research: str | None = None
    research_path: str | None = None  # Dev-only convenience

    model_config = {"extra": "forbid"}
