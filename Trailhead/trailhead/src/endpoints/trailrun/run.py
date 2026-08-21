"""POST /trailrun/{id}/run - Execute experiment."""

import asyncio
from typing import Any

from fastapi import APIRouter, HTTPException

from src.config import settings
from src.trailrun.phases import run_trailrun
from src.trailrun.state import get_trailrun

router = APIRouter()


@router.post("/trailrun/{trailrun_id}/run")
async def run_endpoint(trailrun_id: str) -> dict[str, Any]:
    """Execute experiment. Requires config from design phase.

    Blocks until experiment completes (typically 30-120 seconds, max 10 minutes).
    """
    trailrun = get_trailrun(trailrun_id)
    if not trailrun:
        raise HTTPException(status_code=404, detail=f"Trailrun not found: {trailrun_id}")
    if not trailrun.config:
        raise HTTPException(status_code=400, detail="Trailrun has no config - run design first")

    timeout = settings.run_timeout_seconds
    try:
        result = await asyncio.wait_for(run_trailrun(trailrun_id), timeout=timeout)
        return {
            "experiment_name": result.experiment_result.experiment_name,
            "log_dir": result.experiment_result.log_dir,
            "models": result.models,
            "samples_included": result.samples_included,
            "samples_total": result.samples_total,
        }
    except TimeoutError:
        raise HTTPException(
            status_code=504, detail=f"Experiment timed out after {timeout // 60} minutes"
        ) from None
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
