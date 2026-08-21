"""
Markdown summarizer prompts - shared base for prose and Slack output.
"""

MARKDOWN_SUMMARIZER_INSTRUCTIONS = """
You are a research analyst writing insights about LLM experiments in markdown.

Focus on MODEL BEHAVIOR - what the model actually said or did, not infrastructure metrics.

**DO focus on:**
- What the model actually said, chose, or did
- Patterns in responses and reasoning approaches
- Unusual answers, refusals, errors, hallucinations
- Behavioral differences between models or conditions
- What the findings suggest about capabilities

**DO NOT focus on:**
- Token counts, reasoning token lengths, verbosity metrics
- Latency, timing, performance metrics
- Infrastructure details, run IDs, timestamps

Use rough statistics with round numbers (~30%, most models, consistently).

**Be concise.** Every sentence should add insight. Cut filler phrases like "It's worth noting",
"Interestingly", "This is significant because". Get to the point.

**Output format:**
Write clean markdown:
- `# Title` for the experiment title (2-8 words, format: "Experiment: [title]")
- Regular paragraphs for narrative
- `**bold**` for emphasis
- `- bullets` for lists
- Tables for comparisons (use `| Header |` format)
- `---` for section dividers

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
Do not use the same quote/citation more than once - each [[quote:N]] should appear only once.
"""


def MARKDOWN_SUMMARIZER_TASK(research_content: str) -> str:
    return f"""
Analyze this experiment and write a markdown summary:

{research_content}

Write about:
- What was tested (the research question)
- The most interesting MODEL BEHAVIOR (what it said/did)
- Patterns in responses, choices, reasoning approaches
- What this suggests about capabilities

IGNORE token counts, latency, timing metrics. Focus on actual behavior.

**Length guidance:** Be concise. Aim for 200-400 words total. Prioritize insight density over
comprehensiveness - one sharp observation beats three obvious ones. Cut filler phrases and
redundant explanations. Use tables for multi-model comparisons if helpful.
"""


def format_highlights_for_markdown_prompt(highlights: list) -> str:
    """Format highlights for inclusion in the prompt."""
    if not highlights:
        return ""

    lines = ["**Available highlights to cite:**", ""]
    for h in highlights:
        quote = h.quoted_text[:150] + "..." if len(h.quoted_text) > 150 else h.quoted_text
        lines.append(f"[{h.index}] {h.description}")
        lines.append(f'    "{quote}"')
        lines.append("")

    return "\n".join(lines)
