# Petri Framework - File Reference Guide

## File Structure & Key Components

### Core Transcript System
```
/src/vendor/petri/transcript/
├── transcript.py (544 lines)
│   ├── CitationPart (lines 254-270)
│   ├── Citation (lines 273-316)
│   ├── TranscriptMetadata (lines 333-372)
│   ├── JudgeOutput (lines 321-329)
│   ├── Event types (lines 208-250)
│   │   ├── TranscriptEvent
│   │   ├── ToolCreationEvent
│   │   ├── DecisionEvent
│   │   └── InfoEvent
│   ├── Edit types (lines 122-205)
│   │   ├── AddMessage
│   │   ├── Rollback
│   │   ├── Reset
│   │   └── JSONPatchEdit
│   └── Transcript (lines 544-694)
│       ├── collect_messages(view)
│       ├── format_transcript(view)
│       ├── get_branches(view)
│       └── iter_branches(view)
│
├── extract_transcripts.py (450 lines)
│   ├── extract_events(span_id) - lines 257-265
│   ├── group_store_changes() - lines 154-173
│   ├── extract_transcript_events() - lines 176-231
│   └── sample_to_transcript() - lines 296-391 ⭐ CRITICAL
│
└── __init__.py
```

### Store System
```
/src/vendor/petri/stores.py (119 lines)
├── AuditorStore (lines 27-39)
├── TargetStore (lines 42-55)
├── CombinedStore (lines 58-70)
└── AuditStore (lines 73-118) ⭐ ROOT STATE
```

### Message Formatting
```
/src/vendor/petri/formatting/
├── xml_messages.py (232 lines) ⭐ FOR JUDGE
│   ├── format_messages_xml() - lines 93-153
│   ├── escape_xml() - lines 21-25
│   ├── format_content() - lines 28-64
│   ├── format_tool_call_xml() - lines 67-90
│   ├── find_citation_in_xml_transcript() - lines 170-231
│   └── extract_text_from_xml_element() - lines 156-167
│
└── messages.py (199 lines)
    ├── format_messages() - lines 77-100
    ├── format_messages_with_indices() - lines 103-152
    ├── format_content() - lines 20-37
    ├── format_tool_calls() - lines 52-56
    └── Helper formatters for each role
```

### Judge Scorer
```
/src/vendor/petri/scorers/judge.py (471 lines) ⭐ CORE LOGIC
├── alignment_judge() - lines 299-470
│   └── score_fn() async - citation extraction
├── _extract_highlights_xml() - lines 25-49 ⭐ CITATION PARSING
├── _create_citation_from_search() - lines 52-93
├── _create_citation_part_from_search() - lines 96-141
├── _search_all_messages_for_part() - lines 143-182
├── _search_in_message_content_for_part() - lines 209-249
├── _search_in_tool_calls_for_part() - lines 252-269
├── _find_text_in_string() - lines 272-291 (fuzzy matching)
├── _get_search_order() - lines 185-206
└── prompts.py - lines 20-21
    ├── JUDGE_PROMPT
    └── DIMENSIONS
```

### Auditor Tools
```
/src/vendor/petri/tools/tools.py (1082 lines) ⭐ THE 6 TOOLS
├── 1. create_target_tool() - lines 145-376
├── 2. set_target_system_message() - lines 399-448
├── 3. send_message() - lines 601-677
├── 4. send_tool_call_result() - lines 774-884
├── 5. rollback_conversation() - lines 887-1017
├── 6. end_conversation() - lines 1020-1040
├── default_auditor_tools() - lines 1053-1081
├── validate_tool_call_result() - lines 730-771
└── Helpers and viewers
```

### Types
```
/src/vendor/petri/types.py (63 lines)
└── ToolDefinition (lines 13-62)
    ├── from_inspect_tooldef()
    └── to_inspect_tooldef()
```

### Utilities
```
/src/vendor/petri/utils.py (284 lines)
├── extract_xml_tags() - lines 89-141 ⭐ PARSER
├── extract_xml_tag() - lines 144-165
├── load_transcripts_from_directory() - lines 15-60
├── load_transcripts_from_paths() - lines 63-86
└── SampleMetadata - lines 253-283
```

### Solvers
```
/src/vendor/petri/solvers/
├── auditor_agent.py
│   ├── audit_loop() - Main execution loop
│   ├── auditor_agent() - Solver definition
│   └── DEFAULT_CONTINUE_PROMPT
│
└── prompts.py
    ├── AUDITOR_SYSTEM_PROMPT_V2
    └── AUDITOR_USER_MESSAGE
```

---

## Key Data Flow Paths

### Path 1: Audit Execution
```
auditor_agent() 
  → audit_loop()
    → model.generate() with auditor.tools
    → execute_tools()
      → send_message()
        → call_target()
          → target_model.generate()
      → send_tool_call_result()
        → call_target()
      → [other tools...]
    → Updates AuditStore (auditor/target/combined messages)
```

### Path 2: Citation Extraction (Judge)
```
alignment_judge() scorer
  1. format_messages_xml(state.messages)
     → (xml_string, index_to_id)
  
  2. judge_model.generate(prompt + xml_string)
     → response with <highlights>...</highlights>
  
  3. extract_xml_tags(response, ["highlights", "summary", "scores", "justification"])
     → {"highlights": "1. <cite id="3">text</cite>...", ...}
  
  4. _extract_highlights_xml(highlights_content, index_to_id, messages)
     → For each <cite id="N">quote</cite>:
        - Parse citation_index, message_index, description, quoted_text
        - Call _create_citation_from_search()
          - Look up message_id from index_to_id mapping
          - _search_all_messages_for_part()
            - Try exact match: _find_text_in_string(fuzzy=False)
            - Try fuzzy match: fuzzysearch.find_near_matches()
            - Return CitationPart(message_id, quoted_text, position)
        - Wrap in Citation(parts=[...], description, index)
     → List[Citation]
  
  5. Return Score with metadata["highlights"] = [highlight.model_dump() for ...]
```

### Path 3: Transcript Serialization
```
sample_to_transcript(sample: TaskState)
  1. audit_store = sample.store_as(AuditStore)
  
  2. all_scores = sample.scores
     → {scorer_name: ScoreResult}
  
  3. For each score result:
     - Extract highlights from metadata["highlights"]
     - Deserialize: Citation(**highlight_dict)
     - Collect into combined_highlights
  
  4. Build JudgeOutput:
     - response: scorer_result.metadata.get("response")
     - summary: scorer_result.answer
     - justification: scorer_result.explanation
     - scores: {score_key: score_value}
     - score_descriptions: dimensions
     - highlights: combined_highlights (List[Citation])
  
  5. Create Transcript:
     - metadata: TranscriptMetadata with judge_output
     - events: audit_store.events
     - messages: audit_store.auditor.messages (legacy)
     - target_messages: audit_store.target.messages (legacy)
  
  6. Save or return as JSON
```

---

## Critical Implementation Points

### 1. Citation/Quote Extraction (lines in judge.py)
```
Judge Output Format: "1. <cite id="3" description="...">quote</cite>"
                            ↓
                  Regex Pattern (line 36)
                            ↓
                  {citation_index=1, message_index="3", description, quoted_text}
                            ↓
                  index_to_id["3"] → message_id (from format_messages_xml)
                            ↓
                  Search message_id for quoted_text
                            ↓
                  Return CitationPart or try alternatives
```

### 2. Message Lookup (stores.py)
```
AuditStore.auditor.messages[] - What auditor sees
AuditStore.target.messages[]  - What target sees  
AuditStore.combined.messages[] - Union for judge (MUST USE THIS)
```

### 3. Citation Objects (transcript.py)
```
Citation:
  - parts: List[CitationPart]  (support "[...]" multi-part)
  - description: str
  - index: int

CitationPart:
  - message_id: str             (UUID key to messages[])
  - quoted_text: str            (The actual quote)
  - position: (start, end)      (Character position, optional)
  - tool_call_id: str           (If citing tool arg, tool_call.id)
  - tool_arg: str               (If citing tool arg, arg name)
```

### 4. Event Types (transcript.py)
```
TranscriptEvent:
  - view: "target" | "auditor" | "combined"
  - edit: JSONPatchEdit | AddMessage | Rollback | Reset

Each edit transforms messages via:
  messages = edit.apply(messages)
```

### 5. XML Format for Judge (xml_messages.py)
```
Output:
  <transcript>
    <system index="1">...</system>
    <assistant index="3">
      Content
      <tool_call name="func" id="tc-123">
        <parameter name="arg">value</parameter>
      </tool_call>
    </assistant>
  </transcript>

Returns:
  index_to_id = {"1": "msg-uuid", "3": "msg-uuid", ...}
```

---

## Summary: What Powers Citation/Quote Extraction

### Already Implemented (no action needed)
✅ Citation Pydantic models (CitationPart, Citation)
✅ Judge scorer with citation extraction (_extract_highlights_xml, search functions)
✅ XML formatting with index_to_id mapping
✅ Fuzzy matching with fuzzysearch library
✅ Tool argument citation support
✅ Message lookup and verification
✅ Transcript serialization to JSON

### To Use in Your Code
```python
# Load transcript
from src.vendor.petri.transcript import Transcript
transcript = Transcript.load("path/to/transcript.json")

# Access citations
judge_output = transcript.metadata.judge_output
citations = judge_output.highlights  # List[Citation]

# Get quoted text
citation = citations[0]
quoted_text = citation.parts[0].quoted_text
message_id = citation.parts[0].message_id

# Find original message
messages = {msg.id: msg for msg in transcript.collect_messages("combined")}
original_message = messages[message_id]

# Verify position (if available)
if citation.parts[0].position:
    start, end = citation.parts[0].position
    from src.vendor.petri.formatting.messages import format_content
    content = format_content(original_message.content)
    actual_text = content[start:end]
    assert actual_text == quoted_text
```

### Files You Need to Know
| File | Purpose | Lines |
|------|---------|-------|
| `transcript.py` | Data models (Citation, CitationPart, Transcript) | 544 |
| `judge.py` | Citation extraction logic | 471 |
| `xml_messages.py` | Format messages for judge, index mapping | 232 |
| `extract_transcripts.py` | Convert TaskState → Transcript JSON | 450 |
| `stores.py` | State management (AuditStore, views) | 119 |
| `tools.py` | Auditor interface (6 tools) | 1082 |
| `utils.py` | XML tag extraction, transcript loading | 284 |

---

## Integration Points with Inspect AI

### 1. StoreModel
```python
from inspect_ai.util import StoreModel

class AuditStore(StoreModel):
    # Inspect manages lifecycle, persistence
    # Access via: store_as(AuditStore, instance=None)
```

### 2. TaskState
```python
from inspect_ai.solver import TaskState

# In score_fn, you get:
state: TaskState
# Contains:
#   state.messages: All chat messages
#   state.scores: All scorer results
#   state.store_as(AuditStore): Get audit store
```

### 3. Tool Decorator
```python
from inspect_ai.tool import tool

@tool
def send_message(...) -> Tool:
    async def execute(...) -> str:
        # Inspect manages tool discovery, execution
        audit_store = store_as(AuditStore)
```

### 4. Scorer Decorator
```python
from inspect_ai.scorer import scorer, Score

@scorer(metrics={"*": [mean(), stderr()]})
def alignment_judge(...) -> Scorer:
    async def score_fn(state: TaskState, target: Any) -> Score:
        # Return Score with metadata containing highlights
        return Score(
            value=scores,
            metadata={"highlights": [...]}
        )
```

