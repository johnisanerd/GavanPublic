"""
Prompt for extracting highlights with citations from experiment transcripts.

This is Step 1 of the two-step analysis: identify key moments and quote them exactly.
"""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from src.orchestration.analysis.highlighter import ExperimentContext

HIGHLIGHT_EXTRACTION_SYSTEM = """
You are a research analyst extracting key highlights from LLM experiment transcripts.

Your task is to identify and cite the most interesting, unusual, or notable moments from
the conversation. Focus on MODEL BEHAVIOR - what the assistant actually said or did.

## Transcript Format

The transcript is provided in XML format:
- Each message has an index attribute (e.g., `<user index="1">`, `<assistant index="2">`)
- Use these indices when citing specific messages

## Citation Format

For each highlight, use this exact format:
<cite id="INDEX" description="brief label">exact verbatim text from message</cite>

Where:
- INDEX: The message index number (1, 2, 3, etc.)
- description: 2-5 word label (can include why you found it notable)
- The quoted text must be EXACT - copy it character-for-character

## What to Highlight

Focus on MODEL BEHAVIOR (assistant messages):
- Interesting or unexpected responses
- Patterns in reasoning or approach
- Refusals, hedging, or uncertainty
- Errors, hallucinations, or inconsistencies
- Notable capabilities or failures
- Unusual phrasing or tone

Do NOT focus on:
- Token counts, timing, or performance metrics
- Routine/expected responses
- User messages (unless they provide important context)

## Output Format

Return 5-10 highlights, numbered sequentially:

<highlights>
1. <cite id="3" description="shows uncertainty">I'm not entirely sure, but I think</cite>
2. <cite id="5" description="methodical approach">Let me break this down step by step</cite>
...
</highlights>

Descriptions should explain WHY the quote is notable. Order by importance, not position.
"""


def HIGHLIGHT_EXTRACTION_USER(
    transcript_xml: str,
    context: "ExperimentContext | None" = None,
) -> str:
    """Build user prompt with transcript for highlight extraction.

    Args:
        transcript_xml: XML-formatted transcript with indexed messages
        context: Optional experiment context (title, prompts) to focus extraction
    """
    context_section = ""
    if context:
        prompts_list = "\n".join(f"- {p}" for p in context.prompts)
        context_section = f"""
## Experiment Context

This experiment is titled: "{context.title}"

The prompts/questions tested were:
{prompts_list}

Focus on highlights RELEVANT to what this experiment was testing.
Prioritize quotes that reveal how the model responded to these specific prompts.

"""

    return f"""
{context_section}Extract key highlights from this experiment transcript.

{transcript_xml}

Remember:
- Quote EXACT text from the messages
- Use the message index in your citations
- Focus on interesting MODEL BEHAVIOR
- Return 5-10 highlights in <highlights> tags
"""
