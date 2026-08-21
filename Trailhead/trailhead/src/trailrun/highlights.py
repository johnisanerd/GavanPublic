"""Shared highlight extraction for trailruns.

Extracts highlights from stored messages, used by both summarize phase and answerer.
"""

import os
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from src.config import settings
from src.orchestration.analysis import (
    ExperimentContext,
    build_inspect_deep_link,
    extract_highlights,
)
from src.orchestration.analysis.highlighter import Highlight
from src.orchestration.parsers import MessageContext

if TYPE_CHECKING:
    from src.trailrun.types import Trailrun


@dataclass
class _StoredMessage:
    """ChatMessage-like object reconstructed from stored dict."""

    id: str | None
    role: str
    content: str
    metadata: dict[str, Any] | None = None
    error: Any = None
    tool_calls: list[Any] | None = None


def _reconstruct_messages(stored: list[dict[str, Any]]) -> list[_StoredMessage]:
    """Reconstruct message objects from stored dicts."""
    return [
        _StoredMessage(
            id=m.get("id"),
            role=m["role"],
            content=m["content"] if isinstance(m["content"], str) else str(m["content"]),
            metadata=m.get("metadata"),
            error=m.get("error"),
            tool_calls=m.get("tool_calls"),
        )
        for m in stored
    ]


def _reconstruct_context(stored: dict[str, dict[str, Any]]) -> dict[str, MessageContext]:
    """Reconstruct MessageContext objects from stored dicts."""
    return {
        msg_id: MessageContext(
            sample_id=ctx["sample_id"],
            sample_number=ctx["sample_number"],
            turn=ctx["turn"],
            epoch=ctx.get("epoch", 1),
            model=ctx.get("model"),
            eval_file=ctx.get("eval_file"),
        )
        for msg_id, ctx in stored.items()
    }


async def extract_highlights_for_trailrun(
    trailrun: "Trailrun",
    timeout: float | None = None,
) -> list[Highlight] | None:
    """Extract highlights from a trailrun's stored messages.

    This is the shared extraction logic used by both the summarize phase
    and the answerer. Encapsulates message reconstruction and deep link building.

    Args:
        trailrun: Trailrun with messages, message_context, config, and result
        timeout: Optional timeout override (defaults to settings.timeout_s)

    Returns:
        List of highlights with deep links, or None if no messages stored
    """
    if not trailrun.messages:
        return None

    timeout = timeout or settings.timeout_s

    # Reconstruct messages and context
    messages = _reconstruct_messages(trailrun.messages)
    message_context = (
        _reconstruct_context(trailrun.message_context) if trailrun.message_context else None
    )

    # Build deep link callback for viewer
    bundle_url = f"{settings.app_base_url}/data-inspector/{trailrun.id}/index.html"
    eval_filename = (
        os.path.basename(trailrun.result.log_dir) + ".eval"
        if trailrun.result and trailrun.result.log_dir
        else None
    )

    def build_link(
        message_id: str,
        sample_id: str | None,
        epoch: int = 1,
        eval_file: str | None = None,
    ) -> str | None:
        filename = eval_file or eval_filename
        if not filename:
            return None
        return build_inspect_deep_link(bundle_url, filename, message_id, sample_id, epoch)

    # Build experiment context if config available
    experiment_context = None
    if trailrun.config:
        experiment_context = ExperimentContext(
            title=trailrun.config.title,
            prompts=trailrun.config.prompts,
        )

    # Extract highlights
    return await extract_highlights(
        messages=messages,  # type: ignore[arg-type]
        timeout=timeout,
        build_link=build_link if eval_filename else None,
        experiment_context=experiment_context,
        message_context=message_context,
    )
