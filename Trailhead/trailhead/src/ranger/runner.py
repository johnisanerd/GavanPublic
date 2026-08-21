"""Ranger E2B sandbox runner.

Spawns Claude Code in an E2B sandbox with Trailhead MCP configuration
and streams the research session output.
"""

import asyncio
import json
import logging
import re
from collections.abc import Awaitable, Callable
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from e2b import Sandbox

from src.config import settings
from src.prompts.ranger import build_prompt

logger = logging.getLogger(__name__)

PACIFIC_TZ = ZoneInfo("America/Los_Angeles")

# E2B sandbox configuration
SANDBOX_TEMPLATE = "anthropic-claude-code"
SANDBOX_TIMEOUT_SECONDS = 30 * 60  # 30 minutes


def generate_ranger_id() -> str:
    """Generate a unique ranger session ID based on today's date (Pacific)."""
    today = datetime.now(PACIFIC_TZ)
    return f"ranger_{today.strftime('%Y%m%d')}"


def build_mcp_config(ranger_id: str, trailhead_url: str) -> dict[str, Any]:
    """Build the MCP configuration for Claude Code.

    Args:
        ranger_id: The ranger session ID for header linking.
        trailhead_url: Base URL of the Trailhead server.

    Returns:
        MCP config dict to write to .claude.json
    """
    if not settings.ranger_secret:
        raise ValueError("RANGER_SECRET must be configured for Ranger sessions")

    return {
        "mcpServers": {
            "trailhead": {
                "type": "http",
                "url": f"{trailhead_url}/mcp",
                "headers": {
                    "Authorization": f"Bearer {settings.ranger_secret}",
                    "X-Ranger-ID": ranger_id,
                },
            }
        }
    }


def parse_structured_output(output: str) -> dict[str, Any] | None:
    """Extract structured JSON output from Claude Code's response.

    Looks for a ```json block at the end of the output.

    Args:
        output: Full stdout from the Claude Code session.

    Returns:
        Parsed JSON dict if found, None otherwise.
    """
    # Look for ```json blocks
    pattern = r"```json\s*([\s\S]*?)\s*```"
    matches = re.findall(pattern, output)

    if not matches:
        return None

    # Take the last JSON block (the final output)
    last_json = matches[-1].strip()

    try:
        result = json.loads(last_json)
        if isinstance(result, dict):
            return result
        logger.warning(f"Structured output is not a dict: {type(result)}")
        return None
    except json.JSONDecodeError:
        # Try json-repair if available
        try:
            from json_repair import repair_json

            repaired = repair_json(last_json)
            result = json.loads(repaired)
            if isinstance(result, dict):
                return result
            logger.warning(f"Repaired JSON is not a dict: {type(result)}")
            return None
        except Exception:
            logger.warning("Failed to parse structured output JSON")
            return None


async def run_ranger_session(
    research_focus: str | None = None,
    trailhead_url: str | None = None,
    on_output: Callable[[str], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """Run a Ranger research session in an E2B sandbox.

    Args:
        research_focus: Optional specific research direction to explore.
        trailhead_url: Base URL of Trailhead server. Defaults to settings.app_base_url.
        on_output: Optional async callback for streaming output lines.

    Returns:
        Dict with session results:
        - ranger_id: The session ID
        - status: "success" | "failed"
        - structured: Parsed JSON output (if available)
        - stdout: Full stdout from the session
        - error: Error message (if failed)
    """
    if not settings.e2b_api_key:
        raise ValueError("E2B_API_KEY must be configured for Ranger sessions")
    if not settings.anthropic_api_key:
        raise ValueError("ANTHROPIC_API_KEY must be configured for Ranger sessions")

    ranger_id = generate_ranger_id()
    url = trailhead_url or settings.app_base_url

    logger.info(f"Starting Ranger session: {ranger_id}")

    # Build the prompt and MCP config
    prompt = build_prompt(research_focus)
    mcp_config = build_mcp_config(ranger_id, url)

    stdout_lines: list[str] = []
    # Queue for async processing of output lines
    output_queue: asyncio.Queue[str | None] = asyncio.Queue()

    async def process_output_queue() -> None:
        """Process output lines from queue and call async callback."""
        while True:
            line = await output_queue.get()
            if line is None:  # Sentinel to stop
                break
            if on_output:
                try:
                    await on_output(line)
                except Exception as e:
                    logger.debug(f"Output callback error: {e}")

    try:
        # Create E2B sandbox
        sandbox = Sandbox.create(
            template=SANDBOX_TEMPLATE,
            timeout=SANDBOX_TIMEOUT_SECONDS,
            envs={
                "ANTHROPIC_API_KEY": settings.anthropic_api_key,
            },
            api_key=settings.e2b_api_key,
        )

        try:
            # Write MCP config to sandbox
            config_content = json.dumps(mcp_config, indent=2)
            sandbox.files.write("/home/user/.claude.json", config_content)
            logger.debug(f"Wrote MCP config to sandbox: {config_content}")

            # Start output processor task
            output_task = asyncio.create_task(process_output_queue())

            def handle_stdout(line: str) -> None:
                """Sync callback that queues lines for async processing."""
                stdout_lines.append(line)
                # Put in queue for async processing (non-blocking)
                try:
                    output_queue.put_nowait(line)
                except asyncio.QueueFull:
                    pass  # Drop if queue full

            # Write prompt to file to avoid shell escaping issues
            sandbox.files.write("/home/user/prompt.txt", prompt)

            # Write MCP config to a known location
            sandbox.files.write("/.mcp/mcp.json", config_content)

            # Run Claude Code with the prompt
            # Use -p for pipe mode, --mcp-config to point to our config
            # Use --verbose --output-format stream-json for structured streaming
            # (stream-json requires --verbose when using -p)
            # This format is parsed by SlackStreamThrottle._parse_stream_json()
            claude_cmd = (
                "cat /home/user/prompt.txt | "
                "claude -p --dangerously-skip-permissions "
                "--mcp-config /.mcp/mcp.json --verbose --output-format stream-json"
            )
            process = await asyncio.to_thread(
                sandbox.commands.run,
                claude_cmd,
                timeout=SANDBOX_TIMEOUT_SECONDS,
                on_stdout=handle_stdout,
                on_stderr=lambda line: logger.debug(f"[stderr] {line}"),
            )

            # Signal output processor to stop and wait
            await output_queue.put(None)
            await output_task

            full_stdout = "\n".join(stdout_lines)

            if process.exit_code != 0:
                logger.error(f"Claude Code exited with code {process.exit_code}")
                return {
                    "ranger_id": ranger_id,
                    "status": "failed",
                    "structured": None,
                    "stdout": full_stdout,
                    "error": f"Process exited with code {process.exit_code}",
                }

            # Parse structured output
            structured = parse_structured_output(full_stdout)

            logger.info(f"Ranger session completed: {ranger_id}")
            return {
                "ranger_id": ranger_id,
                "status": "success",
                "structured": structured,
                "stdout": full_stdout,
                "error": None,
            }

        finally:
            # Always clean up the sandbox
            sandbox.kill()

    except Exception as e:
        logger.exception(f"Ranger session failed: {e}")
        return {
            "ranger_id": ranger_id,
            "status": "failed",
            "structured": None,
            "stdout": "\n".join(stdout_lines),
            "error": str(e),
        }
