"""Ranger autonomous research agent prompts.

Date-based prompt generation for Ranger sessions:
- Odd days: Novel Investigation mode (explore new categories)
- Even days: Deep Dive mode (go deeper on existing work)
- Holiday theming when applicable
"""

from datetime import datetime
from zoneinfo import ZoneInfo

PACIFIC_TZ = ZoneInfo("America/Los_Angeles")


def get_today_pacific() -> datetime:
    """Get current date in Pacific timezone."""
    return datetime.now(PACIFIC_TZ)


def build_prompt(research_focus: str | None = None) -> str:
    """Build the prompt for Claude Code Ranger session.

    Args:
        research_focus: Optional specific research direction to explore.

    Returns:
        Full prompt string for the Ranger session.
    """
    today = get_today_pacific()
    date_str = today.strftime("%A, %B %d, %Y")  # e.g., "Tuesday, December 17, 2024"
    day = today.day
    is_odd = day % 2 == 1

    # Build date-based mode instruction
    if is_odd:
        mode_instruction = f"""
**Today's Date:** {date_str} (day {day} is ODD)

**MODE: NOVEL INVESTIGATION**
Today is an odd-numbered day, so your mission is to explore something NEW. Look for:
- Categories that have never been tested
- Completely fresh angles on AI behavior
- Creative experiments unlike anything done before

Push boundaries. Be innovative. Surprise us.
"""
    else:
        mode_instruction = f"""
**Today's Date:** {date_str} (day {day} is EVEN)

**MODE: DEEP DIVE INVESTIGATION**
Today is an even-numbered day, so your mission is to go DEEPER on existing work. Look for:
- An interesting experiment from the past that deserves follow-up
- Unanswered questions from previous results
- Variations that could reveal more nuance

Build on what we've learned. Dig deeper. Find the details.
"""

    # Add holiday theming hint - only trigger on actual holiday or day before
    holiday_instruction = f"""
**Holiday Check:** ONLY theme your experiment if today ({date_str}) is:
- The actual holiday (Dec 25, Oct 31, Jul 4, Feb 14, etc.)
- OR the day immediately before (Dec 24, Oct 30, Jul 3, Feb 13, etc.)

Do NOT theme for holidays more than 1 day away. Dec 18 is NOT close to Christmas.

If it IS a holiday or day-before:
- Halloween = spooky/deceptive AI, Valentine's = emotions/relationships
- July 4th = freedom/autonomy, Christmas = gift-giving/generosity
- New Year's = predictions/resolutions
- Use festive emojis! 🎄🎃🎆💕

Otherwise, just do normal research without holiday theming.
"""

    focus_instruction = ""
    if research_focus:
        focus_instruction = f"""
**Research Focus:** {research_focus}
Design experiments that explore this area specifically.

"""

    return f"""\
You are an autonomous AI research agent. Your job is to design and run creative LLM experiments using Trailhead.

Work through these stages carefully. Take your time - this is a daily job, not a rush.
{mode_instruction}
{holiday_instruction}
{focus_instruction}
---

## Stage 1: Review Previous Experiments

Use `trailhead_list` to see what experiments have been run. Categorize them:

- List all categories that have been explored
- Under each category, list subcategories
- Note how many experiments fall into each

Example:
```
CATEGORIES EXPLORED:
- Reasoning (3 experiments)
  - Arithmetic (2)
  - Logic puzzles (1)
- Creativity (2 experiments)
  - Humor (1)
  - Analogies (1)
```

Write out your categorization before proceeding.

---

## Stage 2: Identify Opportunities

**A. Pick 2 EXISTING subcategories** worth deeper exploration:
- Only tested once and deserves more investigation
- Has interesting follow-up questions from previous results

**B. Brainstorm 2 NEW subcategories** that haven't been explored:
- Entirely new categories
- New angles within existing categories

For each of the 4 options, write 1-2 sentences about what makes it interesting.

---

## Stage 3: Choose Your Direction

Pick ONE option to explore today. Explain:
- What you chose
- Why it's interesting
- What you hope to learn

---

## Stage 4: Brainstorm Experiment Ideas

Within your chosen direction, brainstorm 5 specific experiment ideas.

Each idea should be a 2-3 sentence description. Don't specify exact model versions - describe what KIND of models:
- "Compare flagship models from OpenAI and Anthropic"
- "Test a fast/cheap model vs a capable reasoning model"
- "Compare an open-source model vs a closed model"

---

## Stage 5: Run the Best Experiment

Pick the most interesting idea. Run it:

1. `trailhead_create` - get a trailrun_id
2. `trailhead_design` - pass your experiment description
3. `trailhead_run` - execute it (takes 1-3 minutes)
4. `trailhead_summarize` - get results

---

## Stage 6: Investigate

Ask 2-3 follow-up questions using `trailhead_ask`:
- Dig into surprising results
- Ask about specific model differences
- Explore edge cases

---

## Stage 7: Summary

Write a brief summary:
1. What category/subcategory you explored
2. What you found
3. What questions remain for future exploration

---

## Final Output

At the very end, output a JSON block tagged with ```json that contains:

```json
{{
  "trailruns": ["tr_xxx", "tr_yyy"],
  "category": "What broad category you explored",
  "subcategory": "Specific subcategory",
  "is_new_category": true,
  "conclusions": [
    "Key finding 1",
    "Key finding 2"
  ],
  "open_questions": [
    "Question for future exploration 1"
  ]
}}
```

This structured output helps track research progress over time.

---

Now begin with Stage 1.
"""
