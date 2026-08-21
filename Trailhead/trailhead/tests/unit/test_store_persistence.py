"""Tests for trailrun store persistence."""

import json
from pathlib import Path
from unittest.mock import patch


def test_store_saves_on_create(tmp_path: Path):
    """Test that creating a trailrun persists to JSON file."""
    store_path = tmp_path / "trailruns.json"

    with patch("src.trailrun.store._STORE_PATH", store_path):
        with patch("src.trailrun.store._store", {}):
            from src.trailrun.store import create_trailrun

            # Create a trailrun
            trailrun = create_trailrun(
                channel_id="C123",
                user_id="U456",
                thread_ts="1234567890.123456",
            )

            # Verify file was created
            assert store_path.exists()

            # Verify content (versioned format - v3 includes rangers support)
            data = json.loads(store_path.read_text())
            assert data["version"] == 3
            assert trailrun.id in data["trailruns"]
            assert data["trailruns"][trailrun.id]["channel_id"] == "C123"
            assert data["trailruns"][trailrun.id]["user_id"] == "U456"


def test_store_saves_on_update(tmp_path: Path):
    """Test that updating a trailrun persists changes."""
    store_path = tmp_path / "trailruns.json"

    with patch("src.trailrun.store._STORE_PATH", store_path):
        with patch("src.trailrun.store._store", {}):
            from src.trailrun.store import create_trailrun, update_trailrun
            from src.trailrun.types import Phase

            trailrun = create_trailrun(channel_id="C123", user_id="U456")
            update_trailrun(trailrun.id, phase=Phase.RUN, status="running")

            data = json.loads(store_path.read_text())
            assert data["trailruns"][trailrun.id]["phase"] == "run"
            assert data["trailruns"][trailrun.id]["status"] == "running"


def test_store_saves_on_delete(tmp_path: Path):
    """Test that deleting a trailrun removes it from persistence."""
    store_path = tmp_path / "trailruns.json"

    with patch("src.trailrun.store._STORE_PATH", store_path):
        with patch("src.trailrun.store._store", {}):
            from src.trailrun.store import create_trailrun, delete_trailrun

            trailrun = create_trailrun(channel_id="C123", user_id="U456")
            trailrun_id = trailrun.id

            # Verify it exists
            data = json.loads(store_path.read_text())
            assert trailrun_id in data["trailruns"]

            # Delete and verify removed
            delete_trailrun(trailrun_id)
            data = json.loads(store_path.read_text())
            assert trailrun_id not in data["trailruns"]


def test_store_loads_on_startup(tmp_path: Path):
    """Test that store loads existing data on startup."""
    store_path = tmp_path / "trailruns.json"

    # Pre-populate the file
    existing_data = {
        "tr_existing123": {
            "id": "tr_existing123",
            "phase": "design",
            "status": "pending",
            "channel_id": "C999",
            "user_id": "U999",
            "thread_ts": None,
            "config": None,
            "error": None,
            "created_at": "2024-01-01T00:00:00Z",
            "updated_at": "2024-01-01T00:00:00Z",
        }
    }
    store_path.write_text(json.dumps(existing_data))

    with patch("src.trailrun.store._STORE_PATH", store_path):
        from src.trailrun.store import _load

        loaded = _load()
        assert "tr_existing123" in loaded
        assert loaded["tr_existing123"].channel_id == "C999"


def test_store_handles_corrupted_json(tmp_path: Path, caplog):  # type: ignore[no-untyped-def]
    """Test that store handles corrupted JSON gracefully, warns, and backs up."""
    store_path = tmp_path / "trailruns.json"
    backup_path = tmp_path / "trailruns.json.corrupted"
    store_path.write_text("not valid json {{{")

    with patch("src.trailrun.store._STORE_PATH", store_path):
        from src.trailrun.store import _load

        # Should return empty dict, not crash
        loaded = _load()
        assert loaded == {}

        # Should backup corrupted file
        assert backup_path.exists()
        assert not store_path.exists()
        assert backup_path.read_text() == "not valid json {{{"

        # Should log warning
        assert "Corrupted trailruns.json" in caplog.text
        assert "backed up" in caplog.text


def test_store_increments_backup_filename(tmp_path: Path):
    """Test that backup filenames increment if previous backups exist."""
    store_path = tmp_path / "trailruns.json"

    # Create existing backup files
    (tmp_path / "trailruns.json.corrupted").write_text("old backup 1")
    (tmp_path / "trailruns.json.corrupted.1").write_text("old backup 2")

    store_path.write_text("not valid json {{{")

    with patch("src.trailrun.store._STORE_PATH", store_path):
        from src.trailrun.store import _load

        _load()

        # Should create .corrupted.2 since .corrupted and .corrupted.1 exist
        assert (tmp_path / "trailruns.json.corrupted.2").exists()
        assert (tmp_path / "trailruns.json.corrupted.2").read_text() == "not valid json {{{"

        # Old backups should be untouched
        assert (tmp_path / "trailruns.json.corrupted").read_text() == "old backup 1"
        assert (tmp_path / "trailruns.json.corrupted.1").read_text() == "old backup 2"


def test_store_fails_on_schema_mismatch(tmp_path: Path):
    """Test that store fails loudly on schema mismatch instead of losing data."""
    import pytest

    store_path = tmp_path / "trailruns.json"

    # Valid JSON but missing required fields / wrong schema
    bad_schema_data = {
        "tr_old123": {
            "id": "tr_old123",
            "some_field_that_doesnt_exist": "value",
            # Missing required fields like phase, channel_id, etc.
        }
    }
    store_path.write_text(json.dumps(bad_schema_data))

    with patch("src.trailrun.store._STORE_PATH", store_path):
        from src.trailrun.store import SchemaMigrationError, _load

        # Should raise SchemaMigrationError, not silently continue
        with pytest.raises(SchemaMigrationError) as exc_info:
            _load()

        assert "schema may have changed" in str(exc_info.value)
        # Original file should NOT be deleted
        assert store_path.exists()


def test_store_migrates_legacy_format(tmp_path: Path, caplog):  # type: ignore[no-untyped-def]
    """Test that legacy format (no version) is migrated to versioned format."""
    import logging

    caplog.set_level(logging.INFO)

    store_path = tmp_path / "trailruns.json"

    # Legacy format: just trailruns dict, no version wrapper
    legacy_data = {
        "tr_legacy123": {
            "id": "tr_legacy123",
            "phase": "design",
            "status": "pending",
            "channel_id": "C999",
            "user_id": "U999",
            "thread_ts": None,
            "config": None,
            "error": None,
            "created_at": "2024-01-01T00:00:00Z",
            "updated_at": "2024-01-01T00:00:00Z",
        }
    }
    store_path.write_text(json.dumps(legacy_data))

    with patch("src.trailrun.store._STORE_PATH", store_path):
        from src.trailrun.store import _load

        loaded = _load()
        assert "tr_legacy123" in loaded

        # Should log migration message (now v3 with rangers support)
        assert "Migrating trailruns from v0 to v3" in caplog.text

        # File should now be in versioned format
        new_data = json.loads(store_path.read_text())
        assert new_data["version"] == 3
        assert "tr_legacy123" in new_data["trailruns"]


def test_store_rejects_future_version(tmp_path: Path):
    """Test that store fails on data from a newer version."""
    import pytest

    store_path = tmp_path / "trailruns.json"

    future_data = {"version": 999, "trailruns": {}}
    store_path.write_text(json.dumps(future_data))

    with patch("src.trailrun.store._STORE_PATH", store_path):
        from src.trailrun.store import SchemaMigrationError, _load

        with pytest.raises(SchemaMigrationError) as exc_info:
            _load()

        assert "newer version" in str(exc_info.value)
        assert "v999" in str(exc_info.value)


def test_store_ignores_extra_fields(tmp_path: Path):
    """Test that removed fields in old data are ignored (not errors)."""
    store_path = tmp_path / "trailruns.json"

    # Data with an extra field that doesn't exist in current schema
    data_with_extra = {
        "version": 1,
        "trailruns": {
            "tr_extra123": {
                "id": "tr_extra123",
                "phase": "design",
                "status": "pending",
                "channel_id": "C999",
                "user_id": "U999",
                "thread_ts": None,
                "config": None,
                "error": None,
                "created_at": "2024-01-01T00:00:00Z",
                "updated_at": "2024-01-01T00:00:00Z",
                "old_removed_field": "this field no longer exists",
                "another_old_field": 12345,
            }
        },
    }
    store_path.write_text(json.dumps(data_with_extra))

    with patch("src.trailrun.store._STORE_PATH", store_path):
        from src.trailrun.store import _load

        # Should load successfully, ignoring extra fields
        loaded = _load()
        assert "tr_extra123" in loaded
        assert loaded["tr_extra123"].channel_id == "C999"
        # Extra fields should not be on the model
        assert not hasattr(loaded["tr_extra123"], "old_removed_field")


def test_store_handles_missing_file(tmp_path: Path):
    """Test that store handles missing file gracefully."""
    store_path = tmp_path / "nonexistent.json"

    with patch("src.trailrun.store._STORE_PATH", store_path):
        from src.trailrun.store import _load

        loaded = _load()
        assert loaded == {}


def test_store_creates_parent_directories(tmp_path: Path):
    """Test that save creates parent directories if needed."""
    store_path = tmp_path / "nested" / "path" / "trailruns.json"

    with patch("src.trailrun.store._STORE_PATH", store_path):
        with patch("src.trailrun.store._store", {}):
            from src.trailrun.store import create_trailrun

            create_trailrun(channel_id="C123", user_id="U456")

            assert store_path.exists()
            assert store_path.parent.exists()
