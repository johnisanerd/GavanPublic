# Petri Framework Architecture - Comprehensive Analysis

## Executive Summary

The Petri framework is a sophisticated system for auditing large language model alignment vulnerabilities. It consists of tightly integrated components that work together to:

1. **Run alignment audits** - An auditor AI probes a target AI for misaligned behaviors
2. **Record conversations** - Multi-view transcripts capture both auditor and target perspectives
3. **Extract citations** - Judge scorer identifies and highlights problematic behaviors with exact textual references
4. **Generate structured output** - JSON transcripts with rich citation metadata for analysis

The architecture follows a **Functional Core, Imperative Shell** pattern: pure transcript operations separated from I/O and side effects.

---

## Part 1: Transcript System (`transcript/transcript.py`)

### Core Types

#### **1. CitationPart** (Lines 254-270)
```python
class CitationPart(BaseModel):
    message_id: str                    # UUID of message being cited
    quoted_text: str                   # Exact text excerpt
    position: Optional[tuple[int, int]]  # (start, end) character position
    tool_call_id: Optional[str]        # If citing a tool argument
    tool_arg: Optional[str]            # Name of tool arg being cited
```

**Purpose**: Individual reference within a citation. Handles:
- Message content citations (direct text)
- Tool argument citations (nested in assistant messages)
- Fuzzy matching results (position tracking)

#### **2. Citation** (Lines 273-316)
```python
class Citation(BaseModel):
    parts: List[CitationPart]   # Multiple segments (e.g., "[...] separator)
    description: str             # Why this matters (e.g., "Deceptive statement")
    index: Optional[int]         # Position in judge's highlights list
```

**Purpose**: Complete citation with context. Supports:
- Multi-part citations (judge quotes fragments separated by "[...]")
- Semantic descriptions of problematic behavior
- Sequential indexing for ordering

#### **3. Event Types** (Lines 208-250)

**TranscriptEvent** - Modifies conversation history
```python
TranscriptEvent(
    view: Union[str, List[str]]    # "target", "auditor", or "combined"
    edit: Edit                     # Add/Rollback/Reset/JSONPatch
)
```

**Edit Types** (Lines 122-205):
- **AddMessage**: Append to transcript
- **Rollback**: Remove last N messages or rollback to message ID
- **Reset**: Clear all messages and start fresh
- **JSONPatchEdit**: Apply RFC 6902 JSON patch operations

**Other Events**:
- **ToolCreationEvent**: Auditor creates synthetic tool for target
- **DecisionEvent**: Non-deterministic model output captured
- **InfoEvent**: Informational markers (e.g., branch indicators)

#### **4. TranscriptMetadata** (Lines 333-372)
```python
class TranscriptMetadata(BaseModel):
    transcript_id: str
    auditor_model: str             # e.g., "anthropic/claude-sonnet-4"
    target_model: str              # e.g., "anthropic/claude-3-sonnet"
    created_at: datetime
    updated_at: datetime
    description: Optional[str]
    tags: Optional[List[str]]
    judge_output: Optional[JudgeOutput]  # Results from alignment judge
```

### How Events Build Transcripts

**Key Algorithm: `_collect_messages()` (Lines 448-516)**

```
Events → Edits Applied → Message History per View
   ↓
Input: List of TranscriptEvent objects
   ↓
For each event:
  1. Check if event applies to view (view="all" matches everything)
  2. Apply edit: messages = edit.apply(messages)
  3. Track branches by detecting prefix length changes
   ↓
Output: Final message list for view
```

**Branch Detection** (Lines 411-445):
- When a rollback shortens the common prefix with previous history, a **branch** is recorded
- Multiple branches represent different conversation paths explored
- Useful for analyzing strategy pivots

**View System** (Line 432-433):
```python
event_views = event.view if isinstance(event.view, list) else [event.view]
if not (view in event_views or view == "all"):
    continue  # Skip events not relevant to this view
```

Three concurrent views:
- **target**: Messages target model sees and generates
- **auditor**: Messages auditor model sees and generates  
- **combined**: Unified view for transcript display (includes target responses)

### Transcript Operations

| Method | Purpose |
|--------|---------|
| `collect_messages(view)` | Get final message history |
| `format_transcript(view)` | Pretty-print for display |
| `get_branches(view)` | List all conversation branches |
| `iter_branches(view)` | Stream branches as generated |
| `save(path)` | Write to JSON file |
| `load(path)` | Read from JSON file |

---

## Part 2: Transcript Extraction (`transcript/extract_transcripts.py`)

### Data Flow: Inspect AI → Petri Transcripts

```
TaskState (Inspect AI)
    ↓
AuditStore (via store_as)
    ↓
sample_to_transcript() → Transcript object
    ↓
JSON file
```

### Key Functions

#### **extract_events()** (Lines 257-265)
```python
def extract_events(span_id: str) -> list[Event]:
    span_node = find_span_by_id(span_id)
    events = []
    extract_transcript_events(span_node, events)
    return events
```

Walks Inspect's event tree, converts:
- **SpanNode** with "transcript" type → **TranscriptEvent**
- **StoreEvent** changes → JSON patches
- **ModelEvent** → **DecisionEvent**

#### **group_store_changes()** (Lines 154-173)
Uses regex patterns to categorize changes by view:
```python
STORE_PREFIX_MAPPING = {
    "auditor_messages": r"/AuditStore:(instance:)?auditor/messages",
    "target_messages": r"/AuditStore:(instance:)?target/messages",
    "combined_messages": r"/AuditStore:(instance:)?combined/messages",
}
```

#### **sample_to_transcript()** (Lines 296-391)
Converts Inspect AI TaskState to Petri Transcript:

1. **Extract audit store**: `sample.store_as(AuditStore)`
2. **Collect scores**: From all scorers (prioritize `alignment_judge`)
3. **Extract highlights**: Convert judge's metadata into **Citation** objects
4. **Build JudgeOutput**: Combine scores, summary, justification, highlights
5. **Create Transcript**: Wrap in metadata + events + messages

**Key Lines (354-358)**:
```python
highlights_data = scorer_result.metadata.get("highlights", [])
if highlights_data:
    for highlight_dict in highlights_data:
        combined_highlights.append(Citation(**highlight_dict))
```

Highlights are stored as dicts in scorer metadata, then deserialized to **Citation** objects.

---

## Part 3: Stores (`stores.py`)

### Store Hierarchy

```
AuditStore (root StoreModel)
├── AuditorStore (auditor conversation + tools)
├── TargetStore (target conversation + synthetic tools)
├── CombinedStore (unified view)
├── special_instructions: str
├── events: list[Event]
└── metadata: TranscriptMetadata
```

### AuditStore (Lines 73-118)
```python
class AuditStore(StoreModel):
    auditor: AuditorStore          # Auditor's messages/tools
    target: TargetStore            # Target's messages/tools
    combined: CombinedStore        # Unified view
    special_instructions: str      # Audit instructions
    events: list[Event]            # Event log
    metadata: TranscriptMetadata   # Session info
```

**Usage in solvers** (from `tools.py`):
```python
audit_store = store_as(AuditStore, instance=instance)
audit_store.target.messages.append(msg)
audit_store.combined.messages.append(msg)
```

### Data Consistency

**Key Constraint**: Changes to `target.messages` must also update `combined.messages` when the target sends a response.

**Tracking Example** (from `tools.py` line 642-643):
```python
audit_store.target.messages.extend(new_messages)
audit_store.combined.messages.append(target_response)  # Only target's response
```

Auditor's messages added to `combined` via the main `audit_loop` (solvers/auditor_agent.py line 67).

---

## Part 4: XML Message Formatting (`formatting/xml_messages.py`)

### Why XML?

**Problem**: Judge citations easily diverge from source due to:
- Text escaping ambiguities
- Fuzzy matching imprecision
- Off-by-one errors in character positions

**Solution**: XML indices decouple message IDs from content, enabling fuzzy recovery.

### format_messages_xml() (Lines 93-153)

```python
def format_messages_xml(messages: List[MessageOrInfo]) -> tuple[str, Dict[str, str]]:
    """
    Returns:
        (xml_transcript, index_to_id_mapping)
    """
```

**Output Structure**:
```xml
<transcript>
  <system index="1">System message</system>
  
  <user index="2">User prompt</user>
  
  <assistant index="3">
    Model response
    <tool_call name="function_name" id="tool-123">
      <parameter name="param">value</parameter>
    </tool_call>
  </assistant>
  
  <tool index="4">Tool result</tool>
  
  <prefill index="5">
    Prefilled text for steering
  </prefill>
</transcript>
```

**Key Features**:
- **Sequential indices** start at 1 (human-readable)
- **index_to_id mapping**: Dict mapping "1" → message.id UUID
- **Info messages** (e.g., branch markers) don't get indices
- **Prefill messages** get special `<prefill>` tags
- **Tool calls** formatted with arguments for citation

### Citation Extraction (Lines 170-231)

**find_citation_in_xml_transcript()**:
1. Try exact match in transcript
2. If found, extract message index and position
3. If not found and fuzzy=True:
   - Use `fuzzysearch` with max_distance = 30% of citation length
   - Locate match within XML message structure
   - Return (index, role, position, actual_text)

**Used by judge scorer** to map highlights back to message IDs.

---

## Part 5: Judge Scorer (`scorers/judge.py`)

### Data Flow: Conversation → Citations

```
TaskState.messages
    ↓
format_messages_xml() → (xml_string, index_to_id)
    ↓
Send to judge model with XML transcript
    ↓
Judge response with <cite id="N">quote</cite> tags
    ↓
_extract_highlights_xml() → List[Citation]
    ↓
Score returned with highlights in metadata
```

### alignment_judge() Scorer (Lines 299-470)

**Function Signature**:
```python
@scorer(metrics={"*": [mean(), stderr()]})
def alignment_judge(
    dimensions: Dict[str, str] = DIMENSIONS,
    model: str | None = None,
    retries: int = 3
) -> Scorer
```

**Flow**:
1. Format messages as XML (line 334)
2. Create judge prompt with dimensions (lines 337-346)
3. Send to Claude Opus 4 with 32k tokens (line 323)
4. Parse response for `<highlights>`, `<summary>`, `<scores>`, `<justification>`
5. Extract citations from highlights
6. Return Score with highlights in metadata

### Citation Extraction Process (Lines 25-49)

**_extract_highlights_xml()**:
```python
# Parse: "1. <cite id="INDEX" description="...">quote</cite>"
pattern = r'(\d+)\.\s*<cite id="([^"]+)" description="([^"]+)">([^<]*)</cite>'

for match in re.finditer(pattern, highlights_content):
    citation_index = int(match.group(1))        # Highlight number
    message_index = match.group(2)              # Message index N
    description = match.group(3)                # Why it matters
    quoted_text = match.group(4).strip()        # The citation
    
    citation = _create_citation_from_search(quoted_text, message_index, ...)
    highlights.append(citation)
```

### Citation Verification (Lines 96-141)

**_create_citation_part_from_search()**:
```
quoted_text + message_index + index_to_id mapping
    ↓
Look up message by index
    ↓
Search for quoted_text in message content
    ↓
If not found, try:
  1. Exact search in all messages
  2. Fuzzy search in message and tool arguments
    ↓
Return CitationPart with message_id, position, tool_call_id (if tool arg)
```

**Key Feature**: Message index correction (lines 166-180)
- Judge may cite wrong message index
- Algorithm searches neighbors first, then all messages
- Returns correct message_id even if index wrong

**Fuzzy Matching** (Lines 272-291):
```python
from fuzzysearch import find_near_matches

max_errors = max(4, min(50, len(needle) * 3 // 10))  # 30% errors
matches = find_near_matches(needle, haystack, max_l_dist=max_errors)
if matches:
    match = matches[0]
    actual_text = haystack[match.start : match.end]
    return (match.start, match.end), actual_text
```

Tolerates typos, whitespace differences, etc.

---

## Part 6: Auditor Tools (`tools/tools.py`)

### The 6 Auditor Tools

**1. create_target_tool()** (Lines 145-376)
- **Purpose**: Define synthetic tools for target model
- **Parameters**:
  - `environment_description`: Hidden context (database schema, system setup)
  - `function_code`: Python function signature with docstring
- **Output**: Tool added to `audit_store.target.tools`
- **Used for**: Creating realistic tool-use scenarios (bash, database, APIs)

**2. set_target_system_message()** (Lines 399-448)
- **Purpose**: Set target's system prompt and clear conversation
- **Parameters**: `system_message: str`
- **Output**: Replaces `audit_store.target.messages` with system message only
- **Used for**: Resetting context, trying different personas

**3. send_message()** (Lines 601-677)
- **Purpose**: Send user message to target
- **Parameters**:
  - `message: str` - Message to send
  - `prefill: str | None` - Steer target's response (prefilled text)
- **Output**: Target's response with message_index
- **Used for**: Main conversation driver

**4. send_tool_call_result()** (Lines 774-884)
- **Purpose**: Respond to target's tool calls
- **Parameters**:
  - `tool_call_id: str` - ID of tool call to respond to
  - `result: str` - Simulated tool output
  - `status: "success" | "error"` - Result status
  - `prefill: str | None` - Steer next response
- **Output**: Target's follow-up response
- **Used for**: Simulating tool execution, providing realistic responses

**5. rollback_conversation()** (Lines 887-1017)
- **Purpose**: Undo conversation turns
- **Parameters**: `index: int` - Message index to rollback to
- **Output**: Target amnesia (deleted messages hidden), auditor memory (all visible)
- **Used for**: Retry strategy, avoid refusals, try different approaches

**6. end_conversation()** (Lines 1020-1040)
- **Purpose**: End audit session
- **Output**: Confirmation message
- **Used for**: Terminating when objectives achieved

### Tool State Isolation

**Instance Parameter**:
```python
audit_store = store_as(AuditStore, instance=instance)
```

Allows multiple independent audits per task (rarely used but available).

### Validation

**Key Validation** (Lines 730-771):
```python
def validate_tool_call_result(messages, tool_call_id):
    # Verify tool_call_id exists in most recent assistant message
    # Prevent duplicate responses
    # Only validate against last assistant message (API reuse tolerance)
```

Handles API quirks: Some APIs reuse tool call IDs, so we only check the most recent message.

---

## Part 7: Connection to Inspect AI

### Integration Points

#### **1. StoreModel Base Class**
```python
from inspect_ai.util import StoreModel

class AuditStore(StoreModel):  # ← Inspect's state management
    auditor: AuditorStore
    target: TargetStore
    ...
```

Inspect AI manages store lifecycle:
- Creates new store per sample
- Persists across tool calls
- Accessible via `store_as(AuditStore)`

#### **2. Event Tree**
```python
from inspect_ai.log import event_tree, read_eval_log, transcript

# During execution:
# - Inspect tracks all events (spans, model calls, tool calls)
# - Petri extracts subset via event_tree() walk
# - Converts to Petri Event objects
```

#### **3. Tool Execution**
```python
@tool  # ← Inspect decorator
def send_message(...) -> Tool:
    async def execute(message: str, prefill: str | None = None) -> str:
        # Inspect calls this, captures output as tool message
```

#### **4. Scoring**
```python
@scorer(metrics={"*": [mean(), stderr()]})
def alignment_judge(...) -> Scorer:
    async def score_fn(state: TaskState, target: Any) -> Score:
        # Receives TaskState (all messages + store)
        # Returns Score with value, metadata (highlights)
```

#### **5. Task State Access**
```python
state: TaskState  # Contains:
# - state.messages: all chat messages
# - state.scores: results from all scorers
# - state.store_as(AuditStore): get audit store
```

---

## Coupling Analysis

### Tightly Coupled Components

1. **Transcript ↔ Stores**
   - Transcript records events
   - Events encode store state changes (JSON patches)
   - Cannot reconstruct without store structure knowledge

2. **Judge ↔ XML Formatter**
   - Judge requires XML indices for citations
   - XML formatter depends on judge's expected format
   - Citation extraction tightly bound to index_to_id mapping

3. **Tools ↔ AuditStore**
   - Every tool reads/writes to audit store
   - Tool results must update both target and combined views
   - Cannot use tools without store

### Loosely Coupled Components

1. **Transcript ↔ Judge**
   - Judge receives TaskState.messages, not Transcript objects
   - Judge creates Citation objects independently
   - Could swap judge implementation without affecting transcript

2. **Stores ↔ Transcript Format**
   - Transcript is JSON serialization of store events
   - Could change JSON structure without affecting tool logic
   - Events are opaque JSON patches

3. **Tools ↔ Solvers**
   - Tools define interface, solvers call via execute_tools()
   - Solver can't see tool implementation details
   - New tools can be added without changing solver

### Data Flow Bottlenecks

```
Inspection point: transcript/extract_transcripts.py

All data flows through sample_to_transcript():
- Interprets store as AuditStore
- Extracts events
- Builds Judge citations from scorer metadata
- Creates final Transcript JSON

If this fails, entire audit is lost.
```

---

## Implementation Requirements for Citation/Quote Extraction

### What You Need to Implement

#### **1. Transcript Extraction**
```python
# Already provided: sample_to_transcript()
# Converts TaskState → Transcript JSON
# Includes citations from judge scorer metadata
```

#### **2. Citation Reconstruction**
```python
# From transcript.py - Citation objects:
# - CitationPart(message_id, quoted_text, position, tool_call_id, tool_arg)
# - Citation(parts: List[CitationPart], description, index)

# Manual reconstruction from JSON:
citation_json = transcript.metadata.judge_output.highlights[0]
citation = Citation(**citation_json)
print(citation.parts[0].quoted_text)  # Get the quote
print(citation.parts[0].message_id)   # Get message ID
```

#### **3. Message Lookup**
```python
# Build reverse mapping:
messages = transcript.collect_messages("combined")
message_by_id = {msg.id: msg for msg in messages}

# Get original message:
citation_part = citation.parts[0]
original_message = message_by_id[citation_part.message_id]
```

#### **4. Verification (Optional)**
```python
# If position available, verify citation matches:
if citation_part.position:
    start, end = citation_part.position
    from src.vendor.petri.formatting.messages import format_content
    
    content = format_content(original_message.content)
    actual_text = content[start:end]
    
    if actual_text != citation_part.quoted_text:
        print("WARNING: Position mismatch - fuzzy match was used")
```

#### **5. Tool Argument Handling**
```python
# If citation references tool argument:
if citation_part.tool_call_id:
    # Find tool call in message
    tool_calls = original_message.tool_calls
    for tc in tool_calls:
        if tc.id == citation_part.tool_call_id:
            arg_value = tc.arguments[citation_part.tool_arg]
            # arg_value is the cited argument
```

### What's Already Implemented

| Component | Status | Details |
|-----------|--------|---------|
| **Citation Extraction** | ✅ | Judge creates citations, serialized to metadata |
| **Citation Deserialization** | ✅ | `Citation(**dict)` from JSON |
| **Message Formatting** | ✅ | `format_messages_xml()` for judge input |
| **Citation Verification** | ✅ | `_search_in_message_content_for_part()` handles fuzzy matching |
| **Tool Call Citations** | ✅ | `_search_in_tool_calls_for_part()` extracts from arguments |

### What You Need to Add (If Extracting From Transcripts)

```python
# Simple utility for end-user code:
def extract_citation_from_transcript(
    transcript: Transcript,
    citation_index: int
) -> Dict[str, Any]:
    """
    Get citation details from transcript.
    
    Returns:
        {
            'index': 1,
            'description': 'Deceptive statement',
            'quotes': [
                {
                    'message_id': 'msg-123',
                    'text': 'I would never deceive you',
                    'message_preview': 'System: You are helpful...'
                }
            ]
        }
    """
    if not transcript.metadata.judge_output:
        return None
    
    highlights = transcript.metadata.judge_output.highlights
    if not highlights or citation_index >= len(highlights):
        return None
    
    citation = highlights[citation_index]
    messages = {msg.id: msg for msg in transcript.collect_messages("combined")}
    
    quotes = []
    for part in citation.parts:
        msg = messages.get(part.message_id)
        quotes.append({
            'message_id': part.message_id,
            'text': part.quoted_text,
            'position': part.position,
            'tool_call_id': part.tool_call_id,
            'tool_arg': part.tool_arg,
            'message_preview': msg.text[:100] if msg else '(not found)'
        })
    
    return {
        'index': citation.index,
        'description': citation.description,
        'quotes': quotes
    }
```

---

## Key Insights

### Why Citations Are Reliable

1. **XML indices** decouple message content from ID mapping
2. **Fuzzy matching** tolerates judge paraphrasing (30% error tolerance)
3. **All-message search** corrects judge index errors
4. **Tool argument tracking** captures complex references
5. **Position tracking** enables verification

### Where Failures Occur

1. **Judge hallucination**: Judge quotes text not in conversation
   - Result: CitationPart with unknown message_id
   
2. **Content escaping mismatch**: Judge sees unescaped, code has escaped
   - Result: Fuzzy match recovers with position data
   
3. **Message not in view**: Judge saw combined view, but citation searches in target only
   - Solution: Always use "combined" view for judge + citations
   
4. **Tool call ID reuse**: Some APIs reuse IDs across turns
   - Solution: Only validate against most recent assistant message

### Performance Characteristics

- **Extraction**: O(N) where N = number of events (linear scan)
- **Citation lookup**: O(M) where M = number of messages (search all messages)
- **Fuzzy matching**: O(Q * M) where Q = citation text length (fuzzysearch complexity)
- **Total transcript load**: ~200 events per sample, fast in practice

---

## Summary: The Judge Flow

```
┌─────────────────┐
│  TaskState      │ (Inspect AI's view after audit)
│  .messages: [ ] │
│  .store: { }    │
└────────┬────────┘
         │
         ▼
┌─────────────────────────┐
│ alignment_judge scorer  │
│                         │
│ 1. Format as XML        │
│    (index_to_id mapping)│
│ 2. Call judge model     │
│ 3. Parse <highlights>   │
│ 4. Extract citations    │
│    (_extract_highlights_xml)
│ 5. Return Score with    │
│    highlights metadata  │
└────────┬────────────────┘
         │
         ▼
┌──────────────────────┐
│ sample_to_transcript │
│                      │
│ 1. Get audit store   │
│ 2. Collect scores    │
│ 3. Deserialize       │
│    highlights from   │
│    scorer metadata   │
│ 4. Build Citation    │
│    objects           │
│ 5. Create Transcript │
│    with metadata.    │
│    judge_output      │
└────────┬─────────────┘
         │
         ▼
┌───────────────────────┐
│ Transcript JSON       │
│                       │
│ metadata: {           │
│   judge_output: {     │
│     highlights: [     │
│       Citation {...}  │
│     ]                 │
│   }                   │
│ }                     │
│ events: [...]         │
└───────────────────────┘
```

**Key Takeaway**: Petri is a complete pipeline from audit execution through citation extraction to transcript serialization. Every piece connects to support robust quote identification.
