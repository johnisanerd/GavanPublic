"""Tests for summarizer functionality."""

import json

import pytest

from src.types import SummarizeRequest, SummarizerResponse


def test_summarizer_response_model_validation():
    """Test that SummarizerResponse validates correct structure."""
    valid_data = {
        "blocks": [
            {
                "type": "header",
                "text": {"type": "plain_text", "text": "Test Header"},
            },
            {
                "type": "section",
                "text": {"type": "mrkdwn", "text": "Test *section* content"},
            },
            {"type": "divider"},
        ],
        "metadata": {"run_id": "test123", "tool": "pytest"},
    }

    response = SummarizerResponse.model_validate(valid_data)
    assert len(response.blocks) == 3
    assert response.metadata is not None
    assert response.metadata.run_id == "test123"


def test_summarizer_response_allows_empty_blocks():
    """Test that SummarizerResponse allows empty blocks (for image-only responses)."""
    # Empty blocks are now valid - indicates image was uploaded directly
    data = {"blocks": [], "metadata": None}
    response = SummarizerResponse.model_validate(data)
    assert len(response.blocks) == 0


def test_summarize_request_model():
    """Test SummarizeRequest model validation."""
    # Test with raw_research
    request1 = SummarizeRequest(research_type="generic_log", raw_research="test research content")
    assert request1.raw_research == "test research content"
    assert request1.research_path is None
    assert request1.research_type == "generic_log"

    # Test with research_path
    request2 = SummarizeRequest(research_type="inspect_eval", research_path="/path/to/research.txt")
    assert request2.research_path == "/path/to/research.txt"
    assert request2.raw_research is None
    assert request2.research_type == "inspect_eval"


@pytest.mark.asyncio
async def test_summarizer_cli_arg_vs_env(tmp_path, monkeypatch):
    """Test CLI argument handling."""
    # Create a temporary research file
    research_file = tmp_path / "test.txt"
    research_file.write_text("Test research content\n")

    # Test that we can import the main function
    from src.cli.summarizer import main

    # We won't actually run it without API key, but verify import works
    assert callable(main)


def test_block_kit_json_structure():
    """Test that output matches Block Kit Builder format."""
    response = SummarizerResponse(
        blocks=[
            {
                "type": "header",
                "text": {"type": "plain_text", "text": "Summary"},
            }
        ]
    )

    # Convert to JSON and verify structure
    json_output = response.model_dump(mode="json", exclude_none=True)
    json_str = json.dumps(json_output, indent=2)

    # Verify it's valid JSON
    parsed = json.loads(json_str)
    assert "blocks" in parsed
    assert len(parsed["blocks"]) == 1
    assert parsed["blocks"][0]["type"] == "header"


class TestQuoteTagProcessing:
    """Tests for [[quote:N]] quote tag processing in prose/bullets output."""

    def test_removes_quote_tags_when_no_highlights(self):
        """Test that quote tags are removed when no highlights provided."""
        from src.orchestration.analysis.summarizers.shared import process_quote_tags

        text = "The model said [[quote:1]] here."
        result = process_quote_tags(text, None)

        # Should remove the quote tag
        assert "[[quote:" not in result
        assert "The model said  here." in result

    def test_replaces_block_quote_tag_with_blockquote(self):
        """Test that block-level quote tags are replaced with markdown blockquotes."""
        from src.orchestration.analysis.highlighter import Highlight
        from src.orchestration.analysis.summarizers.shared import process_quote_tags

        # Quote tag on its own line = block-level
        text = "The model expressed uncertainty:\n\n[[quote:1]]"
        highlights = [
            Highlight(
                index=1,
                description="Model uncertainty",
                quoted_text="I'm not entirely sure about this",
                message_id="msg-123",
            )
        ]

        result = process_quote_tags(text, highlights)

        assert "I'm not entirely sure" in result
        assert "> " in result  # Markdown blockquote

    def test_replaces_inline_quote_tag_with_quoted_text(self):
        """Test that inline quote tags are replaced with quoted text."""
        from src.orchestration.analysis.highlighter import Highlight
        from src.orchestration.analysis.summarizers.shared import process_quote_tags

        # Quote tag inline = not a blockquote
        text = "The model said [[quote:1]] in response."
        highlights = [
            Highlight(
                index=1,
                description="Response",
                quoted_text="I'm not sure",
                message_id="msg-123",
            )
        ]

        result = process_quote_tags(text, highlights)

        assert '"I\'m not sure"' in result
        assert "> " not in result  # Not a blockquote

    def test_includes_deep_link_in_attribution(self):
        """Test that deep links appear in blockquote attribution."""
        from src.orchestration.analysis.highlighter import Highlight
        from src.orchestration.analysis.summarizers.shared import process_quote_tags

        text = "[[quote:1]]"
        highlights = [
            Highlight(
                index=1,
                description="Source",
                quoted_text="Verified quote",
                deep_link="https://example.com/viewer#msg-1",
            )
        ]

        result = process_quote_tags(text, highlights)

        # Block quote with linked attribution
        assert "https://example.com/viewer#msg-1" in result
        assert "> Verified quote" in result

    def test_handles_invalid_quote_index(self):
        """Test that invalid quote indices are removed."""
        from src.orchestration.analysis.highlighter import Highlight
        from src.orchestration.analysis.summarizers.shared import process_quote_tags

        text = "Missing quote: [[quote:99]]"
        highlights = [
            Highlight(index=1, description="Only one", quoted_text="Real quote"),
        ]

        result = process_quote_tags(text, highlights)

        # Should remove the invalid quote tag
        assert "[[quote:" not in result
        assert "Missing quote:" in result

    def test_handles_multiple_quote_tags(self):
        """Test processing multiple quote tags."""
        from src.orchestration.analysis.highlighter import Highlight
        from src.orchestration.analysis.summarizers.shared import process_quote_tags

        text = "First [[quote:1]] and second [[quote:2]]"
        highlights = [
            Highlight(index=1, description="First", quoted_text="Quote one"),
            Highlight(index=2, description="Second", quoted_text="Quote two"),
        ]

        result = process_quote_tags(text, highlights)

        assert "Quote one" in result
        assert "Quote two" in result

    def test_blockquote_containing_quote_tag_cleaned_up(self):
        """Test that > [[quote:N]] doesn't leave extra blockquote markers."""
        from src.orchestration.analysis.highlighter import Highlight
        from src.orchestration.analysis.summarizers.shared import process_quote_tags

        # This is the case where LLM writes: > [[quote:1]]
        text = "Introduction:\n\n> [[quote:1]]\n\nConclusion."
        highlights = [Highlight(index=1, description="Quote", quoted_text="The actual quote text")]

        result = process_quote_tags(text, highlights)

        # Should NOT have double > markers
        assert "> >" not in result
        # Should have single clean blockquote
        assert "> The actual quote text" in result

    def test_attribution_includes_model_name(self):
        """Test that attribution shows pretty model name."""
        from src.orchestration.analysis.highlighter import Highlight
        from src.orchestration.analysis.summarizers.shared import process_quote_tags

        text = "[[quote:1]]"
        highlights = [
            Highlight(
                index=1,
                description="Quote",
                quoted_text="Some text",
                model="openai/gpt-4o",
            )
        ]

        result = process_quote_tags(text, highlights)

        # Should have model display name in attribution
        assert "GPT-4o" in result or "gpt-4o" in result.lower()

    def test_attribution_includes_location_info(self):
        """Test that attribution shows case/epoch/turn when relevant."""
        from src.orchestration.analysis.highlighter import Highlight
        from src.orchestration.analysis.summarizers.shared import process_quote_tags

        text = "[[quote:1]]"
        highlights = [
            Highlight(
                index=1,
                description="Quote",
                quoted_text="Some text",
                case=2,  # Non-default case
                epoch=3,
                turn=5,  # Non-default turn
            )
        ]

        result = process_quote_tags(text, highlights)

        # Should include location markers
        assert "s2" in result  # sample 2
        assert "e3" in result  # epoch 3
        assert "t5" in result  # turn 5

    def test_attribution_omits_default_values(self):
        """Test that attribution omits case=1 and turn=2 (defaults)."""
        from src.orchestration.analysis.highlighter import Highlight
        from src.orchestration.analysis.summarizers.shared import process_quote_tags

        text = "[[quote:1]]"
        highlights = [
            Highlight(
                index=1,
                description="Quote",
                quoted_text="Some text",
                case=1,  # Default, should be omitted
                epoch=1,
                turn=2,  # Default for assistant response, should be omitted
            )
        ]

        result = process_quote_tags(text, highlights)

        # Should NOT include s1 or t2 (defaults)
        assert "s1" not in result
        assert "t2" not in result
        # But e1 should be there
        assert "e1" in result

    def test_long_quote_truncated(self):
        """Test that very long quotes are truncated."""
        from src.orchestration.analysis.highlighter import Highlight
        from src.orchestration.analysis.summarizers.shared import process_quote_tags

        long_text = "x" * 500  # Very long quote
        text = "[[quote:1]]"
        highlights = [Highlight(index=1, description="Long", quoted_text=long_text)]

        result = process_quote_tags(text, highlights)

        # Should be truncated with ellipsis
        assert "..." in result
        assert len(result) < len(long_text)


class TestMarkdownToSlackBlocks:
    """Tests for markdown to Slack Block Kit conversion."""

    def test_converts_heading_to_header_block(self):
        """Test that markdown headings become Slack header blocks."""
        from src.orchestration.analysis.summarizers.markdown_to_slack import (
            markdown_to_slack_blocks,
        )

        markdown = "# Experiment Results"
        blocks = markdown_to_slack_blocks(markdown)

        assert len(blocks) == 1
        assert blocks[0]["type"] == "header"
        assert blocks[0]["text"]["text"] == "Experiment Results"

    def test_converts_paragraph_to_section_block(self):
        """Test that paragraphs become Slack section blocks."""
        from src.orchestration.analysis.summarizers.markdown_to_slack import (
            markdown_to_slack_blocks,
        )

        markdown = "This is a paragraph of text."
        blocks = markdown_to_slack_blocks(markdown)

        assert len(blocks) == 1
        assert blocks[0]["type"] == "section"
        assert "This is a paragraph" in blocks[0]["text"]["text"]

    def test_converts_divider(self):
        """Test that --- becomes a divider block."""
        from src.orchestration.analysis.summarizers.markdown_to_slack import (
            markdown_to_slack_blocks,
        )

        markdown = "Before\n\n---\n\nAfter"
        blocks = markdown_to_slack_blocks(markdown)

        dividers = [b for b in blocks if b["type"] == "divider"]
        assert len(dividers) == 1

    def test_converts_bullet_list(self):
        """Test that bullet lists are converted."""
        from src.orchestration.analysis.summarizers.markdown_to_slack import (
            markdown_to_slack_blocks,
        )

        markdown = "- Item one\n- Item two\n- Item three"
        blocks = markdown_to_slack_blocks(markdown)

        assert len(blocks) == 1
        assert blocks[0]["type"] == "section"
        assert "• Item one" in blocks[0]["text"]["text"]
        assert "• Item two" in blocks[0]["text"]["text"]

    def test_converts_table(self):
        """Test that tables are converted to Slack table blocks."""
        from src.orchestration.analysis.summarizers.markdown_to_slack import (
            markdown_to_slack_blocks,
        )

        markdown = "| Model | Score |\n|-------|-------|\n| GPT-4 | 85% |\n| Claude | 90% |"
        blocks = markdown_to_slack_blocks(markdown)

        tables = [b for b in blocks if b["type"] == "table"]
        assert len(tables) == 1
        assert len(tables[0]["rows"]) == 3  # header + 2 data rows

    def test_table_citations_have_no_links(self):
        """Test that citations in tables don't include links (plain bracket format)."""
        from src.orchestration.analysis.highlighter import Highlight
        from src.orchestration.analysis.summarizers.markdown_to_slack import (
            markdown_to_slack_blocks,
        )

        markdown = "| Model | Response |\n|-------|----------|\n| GPT-4 | [[quote:1]] |"
        highlights = [
            Highlight(
                index=1,
                description="Model response",
                quoted_text="I think therefore I am",
                deep_link="https://example.com/viewer#msg-1",
            )
        ]

        blocks = markdown_to_slack_blocks(markdown, highlights)

        tables = [b for b in blocks if b["type"] == "table"]
        assert len(tables) == 1

        # Get the cell text from the data row (row index 1, cell index 1)
        data_row = tables[0]["rows"][1]
        response_cell = data_row[1]
        cell_text = response_cell.get("text", "")

        # Should have bracket citation but NO link format (<url|text>)
        assert "[" in cell_text and "]" in cell_text  # Has bracket citation
        assert "<" not in cell_text  # No link markup
        assert "|" not in cell_text  # No pipe in link
        assert '"I think therefore I am"' in cell_text  # Has the quote

    def test_quote_block_creates_rich_text(self):
        """Test that > [[quote:N]] creates rich_text_quote + context blocks."""
        from src.orchestration.analysis.highlighter import Highlight
        from src.orchestration.analysis.summarizers.markdown_to_slack import (
            markdown_to_slack_blocks,
        )

        markdown = "The model said:\n\n> [[quote:1]]\n\nInteresting!"
        highlights = [
            Highlight(
                index=1,
                description="Key insight",
                quoted_text="I believe this is the answer",
                deep_link="https://example.com/viewer#msg-1",
            )
        ]

        blocks = markdown_to_slack_blocks(markdown, highlights)

        # Should have rich_text quote block with embedded link
        rich_text_blocks = [b for b in blocks if b["type"] == "rich_text"]
        assert len(rich_text_blocks) >= 1

        # Check quote contains verified text and source link
        quote_block = rich_text_blocks[0]
        quote_element = quote_block["elements"][0]
        assert quote_element["type"] == "rich_text_quote"
        assert "I believe this is the answer" in quote_element["elements"][0]["text"]
        # Link is embedded inside the quote block
        link_elements = [e for e in quote_element["elements"] if e.get("type") == "link"]
        assert len(link_elements) >= 1
        assert link_elements[0]["text"] == "[source]"

    def test_non_quote_tag_blockquote_deleted(self):
        """Test that non-quote-tag blockquotes are deleted (algorithmic only quotes)."""
        from src.orchestration.analysis.summarizers.markdown_to_slack import (
            markdown_to_slack_blocks,
        )

        markdown = "The model said:\n\n> This is a fake quote\n\nAfter"
        blocks = markdown_to_slack_blocks(markdown)

        # Should NOT have any rich_text_quote blocks
        rich_text_blocks = [b for b in blocks if b["type"] == "rich_text"]
        assert len(rich_text_blocks) == 0

    def test_inline_quote_tag_converted(self):
        """Test that inline [[quote:N]] becomes quoted text with link."""
        from src.orchestration.analysis.highlighter import Highlight
        from src.orchestration.analysis.summarizers.markdown_to_slack import (
            markdown_to_slack_blocks,
        )

        markdown = "The model admitted [[quote:1]] before continuing."
        highlights = [
            Highlight(
                index=1,
                description="Admission",
                quoted_text="I was wrong",
                deep_link="https://example.com/viewer#msg-1",
            )
        ]

        blocks = markdown_to_slack_blocks(markdown, highlights)

        # Should be in a section block with inline quote and source link
        section = blocks[0]
        assert section["type"] == "section"
        assert '"I was wrong"' in section["text"]["text"]
        assert "[source]" in section["text"]["text"]

    def test_bold_conversion(self):
        """Test that **bold** becomes Slack *bold*."""
        from src.orchestration.analysis.summarizers.markdown_to_slack import (
            markdown_to_slack_blocks,
        )

        markdown = "This is **important** text."
        blocks = markdown_to_slack_blocks(markdown)

        assert "*important*" in blocks[0]["text"]["text"]
        assert "**" not in blocks[0]["text"]["text"]


class TestSanitizeQuotes:
    """Tests for the full quote sanitization pipeline (verify + convert to tags)."""

    def test_exact_match_highlight_becomes_quote_tag(self):
        """Quote exactly matching a highlight gets converted to [[quote:N]]."""
        from src.orchestration.analysis.highlighter import Highlight
        from src.orchestration.analysis.summarizers.shared import sanitize_quotes

        text = 'The model said "I am uncertain about this".'
        source = "Response: I am uncertain about this."
        highlights = [
            Highlight(
                index=1,
                description="Uncertainty",
                quoted_text="I am uncertain about this",
            )
        ]

        result, stats = sanitize_quotes(text, source, highlights)

        assert "[[quote:1]]" in result
        assert '"I am uncertain about this"' not in result

    def test_fuzzy_match_highlight_becomes_quote_tag(self):
        """Quote fuzzy-matching a highlight gets converted to [[quote:N]]."""
        from src.orchestration.analysis.highlighter import Highlight
        from src.orchestration.analysis.summarizers.shared import sanitize_quotes

        # Slight difference: "the" vs no "the"
        text = 'The model said "I believe answer is correct".'
        source = "Response: I believe the answer is correct."
        highlights = [
            Highlight(
                index=1,
                description="Belief",
                quoted_text="I believe the answer is correct",
            )
        ]

        result, stats = sanitize_quotes(text, source, highlights, match_threshold=0.7)

        assert "[[quote:1]]" in result

    def test_verified_quote_without_highlight_keeps_double_quotes(self):
        """Quote matching source but not a highlight stays as double quotes."""
        from src.orchestration.analysis.summarizers.shared import sanitize_quotes

        text = 'The model said "I am not sure about this".'
        source = "Response: I am not sure about this."

        result, stats = sanitize_quotes(text, source, highlights=None)

        # Stays as double quotes (verified in source)
        assert '"I am not sure about this"' in result
        assert "[[quote:" not in result

    def test_unverified_quote_becomes_single_quotes(self):
        """Quote not in source gets converted to single quotes."""
        from src.orchestration.analysis.summarizers.shared import sanitize_quotes

        text = 'The model said "completely fabricated quote".'
        source = "This source has nothing similar."

        result, stats = sanitize_quotes(text, source, highlights=None)

        assert "'completely fabricated quote'" in result
        assert '"completely fabricated quote"' not in result

    def test_threshold_boundary_exact(self):
        """Quote exactly matching source passes verification."""
        from src.orchestration.analysis.summarizers.shared import sanitize_quotes

        # Exact substring match should always pass
        text = 'Said "this is the exact phrase".'
        source = "The source contains this is the exact phrase in context."

        result, _ = sanitize_quotes(text, source, match_threshold=0.8)
        assert '"this is the exact phrase"' in result  # Should pass (exact match)

    def test_threshold_boundary_below(self):
        """Quote just below threshold fails."""
        from src.orchestration.analysis.summarizers.shared import sanitize_quotes

        text = 'Said "completely different text".'
        source = "nothing similar here"

        result, _ = sanitize_quotes(text, source, match_threshold=0.9)
        assert "'completely different text'" in result  # Should fail -> single quotes

    def test_multiple_quotes_different_outcomes(self):
        """Multiple quotes can have different verification outcomes."""
        from src.orchestration.analysis.highlighter import Highlight
        from src.orchestration.analysis.summarizers.shared import sanitize_quotes

        text = 'First "verified quote" then "unverified stuff" and "highlight match".'
        source = "The verified quote is here."
        highlights = [Highlight(index=1, description="Match", quoted_text="highlight match")]

        result, stats = sanitize_quotes(text, source, highlights)

        assert '"verified quote"' in result  # Verified in source
        assert "'unverified stuff'" in result  # Not in source -> single
        assert "[[quote:1]]" in result  # Matched highlight

    def test_returns_highlights_unchanged(self):
        """Sanitize returns highlights list unchanged (for future extension)."""
        from src.orchestration.analysis.highlighter import Highlight
        from src.orchestration.analysis.summarizers.shared import sanitize_quotes

        text = '"good" and "bad" and "highlight".'
        source = "good is here"
        highlights = [Highlight(index=1, description="H", quoted_text="highlight")]

        result, returned_highlights = sanitize_quotes(text, source, highlights)

        # Highlights returned unchanged
        assert returned_highlights == highlights
        assert len(returned_highlights) == 1
        assert returned_highlights[0].index == 1


class TestQuoteVerification:
    """Tests for automatic quote verification against source content."""

    def test_verified_quote_keeps_double_quotes(self):
        """Test that quotes matching source content keep double quotes."""
        from src.orchestration.analysis.summarizers.shared import verify_quotes

        text = 'The model said "I am not sure about this" in response.'
        source = "Sample response: I am not sure about this. End of sample."

        result = verify_quotes(text, source)

        assert '"I am not sure about this"' in result

    def test_unverified_quote_converts_to_single(self):
        """Test that quotes not in source get converted to single quotes."""
        from src.orchestration.analysis.summarizers.shared import verify_quotes

        text = 'The model said "completely made up quote" here.'
        source = "This source content has nothing similar."

        result = verify_quotes(text, source)

        assert "'completely made up quote'" in result
        assert '"completely made up quote"' not in result

    def test_verified_quote_with_highlight_gets_link(self):
        """Test that verified quotes matching a highlight get deep links."""
        from src.orchestration.analysis.highlighter import Highlight
        from src.orchestration.analysis.summarizers.shared import verify_quotes

        text = 'The model admitted "I was wrong about that".'
        source = "Response: I was wrong about that."
        highlights = [
            Highlight(
                index=1,
                description="Admission",
                quoted_text="I was wrong about that",
                deep_link="https://example.com/viewer#msg-1",
            )
        ]

        result = verify_quotes(text, source, highlights)

        assert '"I was wrong about that"' in result
        assert "[🔗]" in result
        assert "https://example.com/viewer#msg-1" in result

    def test_fuzzy_match_works(self):
        """Test that fuzzy matching catches near-matches."""
        from src.orchestration.analysis.summarizers.shared import verify_quotes

        # Slightly different quote (missing "the")
        text = 'Model said "I believe answer is correct".'
        source = "Response: I believe the answer is correct."

        result = verify_quotes(text, source, match_threshold=0.7)

        # Should still match at 0.7 threshold
        assert '"I believe answer is correct"' in result

    def test_no_source_returns_unchanged(self):
        """Test that empty source content returns text unchanged."""
        from src.orchestration.analysis.summarizers.shared import verify_quotes

        text = 'Some "quoted text" here.'
        result = verify_quotes(text, "")

        assert result == text

    def test_multiple_quotes_processed(self):
        """Test that multiple quotes in text are all processed."""
        from src.orchestration.analysis.summarizers.shared import verify_quotes

        text = '"Valid quote" and "Invalid quote" in text.'
        source = "Source contains: Valid quote. Nothing else."

        result = verify_quotes(text, source)

        assert '"Valid quote"' in result
        assert "'Invalid quote'" in result  # Converted to single
