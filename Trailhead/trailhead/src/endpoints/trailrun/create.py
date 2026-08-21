"""POST /trailrun - Create a new trailrun."""

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from src.trailrun.state import create_trailrun, get_trailrun
from src.trailrun.types import TrailrunSource

router = APIRouter()


class CreateTrailrunRequest(BaseModel):
    """Request body for creating a trailrun."""

    source: TrailrunSource = TrailrunSource.API
    clone_from: str | None = None  # Optional trailrun_id to clone config from
    ranger_id: str | None = None  # Ranger session ID (only when source == RANGER)
    channel_id: str | None = None  # Slack channel ID (for RANGER source with Slack)
    thread_ts: str | None = None  # Slack thread timestamp (for RANGER source with Slack)


@router.post("/trailrun")
async def create_trailrun_endpoint(request: CreateTrailrunRequest) -> dict[str, Any]:
    """Create a new trailrun. Optionally clone ExperimentConfig from existing trailrun.

    Args:
        request: CreateTrailrunRequest with source and optional clone_from

    Returns:
        Dict with trailrun_id and cloned_from if applicable
    """
    config = None
    if request.clone_from:
        existing = get_trailrun(request.clone_from)
        if not existing:
            raise HTTPException(status_code=404, detail=f"Trailrun not found: {request.clone_from}")
        config = existing.config

    trailrun = create_trailrun(
        source=request.source,
        config=config,
        ranger_id=request.ranger_id,
        channel_id=request.channel_id,
        thread_ts=request.thread_ts,
    )
    return {
        "trailrun_id": trailrun.id,
        "cloned_from": request.clone_from,
        "has_config": config is not None,
    }
