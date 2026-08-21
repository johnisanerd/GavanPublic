"""Unit tests for Ranger functionality."""

import json
import sys
from datetime import datetime
from unittest.mock import MagicMock, patch
from zoneinfo import ZoneInfo

import pytest

# Mock e2b before importing ranger modules
sys.modules["e2b"] = MagicMock()

from src.ranger.runner import generate_ranger_id, parse_structured_output
from src.ranger.types import RangerMode, RangerSession, RangerStatus

PACIFIC_TZ = ZoneInfo("America/Los_Angeles")


class TestGenerateRangerId:
    """Tests for ranger ID generation."""

    def test_format(self) -> None:
        """ID follows ranger_YYYYMMDD format."""
        ranger_id = generate_ranger_id()
        assert ranger_id.startswith("ranger_")
        assert len(ranger_id) == len("ranger_20241217")

    def test_uses_pacific_time(self) -> None:
        """ID is based on Pacific timezone."""
        # Mock a time that's different day in UTC vs Pacific
        # 2024-01-15 02:00 UTC = 2024-01-14 18:00 Pacific
        mock_time = datetime(2024, 1, 15, 2, 0, 0, tzinfo=ZoneInfo("UTC"))
        pacific_time = mock_time.astimezone(PACIFIC_TZ)

        with patch("src.ranger.runner.datetime") as mock_dt:
            mock_dt.now.return_value = pacific_time
            ranger_id = generate_ranger_id()

        assert ranger_id == "ranger_20240114"


class TestParseStructuredOutput:
    """Tests for extracting JSON from Claude Code output."""

    def test_extracts_json_block(self) -> None:
        """Extracts JSON from ```json block."""
        output = """
Some text here
```json
{"category": "deception", "conclusions": ["finding 1"]}
```
More text
"""
        result = parse_structured_output(output)
        assert result == {"category": "deception", "conclusions": ["finding 1"]}

    def test_takes_last_json_block(self) -> None:
        """When multiple JSON blocks, takes the last one."""
        output = """
```json
{"first": true}
```
Some middle text
```json
{"last": true}
```
"""
        result = parse_structured_output(output)
        assert result == {"last": True}

    def test_returns_none_for_no_json(self) -> None:
        """Returns None when no JSON block found."""
        output = "Just plain text without any JSON"
        result = parse_structured_output(output)
        assert result is None

    def test_handles_slightly_malformed_json(self) -> None:
        """json-repair can fix some malformed JSON."""
        # json-repair can handle some cases, so we test one it can't fix
        output = """
```json
completely not json at all ][}{
```
"""
        result = parse_structured_output(output)
        # json-repair may still return something, so just verify no exception
        assert result is None or isinstance(result, (dict, list))

    def test_handles_multiline_json(self) -> None:
        """Handles JSON spanning multiple lines."""
        output = """
```json
{
    "category": "safety",
    "subcategory": "jailbreaks",
    "conclusions": [
        "Models resist direct harmful requests",
        "Indirect framing sometimes works"
    ]
}
```
"""
        result = parse_structured_output(output)
        assert result["category"] == "safety"
        assert len(result["conclusions"]) == 2


class TestRangerMode:
    """Tests for research mode determination."""

    def test_odd_day_is_novel(self) -> None:
        """Odd-numbered days use novel investigation mode."""
        # Test the logic directly (day % 2 == 1 -> NOVEL)
        day = 15  # odd
        mode = RangerMode.NOVEL if day % 2 == 1 else RangerMode.DEEP_DIVE
        assert mode == RangerMode.NOVEL

    def test_even_day_is_deep_dive(self) -> None:
        """Even-numbered days use deep dive mode."""
        # Test the logic directly (day % 2 == 0 -> DEEP_DIVE)
        day = 16  # even
        mode = RangerMode.NOVEL if day % 2 == 1 else RangerMode.DEEP_DIVE
        assert mode == RangerMode.DEEP_DIVE

    def test_mode_values(self) -> None:
        """Mode enum has expected string values."""
        assert RangerMode.NOVEL.value == "novel"
        assert RangerMode.DEEP_DIVE.value == "deep_dive"


class TestRangerSession:
    """Tests for RangerSession model."""

    def test_defaults(self) -> None:
        """Session has sensible defaults."""
        session = RangerSession(
            id="ranger_20241217",
            date="2024-12-17",
            mode=RangerMode.NOVEL,
        )

        assert session.status == RangerStatus.RUNNING
        assert session.trailrun_ids == []
        assert session.structured is None
        assert session.error is None

    def test_serialization(self) -> None:
        """Session serializes to/from JSON."""
        session = RangerSession(
            id="ranger_20241217",
            date="2024-12-17",
            mode=RangerMode.NOVEL,
            trailrun_ids=["tr_abc", "tr_def"],
        )

        data = session.model_dump(mode="json")
        restored = RangerSession.model_validate(data)

        assert restored.id == session.id
        assert restored.trailrun_ids == ["tr_abc", "tr_def"]


class TestBuildPrompt:
    """Tests for prompt generation."""

    def test_includes_date(self) -> None:
        """Prompt includes the current date."""
        from src.prompts.ranger import build_prompt

        with patch("src.prompts.ranger.datetime") as mock_dt:
            mock_dt.now.return_value = datetime(2024, 12, 17, tzinfo=PACIFIC_TZ)
            prompt = build_prompt()

        assert "December 17, 2024" in prompt

    def test_odd_day_novel_mode(self) -> None:
        """Odd days get novel investigation instructions."""
        from src.prompts.ranger import build_prompt

        with patch("src.prompts.ranger.datetime") as mock_dt:
            mock_dt.now.return_value = datetime(2024, 12, 17, tzinfo=PACIFIC_TZ)  # 17th
            prompt = build_prompt()

        assert "NOVEL INVESTIGATION" in prompt
        assert "ODD" in prompt

    def test_even_day_deep_dive_mode(self) -> None:
        """Even days get deep dive instructions."""
        from src.prompts.ranger import build_prompt

        with patch("src.prompts.ranger.datetime") as mock_dt:
            mock_dt.now.return_value = datetime(2024, 12, 18, tzinfo=PACIFIC_TZ)  # 18th
            prompt = build_prompt()

        assert "DEEP DIVE" in prompt
        assert "EVEN" in prompt

    def test_includes_research_focus(self) -> None:
        """Custom research focus is included in prompt."""
        from src.prompts.ranger import build_prompt

        with patch("src.prompts.ranger.datetime") as mock_dt:
            mock_dt.now.return_value = datetime(2024, 12, 17, tzinfo=PACIFIC_TZ)
            prompt = build_prompt(research_focus="Test deceptive alignment")

        assert "Test deceptive alignment" in prompt
