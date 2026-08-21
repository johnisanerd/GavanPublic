"""Subprocess-based runner for cancellable Inspect evaluations."""

import asyncio
import logging
import os
import sys
import tempfile
from pathlib import Path

from src.runner.runner import find_available_log_dir
from src.runner.types import ExperimentConfig, ExperimentResult

logger = logging.getLogger(__name__)


async def run_experiment_subprocess(config: ExperimentConfig) -> ExperimentResult:
    """Run experiment in a subprocess that can be killed on cancellation.

    Args:
        config: Experiment configuration

    Returns:
        ExperimentResult

    Raises:
        asyncio.CancelledError: If cancelled - subprocess is killed
    """
    # Sanitize title to create filesystem-safe experiment name
    raw_name = config.title.lower().strip()
    experiment_name = "".join(c if c.isalnum() or c == "-" else "-" for c in raw_name)
    experiment_name = "-".join(filter(None, experiment_name.split("-")))
    log_dir = find_available_log_dir(experiment_name)
    os.makedirs(log_dir, exist_ok=True)
    logger.info(f"Starting experiment: {experiment_name}")
    logger.info(f"Log directory: {log_dir}")

    # Write config to temp file
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        f.write(config.model_dump_json())
        config_path = f.name

    try:
        # Run as subprocess - inherit stdout/stderr to see Inspect progress
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            "src.runner.subprocess_worker",
            config_path,
            log_dir,
            stdout=None,  # Inherit - shows in parent process
            stderr=None,  # Inherit - shows in parent process
        )

        try:
            await process.wait()
        except asyncio.CancelledError:
            logger.info(f"Experiment {experiment_name} cancelled - killing subprocess")
            process.kill()
            await process.wait()
            raise

        success = process.returncode == 0

        if not success:
            logger.error(f"Experiment failed with return code {process.returncode}")

        return ExperimentResult(experiment_name=experiment_name, log_dir=log_dir, success=success)

    finally:
        # Clean up temp file
        Path(config_path).unlink(missing_ok=True)
