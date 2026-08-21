"""Phase functions for trailrun lifecycle.

Each phase is a discrete step that can be called independently:
- design: Generate experiment config from description
- run: Execute the experiment
- summarize: Generate summary from results
- ask: Answer questions about results

These can be orchestrated by Slack (human-driven), API (LLM-driven),
or simple scripts (sequential).
"""

from src.trailrun.phases.ask import ask_trailrun
from src.trailrun.phases.design import design_trailrun
from src.trailrun.phases.run import run_trailrun
from src.trailrun.phases.summarize import summarize_trailrun

__all__ = [
    "ask_trailrun",
    "design_trailrun",
    "run_trailrun",
    "summarize_trailrun",
]
