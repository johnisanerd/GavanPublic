"""Tests for highlight extraction utilities."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.trailrun.highlights import (
    _reconstruct_context,
    _reconstruct_messages,
    extract_highlights_for_trailrun,
)


class TestReconstructMessages:
    """Test message reconstruction from stored dicts."""

    def test_reconstruct_basic_message(self):
        """Reconstruct a basic message with required fields."""
        stored = [{"role": "user", "content": "Hello"}]
        messages = _reconstruct_messages(stored)

        assert len(messages) == 1
        assert messages[0].role == "user"
        assert messages[0].content == "Hello"
        assert messages[0].id is None

    def test_reconstruct_message_with_id(self):
        """Reconstruct message with ID."""
        stored = [{"id": "msg-123", "role": "assistant", "content": "Hi there"}]
        messages = _reconstruct_messages(stored)

        assert messages[0].id == "msg-123"
        assert messages[0].role == "assistant"

    def test_reconstruct_message_with_metadata(self):
        """Reconstruct message with optional metadata."""
        stored = [
            {
                "id": "msg-456",
                "role": "assistant",
                "content": "Response",
                "metadata": {"model": "gpt-4"},
                "tool_calls": [{"name": "search"}],
            }
        ]
        messages = _reconstruct_messages(stored)

        assert messages[0].metadata == {"model": "gpt-4"}
        assert messages[0].tool_calls == [{"name": "search"}]

    def test_reconstruct_non_string_content(self):
        """Content that's not a string gets converted."""
        stored = [{"role": "user", "content": ["list", "of", "content"]}]
        messages = _reconstruct_messages(stored)

        assert messages[0].content == "['list', 'of', 'content']"


class TestReconstructContext:
    """Test message context reconstruction."""

    def test_reconstruct_basic_context(self):
        """Reconstruct basic message context."""
        stored = {
            "msg-1": {
                "sample_id": "sample-abc",
                "sample_number": 1,
                "turn": 2,
            }
        }
        context = _reconstruct_context(stored)

        assert "msg-1" in context
        assert context["msg-1"].sample_id == "sample-abc"
        assert context["msg-1"].sample_number == 1
        assert context["msg-1"].turn == 2
        assert context["msg-1"].epoch == 1  # default

    def test_reconstruct_context_with_epoch(self):
        """Reconstruct context with explicit epoch."""
        stored = {
            "msg-2": {
                "sample_id": "sample-xyz",
                "sample_number": 3,
                "turn": 1,
                "epoch": 5,
                "model": "openai/gpt-4",
            }
        }
        context = _reconstruct_context(stored)

        assert context["msg-2"].epoch == 5
        assert context["msg-2"].model == "openai/gpt-4"

    def test_reconstruct_context_with_eval_file(self):
        """Reconstruct context with per-model eval file."""
        stored = {
            "msg-3": {
                "sample_id": "sample-123",
                "sample_number": 1,
                "turn": 1,
                "eval_file": "model_specific.eval",
            }
        }
        context = _reconstruct_context(stored)

        assert context["msg-3"].eval_file == "model_specific.eval"


class TestExtractHighlightsForTrailrun:
    """Test the main highlight extraction function."""

    @pytest.mark.asyncio
    async def test_returns_none_when_no_messages(self):
        """Returns None when trailrun has no messages."""
        trailrun = MagicMock()
        trailrun.messages = None

        result = await extract_highlights_for_trailrun(trailrun)

        assert result is None

    @pytest.mark.asyncio
    async def test_returns_none_for_empty_messages(self):
        """Returns None when messages list is empty."""
        trailrun = MagicMock()
        trailrun.messages = []

        result = await extract_highlights_for_trailrun(trailrun)

        assert result is None

    @pytest.mark.asyncio
    async def test_calls_extract_highlights_with_reconstructed_data(self):
        """Calls extract_highlights with properly reconstructed data."""
        trailrun = MagicMock()
        trailrun.id = "tr_test123"
        trailrun.messages = [{"id": "msg-1", "role": "assistant", "content": "Test response"}]
        trailrun.message_context = {
            "msg-1": {"sample_id": "s1", "sample_number": 1, "turn": 2, "epoch": 1}
        }
        trailrun.result = MagicMock()
        trailrun.result.log_dir = "/path/to/logs/experiment"
        trailrun.config = MagicMock()
        trailrun.config.title = "Test Experiment"
        trailrun.config.prompts = ["Test prompt"]

        mock_highlights = [MagicMock(index=1, quoted_text="Test")]

        with patch(
            "src.trailrun.highlights.extract_highlights",
            new_callable=AsyncMock,
            return_value=mock_highlights,
        ) as mock_extract:
            result = await extract_highlights_for_trailrun(trailrun)

            # Verify extract_highlights was called
            mock_extract.assert_called_once()

            # Check the messages argument
            call_kwargs = mock_extract.call_args.kwargs
            messages = call_kwargs["messages"]
            assert len(messages) == 1
            assert messages[0].id == "msg-1"
            assert messages[0].content == "Test response"

            # Check message_context was passed
            assert call_kwargs["message_context"] is not None
            assert "msg-1" in call_kwargs["message_context"]

            # Check experiment_context was passed
            assert call_kwargs["experiment_context"] is not None
            assert call_kwargs["experiment_context"].title == "Test Experiment"

            # Check build_link callback was passed (since we have log_dir)
            assert call_kwargs["build_link"] is not None

            assert result == mock_highlights

    @pytest.mark.asyncio
    async def test_no_build_link_when_no_log_dir(self):
        """build_link is None when result has no log_dir."""
        trailrun = MagicMock()
        trailrun.id = "tr_test456"
        trailrun.messages = [{"role": "user", "content": "Hi"}]
        trailrun.message_context = None
        trailrun.result = MagicMock()
        trailrun.result.log_dir = None  # No log dir
        trailrun.config = None

        with patch(
            "src.trailrun.highlights.extract_highlights",
            new_callable=AsyncMock,
            return_value=[],
        ) as mock_extract:
            await extract_highlights_for_trailrun(trailrun)

            call_kwargs = mock_extract.call_args.kwargs
            assert call_kwargs["build_link"] is None

    @pytest.mark.asyncio
    async def test_no_experiment_context_when_no_config(self):
        """experiment_context is None when trailrun has no config."""
        trailrun = MagicMock()
        trailrun.id = "tr_test789"
        trailrun.messages = [{"role": "user", "content": "Hi"}]
        trailrun.message_context = None
        trailrun.result = None
        trailrun.config = None

        with patch(
            "src.trailrun.highlights.extract_highlights",
            new_callable=AsyncMock,
            return_value=[],
        ) as mock_extract:
            await extract_highlights_for_trailrun(trailrun)

            call_kwargs = mock_extract.call_args.kwargs
            assert call_kwargs["experiment_context"] is None
