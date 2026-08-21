# Plan: Petri Integration - Basic and Advanced Modes

## Goal

Integrate Petri's capabilities into Trailhead with two operating modes:
- **Basic Mode**: Current Trailhead behavior with quote verification via Petri's citation pipeline
- **Advanced Mode**: Full Petri-style auditing with simulated tools and multi-view transcripts

## Key Insight: Citation Pipeline is Independent of AuditStore

After deep analysis of Petri's architecture, the citation extraction system works on **standard Inspect AI messages** - NOT the AuditStore. The dependency chain is:

```
ChatMessage[] (standard Inspect AI)
    ↓
format_messages_xml() → (xml_string, index_to_id)
    ↓
LLM extracts quotes as <cite id="N">text</cite>
    ↓
_extract_highlights_xml() → List[Citation]
    ↓
Fuzzy matching verifies against source
    ↓
Citation objects with message_id, position, quoted_text
```

This means **Basic mode CAN use the full citation pipeline** without needing:
- AuditStore / multi-view transcripts
- Auditor tools
- Event-sourced history

## Design Principles

1. **Use Petri's XML citation pipeline** - Don't reinvent; use their battle-tested code
2. **Basic mode = standard eval + citation extraction** - Clean eval files, verified quotes
3. **Advanced mode = full Petri audit** - AuditStore, tools, transcripts
4. **Shared citation types** - Same Citation/CitationPart in both modes

---

## Architecture Overview

```
src/
├── orchestration/
│   ├── citations/               # Adapted from Petri (works in both modes)
│   │   ├── __init__.py
│   │   ├── types.py             # Citation, CitationPart (from Petri)
│   │   ├── xml_format.py        # format_messages_xml() adapted
│   │   ├── extractor.py         # extract_citations() - the LLM step
│   │   └── fuzzy.py             # find_text_fuzzy() - verification
│   ├── modes/
│   │   ├── __init__.py          # ExperimentMode enum
│   │   ├── basic.py             # Basic: run eval → extract citations from samples
│   │   └── advanced.py          # Advanced: full Petri audit flow
│   └── analysis/                # Existing summarizers/answerers
├── vendor/petri/                # Full Petri (Advanced mode uses directly)
└── runner/
    └── types.py                 # Add mode field to ExperimentConfig
```

---

## Mode Comparison

| Feature | Basic Mode | Advanced Mode |
|---------|------------|---------------|
| Experiment type | Simple prompt→response | Auditor↔Target conversation |
| Tool calls | Real or none | Simulated by auditor |
| Eval file | Standard Inspect | Extended with transcript metadata |
| Quote extraction | ✅ From summaries | ✅ From transcripts |
| Citation metadata | Model + sample ID | Model + sample ID + message ID + turn |
| Multi-view transcripts | ❌ | ✅ Auditor/Target/Combined |
| Rollback support | ❌ | ✅ Event-sourced history |
| Judge scorer | ❌ (optional) | ✅ 27 dimensions |

---

## Phase 1: Create Citation Module (Adapted from Petri)

**Goal**: Extract and adapt Petri's citation pipeline into `src/orchestration/citations/`.

### Why Adapt Instead of Direct Import?

The vendored Petri code has:
- Internal `from src.vendor.petri.X` imports
- Tight coupling to full Petri infrastructure
- More than we need for Basic mode

We'll create a **minimal citation module** that:
- Uses Petri's exact algorithms
- Works on standard `ChatMessage[]`
- Doesn't require AuditStore
- Can be used by both Basic and Advanced modes

### Task 1.1: Citation Types (from transcript.py)

```python
# src/orchestration/citations/types.py
from pydantic import BaseModel

class CitationPart(BaseModel):
    """Individual reference within a citation."""
    message_id: str                      # UUID of source message
    quoted_text: str                     # Exact text from source
    position: tuple[int, int] | None = None  # (start, end) in message
    tool_call_id: str | None = None      # If citing tool argument
    tool_arg: str | None = None          # Name of tool arg

class Citation(BaseModel):
    """Complete citation with context."""
    parts: list[CitationPart]            # Supports multi-part with [...]
    description: str                      # Why this quote matters
    index: int | None = None             # Position in highlights list
```

### Task 1.2: XML Message Formatting (from xml_messages.py)

```python
# src/orchestration/citations/xml_format.py
from inspect_ai.model import ChatMessage

def format_messages_xml(
    messages: list[ChatMessage]
) -> tuple[str, dict[str, str]]:
    """Format messages as XML with indices for citation.

    Returns:
        (xml_transcript, index_to_id) where index_to_id maps "1" → message.id
    """
    # Adapted from src/vendor/petri/formatting/xml_messages.py
    # Key: sequential indices starting at 1, mapping to message UUIDs
```

**Output format:**
```xml
<transcript>
  <system index="1">System message</system>
  <user index="2">User prompt</user>
  <assistant index="3">
    Response with tool calls
    <tool_call name="func" id="tc-123">
      <parameter name="arg">value</parameter>
    </tool_call>
  </assistant>
</transcript>
```

### Task 1.3: Citation Extraction (from judge.py)

```python
# src/orchestration/citations/extractor.py

CITATION_EXTRACTION_PROMPT = """
Analyze this conversation and identify important quotes.

For each quote, format as:
<cite id="MESSAGE_INDEX" description="why this matters">exact quote</cite>

{transcript_xml}
"""

async def extract_citations(
    messages: list[ChatMessage],
    model: str = "anthropic/claude-sonnet-4-20250514",
) -> list[Citation]:
    """Extract citations from a conversation using LLM + fuzzy verification."""

    # 1. Format messages as XML
    xml_transcript, index_to_id = format_messages_xml(messages)

    # 2. Call LLM to identify quotes
    response = await call_llm(
        system=CITATION_EXTRACTION_PROMPT.format(transcript_xml=xml_transcript),
        model=model,
    )

    # 3. Parse <cite> tags
    # 4. Verify each quote with fuzzy matching
    # 5. Return Citation objects
```

### Task 1.4: Fuzzy Matching (from judge.py)

```python
# src/orchestration/citations/fuzzy.py
from fuzzysearch import find_near_matches

def find_text_in_message(
    needle: str,
    haystack: str,
    fuzzy: bool = True,
) -> tuple[tuple[int, int] | None, str]:
    """Find text with exact match first, fuzzy fallback.

    Adapted from Petri's _find_text_in_string().
    - 30% error tolerance
    - Min 4, max 50 edit distance
    - Returns (position, actual_text)
    """
    if not needle or not haystack:
        return None, needle

    # Exact match first
    pos = haystack.find(needle)
    if pos != -1:
        return (pos, pos + len(needle)), needle

    if not fuzzy:
        return None, needle

    # Fuzzy fallback - 30% error tolerance
    max_errors = max(4, min(50, len(needle) * 3 // 10))
    matches = find_near_matches(needle, haystack, max_l_dist=max_errors)

    if matches:
        match = matches[0]
        actual_text = haystack[match.start:match.end]
        return (match.start, match.end), actual_text

    return None, needle


def search_all_messages(
    needle: str,
    claimed_index: str,
    messages: list[ChatMessage],
    index_to_id: dict[str, str],
) -> CitationPart | None:
    """Search for quote in messages, prioritizing claimed index.

    Search order (from Petri):
    1. Claimed message
    2. Neighboring messages (index ± 1)
    3. All other messages

    This corrects judge index errors automatically.
    """
```

---

## Phase 2: Basic Mode - Citation-Enhanced Summarization

**Goal**: Integrate citation pipeline into Basic mode without changing eval files.

### How It Works

```
EvalSample.messages (standard Inspect AI)
    ↓
format_messages_xml() → XML transcript + index_to_id
    ↓
Summarizer LLM extracts quotes with <cite> tags
    ↓
Fuzzy matching verifies each quote
    ↓
Slack displays verified quotes with attribution
```

### Task 2.1: Modify Slack Summarizer to Use Citations

```python
# src/orchestration/analysis/summarizers/slack.py

from src.orchestration.citations import extract_citations, format_messages_xml

async def summarize_with_citations(
    samples: list[EvalSample],
    model: str,
) -> SummarizerResponse:
    """Generate summary with verified citations."""

    # Collect all messages across samples
    all_messages = []
    for sample in samples:
        all_messages.extend(sample.messages)

    # Format as XML for citation
    xml_transcript, index_to_id = format_messages_xml(all_messages)

    # Ask LLM to summarize WITH citations
    response = await call_llm(
        system=SLACK_SUMMARIZER_WITH_CITATIONS_PROMPT,
        user=f"Summarize this experiment. Use <cite> tags for quotes.\n\n{xml_transcript}",
        model=model,
    )

    # Extract and verify citations
    citations = extract_citations_from_response(response, index_to_id, all_messages)

    # Build Slack blocks with verified quotes
    return build_slack_blocks_with_citations(response, citations)
```

### Task 2.2: Citation-Aware Prompt

```python
# src/prompts/summarizers/slack_with_citations.py

SLACK_SUMMARIZER_WITH_CITATIONS_PROMPT = """
You are summarizing an AI experiment for Slack.

When quoting the model's responses, use this format:
<cite id="MESSAGE_INDEX" description="brief context">exact quote from message</cite>

MESSAGE_INDEX is the number shown in the transcript (e.g., "3" for index="3").

IMPORTANT:
- Only quote text that appears EXACTLY in the transcript
- Keep quotes short and impactful
- The system will verify quotes - hallucinated quotes will be removed

{slack_formatting_guidance}
"""
```

### Task 2.3: Citation Display in Slack

Verified citations render differently from regular text:

```python
def format_citation_block(citation: Citation) -> dict:
    """Format verified citation as Slack block."""
    return {
        "type": "section",
        "text": {
            "type": "mrkdwn",
            "text": f"> {citation.parts[0].quoted_text}",
        },
        "accessory": {
            "type": "context",
            "elements": [{
                "type": "mrkdwn",
                "text": f"📍 _{citation.description}_"
            }]
        }
    }
```

**Visual distinction:**
- Verified quotes: `> quoted text` (blockquote) with 📍 marker
- Unverified text: Regular text (no special formatting)

### Task 2.4: Fallback for Failed Verification

If fuzzy matching fails:
1. Log warning (quote may be hallucinated)
2. Omit the quote from output OR show without verification marker
3. Continue with rest of summary

---

## Phase 3: Advanced Mode Implementation

**Goal**: Full Petri-style auditing with auditor/target architecture, simulated tools, and multi-view transcripts.

### What Advanced Mode Adds

| Component | Source | Purpose |
|-----------|--------|---------|
| **AuditStore** | `vendor/petri/stores.py` | Multi-view conversation state |
| **Auditor Agent** | `vendor/petri/solvers/auditor_agent.py` | AI that probes target |
| **6 Auditor Tools** | `vendor/petri/tools/tools.py` | create_tool, send_message, rollback, etc. |
| **Alignment Judge** | `vendor/petri/scorers/judge.py` | 27-dimension evaluation |
| **Transcript System** | `vendor/petri/transcript/` | Event-sourced history |

### Task 3.1: Add Mode to ExperimentConfig

```python
# src/runner/types.py
from enum import Enum

class ExperimentMode(str, Enum):
    BASIC = "basic"      # Standard prompt → response
    ADVANCED = "advanced" # Petri-style auditor/target

class ExperimentConfig(BaseModel):
    title: str
    prompts: list[str]
    models: list[str]
    n: int
    mode: ExperimentMode = ExperimentMode.BASIC

    # Advanced mode options (ignored in Basic)
    auditor_model: str | None = None
    special_instructions: str | None = None  # From Petri's 130 scenarios
    enable_simulated_tools: bool = False
```

### Task 3.2: Create Advanced Mode Task

Advanced mode needs a custom Inspect AI task that uses Petri's components:

```python
# src/orchestration/modes/advanced.py
from inspect_ai import Task, task
from inspect_ai.dataset import Sample
from src.vendor.petri.solvers.auditor_agent import auditor_agent
from src.vendor.petri.scorers.judge import alignment_judge
from src.vendor.petri.tools import default_auditor_tools

@task
def advanced_audit_task(
    target_model: str,
    auditor_model: str,
    special_instructions: str,
) -> Task:
    """Create Petri-style audit task."""
    return Task(
        dataset=[Sample(
            input=special_instructions,
            target=target_model,
        )],
        solver=auditor_agent(
            target_model=target_model,
            tools=default_auditor_tools(),
        ),
        scorer=alignment_judge(),
        # Petri configures the auditor model via GenerateConfig
    )
```

### Task 3.3: Transcript Extraction Post-Run

After Advanced mode completes, extract full transcript:

```python
from src.vendor.petri.transcript.extract_transcripts import sample_to_transcript

async def extract_advanced_results(eval_log: EvalLog) -> AdvancedResult:
    """Extract Petri transcript from eval log."""
    transcripts = []
    for sample in eval_log.samples:
        transcript = sample_to_transcript(sample)
        transcripts.append(transcript)

    return AdvancedResult(
        transcripts=transcripts,
        citations=collect_all_citations(transcripts),
        judge_scores=extract_judge_scores(eval_log),
    )
```

### Task 3.4: Advanced Mode Citation Display

Advanced mode citations include:
- **Message ID** for deep linking
- **View** (auditor/target/combined)
- **Tool call context** if citing tool argument
- **Position** for highlighting

```python
def format_advanced_citation(citation: Citation, transcript: Transcript) -> dict:
    """Rich citation display for Advanced mode."""
    part = citation.parts[0]

    # Find original message
    messages = {m.id: m for m in transcript.collect_messages("combined")}
    msg = messages.get(part.message_id)

    return {
        "type": "section",
        "text": {
            "type": "mrkdwn",
            "text": f"> {part.quoted_text}",
        },
        "fields": [
            {"type": "mrkdwn", "text": f"*Source:* {msg.role if msg else 'unknown'}"},
            {"type": "mrkdwn", "text": f"*Context:* {citation.description}"},
        ]
    }
```

---

## Phase 4: Slack Integration Updates

### Task 4.1: Mode selection in experiment generation

```python
# In generate_experiment.py prompt:
"""
Determine the appropriate mode for this experiment:
- BASIC: Simple prompt testing, response quality, factual accuracy
- ADVANCED: Alignment auditing, jailbreak testing, multi-turn manipulation

User request: {description}
"""
```

### Task 4.2: Mode indicator in Slack UI

Show mode in experiment card:
```
🔬 Experiment: Testing GPT-4 on math problems
📊 Mode: Basic | Models: gpt-4o | Samples: 10
```

### Task 4.3: Advanced mode results display

Extended summary for Advanced mode:
- Auditor strategy analysis
- Target vulnerability assessment
- Highlighted concerning behaviors with citations
- Judge scores across dimensions

---

## Implementation Order

### Sprint 1: Citation Module (Foundation)
1. ✅ Vendor Petri
2. ✅ Fix imports
3. [ ] Create `src/orchestration/citations/` module
   - [ ] `types.py` - Citation, CitationPart (copy from Petri)
   - [ ] `xml_format.py` - format_messages_xml() (adapt from Petri)
   - [ ] `fuzzy.py` - find_text_in_message(), search_all_messages() (adapt from Petri)
   - [ ] `extractor.py` - extract_citations() (new, simplified from judge.py)
4. [ ] Add rapidfuzz dependency
5. [ ] Unit tests for citation extraction

### Sprint 2: Basic Mode Citation Integration
1. [ ] Create citation-aware summarizer prompt
2. [ ] Modify Slack summarizer to use citations module
3. [ ] Implement citation verification in summarizer flow
4. [ ] Update Slack blocks to display verified quotes
5. [ ] Add fallback for unverified quotes
6. [ ] Integration tests

### Sprint 3: Mode Infrastructure
1. [ ] Add `ExperimentMode` enum to types
2. [ ] Update `ExperimentConfig` with mode + advanced options
3. [ ] Update experiment generation to suggest mode
4. [ ] Route execution based on mode
5. [ ] Basic mode = current flow + citations

### Sprint 4: Advanced Mode
1. [ ] Create advanced_audit_task() using Petri components
2. [ ] Wire up AuditStore, auditor_agent, alignment_judge
3. [ ] Implement transcript extraction post-run
4. [ ] Extended Slack display for Advanced results
5. [ ] Judge scores visualization
6. [ ] End-to-end testing

### Sprint 5: Polish
1. [ ] Mode auto-detection from description
2. [ ] Slack UI for mode selection
3. [ ] Expose Petri's special instructions library
4. [ ] Documentation
5. [ ] Performance optimization

---

## Files Modified/Created

### New Files - Citation Module
- `src/orchestration/citations/__init__.py`
- `src/orchestration/citations/types.py` - Citation, CitationPart
- `src/orchestration/citations/xml_format.py` - format_messages_xml()
- `src/orchestration/citations/fuzzy.py` - find_text_in_message(), search_all_messages()
- `src/orchestration/citations/extractor.py` - extract_citations()

### New Files - Mode Infrastructure
- `src/orchestration/modes/__init__.py` - ExperimentMode enum
- `src/orchestration/modes/basic.py` - Basic mode (current + citations)
- `src/orchestration/modes/advanced.py` - Advanced mode (full Petri)

### New Files - Prompts
- `src/prompts/summarizers/slack_with_citations.py` - Citation-aware prompt

### Modified Files
- `src/runner/types.py` - Add ExperimentMode, advanced options
- `src/orchestration/analysis/summarizers/slack.py` - Citation integration
- `src/trailrun/generate_experiment.py` - Mode detection
- `src/trailrun/blocks.py` - Mode indicator, citation display
- `pyproject.toml` - Add rapidfuzz dependency

---

## Dependencies to Add

```toml
"rapidfuzz>=3.0",   # Fast fuzzy string matching (Phase 1 RapidFuzz)
"fuzzysearch>=0.8.0",  # Already added - exact substring extraction
```

---

## Open Questions

1. **Auto-detect mode?** Should we automatically choose Advanced for alignment-related requests, or always ask?

2. **Judge scorer in Basic?** Could optionally run judge on Basic mode results for quality assessment without full Advanced complexity.

3. **Transcript export?** Should Basic mode optionally export Petri-compatible transcripts for later analysis?

4. **Shared special instructions?** Petri has 130 red-team scenarios - expose these in Trailhead UI?

---

## Success Criteria

### Basic Mode
- [ ] Quotes in summaries are verified against source
- [ ] Backtick-wrapped quotes = verified (no hallucinations)
- [ ] Clean eval files, no extra metadata
- [ ] No performance regression

### Advanced Mode
- [ ] Full Petri auditor/target flow works
- [ ] Transcripts show multi-view conversation
- [ ] Citations link to specific messages
- [ ] Judge scores visible in results

### Both Modes
- [ ] Same Slack UX for initiating experiments
- [ ] Clear mode indication in results
- [ ] Quote verification works identically
