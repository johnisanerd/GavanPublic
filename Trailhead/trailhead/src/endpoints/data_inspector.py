"""GET /data-inspector/{trailrun_id} - Serve Inspect viewer bundle."""

from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import RedirectResponse

from src.config import settings

router = APIRouter()


@router.get("/data-inspector/{trailrun_id}")
async def view_trailrun_data(trailrun_id: str):
    """Serve Inspect viewer bundle for a specific trailrun.

    Redirects to the bundle's index.html file.

    Args:
        trailrun_id: Trailrun ID

    Returns:
        Redirect to the viewer's index.html

    Raises:
        HTTPException: If bundle not found
    """
    # Validate path is within allowed directory (prevent path traversal)
    allowed_dir = Path(settings.inspect_bundle_dir).resolve()
    bundle_path = (allowed_dir / trailrun_id).resolve()

    if not str(bundle_path).startswith(str(allowed_dir)):
        raise HTTPException(
            status_code=403,
            detail="Invalid trailrun_id",
        )

    index_path = bundle_path / "index.html"

    if not index_path.exists():
        raise HTTPException(
            status_code=404,
            detail=f"Viewer bundle not found for trailrun {trailrun_id}",
        )

    return RedirectResponse(f"/data-inspector/{trailrun_id}/index.html")
