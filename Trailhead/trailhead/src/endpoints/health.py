"""Health and root endpoints."""

from fastapi import APIRouter

router = APIRouter()


@router.get("/")
async def root() -> dict[str, str]:
    """Root endpoint."""
    return {"status": "ok", "message": "Trailhead is running"}


@router.get("/health")
async def health() -> dict[str, str]:
    """Health check endpoint.

    Returns:
        Health status indicating the service is operational
    """
    return {"status": "ok"}
