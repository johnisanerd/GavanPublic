"""Core trailrun execution logic without Slack dependencies."""

import glob
import logging
import os
from collections.abc import Callable
from dataclasses import dataclass, field

from inspect_ai.model import ChatMessage

logger = logging.getLogger(__name__)

from src.config import settings
from src.orchestration.parsers import MessageContext, parse_inspect_eval
from src.runner.subprocess_runner import run_experiment_subprocess
from src.runner.types import ExperimentConfig, ExperimentResult


@dataclass
class ResearchResult:
    """Result of experiment execution and parsing."""

    experiment_result: ExperimentResult
    research_content: str
    models: list[str]
    samples_included: int
    samples_total: int
    # For citation extraction
    messages: list[ChatMessage] = field(default_factory=list)
    eval_files: list[str] = field(default_factory=list)
    # For deep links: message_id -> sample/turn context
    message_context: dict[str, MessageContext] = field(default_factory=dict)


async def run_and_parse(
    config: ExperimentConfig,
    on_progress: Callable[[str, str], None] | None = None,
) -> ResearchResult:
    """Run experiment and parse results without Slack dependencies.

    This is the core execution logic extracted from the orchestrator.
    It runs the experiment subprocess, parses .eval files, and returns
    the research content for downstream summarization.

    Args:
        config: Experiment configuration
        on_progress: Optional callback for progress updates.
                     Called with (phase: str, detail: str)

    Returns:
        ResearchResult with experiment output and parsed content

    Raises:
        ValueError: If experiment or parsing fails
    """
    # Run the experiment
    if on_progress:
        on_progress("run", "Running experiment...")

    experiment_result = await run_experiment_subprocess(config)

    if not experiment_result.success:
        raise ValueError("Experiment failed")

    logger.info(f"Experiment complete: {experiment_result.experiment_name}")

    # Find all .eval files
    eval_files = glob.glob(os.path.join(experiment_result.log_dir, "**/*.eval"), recursive=True)
    if not eval_files:
        raise ValueError(f"No .eval file found in {experiment_result.log_dir}")

    logger.info(f"Found {len(eval_files)} .eval file(s)")

    # Parse .eval files with proportional budget
    max_chars = settings.max_research_tokens * 4
    chars_per_model = max_chars // len(eval_files)

    parse_results = []
    for idx, eval_file_path in enumerate(eval_files, start=1):
        if on_progress:
            on_progress("parse", f"Parsing results ({idx}/{len(eval_files)})...")

        try:
            logger.debug(f"Parsing {idx}/{len(eval_files)}: {eval_file_path}")
            parse_result = await parse_inspect_eval(eval_file_path, max_chars=chars_per_model)
            parse_results.append(parse_result)
        except Exception as e:
            logger.warning(f"Failed to parse {eval_file_path}: {e}")
            parse_results.append(None)

    # Check for valid results
    valid_results = [r for r in parse_results if r is not None]
    if not valid_results:
        raise ValueError("Failed to parse all .eval files")

    # Collect metadata
    models = [r.model_name for r in valid_results]
    total_samples_included = sum(r.included_samples for r in valid_results)
    total_samples_total = sum(r.total_samples for r in valid_results)

    # Collect messages and context for citation extraction
    all_messages: list[ChatMessage] = []
    all_message_context: dict[str, MessageContext] = {}
    for r in valid_results:
        if r.messages:
            all_messages.extend(r.messages)
        if r.message_context:
            all_message_context.update(r.message_context)

    # Combine content with separators
    separator = "\n\n" + "=" * 80 + "\n\n"
    content = separator.join(r.content for r in valid_results)

    return ResearchResult(
        experiment_result=experiment_result,
        research_content=content,
        models=models,
        samples_included=total_samples_included,
        samples_total=total_samples_total,
        messages=all_messages,
        eval_files=eval_files,
        message_context=all_message_context,
    )
