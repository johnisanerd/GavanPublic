"""GET /trailrun/{id} - Get trailrun status and details."""

from typing import Any

from fastapi import APIRouter, HTTPException

from src.trailrun.state import get_trailrun

router = APIRouter()


@router.get("/trailrun/{trailrun_id}")
async def get_trailrun_endpoint(trailrun_id: str) -> dict[str, Any]:
    """Get current status and details of a trailrun.

    Args:
        trailrun_id: Trailrun ID

    Returns:
        Dict with trailrun details including status, phase, config, etc.
    """
    trailrun = get_trailrun(trailrun_id)
    if not trailrun:
        raise HTTPException(status_code=404, detail=f"Trailrun not found: {trailrun_id}")

    return {
        "trailrun_id": trailrun.id,
        "status": trailrun.status,
        "phase": trailrun.phase.value,
        "source": trailrun.source.value,
        "has_config": trailrun.config is not None,
        "has_result": trailrun.result is not None,
        "has_summary": trailrun.summary is not None,
        "created_at": trailrun.created_at.isoformat(),
        "updated_at": trailrun.updated_at.isoformat(),
        "error": trailrun.error,
        "title": trailrun.config.title if trailrun.config else None,
    }
