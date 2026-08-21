"""GET /trailruns/list - List recent trailruns with optional config details."""

from typing import Any

from fastapi import APIRouter, Query

from src.trailrun import list_trailruns

router = APIRouter()


@router.get("/trailruns/list")
async def trailruns_list(
    limit: int = Query(default=20, ge=1, le=100, description="Max number of trailruns to return"),
    include_config: bool = Query(default=False, description="Include experiment config details"),
) -> dict[str, Any]:
    """List recent trailruns, sorted by created_at (newest first).

    Default response includes: trailrun_id, title, status, created_at
    With include_config=True, also includes: models, prompts, n
    """
    trailruns = list_trailruns()

    # Sort by created_at descending (newest first)
    sorted_trailruns = sorted(trailruns, key=lambda t: t.created_at, reverse=True)

    # Apply limit
    limited = sorted_trailruns[:limit]

    items = []
    for tr in limited:
        item: dict[str, Any] = {
            "trailrun_id": tr.id,
            "title": tr.config.title if tr.config else None,
            "status": tr.status,
            "created_at": tr.created_at.isoformat(),
        }

        if include_config and tr.config:
            item["models"] = tr.config.models
            item["prompts"] = tr.config.prompts
            item["n"] = tr.config.n

        items.append(item)

    return {
        "trailruns": items,
        "count": len(items),
        "total": len(trailruns),
    }
