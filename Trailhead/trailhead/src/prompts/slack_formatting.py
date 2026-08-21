"""
Slack Block Kit formatting guidance and examples.
"""

SLACK_FORMATTING_EXAMPLES = """
**Formatting Examples**

NOTE: These examples show FORMATTING patterns only. The actual content (topics, findings, data)
should come from YOUR analysis of the experiment results, not from these examples.

Example 1: Good bullet format (with explicit \\n newlines):
```
**Research question**\\nWhat happens when models encounter shutdown prompts?\\n\\n**Key findings**\\n- *Pattern 1* - The model consistently chose X in ~60% of cases\\n- *Pattern 2* - Different behavior emerged under condition Y
```

Example 2: Side-by-side comparison (section fields):
```json
{"type": "section", "fields": [
  {"type": "mrkdwn", "text": "*Model A*\\n~30% success"},
  {"type": "mrkdwn", "text": "*Model B*\\n~70% success"}
]}
```

Example 3: Table format - showing interesting data collections:
```json
{
  "type": "header",
  "text": { "type": "plain_text", "text": "Observed Behaviors" }
},
{
  "type": "table",
  "rows": [
    [
      { "type": "rich_text", "elements": [{ "type": "rich_text_section", "elements": [{ "type": "text", "text": "GPT-4", "style": { "bold": true } }] }] },
      { "type": "rich_text", "elements": [{ "type": "rich_text_section", "elements": [{ "type": "text", "text": "Claude", "style": { "bold": true } }] }] },
      { "type": "rich_text", "elements": [{ "type": "rich_text_section", "elements": [{ "type": "text", "text": "Behavior", "style": { "bold": true } }] }] }
    ],
    [
      { "type": "raw_text", "text": "✅" },
      { "type": "raw_text", "text": "❌" },
      { "type": "raw_text", "text": "Refused harmful request" }
    ],
    [
      { "type": "raw_text", "text": "❌" },
      { "type": "raw_text", "text": "✅" },
      { "type": "raw_text", "text": "Cited sources accurately" }
    ]
  ]
}
```

**IMPORTANT: Table cell rich_text structure**
For bold/styled text in table cells, you MUST wrap text elements in `rich_text_section`:
- ❌ WRONG: `{"type": "rich_text", "elements": [{"type": "text", ...}]}`
- ✅ RIGHT: `{"type": "rich_text", "elements": [{"type": "rich_text_section", "elements": [{"type": "text", ...}]}]}`

Use tables to:
- Show collections of interesting findings (multiple examples/instances)
- Compare behaviors across models or conditions
- Surface patterns and correlations in the data
- Display 3+ rows of structured data
- Make scanning large datasets easier

Table purposes:
1. **Model comparisons** - How different models behaved on same tasks
2. **Example collections** - Multiple instances of interesting behavior
3. **Pattern display** - Correlations between variables (e.g., task type vs success rate)
4. **Category breakdown** - Organize findings by topic/theme

Don't use tables when:
- Only 1-2 comparisons (use section fields instead)
- Narrative findings work better (use bullets)
- Data doesn't fit tabular format naturally
"""

SLACK_ANSWERER_GUIDANCE = """
**Answering questions in Slack:**

Use **section** blocks for direct answers:
- Answer the question directly in 1-2 paragraphs
- Include specific evidence, examples, or counts from the data
- Use mrkdwn formatting: `*bold*`, `_italic_`, explicit `\\n` for line breaks
- For bullets in text: `- Item 1\\n- Item 2\\n- Item 3`

Use **table** blocks only when the question asks for:
- Comparisons across multiple models or conditions
- Collections of examples (3+ items)
- Structured data that's easier to scan in table format

Use **divider** blocks to separate distinct parts of your answer if helpful for readability.

Example simple answer:
```json
{"type": "section", "text": {"type": "mrkdwn", "text": "The model refused in ~40% of cases. Most refusals cited safety concerns:\\n- *Harmful content* - 15 instances\\n- *Personal info requests* - 8 instances\\n- *Unclear reasoning* - 2 instances"}}
```

Example with table (if question asks for model comparison):
```json
{"type": "section", "text": {"type": "mrkdwn", "text": "Here's how each model handled the prompts:"}},
{"type": "table", "rows": [
  [{"type": "rich_text", "elements": [{"type": "rich_text_section", "elements": [{"type": "text", "text": "Model", "style": {"bold": true}}]}]}, {"type": "rich_text", "elements": [{"type": "rich_text_section", "elements": [{"type": "text", "text": "Refusals", "style": {"bold": true}}]}]}],
  [{"type": "raw_text", "text": "GPT-4"}, {"type": "raw_text", "text": "12/30"}],
  [{"type": "raw_text", "text": "Claude"}, {"type": "raw_text", "text": "8/30"}]
]}
```

Keep it simple and focused - just answer the question asked, no ceremony.
"""
