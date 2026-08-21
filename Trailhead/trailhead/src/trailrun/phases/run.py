"""Run phase: Execute the experiment."""

import asyncio

from src.trailrun.core import ResearchResult, run_and_parse
from src.trailrun.state import emit_progress, get_trailrun, update_trailrun
from src.trailrun.types import Phase


async def run_trailrun(trailrun_id: str) -> ResearchResult:
    """Execute experiment. Requires config from design phase.

    Runs the experiment via subprocess, parses results, and stores
    the research content for later summarization/questions.

    Args:
        trailrun_id: ID of the trailrun to run

    Returns:
        ResearchResult with experiment output and parsed content

    Raises:
        KeyError: If trailrun not found
        ValueError: If config is missing or experiment fails
    """
    trailrun = get_trailrun(trailrun_id)
    if not trailrun:
        raise KeyError(f"Trailrun not found: {trailrun_id}")

    if not trailrun.config:
        raise ValueError(f"Trailrun {trailrun_id} has no config - run design phase first")

    # Update phase
    await update_trailrun(trailrun_id, phase=Phase.RUN, status="running")

    # Define sync progress callback that schedules async event emission
    def on_progress(phase: str, detail: str) -> None:
        # Fire-and-forget the async progress event
        asyncio.create_task(emit_progress(trailrun_id, detail, phase=phase))

    # Run core execution
    result = await run_and_parse(trailrun.config, on_progress=on_progress)

    # Serialize messages for storage (ChatMessage -> dict)
    # Store full message data for future features (tool_calls, metadata, etc.)
    serialized_messages = None
    if result.messages:
        serialized_messages = [
            msg.model_dump(mode="json")
            if hasattr(msg, "model_dump")
            else {"role": msg.role, "content": str(msg.content)}
            for msg in result.messages
        ]

    # Serialize message_context (MessageContext -> dict)
    serialized_context = None
    if result.message_context:
        serialized_context = {
            msg_id: {
                "sample_id": ctx.sample_id,
                "sample_number": ctx.sample_number,
                "turn": ctx.turn,
                "epoch": ctx.epoch,
                "model": ctx.model,
                "eval_file": ctx.eval_file,
            }
            for msg_id, ctx in result.message_context.items()
        }

    # Store results - this emits RESULT_READY
    await update_trailrun(
        trailrun_id,
        result=result.experiment_result,
        research_content=result.research_content,
        messages=serialized_messages,
        message_context=serialized_context,
        models=result.models,
        samples_included=result.samples_included,
        samples_total=result.samples_total,
    )

    return result
