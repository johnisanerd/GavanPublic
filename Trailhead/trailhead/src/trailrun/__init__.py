"""Trailrun orchestration system for Design -> Run -> Report lifecycle.

Architecture:
- phases/: Phase functions (design, run, summarize, ask)
- state.py: State machine with event emission
- hooks.py: HookRegistry + LoggingHook + PersistenceHook
- events.py: EventType + TrailrunEvent
"""

from src.trailrun.blocks import build_config_blocks
from src.trailrun.core import ResearchResult, run_and_parse
from src.trailrun.events import EventType, TrailrunEvent
from src.trailrun.generate_experiment import ConfigGenerationError, generate_experiment
from src.trailrun.hooks import (
    HookRegistry,
    LoggingHook,
    PersistenceHook,
    TrailrunHook,
    get_registry,
    setup_default_hooks,
)
from src.trailrun.phases import ask_trailrun, design_trailrun, run_trailrun, summarize_trailrun
from src.trailrun.state import create_trailrun, emit_progress, update_trailrun
from src.trailrun.store import delete_trailrun, get_trailrun, list_trailruns
from src.trailrun.tasks import cancel_trailrun, create_trailrun_task, list_active_trailruns
from src.trailrun.types import Phase, Trailrun, TrailrunSource

__all__ = [
    # Types
    "Phase",
    "Trailrun",
    "TrailrunSource",
    "ResearchResult",
    # Events
    "EventType",
    "TrailrunEvent",
    # Hooks
    "TrailrunHook",
    "HookRegistry",
    "LoggingHook",
    "PersistenceHook",
    "get_registry",
    "setup_default_hooks",
    # State (async, emits events)
    "create_trailrun",
    "update_trailrun",
    "emit_progress",
    # Store (sync, pure CRUD)
    "get_trailrun",
    "delete_trailrun",
    "list_trailruns",
    # Phase functions
    "design_trailrun",
    "run_trailrun",
    "summarize_trailrun",
    "ask_trailrun",
    # Core execution (Slack-independent)
    "ConfigGenerationError",
    "generate_experiment",
    "run_and_parse",
    # Slack blocks
    "build_config_blocks",
    # Task management
    "create_trailrun_task",
    "cancel_trailrun",
    "list_active_trailruns",
]
