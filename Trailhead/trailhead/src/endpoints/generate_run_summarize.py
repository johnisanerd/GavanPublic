"""POST /generate-run-summarize - Full end-to-end experiment pipeline."""

import logging
from typing import Any, Literal

from fastapi import APIRouter, HTTPException

from src.config import settings

logger = logging.getLogger(__name__)
from src.trailrun.phases import design_trailrun, run_trailrun, summarize_trailrun
from src.trailrun.state import create_trailrun, get_trailrun, update_trailrun
from src.trailrun.types import TrailrunSource

router = APIRouter()


@router.post("/generate-run-summarize")
async def generate_run_summarize(
    description: str,
    format: Literal["markdown", "slack"] = "markdown",
) -> dict[str, Any]:
    """Full end-to-end flow: generate config, run experiment, summarize results.

    Takes a natural language description and executes the complete pipeline:
    1. Generate ExperimentConfig from description (using model repository)
    2. Run the experiment and parse results
    3. Generate summary (markdown or Slack Block Kit)

    Uses trailrun tracking for status and dashboard visibility.

    Args:
        description: Natural language description of the experiment
        format: Output format - "markdown" (default) or "slack" for Block Kit

    Returns:
        Dict with trailrun_id, experiment results, summary/blocks, and viewer URL

    Raises:
        HTTPException: If any step fails
    """
    # Create trailrun for tracking
    trailrun = create_trailrun(source=TrailrunSource.API)
    trailrun_id = trailrun.id

    try:
        # Step 1: Design phase - generate config
        logger.info(f"[{trailrun_id}] Generating config for: {description}")
        config = await design_trailrun(trailrun_id, description)
        logger.info(f"[{trailrun_id}] Generated config: {config.title}")

        # Step 2: Run phase - execute experiment
        logger.info(f"[{trailrun_id}] Running experiment...")
        result = await run_trailrun(trailrun_id)
        logger.info(
            f"[{trailrun_id}] Experiment complete: {result.experiment_result.experiment_name}"
        )

        # Step 3: Summarize phase - extract highlights + generate summary + bundle
        logger.info(f"[{trailrun_id}] Summarizing ({format})...")
        summary_result = await summarize_trailrun(trailrun_id, format=format)

        # Get final trailrun state for response
        final_trailrun = get_trailrun(trailrun_id)
        if not final_trailrun:
            raise HTTPException(status_code=500, detail="Trailrun disappeared")

        bundle_url = (
            f"{settings.app_base_url}/data-inspector/{trailrun_id}"
            if final_trailrun.static_inspect_viewer_path
            else None
        )
        logger.info(f"[{trailrun_id}] Complete! View at: {bundle_url}")

        # Build response
        base_response = {
            "trailrun_id": trailrun_id,
            "experiment_name": result.experiment_result.experiment_name,
            "status": "completed",
            "config": config.model_dump(),
            "models": result.models,
            "samples_included": result.samples_included,
            "samples_total": result.samples_total,
            "viewer_url": bundle_url,
        }

        if format == "slack":
            return {**base_response, "blocks": summary_result.blocks}
        else:
            return {**base_response, "summary": summary_result}

    except HTTPException:
        await update_trailrun(trailrun_id, status="failed", error="Pipeline failed")
        raise

    except Exception as e:
        await update_trailrun(trailrun_id, status="failed", error=str(e))
        raise HTTPException(status_code=500, detail=f"Experiment failed: {e}") from e
