"""Tests for SlackStreamThrottle stream-json parsing.

Based on real E2B Claude Code output format (verified 2024-12-18).
Updated 2024-12-18: New formatting with ⏺ prefix, Title() tool names.
"""

from src.endpoints.ranger.run import SlackStreamThrottle, _format_tool_name, _format_tool_params, _markdown_to_mrkdwn


class TestMarkdownToMrkdwn:
    """Test markdown to Slack mrkdwn conversion."""

    def test_bold_conversion(self) -> None:
        """**bold** should become *bold*."""
        assert _markdown_to_mrkdwn("This is **bold** text") == "This is *bold* text"

    def test_header_conversion(self) -> None:
        """## headers should become *bold*."""
        assert _markdown_to_mrkdwn("## My Plan") == "*My Plan*"
        assert _markdown_to_mrkdwn("### Subheader") == "*Subheader*"

    def test_multiple_bold(self) -> None:
        """Multiple bold sections should all convert."""
        result = _markdown_to_mrkdwn("**First** and **Second**")
        assert result == "*First* and *Second*"


class TestToolNameFormatting:
    """Test the _format_tool_name helper."""

    def test_format_trailhead_mcp_name(self) -> None:
        """MCP trailhead tool names should be cleaned and title-cased."""
        assert _format_tool_name("mcp__trailhead__trailhead_create") == "Create"
        assert _format_tool_name("mcp__trailhead__trailhead_run") == "Run"
        assert _format_tool_name("mcp__trailhead__trailhead_summarize") == "Summarize"
        assert _format_tool_name("mcp__trailhead__trailhead_ask") == "Ask"

    def test_format_regular_tool_name(self) -> None:
        """Regular tool names should be title-cased."""
        assert _format_tool_name("Bash") == "Bash"
        assert _format_tool_name("LS") == "Ls"
        assert _format_tool_name("Read") == "Read"
        assert _format_tool_name("Grep") == "Grep"


class TestToolParamsFormatting:
    """Test the _format_tool_params helper."""

    def test_format_description_param(self) -> None:
        """Description params should be quoted."""
        inp = {"description": "Compare GPT and Claude"}
        assert _format_tool_params(inp) == '"Compare GPT and Claude"'

    def test_format_long_description_truncated(self) -> None:
        """Long descriptions should be truncated."""
        inp = {"description": "x" * 50}
        result = _format_tool_params(inp)
        assert result.endswith('..."')
        assert len(result) < 50

    def test_format_question_param(self) -> None:
        """Question params should be quoted."""
        inp = {"question": "Which model was faster?"}
        assert _format_tool_params(inp) == '"Which model was faster?"'

    def test_format_trailrun_id_param(self) -> None:
        """Trailrun ID should be shown directly."""
        inp = {"trailrun_id": "tr_ABC123"}
        assert _format_tool_params(inp) == "tr_ABC123"

    def test_format_path_param(self) -> None:
        """Path params should be shown directly."""
        inp = {"path": "/home/user"}
        assert _format_tool_params(inp) == "/home/user"

    def test_format_command_param(self) -> None:
        """Command params should be in backticks."""
        inp = {"command": "ls -la"}
        assert _format_tool_params(inp) == "`ls -la`"

    def test_format_empty_input(self) -> None:
        """Empty input should return empty string."""
        assert _format_tool_params({}) == ""


class TestSlackStreamThrottleParsing:
    """Test the _parse_stream_json method."""

    def test_parse_system_event_returns_none(self) -> None:
        """System/init events should be skipped."""
        buffer = SlackStreamThrottle()
        line = '{"type":"system","subtype":"init","session_id":"abc123","tools":["Bash","Read"]}'
        assert buffer._parse_stream_json(line) is None

    def test_parse_assistant_with_text(self) -> None:
        """Assistant messages should extract text content."""
        buffer = SlackStreamThrottle()
        line = (
            '{"type":"assistant","message":{"content":[{"type":"text","text":"Analyzing..."}]}}'
        )
        result = buffer._parse_stream_json(line)
        assert result == "Analyzing..."

    def test_parse_assistant_with_tool_use(self) -> None:
        """Assistant messages with tool_use should show Title() format."""
        buffer = SlackStreamThrottle()
        line = (
            '{"type":"assistant","message":{"content":'
            '[{"type":"tool_use","name":"LS","input":{"path":"/home"}}]}}'
        )
        result = buffer._parse_stream_json(line)
        assert result == "⏺ Ls(/home)"
        assert buffer.current_tool == "LS"

    def test_parse_assistant_with_bash_command(self) -> None:
        """Bash tool should show command in backticks."""
        buffer = SlackStreamThrottle()
        line = (
            '{"type":"assistant","message":{"content":'
            '[{"type":"tool_use","name":"Bash","input":{"command":"ls -la"}}]}}'
        )
        result = buffer._parse_stream_json(line)
        assert result == "⏺ Bash(`ls -la`)"

    def test_parse_trailhead_tool_use(self) -> None:
        """Trailhead MCP tools should show clean Title() format."""
        buffer = SlackStreamThrottle()
        line = (
            '{"type":"assistant","message":{"content":'
            '[{"type":"tool_use","name":"mcp__trailhead__trailhead_create","input":{}}]}}'
        )
        result = buffer._parse_stream_json(line)
        assert result == "⏺ Create()"

    def test_parse_trailhead_design_with_description(self) -> None:
        """Trailhead design should show description in parens."""
        buffer = SlackStreamThrottle()
        line = (
            '{"type":"assistant","message":{"content":'
            '[{"type":"tool_use","name":"mcp__trailhead__trailhead_design",'
            '"input":{"description":"Compare GPT and Claude"}}]}}'
        )
        result = buffer._parse_stream_json(line)
        assert result == '⏺ Design("Compare GPT and Claude")'

    def test_parse_user_tool_result_short(self) -> None:
        """Short tool results should be shown in code block."""
        buffer = SlackStreamThrottle()
        line = (
            '{"type":"user","message":{"content":'
            '[{"type":"tool_result","content":"- /home/user/"}]}}'
        )
        result = buffer._parse_stream_json(line)
        assert result == "```\n- /home/user/\n```"

    def test_parse_user_tool_result_multiline_truncated(self) -> None:
        """Tool results with >8 lines should be truncated."""
        import json

        buffer = SlackStreamThrottle()
        content = "\n".join([f"line {i}" for i in range(12)])  # 12 lines
        # Use json.dumps to properly escape the content
        msg = {
            "type": "user",
            "message": {"content": [{"type": "tool_result", "content": content}]},
        }
        line = json.dumps(msg)
        result = buffer._parse_stream_json(line)
        assert result is not None
        assert result.startswith("```\n")
        assert result.endswith("\n```")
        # Should have 8 lines + "..."
        inner = result[4:-4]  # Strip ``` markers
        inner_lines = inner.split("\n")
        assert len(inner_lines) == 9  # 8 lines + "..."
        assert inner_lines[-1] == "..."

    def test_parse_user_tool_result_very_long_skipped(self) -> None:
        """Tool results >1000 chars should be skipped entirely."""
        buffer = SlackStreamThrottle()
        long_content = "x" * 1100  # Over 1000 char limit
        line = (
            f'{{"type":"user","message":{{"content":'
            f'[{{"type":"tool_result","content":"{long_content}"}}]}}}}'
        )
        assert buffer._parse_stream_json(line) is None

    def test_parse_result_success(self) -> None:
        """Success result should show completion (no ⏺ prefix)."""
        buffer = SlackStreamThrottle()
        line = '{"type":"result","subtype":"success","total_cost_usd":0.0542}'
        result = buffer._parse_stream_json(line)
        assert result == "✅ Completed"

    def test_parse_result_error(self) -> None:
        """Error result should show failure (no ⏺ prefix)."""
        buffer = SlackStreamThrottle()
        line = '{"type":"result","subtype":"error"}'
        result = buffer._parse_stream_json(line)
        assert result == "❌ Failed"

    def test_parse_empty_line_returns_none(self) -> None:
        """Empty lines should be skipped."""
        buffer = SlackStreamThrottle()
        assert buffer._parse_stream_json("") is None
        assert buffer._parse_stream_json("   ") is None

    def test_parse_invalid_json_returns_line(self) -> None:
        """Invalid JSON should be returned as-is (might be raw text)."""
        buffer = SlackStreamThrottle()
        line = "This is not JSON"
        assert buffer._parse_stream_json(line) == "This is not JSON"

    def test_parse_unknown_event_type_returns_none(self) -> None:
        """Unknown event types should be skipped."""
        buffer = SlackStreamThrottle()
        line = '{"type":"unknown_event","data":"something"}'
        assert buffer._parse_stream_json(line) is None

    def test_parse_long_text_not_truncated(self) -> None:
        """Long text should NOT be truncated (let Slack handle expand)."""
        buffer = SlackStreamThrottle()
        long_text = "x" * 600
        line = f'{{"type":"assistant","message":{{"content":[{{"type":"text","text":"{long_text}"}}]}}}}'
        result = buffer._parse_stream_json(line)
        assert len(result) == 600  # Full text preserved

    def test_parse_mixed_content_blocks(self) -> None:
        """Assistant with text + tool_use should show both."""
        buffer = SlackStreamThrottle()
        line = (
            '{"type":"assistant","message":{"content":['
            '{"type":"text","text":"Let me check"},'
            '{"type":"tool_use","name":"Grep","input":{"pattern":"error"}}]}}'
        )
        result = buffer._parse_stream_json(line)
        assert "Let me check" in result
        assert "⏺ Grep(error)" in result
