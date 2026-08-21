"""POST /trailrun/{id}/ask - Answer questions about results."""

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from src.trailrun.phases import ask_trailrun

router = APIRouter()


class AskRequest(BaseModel):
    """Request body for ask phase."""

    question: str


@router.post("/trailrun/{trailrun_id}/ask")
async def ask_endpoint(trailrun_id: str, request: AskRequest) -> dict[str, Any]:
    """Answer question about trailrun results.

    Args:
        trailrun_id: Trailrun ID
        request: AskRequest with question

    Returns:
        Dict with markdown-formatted answer
    """
    try:
        answer = await ask_trailrun(trailrun_id, request.question)
        return {"answer": answer}
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
