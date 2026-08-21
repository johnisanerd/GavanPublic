"""Summarizer CLI and API handler."""

import argparse
import asyncio
import json
import logging
import sys
from pathlib import Path
from typing import Any

from src.config import settings
from src.logging_config import setup_logging

setup_logging()
logger = logging.getLogger(__name__)
from src.orchestration.analysis.summarizers import (
    SummarizerOptions,
    get_summarizer,
    list_formats,
)
from src.utils.sanitize import sanitize_block_kit_response


async def summarize_file(
    file_path: str,
    format_type: str = "slack",
    research_type: str = "generic_log",
) -> Any:
    """Summarize a research file using specified format.

    Args:
        file_path: Path to the research file to summarize
        format_type: Output format ("slack", "prose", "bullets")
        research_type: Type of research ("inspect_eval", "generic_log")

    Returns:
        Summarized output (type depends on format)

    Raises:
        FileNotFoundError: If the file doesn't exist
        ValueError: If summarization fails
    """
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"Research file not found: {file_path}")

    research_content = path.read_text(encoding="utf-8")

    # Get the appropriate summarizer
    summarizer = get_summarizer(format_type)

    # Create options with research type
    options = SummarizerOptions(research_type=research_type)  # type: ignore

    # Call summarizer (API key and rate limiting are internal)
    result = await summarizer(
        research_content=research_content,
        model=settings.utility_model,
        timeout=settings.timeout_s,
        options=options,
    )

    # Apply sanitization for Slack format
    if format_type == "slack":
        sanitized_data = sanitize_block_kit_response(result.model_dump(mode="json"))
        return sanitized_data

    return result


def main() -> None:
    """CLI entry point for the summarizer.

    Examples:
        uv run task summarize research/example.log
        uv run task summarize research/example.log -of prose -s
        uv run task summarize research/example.log -o results/summary.json
        uv run task summarize research/example.log -if inspect_eval -of bullets --save
    """
    parser = argparse.ArgumentParser(
        description="Summarize research in various formats",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    parser.add_argument(
        "research_file",
        help="Path to the research file to summarize",
    )

    parser.add_argument(
        "--input_format",
        "-if",
        dest="research_type",
        choices=["inspect_eval", "generic_log"],
        default=None,
        help="Input format/research type (default: infer from file extension)",
    )

    parser.add_argument(
        "--output_format",
        "-of",
        dest="output_format",
        choices=list_formats(),
        default="bullets",
        help="Output format: bullets, prose, slack (default: bullets)",
    )

    parser.add_argument(
        "--output",
        "-o",
        type=str,
        default=None,
        help="Output file path (default: stdout)",
    )

    parser.add_argument(
        "--save",
        "-s",
        action="store_true",
        help="Auto-save with generated filename (overwrites existing)",
    )

    args = parser.parse_args()

    try:
        # Infer research_type from file extension if not provided
        research_type = args.research_type
        if research_type is None:
            file_path = Path(args.research_file)
            ext = file_path.suffix

            if ext == ".eval":
                research_type = "inspect_eval"
            elif ext:
                # Has an extension, assume generic_log
                research_type = "generic_log"
            else:
                # No extension and no flag - error
                logger.error(
                    "Cannot infer research type from file without extension. "
                    "Please provide --research_type flag."
                )
                sys.exit(1)

        # Run async summarization
        result = asyncio.run(
            summarize_file(
                file_path=args.research_file,
                format_type=args.output_format,
                research_type=research_type,
            )
        )

        # Format output based on format type
        if args.output_format == "bullets":
            # Bullets format: already formatted markdown text from AI
            formatted_output = result
        elif args.output_format == "prose":
            # Prose format: output text
            formatted_output = result
        elif args.output_format == "slack":
            # Slack format: output JSON
            formatted_output = json.dumps(result, indent=2)
        else:
            formatted_output = str(result)

        # Determine output destination
        output_path = None
        if args.output:
            # Explicit output path takes precedence
            output_path = Path(args.output)
        elif args.save:
            # Auto-generate filename in summaries/ directory
            input_path = Path(args.research_file)
            ext = "json" if args.output_format == "slack" else "txt"
            summaries_dir = Path("summaries")
            summaries_dir.mkdir(exist_ok=True)
            output_path = summaries_dir / f"{input_path.stem}_summary.{ext}"

        # Write to file or stdout
        if output_path:
            output_path.write_text(formatted_output, encoding="utf-8")
            print(f"Summary written to {output_path}")
        else:
            print(formatted_output)

    except FileNotFoundError as e:
        logger.error(str(e))
        sys.exit(1)
    except ValueError as e:
        logger.error(str(e))
        sys.exit(1)
    except Exception as e:
        logger.error(f"Failed to summarize log: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
