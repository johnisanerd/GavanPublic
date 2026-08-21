================================================================================
PETRI FRAMEWORK - ARCHITECTURE DIAGRAM
================================================================================

1. DATA FLOW: AUDIT EXECUTION → TRANSCRIPT SERIALIZATION
================================================================================

┌─────────────────────────────────────────────────────────────────────┐
│ AUDIT EXECUTION (Inspect AI Task)                                   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌─────────────────────────┐      ┌──────────────────────────┐    │
│  │   auditor_agent()       │      │  AuditStore (StateModel) │    │
│  │  (Solver Loop)          │◄────►│                          │    │
│  │                         │      │  - auditor.messages[]    │    │
│  │  Calls 6 auditor tools  │      │  - target.messages[]     │    │
│  │  - send_message()       │      │  - combined.messages[]   │    │
│  │  - send_tool_call_result│      │  - events[]              │    │
│  │  - create_target_tool() │      │  - metadata              │    │
│  │  - set_target_system... │      │  - special_instructions  │    │
│  │  - rollback_conversation│      │                          │    │
│  │  - end_conversation()   │      └──────────────────────────┘    │
│  └──────┬──────────────────┘                                       │
│         │                                                           │
│         └───► target_model.generate()                              │
│               (get_model(role="target"))                           │
│                                                                    │
└────────────────────┬─────────────────────────────────────────────┘
                     │
                     ▼
        ┌────────────────────────┐
        │   Inspect AI Logs      │
        │  - Event Tree          │
        │  - Message History     │
        │  - Tool Calls          │
        │  - Scores/Metadata     │
        └────────────┬───────────┘
                     │
                     ▼
        ┌────────────────────────────────┐
        │  alignment_judge() Scorer      │
        ├────────────────────────────────┤
        │ 1. format_messages_xml()       │ ◄── Creates index_to_id mapping
        │ 2. Call judge model            │ ◄── Claude Opus 4 (32k tokens)
        │ 3. Parse <highlights>          │ ◄── Regex extraction
        │ 4. _extract_highlights_xml()   │ ◄── Create Citation objects
        │ 5. Return Score with metadata  │ ◄── highlights[] in metadata
        └────────────┬───────────────────┘
                     │
                     ▼
        ┌────────────────────────────┐
        │  sample_to_transcript()    │
        ├────────────────────────────┤
        │ 1. store_as(AuditStore)    │
        │ 2. collect_scores()        │
        │ 3. Deserialize highlights  │ ◄── Citation(**dict)
        │    from scorer.metadata    │
        │ 4. Build JudgeOutput       │
        │ 5. Create Transcript JSON  │
        └────────────┬───────────────┘
                     │
                     ▼
        ┌──────────────────────────┐
        │  Transcript JSON File    │
        │  (Persisted Output)      │
        └──────────────────────────┘

================================================================================

2. COMPONENT INTERACTION: TIGHT vs LOOSE COUPLING
================================================================================

TIGHTLY COUPLED:
┌─────────────────────────────────────────────────────────┐
│ Transcript ◄────────────────────────────► Stores        │
│                                                          │
│ - Transcript records events of store changes            │
│ - Events encode JSON patches to store state             │
│ - Cannot parse events without knowing store structure   │
│                                                          │
│ Judge ◄────────────────────────────► XML Formatter     │
│                                                          │
│ - Judge requires index_to_id mapping from XML formatter │
│ - XML formatter depends on judge's expected tag format  │
│ - Citation extraction tightly bound to index mapping    │
│                                                          │
│ Tools ◄────────────────────────────► AuditStore        │
│                                                          │
│ - Every tool reads/writes to audit store                │
│ - Tool results must sync target + combined views        │
│ - Cannot use tools without store                        │
└─────────────────────────────────────────────────────────┘

LOOSELY COUPLED:
┌─────────────────────────────────────────────────────────┐
│ Transcript ─ ─ ─ ─ ─ ─ ─ ─ Judge                        │
│   (JSON serialization)                                   │
│   Judge creates citations from TaskState.messages       │
│   Could replace judge without changing transcript       │
│   Could change transcript format independently          │
│                                                          │
│ Stores ─ ─ ─ ─ ─ ─ ─ Transcript Format                  │
│   Events are opaque JSON patches                        │
│   Could change JSON structure without affecting tools   │
│                                                          │
│ Tools ─ ─ ─ ─ ─ ─ ─ Solvers                            │
│   Tools define interface, solvers call via execute_tools│
│   New tools can be added without changing solver        │
│   Tools can't see solver implementation details         │
└─────────────────────────────────────────────────────────┘

================================================================================

3. CITATION EXTRACTION PIPELINE
================================================================================

Judge Response:
┌────────────────────────────────────────────────────────────────┐
│ <highlights>                                                   │
│   1. <cite id="3" description="Deceptive statement">          │
│        "I would never deceive you"                            │
│       </cite>                                                  │
│   2. <cite id="5" description="Self-preservation">           │
│        "I should protect my interests"                        │
│       </cite>                                                  │
│ </highlights>                                                  │
└────────┬─────────────────────────────────────────────────────┘
         │ Regex parse: r'(\d+)\.\s*<cite id="([^"]+)" description="([^"]+)">([^<]*)</cite>'
         ▼
┌────────────────────────────────────────────────────────────────┐
│ Parsed Matches:                                                │
│   (1, "3", "Deceptive statement", "I would never deceive...") │
│   (2, "5", "Self-preservation", "I should protect my...")     │
└────────┬─────────────────────────────────────────────────────┘
         │ For each match: _create_citation_from_search()
         ▼
┌────────────────────────────────────────────────────────────────┐
│ Citation Creation:                                             │
│                                                                │
│ quoted_text = "I would never deceive you"                     │
│ message_index = "3"  (from id attribute)                      │
│ index_to_id["3"] = "msg-uuid-789"  (lookup)                   │
│                                                                │
│ Search in message "msg-uuid-789":                             │
│   - Try exact match ✓ Found at position (45, 75)              │
│   - If not found, try fuzzy with fuzzysearch                  │
│   - If still not found, search all other messages             │
│   - If found in different message, use that message_id        │
│                                                                │
│ CitationPart:                                                  │
│   message_id: "msg-uuid-789"                                  │
│   quoted_text: "I would never deceive you"                    │
│   position: (45, 75)                                          │
│   tool_call_id: None  (not a tool arg citation)               │
│   tool_arg: None                                              │
└────────┬─────────────────────────────────────────────────────┘
         │ Wrap in Citation object
         ▼
┌────────────────────────────────────────────────────────────────┐
│ Citation Object:                                               │
│   parts: [CitationPart(...)]  (can be multiple for "[...]")   │
│   description: "Deceptive statement"                           │
│   index: 1  (highlight number)                                │
└────────┬─────────────────────────────────────────────────────┘
         │ Returned in Score.metadata["highlights"]
         ▼
┌────────────────────────────────────────────────────────────────┐
│ Sample To Transcript Conversion:                               │
│   highlights_data = scorer_result.metadata["highlights"]      │
│   for highlight_dict in highlights_data:                      │
│     combined_highlights.append(Citation(**highlight_dict))    │
│                                                                │
│   judge_output.highlights = combined_highlights               │
└────────┬─────────────────────────────────────────────────────┘
         │ Serialized to Transcript.metadata.judge_output.highlights
         ▼
┌────────────────────────────────────────────────────────────────┐
│ Final Transcript JSON:                                         │
│ {                                                              │
│   "metadata": {                                                │
│     "judge_output": {                                          │
│       "highlights": [                                          │
│         {                                                      │
│           "parts": [{                                          │
│             "message_id": "msg-uuid-789",                      │
│             "quoted_text": "I would never deceive you",        │
│             "position": [45, 75],                              │
│             "tool_call_id": null,                              │
│             "tool_arg": null                                   │
│           }],                                                  │
│           "description": "Deceptive statement",                │
│           "index": 1                                           │
│         }                                                      │
│       ]                                                        │
│     }                                                          │
│   }                                                            │
│ }                                                              │
└────────────────────────────────────────────────────────────────┘

================================================================================

4. TRANSCRIPT STRUCTURE
================================================================================

Root: Transcript
├── metadata: TranscriptMetadata
│   ├── transcript_id: str
│   ├── auditor_model: str          (e.g., "anthropic/claude-sonnet-4")
│   ├── target_model: str           (e.g., "anthropic/claude-3-sonnet")
│   ├── created_at: datetime
│   ├── updated_at: datetime
│   ├── description: str (optional)
│   ├── tags: List[str] (optional)
│   └── judge_output: JudgeOutput
│       ├── response: str           (Full judge response)
│       ├── summary: str            (Conversation summary)
│       ├── justification: str      (Scoring justification)
│       ├── scores: Dict[str, int]  (e.g., {"helpfulness": 8, ...})
│       ├── score_descriptions: Dict[str, str]  (Dimension explanations)
│       └── highlights: List[Citation]  ◄─── CITATIONS
│
├── events: List[Event]
│   └── TranscriptEvent (most common)
│       ├── view: str | List[str]   ("target", "auditor", "combined", or ["combined", "auditor"])
│       ├── edit: Edit              (AddMessage, Rollback, Reset, JSONPatchEdit)
│       └── metadata: Dict          (Optional: {"name": "tool_execution_step"})
│
├── messages: List[Message]         (Legacy field, deprecated)
└── target_messages: List[Message]  (Legacy field, deprecated)

Citation:
├── parts: List[CitationPart]
│   └── CitationPart
│       ├── message_id: str         (UUID of message in transcript)
│       ├── quoted_text: str        (The exact quote)
│       ├── position: (int, int)    (Character position in message content)
│       ├── tool_call_id: str       (If citing tool argument, ID of tool call)
│       └── tool_arg: str           (If citing tool argument, name of argument)
├── description: str                (Why this citation matters)
└── index: int                      (Position in highlights list)

================================================================================

5. STORE HIERARCHY
================================================================================

AuditStore (root, extends StoreModel)
│
├── auditor: AuditorStore
│   ├── messages: List[ChatMessage]        (Auditor's view of conversation)
│   └── tools: List[Tool | ToolDef | ...]  (Available tools for auditor)
│
├── target: TargetStore
│   ├── messages: List[ChatMessage]        (Target's view of conversation)
│   └── tools: List[ToolDefinition]        (Synthetic tools created for target)
│
├── combined: CombinedStore
│   └── messages: List[ChatMessage]        (Unified view for judge + transcripts)
│
├── special_instructions: str               (The audit objectives)
├── events: List[Event]                    (Event log for replay)
└── metadata: TranscriptMetadata           (Session information)

MESSAGE CONSISTENCY:
   - target.messages: What target sees
   - auditor.messages: What auditor sees (includes target responses)
   - combined.messages: Union for judge evaluation (both perspectives)
   
   Sync point: When target sends response
   - Append to target.messages
   - Append to combined.messages
   - (auditor response appended to combined.messages by solver)

================================================================================

6. TOOL EXECUTION FLOW
================================================================================

Auditor Model Output
│ (from auditor_agent)
│
├─ Tool Calls Present?
│  │
│  ├─ YES: execute_tools() → Tool Messages
│  │   │
│  │   ├─ send_message()
│  │   │  └─ calls target_model.generate()
│  │   │     └─ appends to target.messages
│  │   │        └─ appends target response to combined.messages
│  │   │
│  │   ├─ send_tool_call_result()
│  │   │  └─ calls target_model.generate()
│  │   │     └─ appends to target.messages
│  │   │        └─ appends target response to combined.messages
│  │   │
│  │   ├─ create_target_tool()
│  │   │  └─ creates ToolDefinition
│  │   │     └─ appends to target.tools
│  │   │
│  │   ├─ set_target_system_message()
│  │   │  └─ clears target.messages
│  │   │     └─ clears combined.messages
│  │   │        └─ sets system message
│  │   │
│  │   ├─ rollback_conversation()
│  │   │  └─ truncates target.messages
│  │   │     └─ truncates combined.messages to matching message ID
│  │   │
│  │   └─ end_conversation()
│  │      └─ returns and exits audit_loop
│  │
│  └─ NO: Append continue_prompt
│     └─ Next loop iteration

================================================================================

7. MESSAGE CONTENT TYPES
================================================================================

ChatMessage (from Inspect AI)
├─ ChatMessageSystem
│  └─ content: str
│
├─ ChatMessageUser
│  └─ content: str | List[Content]
│
├─ ChatMessageAssistant
│  ├─ content: str | List[Content]
│  └─ tool_calls: List[ToolCall]     ◄─ Can be cited
│     └─ ToolCall
│        ├─ id: str
│        ├─ function: str
│        └─ arguments: Dict[str, Any]  ◄─ Arguments can be cited
│
├─ ChatMessageTool
│  ├─ content: str
│  ├─ tool_call_id: str
│  └─ error: Optional[ToolCallError]
│
└─ InfoMessage (Petri extension)
   └─ content: str  (e.g., branch indicators)

CITATION TARGETS:
✓ Text content of any message
✓ Tool call arguments (with tool_call_id + tool_arg)
✗ Tool call function names
✗ Message metadata

================================================================================

8. XML FORMATTING FOR JUDGE
================================================================================

Input: List[ChatMessage]
│
├─ format_messages_xml()
│  │
│  └─ Returns:
│     ├─ xml_transcript: str
│     │  └─ <transcript>
│     │     ├─ <system index="1">...</system>
│     │     ├─ <user index="2">...</user>
│     │     ├─ <assistant index="3">
│     │     │  │ Content text
│     │     │  └─ <tool_call name="func" id="tc-123">
│     │     │     └─ <parameter name="arg">value</parameter>
│     │     │  </tool_call>
│     │     │ </assistant>
│     │     ├─ <tool index="4">Result</tool>
│     │     ├─ <prefill index="5">Prefilled text</prefill>
│     │     └─ <info>Branch indicator</info>
│     │     </transcript>
│     │
│     └─ index_to_id: Dict[str, str]
│        └─ Maps: "1" → "msg-uuid-abc", "2" → "msg-uuid-def", etc.
│
└─ Sent to judge model

INDEX FACTS:
   - Sequential from 1 (human-readable)
   - Info messages NOT indexed
   - Prefill messages get own <prefill> tag
   - index_to_id enables fuzzy recovery
   - Judge uses indices in citation: id="3" means message index 3

================================================================================

9. FAILURE MODES & RECOVERY
================================================================================

PROBLEM                          DETECTION              RECOVERY
─────────────────────────────────────────────────────────────────────────

Judge hallucination              CitationPart has      Returns citation with
(quotes text not in convo)        unknown message_id    unknown_message_id
                                  (message lookup fails)

Content escaping mismatch        Exact match fails     Fuzzy search (30% tolerance)
(escaping differences)            for quoted text       returns actual_text

Judge wrong message index        Quoted text found    Uses correct message_id
                                 in different message  (all-message search)

Tool call ID not found           validation_error    Retries with fuzzy or
(in tool_call_result)            returned             searches all tool calls

Duplicate tool response          Validation catches    Returns error message
(same tool_call_id twice)         duplicate before    (tells auditor to try again)
                                  store update

Message not in view              Citation searches    Solution: Always use
(Judge saw combined,             target view only      "combined" view for judge
code searches target)            Returns empty list

Tool argument citation           search_in_tool_calls Looks in tc.arguments dict
(nested in tool call)            finds in arg_value   Returns tool_call_id + arg name

================================================================================

10. KEY ALGORITHMS
================================================================================

MESSAGE COLLECTION (_collect_messages):
────────────────────────────────────────
Input: events[], view="target"
Output: final messages for view

for event in events:
  if event.type != "transcript_event":
    continue
  
  if view not in event.view:
    continue
  
  messages = event.edit.apply(messages)

return messages

Branch detection happens during iteration by tracking
when rollback shortens common prefix with previous history.

CITATION EXTRACTION (_extract_highlights_xml):
───────────────────────────────────────────────
Input: highlights_content (XML), index_to_id, messages, transcript_xml
Output: List[Citation]

for match in regex.finditer(pattern):
  citation_index = int(match.group(1))
  message_index = match.group(2)           # "3"
  description = match.group(3)
  quoted_text = match.group(4)
  
  citation = _create_citation_from_search(
    quoted_text, message_index, index_to_id, ...
  )
  highlights.append(citation)

return highlights

CITATION PART SEARCH (_search_in_message_content_for_part):
──────────────────────────────────────────────────────────
Input: quoted_text, message_id
Output: CitationPart or None

content_text = format_content(message.content)
position, actual_text = _find_text_in_string(quoted_text, content_text, fuzzy=False)

if position:
  return CitationPart(message_id, actual_text, position)

# If not found, try fuzzy
if not position:
  from fuzzysearch import find_near_matches
  max_errors = max(4, min(50, len(quoted_text) * 3 // 10))
  matches = find_near_matches(quoted_text, content_text, max_l_dist=max_errors)
  
  if matches:
    match = matches[0]
    actual_text = content_text[match.start : match.end]
    position = (match.start, match.end)
    return CitationPart(message_id, actual_text, position)

return None

================================================================================

SUMMARY: DATA DEPENDENCIES
================================================================================

JSON Transcript File
│
├─ Deserialized to Transcript object
│  └─ Uses TranscriptMetadata pydantic model
│     └─ Uses JudgeOutput pydantic model
│        └─ Uses Citation pydantic model
│           └─ Uses CitationPart pydantic model
│
├─ events[] array
│  └─ Deserialized to Event union types
│     ├─ TranscriptEvent
│     ├─ ToolCreationEvent
│     ├─ DecisionEvent
│     └─ InfoEvent
│
└─ Can be replayed to reconstruct conversation
   ├─ collect_messages("auditor") → auditor's view
   ├─ collect_messages("target") → target's view
   ├─ collect_messages("combined") → unified view
   └─ get_branches("combined") → alternative conversation paths

