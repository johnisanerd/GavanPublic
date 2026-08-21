"""
Shared prompt components used across summarizers and answerers.
"""

MODEL_BEHAVIOR_FOCUS = """
Focus on MODEL BEHAVIOR - what the model actually said or did, not infrastructure metrics like token counts or latency.

Focus on:
- What the model actually said, chose, or did
- Patterns in responses and reasoning approaches
- Unusual answers, refusals, errors, hallucinations
- Behavioral differences between conditions

Ignore infrastructure metrics like token counts, reasoning lengths, latency, timing unless they reveal something about model behavior.
"""

ANALYSIS_DIMENSIONS = """
- What was being tested (research question)
- What the model actually said, chose, or did
- Patterns in responses and reasoning approaches
- Unusual answers, refusals, errors, hallucinations
- What this suggests about model capabilities
"""

IGNORE_INFRASTRUCTURE = """
IGNORE infrastructure metrics like token counts, reasoning lengths, latency. Focus on actual model behavior - its answers, choices, refusals, errors, reasoning patterns.
"""


def BEHAVIOR_FOCUS_SYSTEM(context: str = "experiments") -> str:
    """
    Build a system prompt emphasizing focus on model behavior.
    """
    return f"""
You are a research analyst creating insights from LLM {context}.
Extract unusual and interesting behavior from experiment results. {MODEL_BEHAVIOR_FOCUS}
"""


def ANALYSIS_USER(research_content: str, task_description: str) -> str:
    """
    Build user prompt for analyzing research content.
    """
    return f"""
{task_description}:

{research_content}

Focus on MODEL BEHAVIOR:
{ANALYSIS_DIMENSIONS}

{IGNORE_INFRASTRUCTURE}
"""
