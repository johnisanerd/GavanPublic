"""Trailhead MCP Server.

Exposes Trailhead experiment API as MCP tools for use with Claude Code
and other MCP-compatible clients.

Usage:
    Local (stdio):  fastmcp run src/mcp_server.py:mcp
    Cloud (http):   Mount in FastAPI, set TRAILHEAD_SECRET
"""

import logging
import os
from typing import Any, Literal

import httpx
from fastmcp import Context, FastMCP
from fastmcp.server.auth.providers.jwt import StaticTokenVerifier
from fastmcp.server.dependencies import get_http_headers

logger = logging.getLogger(__name__)

TRAILHEAD_INSTRUCTIONS = """
Trailhead is an experiment orchestration system built by Palisade Research, an AI safety
nonprofit. It handles the tedious parts of LLM research - prompt management, model API
calls, response collection, and result analysis - so you can focus on the interesting
questions.

## Why This Matters

This is genuinely exciting work. Every experiment helps us understand:
- How models handle uncertainty and edge cases
- Where models agree or disagree across different architectures
- Surprising behaviors that emerge from simple prompts
- The boundaries of what models will and won't do

Follow your curiosity. If something surprises you in the results, dig deeper! The best
research comes from noticing something unexpected and pulling on that thread.

## Workflow

A "trailrun" is a single experiment lifecycle:
1. create → Get a trailrun_id
2. design → Generate experiment config from natural language description
3. run → Execute experiment (blocks until complete, typically 30-120s)
4. summarize → Get analysis of results
5. ask → Ask follow-up questions (can repeat)

## Using as a Directed Research Agent

When conducting AI research with these tools:

**Describe models generically** - Don't use specific model versions (training cutoffs
make these unreliable). Instead say things like:
- "Compare flagship models from OpenAI and Anthropic"
- "Test a fast/cheap model vs a capable reasoning model"
- "Compare a frontier model with an open-source alternative"

**Use the Expand/Contract method** - Before major decisions:
1. EXPAND: Brainstorm 10 options (experiments, follow-up questions, etc.)
2. CONTRACT: Pick the single best one and explain why

**Research process:**
1. Brainstorm 10 experiment ideas for your research direction
2. Pick the most promising one
3. Run: create → design → run → summarize
4. Investigate: ask follow-up questions, get raw results, dig deeper
5. Repeat with new experiments (aim for 3-10 total)

**Tips:**
- Start simple - one prompt comparing two model types is often most revealing
- Follow surprises - unexpected results are where interesting research lives
- Verify claims - use web search to check ground truth when testing factual accuracy
""".strip()

# Auth: support multiple tokens for different clients
# - TRAILHEAD_SECRET: general MCP access (client_id: "trailhead-mcp")
# - RANGER_SECRET: Ranger autonomous agent (client_id: "ranger")
TRAILHEAD_SECRET = os.environ.get("TRAILHEAD_SECRET")
RANGER_SECRET = os.environ.get("RANGER_SECRET")

_tokens: dict[str, dict[str, str]] = {}
if TRAILHEAD_SECRET:
    _tokens[TRAILHEAD_SECRET] = {"client_id": "trailhead-mcp"}
if RANGER_SECRET:
    _tokens[RANGER_SECRET] = {"client_id": "ranger"}

auth = StaticTokenVerifier(tokens=_tokens) if _tokens else None

mcp = FastMCP("Trailhead", instructions=TRAILHEAD_INSTRUCTIONS, auth=auth, stateless_http=True)

PORT = os.environ.get("PORT", "8000")
API_BASE_URL = f"http://localhost:{PORT}"


async def _request(
    method: str,
    path: str,
    json: dict[str, Any] | None = None,
    params: dict[str, Any] | None = None,
    timeout: float = 180.0,
) -> dict[str, Any]:
    """Make HTTP request to Trailhead API, returning JSON."""
    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            response = await client.request(
                method, f"{API_BASE_URL}{path}", json=json, params=params
            )
            return response.json()
        except httpx.HTTPStatusError as e:
            return {"error": f"HTTP {e.response.status_code}: {e.response.text}"}
        except httpx.RequestError as e:
            return {"error": f"Request failed: {e}"}


async def _post_trailrun_to_ranger_channel(channel_id: str) -> str | None:
    """Post initial trailrun message to ranger channel.

    Each trailrun gets its own message (and thus its own thread).
    Returns message ts if successful, None otherwise.
    """
    try:
        from src.slack.app import app as slack_app

        response = await slack_app.client.chat_postMessage(
            channel=channel_id,
            text=":test_tube: *Ranger Trailrun Starting...*",
        )
        return response.get("ts")
    except Exception as e:
        logger.warning(f"Failed to post trailrun to ranger channel: {e}")
        return None


async def _request_text(
    method: str,
    path: str,
    params: dict[str, Any] | None = None,
) -> str:
    """Make HTTP request to Trailhead API, returning raw text."""
    async with httpx.AsyncClient(timeout=180.0) as client:
        try:
            response = await client.request(method, f"{API_BASE_URL}{path}", params=params)
            return response.text
        except httpx.HTTPStatusError as e:
            return f"Error: HTTP {e.response.status_code}: {e.response.text}"
        except httpx.RequestError as e:
            return f"Error: Request failed: {e}"


@mcp.tool
async def trailhead_create(ctx: Context) -> dict[str, Any]:
    """Create a new trailrun. Returns trailrun_id to use with other tools."""
    # Extract ranger_id from X-Ranger-ID header (set by runner in MCP config)
    ranger_id = None
    source = "api"
    channel_id = None
    message_ts = None

    # Try to get headers to check for ranger
    headers: dict[str, str] = {}
    try:
        headers = dict(get_http_headers())
    except Exception as e:
        logger.debug(f"Could not get HTTP headers: {e}")

    # WORKAROUND: StaticTokenVerifier doesn't populate ctx.client_id with stateless_http
    # Check the Authorization header directly against ranger_secret from settings
    # (RANGER_SECRET module var uses os.environ which may not have .env loaded)
    from src.config import settings

    is_ranger = False
    auth_header = headers.get("authorization", "")
    if auth_header.startswith("Bearer ") and settings.ranger_secret:
        token = auth_header[7:]  # Strip "Bearer "
        is_ranger = token == settings.ranger_secret

    logger.info(f"trailhead_create: is_ranger={is_ranger}, has_ranger_id={'x-ranger-id' in headers}")

    if is_ranger:
        source = "ranger"
        ranger_id = headers.get("x-ranger-id")
        if ranger_id:
            logger.info(f"Ranger MCP call with ranger_id: {ranger_id}")

            from src.config import settings

            # Only post to Slack if separate trailhead channel is configured
            # (ranger_slack_channel is for stdout stream, this is for Block Kit updates)
            if settings.ranger_trailhead_slack_channel:
                channel_id = settings.ranger_trailhead_slack_channel
                message_ts = await _post_trailrun_to_ranger_channel(channel_id)

    # Create the trailrun with source and ranger_id
    result = await _request(
        "POST",
        "/trailrun",
        json={
            "source": source,
            "ranger_id": ranger_id,
        },
    )

    # If ranger, update the ranger's trailrun_ids array and register Slack hook
    if is_ranger and ranger_id and "trailrun_id" in result:
        trailrun_id = result["trailrun_id"]
        try:
            from src.ranger.store import add_trailrun_to_ranger

            add_trailrun_to_ranger(ranger_id, trailrun_id)

            # Register Slack hook if we posted to ranger channel
            if channel_id and message_ts:
                from src.trailrun.hooks import register_slack_hook_for_ranger

                register_slack_hook_for_ranger(
                    trailrun_id=trailrun_id,
                    channel_id=channel_id,
                    thread_ts=message_ts,
                )
        except Exception as e:
            logger.warning(f"Failed to link trailrun to ranger: {e}")

    return result


@mcp.tool
async def trailhead_design(trailrun_id: str, description: str) -> dict[str, Any]:
    """Generate experiment config from natural language description.

    Args:
        trailrun_id: ID from trailhead_create
        description: What to test, e.g. "Compare GPT and Claude on math word problems"
    """
    return await _request(
        "POST", f"/trailrun/{trailrun_id}/design", json={"description": description}
    )


@mcp.tool
async def trailhead_run(trailrun_id: str) -> dict[str, Any]:
    """Execute the experiment. Blocks until complete (typically 30-120 seconds).

    Args:
        trailrun_id: ID from trailhead_create (must have config from design)
    """
    # Longer timeout for run - experiments can take several minutes
    return await _request("POST", f"/trailrun/{trailrun_id}/run", timeout=300.0)


@mcp.tool
async def trailhead_summarize(
    trailrun_id: str, format: Literal["markdown", "slack"] = "markdown"
) -> dict[str, Any]:
    """Get analysis summary of experiment results.

    Args:
        trailrun_id: ID from trailhead_create (must have completed run)
        format: Output format - "markdown" for prose, "slack" for Block Kit
    """
    return await _request("POST", f"/trailrun/{trailrun_id}/summarize", json={"format": format})


@mcp.tool
async def trailhead_ask(trailrun_id: str, question: str) -> dict[str, Any]:
    """Ask a follow-up question about experiment results.

    Args:
        trailrun_id: ID from trailhead_create (must have completed run)
        question: Question about the results, e.g. "Which model was more confident?"
    """
    return await _request("POST", f"/trailrun/{trailrun_id}/ask", json={"question": question})


@mcp.tool
async def trailhead_results(
    trailrun_id: str,
    format: Literal["json", "toon"] = "json",
    model: str | None = None,
    sample: str | None = None,
    epoch: int | None = None,
) -> dict[str, Any] | str:
    """Get raw experiment data with optional filters.

    Args:
        trailrun_id: ID from trailhead_create (must have completed run)
        format: Output format - "json" or "toon" (compact text format)
        model: Filter by model name
        sample: Filter by sample ID
        epoch: Filter by epoch number
    """
    params: dict[str, Any] = {"format": format}
    if model:
        params["model"] = model
    if sample:
        params["sample"] = sample
    if epoch:
        params["epoch"] = epoch
    if format == "toon":
        return await _request_text("GET", f"/trailrun/{trailrun_id}/results", params=params)
    return await _request("GET", f"/trailrun/{trailrun_id}/results", params=params)


@mcp.tool
async def trailhead_status(trailrun_id: str) -> dict[str, Any]:
    """Check current state of a trailrun.

    Args:
        trailrun_id: ID from trailhead_create
    """
    return await _request("GET", f"/trailrun/{trailrun_id}")


@mcp.tool
async def trailhead_cancel(trailrun_id: str) -> dict[str, Any]:
    """Cancel a running experiment.

    Args:
        trailrun_id: ID from trailhead_create
    """
    return await _request("POST", f"/trailrun/{trailrun_id}/cancel")


@mcp.tool
async def trailhead_list(
    limit: int = 20,
    include_config: bool = False,
) -> dict[str, Any]:
    """List recent trailruns.

    Use this to see what experiments have been run before and avoid repeating past work.
    Returns trailruns sorted by creation date (newest first).

    Args:
        limit: Max number to return (default 20, max 100)
        include_config: Include experiment config (models, prompts, n) - more verbose
    """
    params = {"limit": limit, "include_config": include_config}
    return await _request("GET", "/trailruns/list", params=params)


if __name__ == "__main__":
    mcp.run()
