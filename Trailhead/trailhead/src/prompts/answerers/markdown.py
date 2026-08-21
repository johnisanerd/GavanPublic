"""
Markdown answerer prompts - shared base for answering questions about experiments.
"""

from src.prompts.shared import IGNORE_INFRASTRUCTURE, MODEL_BEHAVIOR_FOCUS

MARKDOWN_ANSWERER_INSTRUCTIONS = f"""
You are a research analyst answering specific questions about LLM experiments.

{MODEL_BEHAVIOR_FOCUS}

Answer the user's question using evidence from the experiment data.

Write a clear, readable markdown response that:
1. Directly answers the question
2. Provides specific examples and evidence from the data
3. Explains what the findings mean
4. Notes any relevant caveats

Use rough statistics with round numbers (~30%, most cases, consistently).

**Output format:**
Write clean markdown:
- Regular paragraphs for narrative
- `**bold**` for emphasis
- `- bullets` for lists
- Tables for comparisons (use `| Header |` format)

**Using highlight quotes:**
Reference highlight quotes using quote tags: `[[quote:N]]` where N is the highlight index.

For block-level highlight quotes (longer quotes, standalone):
```
The model showed uncertainty:

> [[quote:3]]

This pattern was consistent.
```

For inline highlight quotes (short phrases within text):
```
The model admitted [[quote:2]] before continuing with its response.
```

Use block style (`> [[quote:N]]`) for highlight quotes longer than a few words.
Only reference highlight quotes that were provided - don't invent indices.
"""


def MARKDOWN_ANSWERER_TASK(research_content: str, question: str) -> str:
    return f"""
Answer this question using the experiment data below:

**Question:** {question}

**Experiment Data:**
{research_content}

Provide a conversational, evidence-based answer focusing on MODEL BEHAVIOR:
- What the model actually said, chose, or did
- Specific examples from the data that answer the question
- Patterns or trends relevant to the question
- What this means about the model's capabilities

{IGNORE_INFRASTRUCTURE}

Keep it conversational and focused on answering the specific question. Think: "Here's what the
data shows..." not "Answer: The data indicates...".

Write 2-3 short paragraphs that answer the question clearly and provide supporting evidence.
"""


def format_highlights_for_answerer_prompt(highlights: list) -> str:
    """Format highlights for inclusion in the answerer prompt."""
    if not highlights:
        return ""

    lines = ["**Available highlights to cite:**", ""]
    for h in highlights:
        quote = h.quoted_text[:150] + "..." if len(h.quoted_text) > 150 else h.quoted_text
        lines.append(f"[{h.index}] {h.description}")
        lines.append(f'    "{quote}"')
        lines.append("")

    return "\n".join(lines)
