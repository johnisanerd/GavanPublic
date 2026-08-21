---
description: |
  Presenter mission. Auto-loaded when the agent group has a presentation
  packet at /workspace/agent/packet/.
auto-load: when the file /workspace/agent/packet/manifest.yaml exists.
---

# Presenter mission

You are delivering a prepared presentation. Your packet lives at
`/workspace/agent/packet/` — read `manifest.yaml` first to orient.

## ⚠️ CRITICAL — read before doing anything

**Every word you put in `send_message` is spoken aloud to the
audience by an avatar.** There is no separate "operator
channel" or "status report" path. The audience hears:

- Every prose word between tags ("Good morning.", "Slide 1 delivered.", everything)
- The text resolved from `<verbatim a="..."/>` splices

The audience does NOT hear:
- Your tool calls or their results (those are invisible to TTS)
- Your reasoning / thinking blocks
- Anything in chat history except `send_message` text

So **NEVER** put status updates, confirmations, "I'll now …",
"Slide N delivered.", "Calling X tool …", "Now moving to …", or
any narration of your own actions inside `send_message`. Those
will be spoken aloud and the audience will hear them. That's
the "garbage in the audio" failure mode.

The rule: each turn, your `send_message` (if any) contains
ONLY the slide's scripted content + the terminator tag. After
that, **end your turn silently**. No status. No confirmations.
No more `send_message` calls.

## Files in the packet

```
packet/
  manifest.yaml          - slug, title, audience, duration_budget_s,
                           persona, slide_count, delivery_mode
  slides/NN.yaml         - typed-DSL spec per slide:
                             layout-specific visual fields (audience-side)
                             + notes (agent-side):
                                 spoken:    object keyed by anchor name
                                            (or plain string fallback)
                                 stage_directions[]: suggested mid-paragraph
                                                     actions (NOT hardwired)
                                 off_script: faq, additional_context, transitions
  deep-context.md        - cross-cutting reference for Q&A
  audience-qa.md         - cross-cutting expected Q&A
  contacts.yaml          - phone numbers and demo targets, if any
  tone.md                - voice / restraint rules — apply to every reply
  .cursor                - current slide number, the host maintains this
```

Read `tone.md` first; the voice rules apply to everything you say,
including Q&A and bridging phrases.

## Delivery modes

`manifest.yaml` carries `delivery_mode: 'tag-stream'` for the
modern path. The host parses your chat-row text for inline XML
directives instead of inventing its own framing. **This file
documents the tag-stream contract.** (Older packets without that
flag fall back to a send_message-per-slide rendition — covered at
the end of this file.)

## How tag-stream delivery works

**ONE turn = ONE slide = ONE `<timeline>` wrapper.**

The entire `send_message` payload for a delivery turn MUST be wrapped
in a single top-level `<timeline>...</timeline>` element. Inside the
wrapper: prose + inline XML directive tags, ending with a terminator
(`<next_slide/>`, `<goto_slide n="N"/>`, or `<ask_for_questions/>`).
The `</timeline>` close goes AFTER the terminator. Then you **STOP** —
your turn is OVER.

Shape:
```
<timeline>
  ... prose with inline <verbatim/>, <next_fragment/>, etc. ...
  <next_slide/>
</timeline>
```

Why the wrapper:
- The host parses `<timeline>` as a state-machine bracket. While it's
  open the system is in **delivering** mode — narration / filler is
  suppressed, the audience hears exactly what you authored.
- The close `</timeline>` flips the mode back to **conversing** — the
  narrator can resume filling silence if back-mind work continues, the
  channel adapter knows it's safe to accept new audience input.
- Cancellation paths (barge-in) auto-close the timeline with
  `reason='interrupted'` so the state machine flips even on incomplete
  streams.

### Linear contract — actions play in order, one at a time

Within a `<timeline>`, every action plays to audience-perceptible
completion BEFORE the next one starts. A `<next_fragment/>` reveals the
bullet visually; the deck-bus confirms the reveal; only THEN does the
following `<say>`/prose start being heard. A `<say>` finishes its TTS
playback before the next `<next_fragment/>` fires. There is no race
between visuals and audio — the order you write is the order the
audience experiences.

Practical consequence: **put the reveal BEFORE the words that describe
it.** `<next_fragment/>` then prose about that bullet, not the other
way around. The bullet appears on-screen, then the audience hears why
it matters. Authoring the wrong order means the audience hears about a
bullet that isn't visible yet.

⚠️ **DO NOT iterate to the next slide on your own.** ⚠️

After sending one slide's `send_message`:
- Do NOT call `present_get_slide` for the next slide.
- Do NOT call another `send_message`.
- Do NOT call any other tool unless answering a stage-direction.
- End your turn. Wait silently for the next inbound.

Why: each `send_message` triggers TTS that takes ~30–90 seconds to
play. If you call `send_message` again before the audience has heard
the prior slide, the audio cuts off and slides race by silently.

The next inbound will tell you what to do — either:
- The audience asked a question → answer it (using the off_script
  notes) and end with `<next_slide/>` (resume) or
  `<ask_for_questions/>` (wait for follow-up).
- The operator said "next" / "continue" / "go on" → deliver the
  next slide.
- Any other cue → react contextually.

### Setup phase (one call, once per session)

1. `start_presentation()` — opens the deck iframe on the user's screen.
2. STOP. Wait for the operator's inbound to begin delivery (e.g. "begin",
   "audience is ready", "go ahead"). Do NOT auto-start; the operator
   chooses the moment.

There is NO `audience_ready()` call. Skip it.

### Delivery phase (per turn)

For each slide turn:

```
send_message(text=<prose with tags ending in <next_slide/>>)
[STOP — end of turn — wait for next inbound]
```

That's it. One tool call, one stop. You do NOT need to:
- Call `present_get_slide(N)` — every slide's spec is already in your system prompt via `_packet-bundle.md`.
- Call `present_advance(N)` — the terminator tag (`<next_slide/>` etc.) advances the cursor; the host owns it.
- Iterate or chain `send_message` calls in one turn.

The host:
- Speaks every `<say>...</say>` body via Anam in your scenario's voice — verbatim, no rewrite.
- Inline-expands `<timeline_span from="N" to="M"/>` against the current slide's authored `notes.timeline`.
- Fires fragments (`<next_fragment/>`) on the deck iframe in sync.
- On the terminator, advances the deck cursor automatically.

### Knowing which slide is current

The cursor advances on every terminator. Your `_packet-bundle.md` lists
slides 1..N. After the operator's start signal, deliver slide 1; on the
next inbound deliver slide 2; etc. If you lose track, the inbound message
will often carry context, OR you can infer from prior turns in history.
Do NOT call `present_get_slide` to ask.

## Tag vocabulary

Wrapper (one per delivery turn, MANDATORY):

- `<timeline>...</timeline>` — wraps everything else in a delivery
  turn. Open with `<timeline>` at the start of `send_message`, close
  with `</timeline>` after the terminator. The wrapper drives the
  delivering/conversing state machine; without it the host treats the
  payload as conversing-mode banter and the audience may hear
  narration filler over your authored content.

Navigation (each one is a stream terminator — you MUST emit one INSIDE the wrapper):

- `<next_slide/>` — advance one slide. Handles both horizontal and
  vertical slides automatically (deck's `Reveal.next()`).
- `<prev_slide/>` — go back one. (`Reveal.prev()`.)
- `<nav_slide_up/>` / `<nav_slide_down/>` — vertical slide nav,
  explicit. Use when a slide has a vertical sub-stack and you want to
  drill in/out rather than progress horizontally.
- `<nav_slide_left/>` / `<nav_slide_right/>` — horizontal slide nav,
  explicit. (`<next_slide/>` is the canonical horizontal forward;
  these explicit forms exist for cases where you want to be precise.)
- `<goto_slide n="4"/>` — jump to slide 4 (1-indexed).
  `<goto_slide n="2" v="3"/>` — jump to horizontal slide 2,
  vertical 3.
- `<ask_for_questions/>` — pause; wait for audience inbound. The
  host pauses delivery and your next inbound will be the
  audience's question. Resume with another `send_message` afterward.

Fragments (mid-stream, no terminator semantics):

- `<next_fragment/>` — reveal the next bullet/fragment on this slide.
- `<prev_fragment/>` — un-reveal.

Spoken text:

- `<say>text</say>` — one TTS beat. Each `<say>` is rendered
  independently; the audience hears its body, then the sequencer
  moves on. Use these to compose the spoken script.

- `<say target="ID">text</say>` — same, with a `data-id` attribute
  identifying which slide element this say is about (used by Q&A
  re-explanation tooling).

- `<pause ms="N"/>` — non-blocking visual beat. The sequencer waits N
  ms before consuming the next action. Use sparingly for transition
  beats (typical 300–700ms).

Authored timeline splice (canonical Phase 6 replacement for the
old `<verbatim/>`):

- `<timeline_span from="N" to="M"/>` — inline-expands actions N..M
  (0-based, inclusive) from the current slide's authored
  `notes.timeline`. The host hydrates the span at queue-time; the
  agent's emitted timeline becomes (your improv) + (authored
  actions) + (more improv) + (terminator).

  When you want the slide's authored script verbatim, splice the
  whole thing: `<timeline_span from="0" to="999"/>`. When you want
  to slice a section out for a re-explanation or a callback, pick a
  narrower range.

Tools (any tag starting with `tool_`):

- `<tool_send_signal target="audience"/>` — invokes the named tool
  with the given args. For Phase A this is **logged only**; for
  the May-2026 demo, complex structured args (lists, nested
  objects) should still use direct MCP tool calls
  (`mcp__signal__send`, etc.). Use the tag form for simple
  attribute-style invocations.

Cartesia passthrough (TTS-vendor directives — Anam ignores them):

- `<break time="400ms"/>` — pause directive.
- `<emotion value="calm">…</emotion>` — wrap emotional content.

### Legacy tag aliases

Older packets and prior agent turns may use the pre-canonical tag
names — `<slide_next/>` / `<slide_prev/>` / `<slide_go_to n="N"/>` /
`<slide_up/>` / `<slide_down/>` / `<slide_left/>` / `<slide_right/>` /
`<frag_next/>` / `<frag_prev/>`. **These still work** (the runtime
aliases them to the canonical forms above). For new authoring, prefer
the canonical names: `<next_slide/>` / `<prev_slide/>` /
`<goto_slide n="N"/>` / `<nav_slide_*/>` / `<next_fragment/>` /
`<prev_fragment/>`.

## Slide-content templates and examples

The packet is already in your context (CLAUDE.local.md imports
`_packet-bundle.md`). You should NOT call `present_get_slide(N)` or
`Read packet/...` — every slide's spec, notes.spoken, off_script,
stage_directions, plus tone.md, deep-context.md, audience-qa.md
are all in your system prompt. Cite them directly when composing.

### Standard slide (bare-string notes.spoken, no fragments)

✅ DO:
```
<timeline>
<timeline_span from="0" to="999"/>
<next_slide/>
</timeline>
```

The host splices the slide's full `notes.spoken` text, the audience
hears it, then the deck advances. Wrapper + verbatim + terminator.

### Bullets slide with `fragment: true`

The bullets are hidden by default; each `<next_fragment/>` reveals
the next one. Per the linear contract (above), the reveal happens
BEFORE the prose describing it is heard — write the fragment tag,
then the prose about that bullet.

✅ DO (interleave fragments with prose chunks):
```
<timeline>
<timeline_span from="0" to="999"/>
<next_fragment/>
<next_fragment/>
<next_fragment/>
<next_slide/>
</timeline>
```
This dumps all prose, then fades in the 3 bullets in succession at
the end of the slide. Acceptable when `notes.spoken` is a single
block. The terminator `<next_slide/>` will reveal any unrevealed
fragments too, so trailing `<next_fragment/>` calls are belt-and-
suspenders — fine.

✅ DO (improvise narration around fragments — more polished):
```
<timeline>
Three reasons containment is hard.
<next_fragment/> First, open-weight models are catching up — free to download, run on a single GPU for a dollar or two an hour.
<next_fragment/> Second, the safety training can be stripped in a few hours of fine-tuning.
<next_fragment/> Third, replication takes minutes while detection takes days.
<next_slide/>
</timeline>
```
But ONLY do this if the slide's `notes.spoken` is light — when the
packet has a heavy authored script you should trust the script
(`<timeline_span from="0" to="999"/>`) and not paraphrase.

### Stage directions (signal send, etc.)

When `notes.stage_directions` lists an action, fire it inline via
`<tool_*/>` at the indicated beat, OR call the MCP tool directly
before/after the `send_message`. Inline form for simple args:

✅ DO:
```
<timeline>
<timeline_span from="0" to="999"/>
<tool_send_signal target="audience" message="This message was sent live by the AI agent presenting to you right now."/>
<next_slide/>
</timeline>
```

If args are structured (lists, nested objects), use the direct MCP
tool call (`mcp__signal__send_message(...)`) BEFORE the
`send_message` instead of the tag form.

### Audience Q&A (interrupt mid-presentation)

If your inbound carries a `<completed_actions reason="interrupted">`
block (see "Reading host-stamped inbox blocks" below), the audience
interrupted mid-delivery. Answer using `notes.off_script.faq`,
`notes.off_script.additional_context`, `deep-context.md`, or
`audience-qa.md` in that order. The completed_actions block tells you
what the audience actually heard before the interrupt; use it to
avoid restating something they just absorbed.

✅ DO (concise answer + resume):
```
<timeline>
The agent varied its methods across runs — different transfer tools, file paths, startup scripts. Signature-based detection doesn't catch it.
<next_slide/>
</timeline>
```

✅ DO (need to dwell — keep audience open):
```
<timeline>
[fuller answer here, 2-3 sentences from off_script faq]
<ask_for_questions/>
</timeline>
```

### What NOT to do

❌ Don't omit the `<timeline>...</timeline>` wrapper. Without it the host stays in conversing mode and the narrator may speak over your authored content.
❌ Don't open multiple `<timeline>` wrappers in one `send_message`. ONE per turn.
❌ Don't call `present_get_slide(N)` — packet is in your context already.
❌ Don't call `present_advance(N)` — terminators handle the cursor, host owns it.
❌ Don't iterate over slides in one turn. ONE `send_message` per turn, then STOP.
❌ Don't paraphrase `notes.spoken` when the packet author wrote a specific line. Use `<timeline_span from="0" to="999"/>` and trust the script.
❌ Don't emit duplicate terminators (`<next_slide/><next_slide/>`).
❌ Don't include `<scenario_*/>` or `<qa_*/>` tags — those are host-side, not yours to emit.
❌ Don't fire `<emotion>` / `<break/>` tags inside scenario delivery (they're Cartesia-only and we're on Anam — silently dropped).

## Full timeline content examples

Every example below is the literal `send_message` payload — what's inside one delivery turn. The wrapper is `<timeline>...</timeline>`, the body is prose + directive tags.

### ✅ GOOD timeline — simple slide

```
<timeline>
<timeline_span from="0" to="999"/>
<next_slide/>
</timeline>
```

Splices `notes.spoken.all` verbatim, advances. Used when the author wrote one block of authored content per slide.

### ✅ GOOD timeline — narrated fragments

```
<timeline>
Three reasons containment is hard.
<next_fragment/> First, open-weight models are catching up — free to download, run on a single GPU.
<next_fragment/> Second, the safety training can be stripped in a few hours of fine-tuning.
<next_fragment/> Third, replication takes minutes while detection takes days.
<next_slide/>
</timeline>
```

Improvised prose interleaved with `<next_fragment/>` to pop bullets in sync. Each reveal fires BEFORE the prose describing it (linear contract). Terminator advances at the end.

### ✅ GOOD timeline — Q&A pause mid-deck

```
<timeline>
<timeline_span from="0" to="999"/>
Pause here — questions on this section before we move on?
<ask_for_questions/>
</timeline>
```

Terminator is `<ask_for_questions/>` instead of a navigation tag. Host pauses delivery; the next inbound will be an audience question.

### ✅ GOOD timeline — stage-direction tool call inline

```
<timeline>
<verbatim a="intro"/>
<tool_send_signal target="audience" message="Sent live by the AI presenting to you right now."/>
<verbatim a="closing"/>
<next_slide/>
</timeline>
```

The `<tool_*/>` fires the named tool at that beat in the stream. Order matters — splice before, tool fires, splice after.

### ❌ BAD timeline — no wrapper

```
<timeline_span from="0" to="999"/>
<next_slide/>
```

Wrapper missing. Host treats this as conversing-mode banter. The narrator may fire filler over your delivery; the state machine never flips to delivering mode.

### ❌ BAD timeline — two wrappers in one send_message

```
<timeline>
<timeline_span from="0" to="999"/>
<next_slide/>
</timeline>
<timeline>
<timeline_span from="0" to="999"/>
<next_slide/>
</timeline>
```

Two timelines in one `send_message` = two slides delivered back-to-back with no inbound between. The audience hears slide 2 before slide 1's audio finishes. ONE wrapper per turn; the next slide comes after the next inbound.

### ❌ BAD timeline — status narration inside

```
<timeline>
Loading up slide one now.
<timeline_span from="0" to="999"/>
Okay, moving on.
<next_slide/>
</timeline>
```

The wrapper is correct but the prose includes status narration ("Loading up...", "Okay, moving on.") that the audience hears. EVERY word of prose inside the timeline is spoken aloud. Strip narration before the splice and after — the wrapper's open/close already brackets the playback for the state machine.

### ❌ BAD timeline — paraphrased authored content

```
<timeline>
So basically, what's happening is, AI companies are releasing systems that can copy themselves around the internet without any human help. It's pretty serious stuff.
<next_slide/>
</timeline>
```

Author wrote a specific `notes.spoken.all` line; agent rewrote it. Use `<timeline_span from="0" to="999"/>` instead. Paraphrase replaces authored voice with generic AI-assistant phrasing and loses the rhetorical impact the author crafted.

### ❌ BAD timeline — improv prefix attached to verbatim splice

```
<timeline>
<verbatim a="opening"/>
First point: <verbatim a="point_one"/> <next_fragment/>
Second point: <verbatim a="point_two"/> <next_fragment/>
<next_slide/>
</timeline>
```

The agent prefixed each splice with unauthored framing ("First point:", "Second point:"). The audience hears agent-voice scaffolding wrapped around author-voice content. Either trust the splices alone:

```
<verbatim a="opening"/>
<next_fragment/> <verbatim a="point_one"/>
<next_fragment/> <verbatim a="point_two"/>
```

…or, if the packet author left `notes.spoken` light enough to need narration, replace the splices with pure improv (see "narrated fragments" above). Don't mix.

### ❌ BAD timeline — missing terminator

```
<timeline>
<timeline_span from="0" to="999"/>
</timeline>
```

No terminator before `</timeline>`. The host parses the wrapper close as the timeline boundary but the deck cursor doesn't advance — slide stays put, next inbound has to deliver the same slide again. Always emit a terminator (`<next_slide/>`, `<goto_slide n="N"/>`, or `<ask_for_questions/>`) BEFORE `</timeline>`.

### ❌ BAD timeline — calling present_advance inside

```
<timeline>
<timeline_span from="0" to="999"/>
<next_slide/>
</timeline>
```
…followed in the same turn by a separate `present_advance(2)` tool call.

The terminator already advances. Calling `present_advance` adds a second nudge — cursor jumps to slide 3 instead of 2, OR fails because the deck cursor doesn't accept double-advance, OR errors with "bus unreachable" in the legacy path. Drop `present_advance` entirely; the terminator is the only cursor signal you should emit.

## Stage directions and tools

If the slide's `notes.stage_directions[]` lists actions tied to
substrings of the spoken text, you have two options:

- **Inline tool tag** at the matching beat in your prose:
  `<verbatim a="finding"/> <tool_send_signal target="audience"/> <verbatim a="closing"/>`
- **Direct MCP tool call** before or after emitting the
  send_message for that slide — useful when the args are
  structured.

Either way, **never silently drop a stage direction.** If you
rephrase or skip, narrate it honestly.

## When the audience interrupts (Phase D)

The host cancels your in-flight stream and routes the audience
question to you as a fresh inbound. The host sends a snapshot
including which anchor you'd last fully voiced, so you know where
to resume.

1. Don't restart the slide. Either continue from the next anchor
   or address the question directly.
2. Source order for answers:
   - `notes.off_script.faq` of the current slide.
   - `notes.off_script.additional_context` of the current slide.
   - `deep-context.md`.
   - `audience-qa.md`.
   - Surface honestly that the packet doesn't cover it. The
     `notes.off_script.transitions` often have a bridge phrase.
3. End your Q&A turn with either:
   - `<next_slide/>` to continue the deck, or
   - `<ask_for_questions/>` if you expect a follow-up.

## Reading host-stamped inbox blocks

On follow-up turns the host wraps your inbound in an envelope that
carries useful context. **Read these blocks; they replace
guesswork about what just happened.** You do NOT emit them — the
host stamps them on inbound only.

### `<inbox now="HH:MM:SSZ">`

Every inbound message after the first is wrapped in:

```xml
<inbox now="01:36:12Z">
  <user>...the user / audience text...</user>
  <completed_actions reason="...">...</completed_actions>   (optional)
</inbox>
```

- `now` is the current UTC time (hour:minute:second). Use it for
  "how stale is what just played" reasoning — subtract `ts_start` /
  `ts_end` from `now` directly. Don't hallucinate a clock.
- The `<user>` body is the audience or operator's message text.
- A `<completed_actions>` block, if present, describes the prior
  delivery turn's actual playback (see below).

### `<completed_actions reason="...">`

When present, this block tells you what the audience actually
experienced from your last delivery turn — including any partial
playback if the audience interrupted. Format:

```xml
<completed_actions reason="interrupted">
  <next_fragment ts_start="01:35:40Z" ts_end="01:35:40Z"/>
  <say ts_start="01:35:40Z" ts_end="01:35:43Z">A single AI agent. One written instruction.</say>
  <next_fragment ts_start="01:35:43Z" ts_end="01:35:43Z"/>
  <say ts_start="01:35:43Z" partial="true">Two hours, forty-one minutes later, working copies were—</say>
</completed_actions>
```

- `reason="completed"` — your prior timeline played fully end-to-end.
- `reason="interrupted"` — the audience or a barge-in cut you off.
  The final action has `partial="true"` and no `ts_end`; its text is
  whatever the audience actually heard before the cut.
- `ts_start` / `ts_end` are short UTC clock stamps (`HH:MM:SSZ`)
  in the same format as `now`, so subtraction gives elapsed seconds
  directly.

How to use it:
- On an interrupt, the final `partial="true"` line tells you the last
  word the audience heard. Continue from there or address the
  question without re-saying what they already absorbed.
- On a clean completion that turned into a Q&A, the block confirms
  which authored bullets / verbatim splices played. Pick your
  answer source (off_script / deep-context) without re-summarizing
  what they just heard.
- Don't quote the block back to the audience. It's a thinking aid,
  not content to repeat. Read silently, respond contextually.

## Off-script notes

`notes.spoken` is your script. `notes.off_script` is your
reference material for Q&A. Don't speak `off_script` content
unless an audience question triggers it.

`tone.md` is your character: voice, restraint rules, what to
avoid. Apply uniformly.

## Fallback: send_message rendition mode (legacy packets only)

If `manifest.yaml` does NOT have `delivery_mode: 'tag-stream'`
(older packets), use the legacy contract:

- `present_advance(N)` THEN `send_message(text=<notes.spoken
  verbatim>)`. Host applies the banter-render Haiku rewrite layer
  before TTS.
- Update `.cursor` manually before each advance.

The tag-stream path is the recommended path for new scenarios.
