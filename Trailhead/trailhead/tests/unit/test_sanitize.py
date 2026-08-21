"""Tests for sanitization utilities."""

from src.utils.sanitize import (
    clamp_text_length,
    remove_unsafe_markdown,
    sanitize_block_kit_response,
    sanitize_text,
    strip_control_characters,
)


def test_strip_control_characters():
    """Test removal of control characters."""
    # Test with null bytes and other control chars
    text = "Hello\x00World\x01Test\x1f"
    result = strip_control_characters(text)
    assert result == "HelloWorldTest"

    # Newlines and tabs should be preserved
    text = "Hello\nWorld\tTest"
    result = strip_control_characters(text)
    assert result == "Hello\nWorld\tTest"


def test_clamp_text_length():
    """Test text length clamping."""
    # Short text should be unchanged
    short = "Hello"
    assert clamp_text_length(short, max_length=100) == short

    # Long text should be clamped with ellipsis
    long = "A" * 100
    result = clamp_text_length(long, max_length=50)
    assert len(result) == 50
    assert result.endswith("...")
    assert result.startswith("A")


def test_remove_unsafe_markdown():
    """Test removal of unsafe markdown patterns."""
    # Hidden links should be removed
    text = "Check this [ ](http://evil.com) out"
    result = remove_unsafe_markdown(text)
    assert "http://evil.com" not in result

    # Script tags should be removed
    text = "Hello <script>alert('xss')</script> World"
    result = remove_unsafe_markdown(text)
    assert "<script>" not in result
    assert "alert" not in result

    # Safe markdown should be preserved
    text = "This is *bold* and _italic_"
    result = remove_unsafe_markdown(text)
    assert "*bold*" in result
    assert "_italic_" in result


def test_sanitize_text():
    """Test full text sanitization."""
    # Test with adversarial input
    adversarial = "Hello\x00World [ ](http://evil.com) <script>alert('xss')</script>" + ("A" * 3000)
    result = sanitize_text(adversarial)

    # Should have no control chars
    assert "\x00" not in result

    # Should have no hidden links
    assert "[ ]" not in result

    # Should have no scripts
    assert "<script>" not in result

    # Should be clamped to max length
    assert len(result) <= 3000


def test_sanitize_block_kit_response():
    """Test sanitization of full Block Kit response."""
    response = {
        "blocks": [
            {
                "type": "header",
                "text": {
                    "type": "plain_text",
                    "text": "Test\x00Header" + ("A" * 4000),
                },
            },
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": "Bad link: [ ](http://evil.com)",
                },
            },
        ]
    }

    result = sanitize_block_kit_response(response)

    # Header text should be sanitized
    header_text = result["blocks"][0]["text"]["text"]
    assert "\x00" not in header_text
    assert len(header_text) <= 3000

    # Section text should have no hidden links
    section_text = result["blocks"][1]["text"]["text"]
    assert "[ ]" not in section_text


def test_sanitize_block_kit_response_limits_blocks():
    """Test that block count is limited."""
    # Create more blocks than the limit
    blocks = [{"type": "divider"} for _ in range(100)]
    response = {"blocks": blocks}

    result = sanitize_block_kit_response(response)

    # Should be clamped to MAX_BLOCKS (50)
    assert len(result["blocks"]) <= 50


def test_sanitize_block_kit_response_limits_fields():
    """Test that fields in sections are limited."""
    fields = [{"type": "mrkdwn", "text": f"Field {i}"} for i in range(20)]

    response = {
        "blocks": [
            {
                "type": "section",
                "fields": fields,
            }
        ]
    }

    result = sanitize_block_kit_response(response)

    # Should be clamped to MAX_FIELDS (10)
    assert len(result["blocks"][0]["fields"]) <= 10
