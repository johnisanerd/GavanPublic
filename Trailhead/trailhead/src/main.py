"""FastAPI application with Slack Bolt integration."""

import logging
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from slack_bolt.adapter.fastapi.async_handler import AsyncSlackRequestHandler

from src.config import settings
from src.endpoints import (
    dashboard_router,
    data_inspector_router,
    generate_run_summarize_router,
    health_router,
    ranger_list_router,
    ranger_run_router,
    trailrun_routers,
    trailruns_list_router,
)
from src.logging_config import setup_logging
from src.mcp_server import mcp
from src.slack.app import app as slack_app
from src.trailrun.hooks import setup_default_hooks

# Initialize logging first
setup_logging()
logger = logging.getLogger(__name__)

# Create MCP HTTP app first (needed for lifespan)
mcp_app = mcp.http_app(path="/mcp")

# Initialize FastAPI with MCP lifespan for proper session management
app = FastAPI(
    title="Trailhead",
    description="Experimental Slack interface for LLM experiment results",
    version="0.1.0",
    lifespan=mcp_app.lifespan,
)

# Initialize Slack request handler
slack_handler = AsyncSlackRequestHandler(slack_app)

# Ensure default hooks are registered
setup_default_hooks()


@app.middleware("http")
async def check_non_slack_access(request: Request, call_next: Any):
    """Middleware to control access to API endpoints.

    When ACCEPT_NON_SLACK_REQUESTS is false, only whitelisted public endpoints
    are accessible. All other endpoints require the flag to be enabled.

    Whitelisted endpoints:
    - / (root)
    - /health (health check)
    - /docs, /openapi.json (API documentation)
    - /slack/events (has its own Bolt verification)
    - /data-inspector/* (public viewer bundles)
    - /trailruns (dashboard)
    - /trailrun/*/cancel (cancel operations)
    """
    # Whitelist of always-accessible endpoints
    public_paths = {"/", "/health", "/docs", "/openapi.json", "/slack/events", "/trailruns"}

    # Allow all /data-inspector paths (viewer bundles)
    if request.url.path.startswith("/data-inspector"):
        return await call_next(request)

    # Allow /trailrun paths (phase endpoints and dashboard operations)
    if request.url.path.startswith("/trailrun"):
        return await call_next(request)

    # Allow /mcp paths (MCP server)
    if request.url.path.startswith("/mcp"):
        return await call_next(request)

    # Allow /ranger paths (autonomous research agent - has own auth)
    if request.url.path.startswith("/ranger"):
        return await call_next(request)

    # Block non-public endpoints if non-Slack requests are not accepted
    if not settings.accept_non_slack_requests and request.url.path not in public_paths:
        raise HTTPException(
            status_code=403,
            detail="Direct API access disabled. Set ACCEPT_NON_SLACK_REQUESTS=true to enable.",
        )

    return await call_next(request)


# Include API routers (one endpoint per file)
app.include_router(health_router)
app.include_router(generate_run_summarize_router)
app.include_router(data_inspector_router)
app.include_router(dashboard_router)
app.include_router(trailruns_list_router)

# Ranger autonomous research agent
app.include_router(ranger_run_router)
app.include_router(ranger_list_router)

# Include all trailrun routers
for router in trailrun_routers:
    app.include_router(router)


@app.post("/slack/events")
async def slack_events(request: Request):
    """Handle Slack events and slash commands.

    Args:
        request: The incoming FastAPI request from Slack

    Returns:
        Response from the Slack handler
    """
    return await slack_handler.handle(request)


# Mount static files for Inspect viewer bundles
# Must be mounted AFTER the /data-inspector/{trailrun_id} route
# Create directory if it doesn't exist
Path(settings.inspect_bundle_dir).mkdir(parents=True, exist_ok=True)
app.mount(
    "/data-inspector", StaticFiles(directory=settings.inspect_bundle_dir), name="data-inspector"
)

# Log startup info for bundles
bundle_count = len([d for d in Path(settings.inspect_bundle_dir).iterdir() if d.is_dir()])
if bundle_count:
    logger.info(f"Found {bundle_count} bundle(s) in {settings.inspect_bundle_dir}")
else:
    logger.info("No existing bundles found")

# Mount MCP server for HTTP transport (cloud deployment)
# Also works standalone via: fastmcp run src/mcp_server.py:mcp (stdio)
app.mount("", mcp_app)
