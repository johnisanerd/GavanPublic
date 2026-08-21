"""Markdown format answerer - base for answering questions about experiments.

Returns markdown with [[quote:N]] tags that can be:
- Processed via process_quote_tags() for final markdown output
- Converted via markdown_to_slack_blocks() for Slack output
"""

import logging

from src.config import settings
from src.orchestration.analysis.summarizers.shared import (
    SummarizerOptions,
    process_quote_tags,
    sanitize_quotes,
    truncate_research,
)
from src.orchestration.client import call_llm
from src.prompts.answerers.markdown import (
    MARKDOWN_ANSWERER_INSTRUCTIONS,
    MARKDOWN_ANSWERER_TASK,
    format_highlights_for_answerer_prompt,
)

logger = logging.getLogger(__name__)


async def answer_to_markdown(
    research_content: str,
    question: str,
    model: str,
    timeout: float = 30.0,
    options: SummarizerOptions | None = None,
    expand_quotes: bool = True,
) -> str:
    """Answer a question about experiment data in markdown format.

    This is the base answerer - generates clean markdown that can be:
    - Used directly for final markdown output (expand_quotes=True)
    - Converted to Slack blocks via markdown_to_slack_blocks() (expand_quotes=False)

    Includes quote sanitization: verifies "..." quotes against source content
    and converts them to [[quote:N]] tags or single quotes.

    Args:
        research_content: Raw research text to analyze
        question: Specific question to answer
        model: Model name to use
        timeout: Request timeout in seconds
        options: Optional answerer options (includes highlights, source_content)
        expand_quotes: If True, expand [[quote:N]] tags to blockquotes.
                      If False, leave tags for downstream processing (e.g., Slack).

    Returns:
        Markdown formatted answer with sanitized quotes

    Raises:
        ValueError: If answering fails
    """
    options = options or SummarizerOptions()

    # Truncate research if too large
    max_chars = settings.max_research_tokens * 4
    truncated_content = truncate_research(research_content, max_chars=max_chars)
    char_count = len(truncated_content)
    token_estimate = char_count // 4
    logger.info(f"Processing {char_count} chars (~{token_estimate} tokens) for question")

    # Build prompt
    user_prompt = MARKDOWN_ANSWERER_TASK(truncated_content, question)

    # Add highlights if available
    if options.highlights:
        highlights_text = format_highlights_for_answerer_prompt(options.highlights)
        user_prompt += f"\n\n{highlights_text}"

    # Call LLM
    response = await call_llm(
        model=model,
        messages=[
            {"role": "system", "content": MARKDOWN_ANSWERER_INSTRUCTIONS},
            {"role": "user", "content": user_prompt},
        ],
        timeout=timeout,
    )

    content = response.choices[0].message.content
    if not content:
        raise ValueError("Empty response from model")

    markdown = content.strip()

    # Sanitize quotes: verify "..." against source, convert to [[quote:N]] or '...'
    # Use provided source_content or fall back to research_content
    source = options.source_content or research_content
    sanitized, _ = sanitize_quotes(
        markdown,
        source,
        options.highlights,
    )

    # Optionally expand [[quote:N]] tags to blockquotes
    if expand_quotes:
        return process_quote_tags(sanitized, options.highlights)

    return sanitized
