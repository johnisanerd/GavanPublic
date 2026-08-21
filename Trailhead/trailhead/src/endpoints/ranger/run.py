"""POST /ranger/run - Trigger a Ranger research session."""

import asyncio
import json
import logging
import re
from datetime import datetime
from typing import Annotated, Any
from zoneinfo import ZoneInfo

from aiolimiter import AsyncLimiter
from fastapi import APIRouter, BackgroundTasks, Header, HTTPException
from pydantic import BaseModel

from src.config import settings
from src.ranger.runner import run_ranger_session
from src.ranger.store import (
    complete_ranger,
    create_ranger,
    get_ranger,
    save_ranger_log,
)
from src.ranger.types import RangerMode, RangerStatus

logger = logging.getLogger(__name__)
router = APIRouter(tags=["ranger"])

PACIFIC_TZ = ZoneInfo("America/Los_Angeles")


class RunRequest(BaseModel):
    """Request body for triggering a ranger run."""

    research_focus: str | None = None
    minimal: bool = False  # If true, tell ranger to do a quick test run


class RunResponse(BaseModel):
    """Response from triggering a ranger run."""

    status: str
    ranger_id: str
    message: str


def _get_mode_for_today() -> RangerMode:
    """Determine research mode based on today's date (Pacific)."""
    today = datetime.now(PACIFIC_TZ)
    return RangerMode.NOVEL if today.day % 2 == 1 else RangerMode.DEEP_DIVE


def _get_date_string() -> str:
    """Get today's date string in YYYY-MM-DD format (Pacific)."""
    today = datetime.now(PACIFIC_TZ)
    return today.strftime("%Y-%m-%d")


def _get_ranger_id() -> str:
    """Generate ranger ID for today (Pacific)."""
    today = datetime.now(PACIFIC_TZ)
    return f"ranger_{today.strftime('%Y%m%d')}"


async def _post_to_ranger_channel(
    text: str,
    blocks: list[dict[str, Any]] | None = None,
) -> None:
    """Post a message to the ranger channel (no threading)."""
    if not settings.ranger_slack_channel:
        return

    try:
        from src.slack.app import app as slack_app

        await slack_app.client.chat_postMessage(
            channel=settings.ranger_slack_channel,
            text=text,
            blocks=blocks,
        )
    except Exception as e:
        logger.debug(f"Failed to post to ranger channel: {e}")


def _markdown_to_mrkdwn(text: str) -> str:
    """Convert markdown formatting to Slack mrkdwn.

    Uses the existing converter from our summarizers.
    """
    from src.orchestration.analysis.summarizers.markdown_to_slack import (
        _convert_inline_formatting,
    )

    # Convert inline formatting (**bold** → *bold*, etc.)
    text = _convert_inline_formatting(text)

    # Headers: # text or ## text → *text* (bold)
    text = re.sub(r"^#+ (.+)$", r"*\1*", text, flags=re.MULTILINE)

    # Horizontal rules: --- → (just remove, Slack doesn't support)
    text = re.sub(r"^-{3,}$", "", text, flags=re.MULTILINE)

    # Tables: simplify by removing | borders and keeping content
    text = re.sub(r"^\|[-:| ]+\|$", "", text, flags=re.MULTILINE)  # Remove |---|---| lines
    text = re.sub(r"^\|(.+)\|$", lambda m: m.group(1).replace("|", "  "), text, flags=re.MULTILINE)

    # Clean up multiple blank lines
    text = re.sub(r"\n{3,}", "\n\n", text)

    return text.strip()


def _format_tool_name(name: str) -> str:
    """Format tool name: mcp__trailhead__trailhead_create → Create."""
    # Strip MCP prefix for trailhead tools
    if name.startswith("mcp__trailhead__trailhead_"):
        name = name[len("mcp__trailhead__trailhead_") :]
    elif name.startswith("mcp__trailhead__"):
        name = name[len("mcp__trailhead__") :]
    # Title case (Run, Summarize, Create, etc.)
    return name.title().replace("_", "")


def _format_tool_params(inp: dict[str, Any]) -> str:
    """Format key params for display inside parens."""
    # For trailhead tools, show meaningful params
    if "description" in inp:
        desc = inp["description"][:40]
        return f'"{desc}..."' if len(inp["description"]) > 40 else f'"{desc}"'
    if "question" in inp:
        q = inp["question"][:40]
        return f'"{q}..."' if len(inp["question"]) > 40 else f'"{q}"'
    if "trailrun_id" in inp:
        return inp["trailrun_id"]
    # For other tools, show path/command/pattern
    if "path" in inp:
        return inp["path"]
    if "file_path" in inp:
        return inp["file_path"]
    if "command" in inp:
        cmd = str(inp["command"])[:50]
        return f"`{cmd}`"
    if "pattern" in inp:
        return inp["pattern"]
    if "query" in inp:
        return str(inp["query"])[:30]
    return ""


def _format_trailhead_result(content: str, tool_name: str | None) -> str | list[dict[str, Any]] | None:
    """Parse trailhead MCP result and format nicely.

    Returns:
        - str for simple text output
        - list[dict] for Block Kit blocks
        - None to skip/use default formatting
    """
    try:
        # MCP results can come in different formats:
        # 1. JSON: [{"type": "text", "text": "{...}"}]
        # 2. Python repr: [{'type': 'text', 'text': '{...}'}]

        # Try JSON first
        try:
            wrapper = json.loads(content)
        except json.JSONDecodeError:
            # Try converting Python repr to JSON (single quotes to double)
            # This handles: [{'type': 'text', ...}] format
            try:
                import ast
                wrapper = ast.literal_eval(content)
            except (SyntaxError, ValueError):
                logger.debug(f"Could not parse trailhead result: {content[:100]}")
                return None

        if isinstance(wrapper, list) and wrapper:
            first = wrapper[0]
            if isinstance(first, dict) and "text" in first:
                inner = first.get("text", "")
                try:
                    data = json.loads(inner)
                except json.JSONDecodeError:
                    # inner might also need ast.literal_eval
                    try:
                        import ast
                        data = ast.literal_eval(inner)
                    except (SyntaxError, ValueError):
                        return None

                # trailhead_create: just show the ID
                if "trailrun_id" in data and "has_config" in data:
                    return f"→ `{data['trailrun_id']}`"

                # trailhead_design: format as config card using existing Block Kit builder
                if "config" in data:
                    from src.runner.types import ExperimentConfig
                    from src.trailrun.blocks import build_config_blocks

                    config = ExperimentConfig(**data["config"])
                    return build_config_blocks(config, "✅ Configured")

                # trailhead_summarize: return markdown directly (convert to mrkdwn)
                if "summary" in data:
                    return _markdown_to_mrkdwn(data["summary"])

                # trailhead_ask: return answer directly (convert to mrkdwn)
                if "answer" in data:
                    return _markdown_to_mrkdwn(data["answer"])

                # trailhead_run: show completion status
                if "status" in data and data.get("status") == "completed":
                    return "✅ Experiment complete"

                # trailhead_run might have other fields, show samples info
                if "samples_included" in data:
                    return f"✅ Experiment complete ({data['samples_included']} samples)"

    except Exception as e:
        logger.debug(f"Error parsing trailhead result: {e}")
    return None


class SlackStreamThrottle:
    """Throttles Claude Code stream-json output to Slack.

    Queues messages and drains at max velocity (1 message per interval).
    Uses aiolimiter for proper async rate limiting.
    All messages are prefixed with ⏺ (filled circle).
    """

    def __init__(self, min_interval: float = 3.0) -> None:
        # AsyncLimiter(1, interval) = 1 message per interval, no bursts
        self._limiter = AsyncLimiter(1, min_interval)
        self._queue: list[str | list[dict[str, Any]]] = []
        self._drain_task: asyncio.Task[None] | None = None
        self.current_tool: str | None = None

    def _parse_stream_json(self, line: str) -> str | list[dict[str, Any]] | None:
        """Parse stream-json line into human-readable format.

        Returns:
            - str for text messages (will be prefixed with ⏺)
            - list[dict] for Block Kit blocks (posted as-is)
            - None to skip
        """
        line = line.strip()
        if not line:
            return None

        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            logger.debug(f"[parse] plain text: {line[:100]}")
            return line  # Plain text passthrough

        event_type = obj.get("type")

        # Skip system/init events
        if event_type == "system":
            return None

        # Assistant messages (Claude's responses)
        if event_type == "assistant":
            parts = []
            for block in obj.get("message", {}).get("content", []):
                block_type = block.get("type")
                if block_type == "text":
                    text = block.get("text", "")
                    if text:
                        # Convert markdown to Slack mrkdwn (no truncation - let Slack handle)
                        text = _markdown_to_mrkdwn(text)
                        parts.append(text)
                elif block_type == "tool_use":
                    name = block.get("name", "?")
                    self.current_tool = name
                    inp = block.get("input", {})
                    # Format as Title() with params
                    formatted_name = _format_tool_name(name)
                    params = _format_tool_params(inp)
                    parts.append(f"⏺ {formatted_name}({params})")
            # Join parts, but tool calls already have ⏺
            if parts:
                result = "\n".join(parts)
                # If it's just text (no tool), add prefix
                if not any(p.startswith("⏺") for p in parts):
                    return result
                return result
            return None

        # User messages (tool results)
        if event_type == "user":
            for block in obj.get("message", {}).get("content", []):
                if block.get("type") == "tool_result":
                    content = str(block.get("content", ""))

                    # Try to format trailhead results specially
                    if self.current_tool and "trailhead" in self.current_tool:
                        formatted = _format_trailhead_result(content, self.current_tool)
                        if formatted is not None:
                            return formatted

                    # Skip very long results
                    if len(content) > 1000:
                        return None

                    # Format as code block, max 8 lines
                    lines = content.split("\n")
                    if len(lines) > 8:
                        lines = lines[:8] + ["..."]
                    formatted = "\n".join(lines)
                    return f"```\n{formatted}\n```"
            return None

        # Final result (no ⏺ prefix for completion/failure)
        if event_type == "result":
            subtype = obj.get("subtype", "unknown")
            duration_ms = obj.get("duration_ms", 0)
            if subtype == "success":
                if duration_ms:
                    mins, secs = divmod(int(duration_ms / 1000), 60)
                    if mins > 0:
                        return f"✅ Completed ({mins}m {secs}s)"
                    else:
                        return f"✅ Completed ({secs}s)"
                return "✅ Completed"
            else:
                return "❌ Failed"

        return None

    async def add_line(self, line: str) -> None:
        """Parse and queue a line, start draining if not already."""
        parsed = self._parse_stream_json(line)
        if parsed is None:
            return

        # Add ⏺ prefix to text messages that don't already have it
        # Skip prefix for: tool calls (already have ⏺), code blocks, completion/failure
        if isinstance(parsed, str) and not parsed.startswith("⏺") and not parsed.startswith("```") and not parsed.startswith("✅") and not parsed.startswith("❌") and not parsed.startswith("→"):
            parsed = f"⏺ {parsed}"

        self._queue.append(parsed)

        # Start drain task if not running
        if self._drain_task is None or self._drain_task.done():
            self._drain_task = asyncio.create_task(self._drain_loop())

    async def _drain_loop(self) -> None:
        """Drain queue at max velocity using aiolimiter."""
        while self._queue:
            async with self._limiter:
                if self._queue:
                    msg = self._queue.pop(0)
                    if isinstance(msg, list):
                        # Block Kit blocks
                        await _post_to_ranger_channel("", blocks=msg)
                    else:
                        # Plain text
                        await _post_to_ranger_channel(msg)

    async def flush(self) -> None:
        """Wait for drain to complete."""
        if self._drain_task and not self._drain_task.done():
            await self._drain_task


async def _run_ranger_task(ranger_id: str, research_focus: str | None) -> None:
    """Background task to run a ranger session with Slack streaming."""
    try:
        logger.info(f"Starting ranger session: {ranger_id}")

        # Post start message
        ranger = get_ranger(ranger_id)
        if ranger:
            mode_desc = "Novel Investigation" if ranger.mode == RangerMode.NOVEL else "Deep Dive"
            await _post_to_ranger_channel(
                f":hiking_boot: *Ranger Starting* ({mode_desc})\nSession: `{ranger_id}`"
            )

        # Create throttled stream for Slack updates (3s between posts)
        throttle = SlackStreamThrottle(min_interval=3.0)

        async def on_output(line: str) -> None:
            logger.debug(f"[ranger-output] {line[:200]}")
            await throttle.add_line(line)

        result = await run_ranger_session(
            research_focus=research_focus,
            on_output=on_output,
        )

        # Flush any remaining queued output
        await throttle.flush()

        # Save the log file
        if result.get("stdout"):
            save_ranger_log(ranger_id, result["stdout"])

        # Update ranger with results
        status = RangerStatus.SUCCESS if result["status"] == "success" else RangerStatus.FAILED
        complete_ranger(
            ranger_id,
            status=status,
            structured=result.get("structured"),
            error=result.get("error"),
        )

        logger.info(f"Ranger session completed: {ranger_id} ({status.value})")

        # Post completion message
        await _post_ranger_completion(ranger_id)

    except Exception as e:
        logger.exception(f"Ranger session failed: {ranger_id}")
        complete_ranger(
            ranger_id,
            status=RangerStatus.FAILED,
            error=str(e),
        )
        await _post_to_ranger_channel(f":x: *Ranger Failed*\n`{ranger_id}`: {e}")


async def _post_ranger_completion(ranger_id: str) -> None:
    """Post completion summary to ranger channel as Block Kit."""
    ranger = get_ranger(ranger_id)
    if not ranger:
        return

    blocks: list[dict[str, Any]] = []

    # Header with status
    if ranger.status == RangerStatus.SUCCESS:
        icon = ":white_check_mark:"
        status_text = "Ranger completed"
    else:
        icon = ":x:"
        status_text = "Ranger failed"

    blocks.append({
        "type": "header",
        "text": {"type": "plain_text", "text": f"{icon} {status_text}", "emoji": True},
    })

    # Session info section
    info_parts = [f"*Session:* `{ranger_id}`"]
    info_parts.append(f"*Trailruns:* {len(ranger.trailrun_ids)}")

    if ranger.structured:
        if ranger.structured.get("category"):
            cat = ranger.structured["category"]
            subcat = ranger.structured.get("subcategory", "")
            if subcat:
                info_parts.append(f"*Category:* {cat} → {subcat}")
            else:
                info_parts.append(f"*Category:* {cat}")

        is_new = ranger.structured.get("is_new_category", False)
        if is_new:
            info_parts.append("✨ _New category explored_")

    blocks.append({
        "type": "section",
        "text": {"type": "mrkdwn", "text": "\n".join(info_parts)},
    })

    # Key findings
    if ranger.structured and ranger.structured.get("conclusions"):
        blocks.append({"type": "divider"})
        blocks.append({
            "type": "section",
            "text": {"type": "mrkdwn", "text": "*Key Findings*"},
        })
        findings = []
        for c in ranger.structured["conclusions"][:5]:
            findings.append(f"• {c}")
        blocks.append({
            "type": "section",
            "text": {"type": "mrkdwn", "text": "\n".join(findings)},
        })

    # Open questions
    if ranger.structured and ranger.structured.get("open_questions"):
        blocks.append({
            "type": "section",
            "text": {"type": "mrkdwn", "text": "*Open Questions*"},
        })
        questions = []
        for q in ranger.structured["open_questions"][:3]:
            questions.append(f"› _{q}_")
        blocks.append({
            "type": "section",
            "text": {"type": "mrkdwn", "text": "\n".join(questions)},
        })

    # Error details if failed
    if ranger.status == RangerStatus.FAILED and ranger.error:
        blocks.append({"type": "divider"})
        blocks.append({
            "type": "section",
            "text": {"type": "mrkdwn", "text": f"*Error:* `{ranger.error[:200]}`"},
        })

    # Fallback text for notifications
    fallback = f"{status_text}: {ranger_id}"

    await _post_to_ranger_channel(fallback, blocks=blocks)


@router.post("/ranger/run", response_model=RunResponse)
async def ranger_run(
    background_tasks: BackgroundTasks,
    authorization: Annotated[str | None, Header()] = None,
    body: RunRequest | None = None,
) -> RunResponse:
    """Trigger a Ranger autonomous research session.

    This endpoint is called by Railway cron daily at noon PST.
    The session runs in the background (up to 30 minutes).

    Requires TRAILHEAD_SECRET bearer token for authentication.
    """
    # Verify authentication
    if not settings.trailhead_secret:
        raise HTTPException(
            status_code=500,
            detail="TRAILHEAD_SECRET not configured",
        )

    expected_auth = f"Bearer {settings.trailhead_secret}"
    if authorization != expected_auth:
        raise HTTPException(
            status_code=401,
            detail="Invalid or missing authorization",
        )

    # Check required config
    if not settings.e2b_api_key:
        raise HTTPException(
            status_code=500,
            detail="E2B_API_KEY not configured",
        )
    if not settings.anthropic_api_key:
        raise HTTPException(
            status_code=500,
            detail="ANTHROPIC_API_KEY not configured",
        )
    if not settings.ranger_secret:
        raise HTTPException(
            status_code=500,
            detail="RANGER_SECRET not configured",
        )

    # Create ranger record
    ranger_id = _get_ranger_id()
    mode = _get_mode_for_today()
    date = _get_date_string()

    ranger = create_ranger(ranger_id=ranger_id, mode=mode, date=date)

    # Start background task
    research_focus = body.research_focus if body else None
    minimal = body.minimal if body else False

    # In minimal mode, prepend instructions to do a quick but real test
    if minimal:
        minimal_prefix = """**MINIMAL TEST MODE**: Do a real but quick experiment. Keep it fast:
- Skip Stage 1 (reviewing past experiments)
- Skip Stage 2 (identifying opportunities)
- Go straight to running ONE simple experiment: "Compare GPT-4o and Claude on 'What is 2+2?'"
- Use n=1 (single run per model)
- Ask ONE follow-up question
- Output the JSON summary

**IMPORTANT**: Narrate your thinking out loud as you work. Before each action, explain:
- What you're about to do and why
- What you expect to find
- Your observations after each step

This helps us follow your reasoning process.

This should take ~3 minutes total.

"""
        research_focus = minimal_prefix + (research_focus or "")

    background_tasks.add_task(_run_ranger_task, ranger_id, research_focus)

    mode_desc = "Novel Investigation" if mode == RangerMode.NOVEL else "Deep Dive"
    return RunResponse(
        status="started",
        ranger_id=ranger.id,
        message=f"Ranger session started in {mode_desc} mode",
    )
