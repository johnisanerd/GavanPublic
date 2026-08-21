"""POST /trailrun/{id}/cancel - Cancel a running trailrun."""

from typing import Any

from fastapi import APIRouter, HTTPException

from src.trailrun import cancel_trailrun, get_trailrun
from src.trailrun.state import update_trailrun

router = APIRouter()


@router.post("/trailrun/{trailrun_id}/cancel")
async def cancel_trailrun_endpoint(trailrun_id: str) -> dict[str, Any]:
    """Cancel a running trailrun.

    Args:
        trailrun_id: Trailrun ID to cancel

    Returns:
        Status of the cancellation

    Raises:
        HTTPException: If trailrun not found or not cancellable
    """
    trailrun = get_trailrun(trailrun_id)
    if not trailrun:
        raise HTTPException(status_code=404, detail=f"Trailrun not found: {trailrun_id}")

    cancelled = cancel_trailrun(trailrun_id)
    if cancelled:
        # Use async update_trailrun to emit CANCELLED event
        await update_trailrun(trailrun_id, status="cancelled", error="Cancelled by user")
        return {"status": "cancelled", "trailrun_id": trailrun_id}
    else:
        raise HTTPException(status_code=400, detail="Trailrun not active or already completed")
