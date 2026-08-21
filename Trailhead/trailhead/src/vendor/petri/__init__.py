"""
Alignment Auditing Agent for LLM Safety Research.

An automated alignment auditing agent for LLMs that designs realistic scenarios,
interacts with target models using human-like messages and simulated tools,
then evaluates transcripts to surface concerning behaviors.
"""

from src.vendor.petri.solvers.auditor_agent import auditor_agent
from src.vendor.petri.scorers.judge import alignment_judge
from src.vendor.petri.transcript import Transcript, TranscriptMetadata
from src.vendor.petri.tools import default_auditor_tools

__version__ = "0.1.0"
__all__ = [
    "auditor_agent",
    "alignment_judge", 
    "Transcript",
    "TranscriptMetadata",
    "default_auditor_tools",
]