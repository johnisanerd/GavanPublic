"""In-memory storage for trailrun instances with JSON file persistence.

NOTE: Currently persists to RUNNER_LOG_DIR/trailruns.json for simplicity.
See BACKLOG.md for future persistence improvements.
"""

import json
import logging
import secrets
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from src.config import settings
from src.trailrun.types import Phase, Trailrun

logger = logging.getLogger(__name__)

_STORE_PATH = Path(settings.runner_log_dir) / "trailruns.json"

# Increment this when making breaking schema changes
# v1: Initial schema
# v2: Added source field, made channel_id/user_id optional
# v3: Added rangers array for Ranger autonomous sessions
SCHEMA_VERSION = 3


class SchemaMigrationError(Exception):
    """Raised when stored data doesn't match current Trailrun schema."""

    pass


def _migrate_trailrun(data: dict[str, Any], from_version: int) -> dict[str, Any]:
    """Migrate a single trailrun record from an older schema version.

    Add migration logic here when schema changes. Example:
        if from_version < 2:
            data["new_field"] = "default_value"
        if from_version < 3:
            data["renamed_field"] = data.pop("old_field_name", None)

    Returns:
        Migrated data dict
    """
    if from_version < 2:
        # v2: Added source field (default to SLACK for existing trailruns)
        # channel_id and user_id are now optional, but existing data has them
        data.setdefault("source", "slack")

    return data


def _load() -> dict[str, Trailrun]:
    """Load trailruns from JSON file on startup.

    Handles:
    - Missing file: returns empty dict
    - Corrupted JSON: backs up file and returns empty dict
    - Old schema version: attempts migration
    - New optional fields: Pydantic handles with defaults
    - Removed fields: ignored during load

    Raises:
        SchemaMigrationError: If stored data can't be loaded even after migration.
    """
    if not _STORE_PATH.exists():
        return {}

    try:
        raw = json.loads(_STORE_PATH.read_text())
    except json.JSONDecodeError as e:
        # Actual corruption - backup and continue
        backup_path = _STORE_PATH.with_suffix(".json.corrupted")
        n = 1
        while backup_path.exists():
            backup_path = _STORE_PATH.with_suffix(f".json.corrupted.{n}")
            n += 1
        _STORE_PATH.rename(backup_path)
        logger.warning(f"Corrupted trailruns.json, backed up to {backup_path.name}: {e}")
        return {}

    # Handle versioned format: {"version": N, "trailruns": {...}}
    # or legacy unversioned format: {"tr_xxx": {...}, ...}
    if "version" in raw and "trailruns" in raw:
        file_version = raw["version"]
        trailruns_data = raw["trailruns"]
    else:
        # Legacy format (no version) - treat as version 0
        file_version = 0
        trailruns_data = raw

    if file_version > SCHEMA_VERSION:
        raise SchemaMigrationError(
            f"trailruns.json is from a newer version (v{file_version}) "
            f"than this code supports (v{SCHEMA_VERSION}). "
            f"Please upgrade the application or delete the file."
        )

    if file_version < SCHEMA_VERSION:
        logger.info(f"Migrating trailruns from v{file_version} to v{SCHEMA_VERSION}")

    # Load each trailrun, applying migrations and ignoring extra fields
    result: dict[str, Trailrun] = {}
    errors: list[str] = []

    for trailrun_id, data in trailruns_data.items():
        try:
            # Apply migrations if needed
            if file_version < SCHEMA_VERSION:
                data = _migrate_trailrun(data, file_version)

            # Use model_validate with strict=False to ignore extra fields
            result[trailrun_id] = Trailrun.model_validate(data)
        except ValidationError as e:
            errors.append(f"{trailrun_id}: {e}")

    if errors:
        raise SchemaMigrationError(
            f"Failed to load {len(errors)} trailrun(s) - schema may have changed.\n"
            + "\n".join(errors[:5])  # Show first 5 errors
            + (f"\n... and {len(errors) - 5} more" if len(errors) > 5 else "")
            + f"\nFile: {_STORE_PATH}"
        )

    # If we migrated, save the new format
    if file_version < SCHEMA_VERSION:
        _save_store(result)
        logger.info(f"Migration complete, saved {len(result)} trailruns")

    return result


def _save_store(store: dict[str, Trailrun]) -> None:
    """Persist trailruns dict to JSON file with version.

    Preserves the rangers array if it exists (managed by ranger.store).
    """
    _STORE_PATH.parent.mkdir(parents=True, exist_ok=True)

    # Preserve existing rangers array
    rangers: list[dict[str, Any]] = []
    if _STORE_PATH.exists():
        try:
            existing = json.loads(_STORE_PATH.read_text())
            rangers = existing.get("rangers", [])
        except json.JSONDecodeError:
            pass

    data = {
        "version": SCHEMA_VERSION,
        "trailruns": {k: v.model_dump(mode="json") for k, v in store.items()},
        "rangers": rangers,
    }
    _STORE_PATH.write_text(json.dumps(data, indent=2))


def save() -> None:
    """Persist current _store to JSON file.

    This is called by PersistenceHook on state change events.
    """
    _save_store(_store)


# Backwards compatibility alias
_save = save


_store: dict[str, Trailrun] = _load()

# Log startup info
if _store:
    logger.info(f"Loaded {len(_store)} trailrun(s) from {_STORE_PATH}")
else:
    logger.info("No existing trailruns found")


def generate_id() -> str:
    """Generate a unique trailrun ID."""
    return f"tr_{secrets.token_urlsafe(12)}"


def create_trailrun(
    channel_id: str,
    user_id: str,
    thread_ts: str | None = None,
) -> Trailrun:
    """Create a new trailrun in DESIGN phase.

    Args:
        channel_id: Slack channel ID
        user_id: Slack user ID who initiated
        thread_ts: Optional Slack thread timestamp

    Returns:
        Created Trailrun instance
    """
    trailrun_id = generate_id()
    trailrun = Trailrun(
        id=trailrun_id,
        phase=Phase.DESIGN,
        channel_id=channel_id,
        user_id=user_id,
        thread_ts=thread_ts,
    )
    _store[trailrun_id] = trailrun
    _save()
    return trailrun


def get_trailrun(trailrun_id: str) -> Trailrun | None:
    """Get a trailrun by ID.

    Args:
        trailrun_id: Trailrun ID

    Returns:
        Trailrun instance or None if not found
    """
    return _store.get(trailrun_id)


def get_trailrun_by_thread(thread_ts: str) -> Trailrun | None:
    """Get a trailrun by Slack thread timestamp.

    Args:
        thread_ts: Slack thread timestamp

    Returns:
        Trailrun instance or None if not found
    """
    for trailrun in _store.values():
        if trailrun.thread_ts == thread_ts:
            return trailrun
    return None


def update_trailrun(trailrun_id: str, **updates: Any) -> Trailrun:
    """Update a trailrun with new field values.

    Args:
        trailrun_id: Trailrun ID
        **updates: Field name -> value mappings

    Returns:
        Updated Trailrun instance

    Raises:
        KeyError: If trailrun not found
    """
    trailrun = _store.get(trailrun_id)
    if not trailrun:
        raise KeyError(f"Trailrun not found: {trailrun_id}")

    # Update fields
    updated_data = trailrun.model_dump()
    updated_data.update(updates)
    updated_data["updated_at"] = datetime.now(UTC)

    # Validate and reconstruct
    updated_trailrun = Trailrun(**updated_data)
    _store[trailrun_id] = updated_trailrun
    _save()
    return updated_trailrun


def delete_trailrun(trailrun_id: str) -> None:
    """Delete a trailrun from the store.

    Args:
        trailrun_id: Trailrun ID

    Raises:
        KeyError: If trailrun not found
    """
    if trailrun_id not in _store:
        raise KeyError(f"Trailrun not found: {trailrun_id}")
    del _store[trailrun_id]
    _save()


def list_trailruns() -> list[Trailrun]:
    """List all trailruns in the store.

    Returns:
        List of all Trailrun instances
    """
    return list(_store.values())
