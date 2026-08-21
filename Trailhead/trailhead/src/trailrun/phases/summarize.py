"""Summarize phase: Generate summary from experiment results."""

import asyncio
import logging
from pathlib import Path
from typing import Any, Literal

from src.config import settings

logger = logging.getLogger(__name__)
from src.orchestration.analysis.summarizers import SummarizerOptions, get_summarizer
from src.trailrun.highlights import extract_highlights_for_trailrun
from src.trailrun.state import emit_progress, get_trailrun, update_trailrun
from src.trailrun.types import Phase


async def summarize_trailrun(
    trailrun_id: str,
    format: Literal["slack", "markdown"] = "slack",
) -> Any:
    """Generate summary from results. Requires result from run phase.

    Includes:
    - Highlight extraction with citations
    - Summary generation in requested format
    - Viewer bundle generation

    Args:
        trailrun_id: ID of the trailrun to summarize
        format: Output format ("slack" for Block Kit, "markdown" for text)

    Returns:
        Summary result (SummarizerResponse for slack, str for markdown)

    Raises:
        KeyError: If trailrun not found
        ValueError: If results are missing
    """
    trailrun = get_trailrun(trailrun_id)
    if not trailrun:
        raise KeyError(f"Trailrun not found: {trailrun_id}")

    if not trailrun.result:
        raise ValueError(f"Trailrun {trailrun_id} has no result - run phase first")

    if not trailrun.research_content:
        raise ValueError(f"Trailrun {trailrun_id} has no research content")

    if not trailrun.config:
        raise ValueError(f"Trailrun {trailrun_id} has no config")

    # Update phase
    await update_trailrun(trailrun_id, phase=Phase.REPORT, status="summarizing")

    # Extract highlights if we have stored messages
    highlights = None
    if trailrun.messages:
        await emit_progress(trailrun_id, "Extracting highlights...")
        highlights = await extract_highlights_for_trailrun(trailrun)

    # Generate summary
    await emit_progress(trailrun_id, "Generating summary...")

    summarizer = get_summarizer(format)

    # Get models from stored metadata (populated by run phase)
    models = trailrun.models or [trailrun.result.experiment_name]

    summary_result = await summarizer(
        research_content=trailrun.research_content,
        model=settings.utility_model,
        timeout=settings.timeout_s,
        options=SummarizerOptions(
            research_type="inspect_eval",
            models=models,
            highlights=highlights,
            samples_included=trailrun.samples_included,
            samples_total=trailrun.samples_total,
        ),
    )

    # Generate viewer bundle
    await emit_progress(trailrun_id, "Generating data explorer...")
    bundle_path = await _generate_viewer_bundle(trailrun_id, trailrun.result.log_dir)

    # Store summary - this emits SUMMARY_READY then COMPLETED
    # Slack format returns SummarizerResponse (has model_dump), markdown returns str
    if hasattr(summary_result, "model_dump"):
        summary_data = summary_result.model_dump(mode="json")
    elif isinstance(summary_result, str):
        summary_data = {"markdown": summary_result}
    else:
        summary_data = {"raw": summary_result}
    await update_trailrun(
        trailrun_id,
        summary=summary_data,
        static_inspect_viewer_path=bundle_path,
        status="completed",
    )

    return summary_result


async def _generate_viewer_bundle(trailrun_id: str, log_dir: str) -> str | None:
    """Generate static Inspect viewer bundle.

    Args:
        trailrun_id: Trailrun ID for bundle path
        log_dir: Directory containing .eval files

    Returns:
        Path to bundle directory if successful, None if failed
    """
    bundle_dir = Path(settings.inspect_bundle_dir) / trailrun_id

    try:
        Path(settings.inspect_bundle_dir).mkdir(parents=True, exist_ok=True)

        process = await asyncio.create_subprocess_exec(
            "inspect",
            "view",
            "bundle",
            "--log-dir",
            log_dir,
            "--output-dir",
            str(bundle_dir),
            "--overwrite",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        _, stderr = await process.communicate()

        if process.returncode == 0:
            logger.info(f"[{trailrun_id}] Bundle generated at {bundle_dir}")
            return str(bundle_dir)
        else:
            error_msg = stderr.decode() if stderr else "Unknown error"
            logger.warning(f"[{trailrun_id}] Bundle generation failed: {error_msg}")
            return None

    except Exception as e:
        logger.error(f"[{trailrun_id}] Bundle generation error: {e}")
        return None
