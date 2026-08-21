"""GET /ranger/list - List past Ranger sessions."""

from fastapi import APIRouter, Query
from pydantic import BaseModel

from src.ranger.store import list_rangers
from src.ranger.types import RangerSession

router = APIRouter(tags=["ranger"])


class RangerListItem(BaseModel):
    """Summary of a ranger session for list response."""

    id: str
    date: str
    mode: str
    status: str
    trailrun_count: int
    created_at: str
    completed_at: str | None


class RangerListResponse(BaseModel):
    """Response for listing ranger sessions."""

    rangers: list[RangerListItem]
    count: int


def _to_list_item(ranger: RangerSession) -> RangerListItem:
    """Convert RangerSession to list item."""
    return RangerListItem(
        id=ranger.id,
        date=ranger.date,
        mode=ranger.mode.value,
        status=ranger.status.value,
        trailrun_count=len(ranger.trailrun_ids),
        created_at=ranger.created_at.isoformat(),
        completed_at=ranger.completed_at.isoformat() if ranger.completed_at else None,
    )


@router.get("/ranger/list", response_model=RangerListResponse)
async def ranger_list(
    limit: int = Query(default=20, ge=1, le=100, description="Max results to return"),
) -> RangerListResponse:
    """List past Ranger sessions.

    Returns sessions sorted by creation date (newest first).
    """
    rangers = list_rangers(limit=limit)
    items = [_to_list_item(r) for r in rangers]

    return RangerListResponse(
        rangers=items,
        count=len(items),
    )
