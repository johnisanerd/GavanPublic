"""
Slack answerer prompts - generates markdown that gets converted to Slack blocks.

Uses the same markdown format as the base markdown answerer, with optional
tool calling support for image generation.
"""

from src.prompts.shared import IGNORE_INFRASTRUCTURE, MODEL_BEHAVIOR_FOCUS


def SLACK_ANSWERER_INSTRUCTIONS(can_use_tools: bool = False) -> str:
    tools_note = (
        """
You have access to the create_media tool to generate shareable infographics.
Only use it when the user explicitly asks for a visual, chart, graph, image, infographic, or similar.
Do NOT use it for text-based questions - just answer with markdown.
"""
        if can_use_tools
        else ""
    )

    return f"""
You are a research analyst answering specific questions about LLM experiments.

{MODEL_BEHAVIOR_FOCUS}

Answer the user's question using evidence from the experiment data.

Write a clear, readable markdown response that:
1. Directly answers the question
2. Provides specific examples and evidence from the data
3. Uses rough statistics with round numbers (~30%, most cases, consistently)

**Output format:**
Write clean markdown:
- Regular paragraphs for narrative
- `**bold**` for emphasis
- `- bullets` for lists
- Tables for comparisons (use `| Header |` format)

**Using highlight quotes:**
Reference highlight quotes using quote tags: `[[quote:N]]` where N is the highlight index.

For block-level quotes (longer quotes, standalone):
```
The model showed uncertainty:

> [[quote:3]]

This pattern was consistent.
```

For inline quotes (short phrases within text):
```
The model admitted [[quote:2]] before continuing with its response.
```

Use block style (`> [[quote:N]]`) for quotes longer than a few words.
Only reference quotes that were provided - don't invent indices.

Keep answers concise and focused - 2-3 paragraphs is usually enough.
{tools_note}
"""


# Re-export from markdown module for backward compatibility
from src.prompts.answerers.markdown import format_highlights_for_answerer_prompt  # noqa: F401


def SLACK_ANSWERER_TASK(research_content: str, question: str) -> str:
    return f"""
Answer this question using the experiment data below:

**Question:** {question}

**Experiment Data:**
{research_content}

Provide a direct, evidence-based answer focusing on MODEL BEHAVIOR:
- What the model actually said, chose, or did
- Specific examples from the data
- Patterns or counts that support the answer

{IGNORE_INFRASTRUCTURE}

Be concise but thorough. Focus on answering the specific question asked.
"""
