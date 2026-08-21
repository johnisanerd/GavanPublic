"""Trailrun models for orchestrating Design -> Run -> Report lifecycle."""

from datetime import UTC, datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field

from src.runner.types import ExperimentConfig, ExperimentResult


class Phase(str, Enum):
    """Lifecycle phase for a trailrun."""

    DESIGN = "design"
    RUN = "run"
    REPORT = "report"


class TrailrunSource(str, Enum):
    """Source interface that initiated the trailrun."""

    SLACK = "slack"
    API = "api"
    CLI = "cli"
    RANGER = "ranger"  # Created by Ranger autonomous research agent


class Trailrun(BaseModel):
    """State container for a full experiment lifecycle."""

    id: str = Field(..., description="Unique identifier for this trailrun")
    phase: Phase = Field(..., description="Current lifecycle phase")
    source: TrailrunSource = Field(
        default=TrailrunSource.SLACK,
        description="Interface that initiated this trailrun",
    )
    config: ExperimentConfig | None = Field(
        default=None, description="Experiment configuration (populated after design phase)"
    )
    result: ExperimentResult | None = Field(
        default=None, description="Experiment result (populated after run phase)"
    )
    static_inspect_viewer_path: str | None = Field(
        default=None,
        description="Path to static Inspect viewer bundle (populated after report phase)",
    )
    research_content: str | None = Field(
        default=None,
        description="Cached parsed research content for answering questions (populated after report phase)",
    )
    summary: dict[str, Any] | None = Field(
        default=None, description="Generated summary as Slack blocks (populated after report phase)"
    )

    # For highlight extraction - stored as serialized dicts for JSON compatibility
    messages: list[dict[str, Any]] | None = Field(
        default=None, description="Chat messages from experiment (for citation extraction)"
    )
    message_context: dict[str, dict[str, Any]] | None = Field(
        default=None, description="Message ID -> sample/turn context mapping (for deep links)"
    )

    # Metadata from run phase for summarization
    models: list[str] | None = Field(default=None, description="Models used in the experiment")
    samples_included: int | None = Field(
        default=None, description="Number of samples included in summary"
    )
    samples_total: int | None = Field(
        default=None, description="Total number of samples in experiment"
    )

    # Slack fields - optional for non-Slack sources
    channel_id: str | None = Field(
        default=None, description="Slack channel ID where trailrun was initiated"
    )
    thread_ts: str | None = Field(default=None, description="Slack thread timestamp for replies")
    user_id: str | None = Field(default=None, description="Slack user who initiated the trailrun")

    # Ranger fields - only set when source == RANGER
    ranger_id: str | None = Field(
        default=None, description="ID of the Ranger session that created this trailrun"
    )

    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    status: str = Field(
        default="pending", description="Current status (pending/running/completed/failed)"
    )
    error: str | None = Field(default=None, description="Error message if failed")

    # Allow extra fields for backward compat when loading old data with removed fields
    model_config = {"extra": "ignore"}
