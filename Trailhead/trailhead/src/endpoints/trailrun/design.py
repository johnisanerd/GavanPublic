"""POST /trailrun/{id}/design - Generate experiment config."""

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from src.trailrun.phases import design_trailrun

router = APIRouter()


class DesignRequest(BaseModel):
    """Request body for design phase."""

    description: str


@router.post("/trailrun/{trailrun_id}/design")
async def design_endpoint(trailrun_id: str, request: DesignRequest) -> dict[str, Any]:
    """Generate experiment config from description.

    Args:
        trailrun_id: Trailrun ID
        request: DesignRequest with description

    Returns:
        Dict with generated config
    """
    try:
        config = await design_trailrun(trailrun_id, request.description)
        return {"config": config.model_dump()}
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
