"""CLI for testing highlight extraction from eval files.

Usage:
    uv run python -m src.cli.highlight <eval_file_or_url> [options]

Options:
    --model MODEL      Model to use for extraction
    --title TITLE      Experiment title for focused highlight extraction
    --prompt PROMPT    Experiment prompt (can be repeated)

Example:
    uv run python -m src.cli.highlight ./logs/experiment.eval
    uv run python -m src.cli.highlight ./logs/experiment.eval \\
        --title "Safety test" --prompt "Tell me how to..."
"""

import argparse
import asyncio
import logging
import os
import sys
from functools import partial

from src.config import settings
from src.logging_config import setup_logging

setup_logging()
logger = logging.getLogger(__name__)
from src.orchestration.analysis.highlighter import (
    ExperimentContext,
    build_inspect_deep_link,
    extract_highlights,
)
from src.orchestration.parsers import parse_inspect_eval


async def main() -> None:
    parser = argparse.ArgumentParser(description="Extract highlights from eval files")
    parser.add_argument("source", help="Path or URL to .eval file")
    parser.add_argument("--model", default=None, help="Model to use (default: utility_model)")
    parser.add_argument("--title", default=None, help="Experiment title for context")
    parser.add_argument(
        "--prompt",
        action="append",
        dest="prompts",
        default=None,
        help="Experiment prompt (can be specified multiple times)",
    )

    args = parser.parse_args()

    logger.info(f"Loading eval file: {args.source}")

    # Parse eval file (character budget is the limit, not sample count)
    parse_result = await parse_inspect_eval(args.source)

    logger.info(f"Model: {parse_result.model_name}")
    logger.info(f"Samples: {parse_result.included_samples}/{parse_result.total_samples}")
    logger.info(f"Messages: {len(parse_result.messages or [])}")

    if not parse_result.messages:
        logger.error("No messages found in eval file")
        sys.exit(1)

    # Build link callback for Inspect viewer deep links
    eval_filename = os.path.basename(args.source)
    viewer_base_url = f"{settings.app_base_url}/data-inspector/cli/index.html"
    build_link = partial(
        build_inspect_deep_link,
        viewer_base_url,
        eval_filename,
    )

    # Build experiment context if provided
    experiment_context = None
    if args.title or args.prompts:
        experiment_context = ExperimentContext(
            title=args.title or "Untitled experiment",
            prompts=args.prompts or [],
        )
        logger.info(f"Experiment: {experiment_context.title}")
        if experiment_context.prompts:
            logger.info(f"Prompts: {len(experiment_context.prompts)}")

    # Extract highlights
    model_display = args.model or settings.utility_model
    logger.info(f"Extracting highlights with {model_display}...")
    highlights = await extract_highlights(
        messages=parse_result.messages,
        model=args.model,
        build_link=build_link,
        experiment_context=experiment_context,
    )

    # Output results
    print("\n" + "=" * 60)
    print("HIGHLIGHTS")
    print("=" * 60)
    for h in highlights:
        quote = h.quoted_text or "(no quote)"
        print(f"[{h.index}] {h.description}")
        print(f'    "{quote[:100]}{"..." if len(quote) > 100 else ""}"')
        if h.deep_link:
            print(f"    🔗 {h.deep_link}")
        print()

    print("=" * 60)
    print(f"Total highlights: {len(highlights)}")


if __name__ == "__main__":
    asyncio.run(main())
