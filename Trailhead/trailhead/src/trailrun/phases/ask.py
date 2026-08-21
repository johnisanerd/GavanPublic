"""Ask phase: Answer questions about trailrun results."""

from src.config import settings
from src.orchestration.analysis.answerers import answer_to_markdown
from src.trailrun.state import get_trailrun


async def ask_trailrun(trailrun_id: str, question: str) -> str:
    """Answer question about trailrun results.

    Uses the cached research_content from the run phase to answer
    questions without re-parsing .eval files.

    Args:
        trailrun_id: ID of the trailrun to query
        question: Natural language question about the results

    Returns:
        Markdown-formatted answer

    Raises:
        KeyError: If trailrun not found
        ValueError: If research content is missing
    """
    trailrun = get_trailrun(trailrun_id)
    if not trailrun:
        raise KeyError(f"Trailrun not found: {trailrun_id}")

    if not trailrun.research_content:
        raise ValueError(
            f"Trailrun {trailrun_id} has no research content - complete the run phase first"
        )

    answer = await answer_to_markdown(
        research_content=trailrun.research_content,
        question=question,
        model=settings.utility_model,
        timeout=settings.timeout_s,
    )

    return answer
