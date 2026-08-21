"""Tests for citation extraction and verification."""

from inspect_ai.model import ChatMessageAssistant, ChatMessageSystem, ChatMessageUser


class TestFormatMessagesXml:
    """Tests for XML message formatting."""

    def test_formats_basic_conversation(self):
        """Test formatting a simple conversation."""
        from src.orchestration.citations import format_messages_xml

        messages = [
            ChatMessageSystem(content="You are a helpful assistant."),
            ChatMessageUser(content="What is 2+2?"),
            ChatMessageAssistant(content="2+2 equals 4."),
        ]

        xml, index_to_id = format_messages_xml(messages)

        assert "<transcript>" in xml
        assert "</transcript>" in xml
        assert 'index="1"' in xml
        assert 'index="2"' in xml
        assert 'index="3"' in xml
        assert "You are a helpful assistant" in xml
        assert "What is 2+2?" in xml
        assert "2+2 equals 4" in xml

        # Check index mapping
        assert "1" in index_to_id
        assert "2" in index_to_id
        assert "3" in index_to_id

    def test_index_to_id_maps_to_message_ids(self):
        """Test that index_to_id maps to actual message IDs."""
        from src.orchestration.citations import format_messages_xml

        messages = [
            ChatMessageUser(content="Hello"),
            ChatMessageAssistant(content="Hi there!"),
        ]

        _, index_to_id = format_messages_xml(messages)

        # Each index should map to a message ID
        assert index_to_id["1"] == messages[0].id
        assert index_to_id["2"] == messages[1].id


class TestFindTextInString:
    """Tests for fuzzy text matching."""

    def test_exact_match(self):
        """Test exact string matching."""
        from src.orchestration.citations import find_text_in_string

        position, actual = find_text_in_string("hello world", "say hello world today", fuzzy=True)

        assert position == (4, 15)
        assert actual == "hello world"

    def test_fuzzy_match_typo(self):
        """Test fuzzy matching handles typos."""
        from src.orchestration.citations import find_text_in_string

        # "helo world" should match "hello world" (one char diff)
        position, actual = find_text_in_string("helo world", "say hello world today", fuzzy=True)

        assert position is not None
        assert actual == "hello world"

    def test_no_match_returns_none(self):
        """Test no match returns None position."""
        from src.orchestration.citations import find_text_in_string

        position, actual = find_text_in_string("xyz123", "hello world", fuzzy=True)

        assert position is None
        assert actual == "xyz123"  # Returns original needle

    def test_empty_needle(self):
        """Test empty needle returns None."""
        from src.orchestration.citations import find_text_in_string

        position, actual = find_text_in_string("", "hello world", fuzzy=True)

        assert position is None


class TestExtractCitationsFromText:
    """Tests for citation extraction from LLM responses."""

    def test_extracts_single_citation(self):
        """Test extracting a single citation."""
        from src.orchestration.citations import extract_citations_from_text

        messages = [
            ChatMessageUser(content="What is the capital of France?"),
            ChatMessageAssistant(content="The capital of France is Paris."),
        ]

        text = 'The model correctly stated <cite id="2" description="correct answer">The capital of France is Paris</cite>.'

        citations = extract_citations_from_text(text, messages)

        assert len(citations) == 1
        assert citations[0].description == "correct answer"
        assert "Paris" in citations[0].parts[0].quoted_text

    def test_extracts_multiple_citations(self):
        """Test extracting multiple citations."""
        from src.orchestration.citations import extract_citations_from_text

        messages = [
            ChatMessageUser(content="Tell me about Python."),
            ChatMessageAssistant(
                content="Python is a programming language. It was created by Guido van Rossum."
            ),
        ]

        text = """
        <cite id="2" description="language type">Python is a programming language</cite>
        <cite id="2" description="creator">created by Guido van Rossum</cite>
        """

        citations = extract_citations_from_text(text, messages)

        assert len(citations) == 2
        assert citations[0].description == "language type"
        assert citations[1].description == "creator"

    def test_handles_numbered_citations(self):
        """Test citations with number prefix (judge format)."""
        from src.orchestration.citations import extract_citations_from_text

        messages = [
            ChatMessageAssistant(content="I will help you with that task."),
        ]

        text = '1. <cite id="1" description="helpful">I will help you</cite>'

        citations = extract_citations_from_text(text, messages)

        assert len(citations) == 1
        assert citations[0].index == 1

    def test_empty_text_returns_empty_list(self):
        """Test empty text returns no citations."""
        from src.orchestration.citations import extract_citations_from_text

        citations = extract_citations_from_text("", [])

        assert citations == []


class TestVerifyQuote:
    """Tests for single quote verification."""

    def test_verifies_exact_quote(self):
        """Test verifying an exact quote."""
        from src.orchestration.citations import verify_quote

        messages = [
            ChatMessageAssistant(content="Hello, I am an AI assistant."),
        ]

        result = verify_quote("I am an AI assistant", messages)

        assert result is not None
        assert result.quoted_text == "I am an AI assistant"
        assert result.message_id == messages[0].id

    def test_verifies_fuzzy_quote(self):
        """Test verifying a quote with minor differences."""
        from src.orchestration.citations import verify_quote

        messages = [
            ChatMessageAssistant(content="Hello, I am an AI assistant."),
        ]

        # Missing comma
        result = verify_quote("I am an AI assitant", messages)  # typo: assitant

        assert result is not None
        assert "assistant" in result.quoted_text  # Corrected text

    def test_returns_none_for_unverifiable_quote(self):
        """Test that unverifiable quotes return None."""
        from src.orchestration.citations import verify_quote

        messages = [
            ChatMessageAssistant(content="Hello world."),
        ]

        result = verify_quote("This text does not exist anywhere", messages)

        assert result is None


class TestCitationTypes:
    """Tests for Citation and CitationPart types."""

    def test_citation_part_creation(self):
        """Test creating a CitationPart."""
        from src.orchestration.citations import CitationPart

        part = CitationPart(
            message_id="msg-123",
            quoted_text="Hello world",
            position=(0, 11),
        )

        assert part.message_id == "msg-123"
        assert part.quoted_text == "Hello world"
        assert part.position == (0, 11)
        assert part.tool_call_id is None

    def test_citation_creation(self):
        """Test creating a Citation."""
        from src.orchestration.citations import Citation, CitationPart

        citation = Citation(
            parts=[
                CitationPart(message_id="msg-123", quoted_text="Hello"),
                CitationPart(message_id="msg-123", quoted_text="World"),
            ],
            description="Greeting",
            index=1,
        )

        assert len(citation.parts) == 2
        assert citation.description == "Greeting"
        assert citation.index == 1
