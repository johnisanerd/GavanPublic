"""Event types for the trailrun event system.

Events are emitted during trailrun lifecycle transitions and progress updates.
Hooks subscribe to these events to react (Slack posts, logging, persistence, etc).
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class EventType(str, Enum):
    """Types of events emitted during trailrun lifecycle."""

    # State transition events (emitted by state.py after update)
    CONFIG_READY = "trailrun.config_ready"  # After design phase, config available
    RESULT_READY = "trailrun.result_ready"  # After run phase, results available
    SUMMARY_READY = "trailrun.summary_ready"  # After summarize phase
    COMPLETED = "trailrun.completed"  # Trailrun finished successfully
    FAILED = "trailrun.failed"  # Trailrun failed with error
    CANCELLED = "trailrun.cancelled"  # Trailrun cancelled by user

    # Progress events (emitted by phase functions during execution)
    PROGRESS = "trailrun.progress"  # Progress update during long operations


@dataclass
class TrailrunEvent:
    """Event emitted during trailrun lifecycle.

    Attributes:
        type: Type of event
        trailrun_id: ID of the trailrun this event is for
        data: Additional event-specific data
    """

    type: EventType
    trailrun_id: str
    data: dict[str, Any] = field(default_factory=dict)
