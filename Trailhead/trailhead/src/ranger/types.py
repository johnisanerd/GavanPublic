"""Ranger session types."""

from datetime import UTC, datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class RangerMode(str, Enum):
    """Research mode for the ranger session."""

    NOVEL = "novel"  # Odd days - explore new categories
    DEEP_DIVE = "deep_dive"  # Even days - go deeper on existing work


class RangerStatus(str, Enum):
    """Status of the ranger session."""

    RUNNING = "running"
    SUCCESS = "success"
    FAILED = "failed"


class RangerSession(BaseModel):
    """Metadata for a Ranger autonomous research session."""

    id: str = Field(..., description="Unique identifier (ranger_YYYYMMDD)")
    date: str = Field(..., description="Date of the session (YYYY-MM-DD)")
    mode: RangerMode = Field(..., description="Research mode (novel or deep_dive)")
    status: RangerStatus = Field(default=RangerStatus.RUNNING, description="Current status")

    # Linked trailruns
    trailrun_ids: list[str] = Field(
        default_factory=list, description="IDs of trailruns created during this session"
    )

    # Output from Claude Code
    structured: dict[str, Any] | None = Field(
        default=None, description="Structured JSON output from the session"
    )
    log_path: str | None = Field(default=None, description="Path to full stdout log file")

    # Timestamps
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    completed_at: datetime | None = Field(default=None)

    # Error info
    error: str | None = Field(default=None, description="Error message if failed")

    model_config = {"extra": "ignore"}
