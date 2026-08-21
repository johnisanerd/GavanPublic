"""Storage for Ranger sessions.

Rangers are stored alongside trailruns in the same JSON file.
This module provides CRUD operations for the rangers array.

Note: This imports from trailrun.store to share the same file and
avoid duplication. Rangers live in the "rangers" key.
"""

import json
import logging
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from src.config import settings
from src.ranger.types import RangerMode, RangerSession, RangerStatus

logger = logging.getLogger(__name__)

_STORE_PATH = Path(settings.runner_log_dir) / "trailruns.json"
_RANGERS_LOG_DIR = Path(settings.runner_log_dir) / "rangers"

# In-memory store - loaded on import
_rangers: dict[str, RangerSession] = {}


def _load_rangers() -> dict[str, RangerSession]:
    """Load rangers from the shared trailruns.json file."""
    if not _STORE_PATH.exists():
        return {}

    try:
        raw = json.loads(_STORE_PATH.read_text())
    except json.JSONDecodeError:
        return {}

    # Get rangers array from versioned format
    rangers_data = raw.get("rangers", [])

    result: dict[str, RangerSession] = {}
    for data in rangers_data:
        try:
            ranger = RangerSession.model_validate(data)
            result[ranger.id] = ranger
        except ValidationError as e:
            logger.warning(f"Failed to load ranger {data.get('id', '?')}: {e}")

    return result


def _save_rangers() -> None:
    """Save rangers to the shared trailruns.json file.

    This reads the existing file, updates the rangers array, and writes back.
    """
    _STORE_PATH.parent.mkdir(parents=True, exist_ok=True)

    # Read existing data
    if _STORE_PATH.exists():
        try:
            raw = json.loads(_STORE_PATH.read_text())
        except json.JSONDecodeError:
            raw = {"version": 3, "trailruns": {}}
    else:
        raw = {"version": 3, "trailruns": {}}

    # Update rangers array
    raw["rangers"] = [r.model_dump(mode="json") for r in _rangers.values()]

    # Ensure version is at least 3 (rangers support)
    if raw.get("version", 0) < 3:
        raw["version"] = 3

    _STORE_PATH.write_text(json.dumps(raw, indent=2))


# Load on import
_rangers = _load_rangers()
if _rangers:
    logger.info(f"Loaded {len(_rangers)} ranger session(s)")


def create_ranger(
    ranger_id: str,
    mode: RangerMode,
    date: str,
) -> RangerSession:
    """Create a new ranger session.

    Args:
        ranger_id: Unique ID (format: ranger_YYYYMMDD)
        mode: Research mode (novel or deep_dive)
        date: Date string (YYYY-MM-DD)

    Returns:
        Created RangerSession instance
    """
    ranger = RangerSession(
        id=ranger_id,
        date=date,
        mode=mode,
        status=RangerStatus.RUNNING,
    )
    _rangers[ranger_id] = ranger
    _save_rangers()
    return ranger


def get_ranger(ranger_id: str) -> RangerSession | None:
    """Get a ranger session by ID."""
    return _rangers.get(ranger_id)


def update_ranger(ranger_id: str, **updates: Any) -> RangerSession:
    """Update a ranger session.

    Args:
        ranger_id: Ranger session ID
        **updates: Field updates

    Returns:
        Updated RangerSession

    Raises:
        KeyError: If ranger not found
    """
    ranger = _rangers.get(ranger_id)
    if not ranger:
        raise KeyError(f"Ranger not found: {ranger_id}")

    updated_data = ranger.model_dump()
    updated_data.update(updates)

    updated_ranger = RangerSession.model_validate(updated_data)
    _rangers[ranger_id] = updated_ranger
    _save_rangers()
    return updated_ranger


def complete_ranger(
    ranger_id: str,
    status: RangerStatus,
    structured: dict[str, Any] | None = None,
    error: str | None = None,
) -> RangerSession:
    """Mark a ranger session as complete.

    Args:
        ranger_id: Ranger session ID
        status: Final status (success or failed)
        structured: Optional structured JSON output
        error: Optional error message

    Returns:
        Updated RangerSession
    """
    return update_ranger(
        ranger_id,
        status=status,
        structured=structured,
        error=error,
        completed_at=datetime.now(UTC),
    )


def add_trailrun_to_ranger(ranger_id: str, trailrun_id: str) -> RangerSession:
    """Add a trailrun ID to a ranger session's list.

    Args:
        ranger_id: Ranger session ID
        trailrun_id: Trailrun ID to add

    Returns:
        Updated RangerSession
    """
    ranger = _rangers.get(ranger_id)
    if not ranger:
        raise KeyError(f"Ranger not found: {ranger_id}")

    if trailrun_id not in ranger.trailrun_ids:
        trailrun_ids = ranger.trailrun_ids + [trailrun_id]
        return update_ranger(ranger_id, trailrun_ids=trailrun_ids)

    return ranger


def list_rangers(limit: int = 20) -> list[RangerSession]:
    """List ranger sessions, most recent first.

    Args:
        limit: Maximum number to return

    Returns:
        List of RangerSession instances
    """
    sorted_rangers = sorted(
        _rangers.values(),
        key=lambda r: r.created_at,
        reverse=True,
    )
    return sorted_rangers[:limit]


def save_ranger_log(ranger_id: str, content: str) -> str:
    """Save ranger session stdout to a log file.

    Args:
        ranger_id: Ranger session ID
        content: Log content to save

    Returns:
        Path to the saved log file
    """
    _RANGERS_LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_path = _RANGERS_LOG_DIR / f"{ranger_id}.log"
    log_path.write_text(content)

    # Update ranger with log path
    update_ranger(ranger_id, log_path=str(log_path))

    return str(log_path)
