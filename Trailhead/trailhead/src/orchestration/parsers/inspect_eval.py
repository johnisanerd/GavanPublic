"""Parser for Inspect AI .eval files using the Inspect AI SDK.

This module provides functionality to parse .eval files (Inspect AI evaluation logs)
and extract structured data for summarization.
"""

import os
import random
from collections import defaultdict
from dataclasses import dataclass

from inspect_ai.log import EvalLog, EvalSample, read_eval_log
from inspect_ai.model import ChatMessage


@dataclass
class MessageContext:
    """Context about a message's position in the evaluation."""

    sample_id: str  # The sample ID (usually "1", "2", etc.)
    sample_number: int  # 1-indexed position in evaluation
    turn: int  # 1-indexed position in conversation
    epoch: int = 1  # The epoch (iteration) for this sample
    model: str | None = None  # Model ID (e.g., "openai/gpt-4o")
    eval_file: str | None = None  # Filename of the .eval file this message belongs to


@dataclass
class ParseResult:
    """Result from parsing an Inspect AI .eval file.

    Attributes:
        content: Formatted string with eval metadata and samples
        model_name: Name of the model evaluated
        total_samples: Total number of samples in the eval
        included_samples: Number of samples included in the content
        samples: The selected EvalSample objects (for citation support)
        messages: Flattened list of all messages from samples (for citation verification)
        message_context: Mapping from message_id to sample/turn info (for deep links)
    """

    content: str
    model_name: str
    total_samples: int
    included_samples: int
    samples: list[EvalSample] | None = None
    messages: list[ChatMessage] | None = None
    message_context: dict[str, MessageContext] | None = None


def flatten_messages_with_context(
    samples: list[EvalSample],
    model: str | None = None,
    eval_file: str | None = None,
) -> tuple[list[ChatMessage], dict[str, MessageContext]]:
    """Flatten messages from multiple samples, preserving sample/turn context.

    Args:
        samples: List of EvalSample objects
        model: Model ID (e.g., "openai/gpt-4o") for attribution
        eval_file: Filename of the .eval file these samples came from

    Returns:
        Tuple of:
        - All messages from all samples in order
        - Mapping from message_id to MessageContext (sample_id, sample_number, turn, model, eval_file)
    """
    messages: list[ChatMessage] = []
    context_map: dict[str, MessageContext] = {}

    for sample_idx, sample in enumerate(samples):
        if sample.messages:
            epoch = getattr(sample, "epoch", 1)  # Default to 1 if not present
            for turn_idx, msg in enumerate(sample.messages):
                messages.append(msg)
                if hasattr(msg, "id") and msg.id:
                    context_map[msg.id] = MessageContext(
                        sample_id=str(sample.id),
                        sample_number=sample_idx + 1,  # 1-indexed
                        turn=turn_idx + 1,  # 1-indexed
                        epoch=epoch,
                        model=model,
                        eval_file=eval_file,
                    )

    return messages, context_map


def flatten_messages(samples: list[EvalSample]) -> list[ChatMessage]:
    """Flatten messages from multiple samples into a single list.

    Args:
        samples: List of EvalSample objects

    Returns:
        All messages from all samples in order

    Note: Use flatten_messages_with_context if you need sample/turn info.
    """
    messages, _ = flatten_messages_with_context(samples)
    return messages


def format_eval_log_with_samples(
    log: EvalLog, samples: list[EvalSample], max_chars: int | None = None
) -> str:
    """Format an EvalLog with selected samples into a readable string.

    Args:
        log: The EvalLog object
        samples: List of samples to include
        max_chars: Maximum characters for output (for verification)

    Returns:
        Formatted string representation
    """
    # Format header
    header = f"""Inspect AI Evaluation Log

Run ID: {log.eval.run_id}
Task: {log.eval.task}
Model: {log.eval.model}
Status: {log.status}

Results:
- Total samples: {log.results.total_samples}
- Completed samples: {log.results.completed_samples}
- Samples in this summary: {len(samples)}

Scores:
{chr(10).join(f"- {score.name}: {score.metrics}" for score in log.results.scores)}

Stats:
- Started: {log.stats.started_at}
- Completed: {log.stats.completed_at}
- Model usage: {log.stats.model_usage}

--- Sample Details ---
"""

    # Format each sample (exclude transcript - it's 200x larger than useful data)
    sample_texts = []
    for sample in samples:
        # Format ALL messages for full conversation context
        messages_text = []
        for msg in sample.messages:
            role = msg.role

            # Extract clean text from content (avoid verbose ContentText repr)
            if isinstance(msg.content, list):
                # Content is list of ContentText objects - extract text only
                content_parts = []
                for item in msg.content:
                    if hasattr(item, "text"):
                        content_parts.append(item.text)
                    else:
                        content_parts.append(str(item))
                content = " ".join(content_parts)
            elif isinstance(msg.content, str):
                content = msg.content
            else:
                # Fallback to string representation
                content = str(msg.content)

            # Include tool call info if present
            if hasattr(msg, "tool_calls") and msg.tool_calls:
                tool_calls = []
                for tc in msg.tool_calls:
                    # Extract just function name and args, skip verbose fields
                    args_str = str(tc.arguments) if tc.arguments else ""
                    tool_calls.append(f"{tc.function}({args_str})")
                content = f"{content} [TOOLS: {', '.join(tool_calls)}]"

            # Add function name for tool results
            if hasattr(msg, "function") and msg.function:
                role = f"tool({msg.function})"

            messages_text.append(f"  [{role}]: {content}")

        # Include metadata
        metadata_parts = []
        if sample.model_usage:
            metadata_parts.append(f"Model usage: {sample.model_usage}")
        if sample.total_time:
            metadata_parts.append(f"Total time: {sample.total_time}s")
        if sample.error:
            metadata_parts.append(f"Error: {sample.error}")

        metadata_text = "\nMetadata: " + ", ".join(metadata_parts) if metadata_parts else ""

        sample_text = f"""
Sample {sample.id}:
Input: {sample.input}
Target: {sample.target}
Score: {sample.scores}{metadata_text}

Conversation ({len(sample.messages)} messages):
{chr(10).join(messages_text)}
"""
        sample_texts.append(sample_text)

    full_text = header + "\n".join(sample_texts)

    if max_chars and len(full_text) > max_chars:
        # Truncate if needed
        full_text = full_text[:max_chars] + "\n\n[Output truncated to fit context window]"

    return full_text


async def parse_inspect_eval(
    source: str, max_samples: int | None = None, max_chars: int = 100_000
) -> ParseResult:
    """Parse an Inspect AI .eval file and return formatted content with metadata.

    Uses iterative budget enforcement: adds samples one at a time until max_chars
    is exceeded. Ensures at least 1 sample is always included.

    Uses Inspect AI's built-in read_eval_log() which supports:
    - Local file paths
    - HTTP/HTTPS URLs
    - S3 URLs
    - Other remote storage

    Args:
        source: URL or file path to the .eval file
        max_samples: Maximum number of samples to include (randomly selected).
                    If None, adds samples until max_chars budget is exceeded.
        max_chars: Maximum characters in output (default: 100k ~= 25k tokens)

    Returns:
        ParseResult with formatted content and metadata (model name, sample counts)

    Raises:
        Exception: If file cannot be read or parsed
    """
    # Read the full eval log (just metadata, we'll load samples selectively)
    log = read_eval_log(source, header_only=False)

    total_samples = len(log.samples) if log.samples else 0
    model_name = log.eval.model if hasattr(log.eval, "model") else "unknown"

    if total_samples == 0:
        # No samples, just return header
        content = format_eval_log_with_samples(log, [], max_chars)
        return ParseResult(
            content=content,
            model_name=model_name,
            total_samples=0,
            included_samples=0,
        )

    # Stratified sampling: ensure we get samples from all unique inputs (questions)
    # Group samples by input to ensure we don't miss any questions
    input_groups: dict[str, list[EvalSample]] = defaultdict(list)
    for sample in log.samples:
        # Group by input text (the question/prompt)
        input_key = str(sample.input) if sample.input else "no_input"
        input_groups[input_key].append(sample)

    # Shuffle samples within each input group for randomness
    for samples_list in input_groups.values():
        random.shuffle(samples_list)

    # Strategy: Round-robin across input groups to ensure all questions represented
    # This gives each unique input equal representation
    input_group_items = list(input_groups.items())
    random.shuffle(input_group_items)  # Randomize which input group we start with

    selected_samples = []
    round_idx = 0

    while True:
        added_this_round = False

        # Try to add one sample from each input group in this round
        for input_key, samples_list in input_group_items:
            # Check if this input group still has samples
            if round_idx >= len(samples_list):
                continue

            sample = samples_list[round_idx]

            # Try adding this sample
            candidate_samples = selected_samples + [sample]
            candidate_output = format_eval_log_with_samples(log, candidate_samples, max_chars=None)

            # Check if we're over budget
            if len(candidate_output) > max_chars and len(selected_samples) > 0:
                # Would exceed budget and we have at least 1 sample - done
                break

            # Add the sample
            selected_samples.append(sample)
            added_this_round = True

            # Stop if we hit max_samples limit (if specified)
            if max_samples is not None and len(selected_samples) >= max_samples:
                break

        # If we hit budget or max_samples, stop
        if not added_this_round or (
            max_samples is not None and len(selected_samples) >= max_samples
        ):
            break

        round_idx += 1

    # Sort selected samples by ID for readability
    selected_samples.sort(key=lambda s: s.id)

    # Format and return (with truncation if needed)
    content = format_eval_log_with_samples(log, selected_samples, max_chars)

    # Flatten messages with context for citation support and deep links
    # Pass model name and eval file for attribution in highlights and deep links
    eval_filename = os.path.basename(source)
    messages, message_context = flatten_messages_with_context(
        selected_samples, model=model_name, eval_file=eval_filename
    )

    return ParseResult(
        content=content,
        model_name=model_name,
        total_samples=total_samples,
        included_samples=len(selected_samples),
        samples=selected_samples,
        messages=messages,
        message_context=message_context,
    )
