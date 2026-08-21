"""GET /trailrun/{id}/results - Get experiment results."""

from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query, Response
from toon_format import encode as toon_encode

from src.config import settings
from src.trailrun.state import get_trailrun

router = APIRouter()


def _extract_content(message: dict[str, Any]) -> str:
    """Extract text content from a message dict."""
    content = message.get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        # Content is list of content parts - extract text
        parts = []
        for item in content:
            if isinstance(item, dict) and "text" in item:
                parts.append(item["text"])
            elif isinstance(item, str):
                parts.append(item)
        return " ".join(parts)
    return str(content)


@router.get("/trailrun/{trailrun_id}/results")
async def get_trailrun_results(
    trailrun_id: str,
    format: Literal["json", "toon"] = Query(default="json", description="Output format"),
    schema: Literal["simple_flat"] = Query(default="simple_flat", description="Response schema"),
    model: str | None = Query(default=None, description="Filter by model"),
    sample: str | None = Query(default=None, description="Filter by sample ID"),
    epoch: int | None = Query(default=None, description="Filter by epoch"),
) -> Any:
    """Get experiment results with optional filtering.

    Args:
        trailrun_id: Trailrun ID
        format: Output format (json or toon)
        schema: Response schema (simple_flat only for now)
        model: Filter by model ID
        sample: Filter by sample ID
        epoch: Filter by epoch number

    Returns:
        Results in requested format with applied filters
    """
    trailrun = get_trailrun(trailrun_id)
    if not trailrun:
        raise HTTPException(status_code=404, detail=f"Trailrun not found: {trailrun_id}")

    if not trailrun.messages or not trailrun.message_context:
        raise HTTPException(
            status_code=400, detail="Results not available - experiment may not have completed"
        )

    # Build flat results list: model, sample, epoch, turn, role, content
    results = []
    for msg in trailrun.messages:
        msg_id = msg.get("id")
        if not msg_id or msg_id not in trailrun.message_context:
            continue

        ctx = trailrun.message_context[msg_id]

        # Apply filters
        if model and ctx.get("model") != model:
            continue
        if sample and ctx.get("sample_id") != sample:
            continue
        if epoch and ctx.get("epoch") != epoch:
            continue

        results.append(
            {
                "model": ctx.get("model"),
                "sample": ctx.get("sample_id"),
                "epoch": ctx.get("epoch"),
                "turn": ctx.get("turn"),
                "role": msg.get("role"),
                "content": _extract_content(msg),
            }
        )

    # Sort by model, sample, epoch, turn
    results.sort(
        key=lambda r: (r["model"] or "", r["sample"] or "", r["epoch"] or 0, r["turn"] or 0)
    )

    # Build response
    viewer_url = None
    if trailrun.static_inspect_viewer_path:
        viewer_url = f"{settings.app_base_url}/data-inspector/{trailrun_id}"

    response_data = {
        "trailrun_id": trailrun.id,
        "status": trailrun.status,
        "experiment": {
            "title": trailrun.config.title if trailrun.config else None,
            "prompts": trailrun.config.prompts if trailrun.config else [],
            "models": trailrun.config.models if trailrun.config else [],
            "n": trailrun.config.n if trailrun.config else None,
        },
        "execution": {
            "samples_total": trailrun.samples_total,
            "samples_included": trailrun.samples_included,
        },
        "viewer_url": viewer_url,
        "filters": {
            "model": model,
            "sample": sample,
            "epoch": epoch,
        },
        "schema": schema,
        "results": results,
    }

    if format == "toon":
        # Return toon-encoded response
        toon_output = toon_encode(response_data)
        return Response(content=toon_output, media_type="text/plain")

    return response_data
