"""POST /trailrun/{id}/summarize - Generate summary from results."""

from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from src.trailrun.phases import summarize_trailrun

router = APIRouter()


class SummarizeRequest(BaseModel):
    """Request body for summarize phase."""

    format: Literal["slack", "markdown"] = "markdown"


@router.post("/trailrun/{trailrun_id}/summarize")
async def summarize_endpoint(trailrun_id: str, request: SummarizeRequest) -> dict[str, Any]:
    """Generate summary from results. Requires result from run phase.

    Args:
        trailrun_id: Trailrun ID
        request: SummarizeRequest with format

    Returns:
        Dict with summary (format depends on request.format)
    """
    try:
        summary = await summarize_trailrun(trailrun_id, request.format)
        if request.format == "slack":
            return {"blocks": summary.blocks}
        else:
            return {"summary": summary}
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
