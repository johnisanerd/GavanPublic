"""Experiment runner for LLM evaluations.

This module runs experiments using Inspect AI's eval framework.
"""

import asyncio
import logging
import os

from inspect_ai import Task, eval_set, task

logger = logging.getLogger(__name__)
from inspect_ai.dataset import MemoryDataset, Sample
from inspect_ai.solver import generate

from src.config import settings
from src.runner.types import ExperimentConfig, ExperimentResult


@task
def create_experiment_task(prompts: list[str], n: int):
    """Create an Inspect AI task from prompts."""
    samples = [Sample(input=prompt) for prompt in prompts]
    return Task(dataset=MemoryDataset(samples), solver=generate(), epochs=n)


def find_available_log_dir(base_name: str) -> str:
    """Find an available log directory by appending a number if needed."""
    base_path = os.path.join(settings.runner_log_dir, base_name)
    if not os.path.exists(base_path):
        return base_path

    n = 2
    while os.path.exists(f"{base_path}-{n}"):
        n += 1
    return f"{base_path}-{n}"


async def run_experiment_from_config(config: ExperimentConfig) -> ExperimentResult:
    """Run an experiment from configuration.

    Args:
        config: Experiment configuration (prompts, models, repetitions)

    Returns:
        ExperimentResult with experiment name, log directory, and success status

    Raises:
        asyncio.CancelledError: If the experiment is cancelled mid-execution
    """
    # Sanitize title to create filesystem-safe experiment name
    raw_name = config.title.lower().strip()
    experiment_name = "".join(c if c.isalnum() or c == "-" else "-" for c in raw_name)
    experiment_name = "-".join(filter(None, experiment_name.split("-")))
    log_dir = find_available_log_dir(experiment_name)
    os.makedirs(log_dir, exist_ok=True)

    logger.info(f"Experiment: {experiment_name}")
    logger.info(f"Log directory: {log_dir}")

    # Create the task
    task_instance = create_experiment_task(config.prompts, config.n)

    # Prefix model names with openrouter/ for Inspect AI to route through OpenRouter
    inspect_models = [f"openrouter/{m}" for m in config.models]

    # Run the evaluation in a thread to avoid asyncio.run() conflicts
    # eval_set() is synchronous and uses asyncio.run() internally,
    # which conflicts with FastAPI's async context
    #
    # NOTE: If cancelled, the thread will continue running in background
    # until Inspect naturally completes. We can't forcibly stop threads in Python.
    # For true cancellation, we'd need to run Inspect as a subprocess.
    try:
        success, _logs = await asyncio.to_thread(
            eval_set, tasks=[task_instance], model=inspect_models, log_dir=log_dir
        )
    except asyncio.CancelledError:
        logger.info(f"Experiment {experiment_name} cancelled - thread will finish in background")
        raise

    return ExperimentResult(experiment_name=experiment_name, log_dir=log_dir, success=success)
