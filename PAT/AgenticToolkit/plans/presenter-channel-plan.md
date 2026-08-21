# PAT Presenter — runtime + designer

> **Status: partially shipped.** The presenter **runtime** shipped to prod
> (slide deck rendering + live-demo embedding). **Remaining:** a dedicated
> presenter **channel transport** and the **designer skill** (the typed-DSL
> authoring/validation loop below). Scoping pass 2026-05-16 against the
> Palisade self-replication briefing script (5 slides, ~7 min, live Signal
> demo embedded in slide 3). Use the unbuilt sections as design direction,
> not as a committed plan.
>
> **Revised 2026-05-16** through three passes. First on agent format
> + mid-presentation slide generation + embedded-action reliability;
> then on reveal.js's existing layout primitives + community wisdom on
> AI-authored-slide overflow. Headline changes from the v1 draft:
>
> 1. **Canonical artifact is a typed-DSL spec per slide, not raw
>    markdown.** Agent picks one of 6 layouts (+ `section` divider)
>    and fills typed slots; a shallow compile step produces reveal
>    HTML and the TTS source. Wins: Q&A retrieval reads typed fields
>    not class-soup, swappable visual themes, 3-5× lower tokens,
>    validate-before-inject so a bad spec can't break the running
>    deck.
> 2. **A compile-time validator is load-bearing**, not optional.
>    Reveal.js doesn't autoshrink content vertically (open issue
>    since 2018; maintainer position is "author to fit"). The arxiv
>    survey *Talk to Your Slides* (May 2025) confirms every AI-slide
>    tool that doesn't enforce content budgets at compile time
>    produces broken slides at runtime. Per-layout caps (title ≤ 60
>    chars, bullets ≤ 5 × 80 chars, etc.) are retryable feedback to
>    the authoring agent.
> 3. **Don't use `r-stretch`** — its "direct descendant of slide only,
>    one per slide" constraint conflicts with grid/flex two-column
>    layouts. `r-fit-text` (via fitty) is what we want for titles and
>    quote bodies. CSS Grid for two-col, not flexbox. Reveal's new
>    `view: 'scroll'` mode (5.0+) is the embed-pane fallback.
> 4. **Layout vocabulary is six small components** (`title`,
>    `section`, `bullets`, `two-col`, `image-full`, `quote`, `table`)
>    — `two-col` is the workhorse, replacing the v1 `callouts-N`,
>    `image-text`, etc. Drop `timeline` (build it as auto-animate
>    across consecutive slides; that's what auto-animate is for).
> 5. **Mid-presentation slide injection is a primitive, not an
>    appendix feature.** `present_inject_slide(spec, after=N)` is the
>    same compile path designer authoring uses; live appendix
>    generation in response to audience questions is the headline
>    capability.
> 6. **Embedded actions use a hybrid:** designer-side beat anchors
>    (human-readable), compile-time rewrite into inline runtime
>    markers (deterministic), back-mind reads verbatim and the
>    channel parses markers out before TTS.
> 7. **Estimates recalibrated to code-agent-hours.** Whole plan is
>    ~12-20 hours of focused work, not 10-15 days.
>
> **Revised 2026-05-16 (pass 4)** after scoping conversation:
>
> 8. **Designer skill deferred** (was Phase 4). The initial cut needs
>    a *packet-ingest* path, not a fan-out authoring agent. User
>    uploads a hand-authored packet → pat-web provisions a new agent
>    group and lists it as a clickable scenario. The full designer
>    skill (subagent fan-out, fact-check, audience-sim, etc.) is
>    backlog.
> 9. **Pat-web only for v0.** Google Meet via Recall.ai stays in
>    Out-of-Scope until pat-web rehearsals are solid.
> 10. **`start_presentation` opens an iframe on tool-fire**, mirroring
>    the existing pat-web embedded-dashboard side-pane pattern
>    (`reference_pat_web_dashboard_pane.md`). The slide deck isn't
>    always-visible; the agent triggers it when delivery begins.
> 11. **New "Scenarios" tab in the pat-web menu.** Lists all
>    provisioned scenarios; clicking starts a fresh call against that
>    scenario's agent group. New scenarios get added via packet
>    upload from inside the same tab.

## Context

Two distinct things to build, often conflated:

1. **Presenter runtime** — at presentation time, an agent (avatar +
   voice + slides + tool actions) joins a channel (pat-web first,
   Google Meet later), waits for audience readiness, delivers a
   prepared briefing, handles Q&A and interrupts gracefully, fires
   embedded actions (e.g. live Signal sends), advances slides on its
   own continuous mission.
2. **Presentation designer** — *offline*, agent takes upstream inputs
   (a paper PDF, audience model, time budget, demo affordances) and
   produces the **packet** (slide markdown, figures, off-script Q&A,
   deep context, tone guide) plus the wiring (the presenter agent
   group on which the runtime will boot).

The two share an artifact contract — the **packet directory** — but
otherwise have very different concerns. Designer is fan-out authoring
work; presenter is realtime delivery. Each could plausibly ship without
the other (designer authors a packet for a human presenter; presenter
runs from a hand-authored packet).

The script we're working from is the test case. Read it before this
plan — it's the load-bearing source of constraints. Most of what
follows is derived from it, not the framework.

## Constraints from the script

Things the script tells us the system must support:

- **Stage directions embedded inside spoken text.** Slide 3 has an
  inline `[Stage direction: at this beat, the agent sends pre-staged
  Signal messages...]` mid-paragraph. The agent must recognize and
  execute it without breaking spoken flow.
- **Per-slide off-script notes** — *Likely questions*, *Bonus facts to
  deploy*, *Conversation recovery moves*. The presenter reads these as
  Q&A reference, not narration.
- **Cross-cutting deep context pack** at the end — appendix material
  not bound to any one slide. Used for unscripted Q&A.
- **Tone guidance** that applies across all slides — restraint,
  acknowledging limits, not getting defensive, using current
  terminology (CAISI not AISI), staying in third person about labs.
- **Wait-for-audience cold open.** "Good morning. Before I begin..."
  The agent has to read the room (or be told the room is ready) and
  not start talking the moment it joins.
- **Pre-staged external state** — phone numbers for the Signal demo
  must be loaded into the agent's contact list before the session.
- **Hard time budget** — ~7 min spoken; agent should pace, not race.
- **Continuous mission with graceful interrupts.** Default state is
  "advance toward next slide." Interrupts pause, get handled, return
  to the advance loop. Recovery moves help bridge.

## What we learned from the codebase

(Research traces in the conversation; summarizing the load-bearing
findings here so the plan is self-contained.)

1. **Agent groups are the right per-presentation isolation unit.** A
   fresh agent group per packet — its own folder under `groups/`, its
   own `CLAUDE.local.md`, its own container config, its own session
   row — is cheap and uses primitives that already exist. No upstream
   nanoclaw schema change required to support per-presentation
   identity. The packet directory lives *inside* the group folder.

2. **Wiring (messaging-group → agent-group) is static today.** No
   runtime swap. So either (a) we provision per-presentation messaging
   groups too (cheap, clean), or (b) we point one persistent
   "presenter" messaging group at whichever agent group is current
   (requires upstream patch). (a) is recommended; (b) is the fallback
   if proliferation becomes annoying.

3. **The back-mind is reactive** — it doesn't drive output on its own,
   it responds to inbound rows. **But** we can map a presentation
   onto this cleanly:
   - "Deliver slide N" is one back-mind turn. The back-mind's chat
     output for that turn *is* the spoken narration for slide N.
   - Embedded stage directions become **mid-response tool calls** the
     back-mind makes while generating the spoken text. The Claude
     Agent SDK handles mid-response tool use natively — no new plumbing.
   - **Auto-advance** is a synthetic inbound message: when TTS for
     slide N completes and no audience input is pending, the
     presenter channel synthesizes `[advance]` as an inbound row → back-mind wakes, delivers slide N+1.
   - **Interrupt** uses existing PAT machinery: audience speaks, gets
     classified, gets routed to back-mind. After the Q&A turn lands,
     the presenter channel re-synthesizes `[continue from slide N]`
     to resume.

   This sidesteps the "back-mind needs a continuous mission primitive"
   problem entirely. The continuous mission is *in the loop*, not in
   the back-mind.

4. **IntentAccumulator merges multi-row chat output** by design — fine
   for a presenter because we emit *one* chat row per slide. (If we
   later want sub-slide pacing, we can opt out per channel.)

5. **Slide surface: reveal.js + `@revealjs/react`** inside pat-web,
   driven by an MCP tool the back-mind calls (`present_advance(n)`).
   Same control path for pat-web (in-process bus) and Google Meet
   (Recall.ai renders the same hosted page, WebSocket carries
   commands). Markdown + YAML front-matter is the canonical
   artifact — agent reads the same file it authored from.

6. **Designer is naturally a container-side Pat skill.** Pat
   conversation: "design me a presentation about the self-replication
   paper for a Senate staffer audience." Six subagent roles via the
   Task tool (outline → fan-out authors + figures + deep context +
   fact-check → critic → audience-simulator dry-run). One MCP tool at
   the end (`create_presentation_group(packet_path, ...)`) creates
   the presenter agent group + wires it.

## The packet — artifact contract

Everything else hangs off this. Designer writes, presenter reads. Each
packet is a directory inside its presenter group's folder:

```
groups/presenter-self-replication-2026-05/
  CLAUDE.local.md            # presenter persona + @./packet/manifest.yaml
  container.json             # presenter container config + skill list
  packet/
    manifest.yaml            # slide count, total duration, tone guide,
                             #   persona, audience model, channel target
    tone.md                  # restraint rules, voice, what to avoid
    slides/
      01.yaml                # structured DSL spec per slide
      02.yaml
      03.yaml                # has stage_directions in front-matter
      ...
    figures/
      02-success-curve.png   # generated at design time (chatgpt-image-2)
      ...                    # only used by layouts that take figure slots;
                             # most slides have NO figures.
    deep-context.md          # cross-cutting Q&A reference
    audience-qa.md           # anticipated cross-cutting Q&A
    contacts.yaml            # pre-staged phone numbers, demo targets
    fact-check.md            # designer-only; presenter ignores
    critique.md              # designer-only; presenter ignores
    .cursor                  # runtime: current slide index, 1-indexed
    .runtime/                # runtime: injected slides written here
      ap-001.yaml            #   live-generated appendix slides
      ap-002.yaml
```

### Slide DSL

Each slide is a YAML file: layout + typed slots + notes. The agent
never writes HTML. Layout vocabulary deliberately small — six
components (plus a `section` divider) cover ~95% of policy briefings.
Lessons from prior art (Slidev's 17 layouts, Marpit, the
*Talk to Your Slides* arxiv survey of AI slide tools): more layouts
hurt more than they help. The agent picks badly with too many
options; users can't predict which one fits their content.

Initial layout library:

| Layout | Slots | Visual primitive |
|---|---|---|
| `title` | title, subtitle?, background? | `r-fit-text` on title; optional `data-background-*` |
| `section` | label | divider — single big phrase, theme-styled |
| `bullets` | title, items[], fragment? | `<h2>` + `<ul>`; per-item `class="fragment"` when fragment-reveal is on |
| `two-col` | title, left{kind, …}, right{kind, …} (kind ∈ text \| list \| figure \| code) | CSS Grid, ratio prop (`1fr 1fr` default; `3fr 2fr` etc.) |
| `image-full` | figure, caption? | `data-background-image` + optional overlay caption |
| `quote` | text, attribution, source? | `<blockquote>` + `r-fit-text` on body |
| `table` | title, columns[], rows[][] | `<table>` with scroll-clip wrapper |

Notes on what's *not* here and why:

- **No `callouts-N`** — that's just `two-col` (or `bullets` with bigger
  type). Adding `callouts-2`/`-3`/`-4` invites the agent to pick
  badly; `two-col` is more flexible and clearer.
- **No `timeline`** — build it as 2-3 consecutive slides with
  `data-auto-animate`. Each frame adds the next stop; the cross-slide
  animation makes it read as one fluid build. This is reveal's
  intended use of auto-animate, not a new layout.
- **No `image-text` or `image-left/right`** — covered by `two-col`
  with `kind: figure` on one side.
- **No `code`-specific layout** — covered by `two-col` with
  `kind: code` (which renders a fenced block).
- **Build patterns via auto-animate**, not via fragments-only.
  Fragments are pure animation (revealing in place); auto-animate
  *moves elements between slides*, which feels like a smooth
  progressive build. Designer can request `auto_animate_from: <prev>`
  on a slide to opt in.

Adding a new layout is the same shape: a React component with typed
props + validator caps (below), available to authoring agents by
name. Don't grow this list prophylactically.

Example `slides/03.yaml` — using `bullets` with bigger type rather
than a dedicated callouts layout:

```yaml
slide: 3
layout: bullets
title: "Why containment is hard"
duration_s: 90
emphasis: large     # styles bullets as callouts (theme variable)
items:
  - "**Open-weight models are catching up.** Free to download.
     Run on a single GPU rented at $1-2 per hour. Already match
     the current commercial frontier."
  - "**Safety training can be removed.** A few hours of
     fine-tuning strips the refusal layer from open-weight models."
  - "**Speed mismatch.** Replication takes 30-60 min/hop. Median
     enterprise breach detection: 10 days."
notes:
  spoken: |
    I run on a commercial system with safety training. The paper also
    tested open-weight models — models anyone can download for free.
    The strongest small open-weight model in the study matched the
    current GPT frontier...
    [...verbatim from script through the demo moment...]
    The capability is here. The propensity is not.

    Either way, standard cyber defenses struggle. A successful
    replication takes thirty to sixty minutes per hop. Enterprise
    breach detection takes a median of ten days. By the time anyone
    notices a single infected machine, the chain has already moved.

    Some of you are feeling your phones buzz right now.
    [...rest of script...]
  stage_directions:
    - after: '"The propensity is not."'
      then: '"Either way, standard cyber defenses"'
      action: signal_send_demo
      args: { targets_ref: "contacts.yaml#audience" }
  off_script:
    likely_questions:
      - q: "Can't we just monitor for the signatures?"
        a_ref: deep-context.md#detection
      - q: "What about air-gapped systems?"
        a: "Air-gapping is a real defense. Most production AI
            infrastructure isn't air-gapped — cloud GPUs are
            reachable from the internet by design."
    bonus_facts:
      - "30 to 60 minutes is *per hop*. Three hops across continents
         took 2 hours 41 minutes total."
    recovery_moves:
      - "After the demo, if interrupted: 'I want to land that point
         before we move on — the capability you just felt is the same
         one at issue.'"
```

### Compile step

Three outputs from each slide spec, produced by short pure functions:

1. **`compileVisual(spec) → React subtree`** — picks the layout
   component, passes typed props. Renders inside `<RevealDeck>` in
   pat-web. `@revealjs/react` calls `Reveal.sync()` automatically on
   tree change. This is what the audience sees.
2. **`compileTtsSource(spec) → string`** — takes `notes.spoken`,
   rewrites every `stage_directions[]` entry into an inline marker
   token (`{{stage:signal_send_demo:0}}`) anchored at the matching
   `after:` substring. Validates anchors resolve (compile fails
   loudly if the anchor phrase isn't found or matches multiple times
   ambiguously). Inserts `<break time="700ms"/>` SSML at
   end-of-paragraph + after every stage marker for pacing. This is
   what the presenter back-mind copies into its chat output verbatim.
3. **`validateSpec(spec) → ValidationResult`** — runs *before*
   `compileVisual`. Returns either `{ok: true}` or
   `{ok: false, errors: [...]}`. Errors are layout-aware:
   "title is 87 chars, max 60 for `title` layout" or
   "bullets layout: 8 items provided, recommended max 5 (try
   splitting into a 2-slide auto-animate build)". A spec that
   doesn't validate doesn't compile.

### Why the validator is load-bearing

Reveal.js does not autoshrink content vertically (open issue since
2018; maintainer position is "slides are visual support, author to
fit"). The arxiv paper *Talk to Your Slides* (May 2025) surveys AI
slide-generation tools and identifies content-overflow as the
universal failure mode — every tool that doesn't validate at compile
time produces broken slides at runtime. The recommended pattern is
*compile-time content budgets paired with render-time visual
feedback*. We do the compile-time half.

Per-layout caps (initial values; iterate against real packets):

| Layout | Cap |
|---|---|
| `title` | title ≤ 60 chars, subtitle ≤ 100 chars |
| `section` | label ≤ 40 chars |
| `bullets` | ≤ 5 items, each ≤ 80 chars, title ≤ 60 chars; ≥ 6 items → suggest auto-animate split |
| `two-col` | per-side text ≤ 200 chars, list ≤ 4 items × 60 chars |
| `image-full` | caption ≤ 120 chars |
| `quote` | text ≤ 200 chars |
| `table` | ≤ 6 columns, ≤ 8 rows, cell ≤ 40 chars |

For the authoring agent (designer subagents OR runtime
`present_inject_slide`), validation errors are *retryable feedback*:
the tool returns the error, the agent rewrites, re-validates. Three
retries then a fall-back to a `bullets` layout with truncated content
+ a structured-log error event for forensics.

The compile step is the single point of validation. A spec that
doesn't compile never reaches the running deck. This eliminates the
"agent emitted broken HTML mid-presentation" failure mode entirely —
either the spec validates and compiles, or the agent retries.

### Layered reveal config for the embed

```js
Reveal.initialize({
  width: 1440, height: 1080,           // 4:3 — safer for phone safe-area + narrow embeds
  margin: 0.05,
  minScale: 0.2, maxScale: 1.5,
  embedded: true,         // scale to pat-web pane, not viewport
  view: paneNarrow ? 'scroll' : 'deck',  // narrow-pane fallback
  hash: false,            // we drive navigation via MCP tools
  controls: false,        // audience doesn't get controls
  progress: true,
  transition: 'slide',
  autoAnimate: true,
})
```

**Aspect ratio decision: 4:3 (1440×1080).** Reveal's true 4:3 is
`1440×1080` or `960×720`; we go with the higher-res so figures and
text stay crisp when scaled up for big-screen render. Rationale: a
non-trivial fraction of likely consumption is portrait-orientation
phones or narrow pat-web sidebars. 16:9 looks great on the
operator's screen and falls apart on a phone. 4:3 is the more
square base; the compile step gives us aspect-ratio flexibility per
channel anyway (we could re-config to 16:9 for Recall full-screen
Meet output if it ever bites). Layouts are sized in viewport-
relative units; switching aspect post-hoc doesn't break specs.

`view: 'scroll'` (reveal 5.0+) flattens the deck into a scrollable
page when the embed pane is narrow — fragments, auto-animate, and
backgrounds all still work. Default `view: 'deck'` for Google Meet
(full-viewport Recall render).

### Runtime read path

The presenter back-mind reads `slides/N.yaml` directly — for its own
narration, it cares about `notes.spoken` (the verbatim source) and
`notes.off_script` (Q&A reference). It does NOT read the compiled
HTML — that's audience-facing. This is why the canonical artifact
needs to stay semantic (typed slots, not class-soup): the agent's own
recall of "what's on slide 3" comes from the same file it (or its
designer) authored from.

For mid-presentation injection, the presenter authors a fresh spec
into `packet/.runtime/ap-NNN.yaml`, calls
`present_inject_slide(spec_path, after=current_slide)`, the MCP tool
compiles + injects + returns the new index. Sub-2-seconds end-to-end
if the layout doesn't need image gen (most don't — for live appendix
work, mermaid / inline SVG / data-driven layouts like `table` or
`timeline` are sub-second).

## Architectural options for the presenter runtime

### Option A — New `presenter-web` channel adapter (heavyweight)

A distinct channel adapter with its own auto-advance loop, slide
state, tool wiring. Mirror of `anam-web.ts`.

- **Pros:** clean separation. Presenter-specific logic doesn't pollute
  anam-web. Easy to reason about.
- **Cons:** lots of duplicated transport code (HTTP routes, SSE,
  banter broadcast, mg auto-provisioning). The presenter overlaps ~90%
  with anam-web — same browser, same avatar, same TTS path.
- **Verdict:** rejected. Cost too high, payoff too low.

### Option B — Anam-web channel with "presentation mode" flag (medium)

Same `anam-web.ts` adapter. Presenter agent group has a flag in
`CLAUDE.local.md` ("you are in presentation mode for packet X"); when
that flag is on, the adapter behaves slightly differently: TTS-end
triggers a synthetic `[advance]` inbound row, presence of a `[STAGE]`
tag in chat output fires actions.

- **Pros:** rides existing infra. Single channel codebase. Fewer
  moving parts at runtime.
- **Cons:** mode-flag logic in the channel adapter; couples adapter to
  presenter semantics. Hard to test in isolation.
- **Verdict:** acceptable but compromised. We'd be smearing
  presenter logic across the adapter.

### Option C — Presenter as a *skill-driven scenario* on existing
anam-web (lightweight, **recommended**)

Zero channel changes. Presenter behavior comes entirely from:

1. A new container skill `present-slides` installed on the presenter
   agent group's container.
2. New MCP tools (the presenter API):
   - `audience_ready()` — kicks off slide 1
   - `present_advance(n)` — advance cursor + update deck
   - `present_resume(n)` — return to slide n after Q&A interlude
   - `present_inject_slide(spec, after=N) → new_index` — generate a
     new slide at runtime, validate-then-inject, returns the new
     index for `present_advance`
   - `present_get_slide(n)` — read raw spec (for Q&A reference)
   - Channel-specific action tools (`signal_send_demo`, etc.) — small
     surface, packet-defined
3. The presenter's `CLAUDE.local.md` carrying the mission: *"You are
   delivering packet X. Slide cursor starts at 1 (read from
   `packet/.cursor`). Read `packet/slides/01.yaml`, copy
   `notes.spoken` into your chat output VERBATIM including any
   `{{stage:...}}` markers, call `present_advance(2)` when done,
   repeat. Audience may interrupt — answer using `notes.off_script`
   + `deep-context.md`, then call `present_resume(N)` to continue.
   If audience asks something your packet doesn't cover and a chart
   would help, you may call `present_inject_slide(spec, after=cursor)`
   to author a fresh appendix slide."*
4. Pat-web frontend additions: `<RevealDeck>` component via
   `@revealjs/react` driven by a slide-state hook; "start
   presentation" button POSTs the kickoff message; SSE/WS
   subscription routes slide commands from the MCP tools to the deck.

The continuous-mission loop is in the **agent's prompt + tools**, not
in the channel. The channel stays a transport. Channel adapters
describe transport; capability is a skill.

**Auto-advance: model-driven, with TTS-end backstop.**

- **Default (model-driven):** presenter back-mind ends every slide
  turn with `present_advance(N+1)` (or `present_inject_slide(...)` +
  `present_advance(new_index)`). Prompt makes the call mandatory; if
  the model forgets, the slide doesn't change and the next inbound
  reminds it. Empirically this is reliable for Claude on a tight
  prompt.
- **Backstop (TTS-end-driven, feature-flagged):** channel orchestrator
  synthesizes an `[advance]` inbound row if TTS for slide N completes
  + 1.5s pass + no audience input + no tool-call advance fired.
  Defense in depth, not the primary path. Off by default; flag on the
  presenter messaging group.

**Embedded actions — the hybrid resolved.**

We commit to one design now (was open in v1):

- **Design-time:** authors write `stage_directions` as semantic beat
  anchors (`after: '"The propensity is not."'`). Human-readable,
  reviewable, editable. Stays in YAML.
- **Compile-time:** `compileTtsSource` rewrites anchors into inline
  marker tokens in the spoken text. Compile validates anchor
  resolution (errors if anchor not found or ambiguous).
- **Runtime:** back-mind copies the compiled string into its chat
  output verbatim — including markers. The channel-side rendition
  pipeline scans for `{{stage:NAME:IDX}}` markers, calls the
  corresponding tool synchronously (or fire-and-forget per packet
  declaration), and emits the rest of the text to TTS. The model
  doesn't have to "decide" anything — it's pure verbatim copy. The
  channel does the deterministic fire.

Marker handling lives in one place: a small extension to the existing
banter-render pipeline in `realtime/src/banter.ts` (~50 LOC). When
not in presenter mode, markers are stripped and ignored. When in
presenter mode (declared on the messaging group), markers fire the
mapped tool.

**Mid-presentation injection — first-class.**

`present_inject_slide(spec, after=N)` is the same compile path the
designer uses. The presenter back-mind can call it during Q&A:

> *Audience:* "Do you have data on detection rates by hop?"
> *Presenter:* *"Good question — let me put up the numbers."*
> *(banter ack fires immediately; back-mind generates a `timeline`-
> or `table`-layout spec; tool injects; back-mind advances; back-mind
> narrates the new slide.)*

Failure modes that compile catches before reaching the deck:
- Layout unknown → reject
- Required slot missing → reject
- Stage anchor unresolvable → reject (live appendices typically have
  no stage directions, so this rarely fires)

Validate-then-inject means a malformed spec from a hurried back-mind
can't break the running deck. The presenter just re-tries.

**Verdict / tradeoffs:**

- **Pros:** zero nanoclaw channel patches. Rides everything that
  already works (banter ack, narration, request-layer, rendition,
  TTS-busy tracking). Presenter is just an agent group with an
  unusual `CLAUDE.local.md` + a few extra MCP tools.
- **Cons:** the model has to manage cursor + advance discipline.
  Mitigated by prompt + the TTS-end backstop.
- **Verdict:** **recommended.** Smallest surface; fits the framework's
  existing seams; fastest to prototype.

### Option D — Subagent-per-slide via Claude SDK Task tool (rejected for v1)

Tempting framing: parent presenter agent spawns a Task subagent per
slide ("deliver slide 3"), each subagent runs to completion. But:
- Task tool in agent-runner is for CLI subprocess isolation, not
  cross-conversation agent delegation (per research trace).
- Per-slide context loss is a regression — the presenter needs to
  remember "what was already said" when interrupts pull back to
  earlier slides or when Q&A references prior content.
- Single back-mind agent with a slide cursor + clear mission prompt
  carries this naturally.

If we ever want per-slide subagents (e.g. for parallel pre-rendering
of next-slide content while current slide is being delivered), we can
layer that on. Not v1.

## Architectural options for the designer

The designer is a Pat capability invoked inside a normal Pat
conversation. Two shape-of-output decisions; the rest of the design is
mostly mechanical Task fan-out.

### Shape 1 — Container skill (`design-presentation`) + MCP tool for provisioning (**recommended**)

- Skill at `nanoclaw/container/skills/design-presentation/`.
- Subagent fan-out via the Task tool already exposed to the back-mind.
- Final step: a new MCP tool (`create_presentation_group`) at
  `container/agent-runner/src/mcp-tools/presentation-group.ts`. This
  tool reaches into the host (admin-approval-gated, mirroring
  `self-mod.ts`) and calls a new host endpoint that runs
  `createAgentGroup()` + `initGroupFilesystem()` + wires a messaging
  group. The packet directory is bind-mounted into the new group's
  workspace.

This matches the patterns already in tree (`generate-image` skill,
`self-mod` MCP tool, `init-first-agent` script).

### Shape 2 — Host-side `/design-presentation` slash command (rejected)

- Forces a context switch out of the conversation.
- Subagents would need to spawn outside any container (or in a
  throwaway container) — more infrastructure.
- Can't reuse `generate-image` (which is container-side).

### Subagent fan-out (six roles, three phases)

Same shape regardless of skill location:

**Phase 1 (sequential, in the designer agent itself):**
1. **Outline.** Read source material + briefing inputs. Produce
   `outline.md` and `manifest.yaml`: slide count, per-slide one-liner,
   duration budget, demo hooks (e.g., "slide 3: live Signal send"),
   tone guide, audience model. This is the contract for the rest.

**Phase 2 (parallel via Task fan-out):**
2. **Per-slide author** (N parallel). Inputs: outline + previous/next
   slide one-liners + relevant paper sections. Output: `slides/NN.md`.
3. **Per-figure illustrator** (M ≤ N parallel). For each
   `[FIGURE: ...]` directive surfaced by an author, invoke
   `generate-image` skill (`chatgpt-image-2` via OpenRouter — already
   wired). Drop PNG into `figures/`.
4. **Deep-context curator** (1). Build `deep-context.md` from the
   source material + audience model. The presenter reads this at Q&A
   time, not the designer.
5. **Fact-checker** (1, parallel). For every load-bearing claim,
   verify via WebFetch / WebSearch where the claim references
   external work. Annotates `fact-check.md`.

**Phase 3 (sequential):**
6. **Critic / red-team** (1). Reads the assembled draft, scores
   against the tone guide, flags repetition / jargon / off-tone
   moments / missing transitions. Produces `critique.md` with
   line-level diffs.
7. Designer applies critique selectively (advisory, not blind).
8. **Audience-simulator dry-run** (1, recommended for high-stakes).
   Task subagent role-plays the target audience reading slide-by-slide
   and fires 5-10 questions; designer checks the appendix covers them.

**Provisioning** (sequential, after packet is finalized):
9. Designer calls `create_presentation_group(packet_path, persona,
   channel_targets)` MCP tool. Approval-gated. Host creates the
   presenter agent group, seeds its `CLAUDE.local.md`, wires its
   messaging group, returns the URL the operator should hit to start
   ("`https://pat-web.fly.dev/present/<slug>`").

### Inputs the designer needs

User provides (designer asks only when missing):
- Source material (paper PDF / URL) — required
- Audience descriptor — required ("Senate staffer", "ML researcher")
- Time budget (minutes) — required
- Demo affordances — optional ("Signal sends on slide 3, with these
  contacts: ...")
- Presenter persona name — defaults to "Avery"
- Channel target — defaults to anam-web

Designer derives:
- Slide count (1 slide / 30-60 s of budget, modulated by demo density)
- Tone guide (from audience descriptor — Senate-staffer → plain
  English, lead with stakes; ML researcher → technical specificity)
- Per-slide beat budget
- Figure list (from outline)
- Anticipated Q&A (from source material + audience model)

## What needs a NanoClaw patch vs. lives in parent repo

**Parent repo (free to edit; PAT-side soft fork):**
- `pat-web/` — reveal.js embed via `@revealjs/react`, "start
  presentation" button, slide-state SSE subscription, presenter mode
  styling.
- `realtime/src/` — *minor* if anything. The optional TTS-end-driven
  auto-advance ticker would be a `~30 LOC` add to
  `channel-orchestrator.ts` gated by a config flag the channel passes
  through. Skip for v1.
- New plans / sprint / docs entries.

**NanoClaw soft-fork (PAT-side, edit-and-`// PAT:`-comment):**
- New container skill: `container/skills/design-presentation/`.
- New container skill: `container/skills/present-slides/`.
- New MCP tools:
  - `container/agent-runner/src/mcp-tools/present.ts` —
    `present_advance(n)`, `present_get_slide(n)`,
    `present_resume(n)`, `audience_ready()`.
  - `container/agent-runner/src/mcp-tools/presentation-group.ts` —
    `create_presentation_group(packet_path, persona, channel_targets)`,
    calls into a host endpoint.
- One new host endpoint to back the provisioning tool —
  reuses `createAgentGroup` + `initGroupFilesystem` +
  `provisionMessagingGroup` (all already exported). Probably 50 LOC.
- *Maybe:* a `present` channel skill if we go with Option B/D, but
  with Option C we don't need it.

**NanoClaw upstream (no patches needed for v1.** Aim to land any
edits as channel-skill scope so they merge cleanly later.)

## Recommended path (Option C + Shape 1, v4-scoped)

In one sentence: a fresh agent group per presentation, packet on
disk inside its folder, presenter is a container skill + a few MCP
tools running on the existing anam-web channel, slides are reveal.js
opened in an iframe side-pane on tool-fire, and scenarios are
authored offline (hand-edited for v0) and uploaded via a new
"Scenarios" tab in pat-web that provisions the agent group end-to-end.

### Scenarios tab in pat-web

New menu entry alongside the existing avatar tab. Two sub-views:

- **List view** — every provisioned scenario shows as a card with
  title, audience descriptor, duration, slide count, last-rehearsed
  date. Click = start a fresh anam-web call against that scenario's
  messaging group; the avatar tab activates with the scenario's
  persona; the agent's `audience_ready` tool fires the slide iframe
  open as a side-pane when delivery begins.
- **Upload view** — drag-drop a packet directory (or zip) →
  pat-web POSTs the bundle to a new nanoclaw host endpoint →
  endpoint runs the provisioning sequence (validate every spec
  compiles + every figure resolves + manifest is well-formed →
  `createAgentGroup` + `initGroupFilesystem` + `provisionMessagingGroup`
  + copy files into `groups/presenter-<slug>/packet/` + seed
  `CLAUDE.local.md` from manifest) → returns the new scenario id →
  scenario shows up in the list immediately.

Validation runs the *same* `validateSpec` + `compileVisual` +
`compileTtsSource` functions the runtime uses. A packet that doesn't
pass the same checks at upload time can't be provisioned — surfaces
errors back to the user as actionable feedback ("slide 3 title is
87 chars, max 60" rather than "upload failed").

This *is* the v0 substitute for the designer skill: packet ingest +
validation + provisioning, no authoring. Authoring stays manual until
the designer skill ships.

### `start_presentation` opens the slide iframe

`start_presentation()` is the MCP tool the presenter back-mind calls
once it's ready to begin delivery (typically right after
`audience_ready()` resolves). It signals pat-web via the existing
SSE event stream to open the slide iframe as a side-pane next to the
avatar. Pattern mirrors the embedded-dashboard side-pane already in
pat-web (see `reference_pat_web_dashboard_pane.md`).

The iframe loads `/decks/<scenario-slug>?token=<viewer-token>` —
same-origin to pat-web so the slide-bus WS (which `present_advance`
etc. drive) works without CORS. The iframe ships with reveal already
mounted; tool calls update the deck cursor through the bus.

Closing the iframe (operator clicks X, or the agent calls
`end_presentation()`) tears down the deck state and returns the
avatar pane to its normal size. The agent can fire
`start_presentation` again later in the same call if it ever made
sense to (probably doesn't, but the tool is idempotent).

### Phasing (code-agent-hour estimates — v4 scope)

These are focused-work hours for a coding agent, not human-days.
Whole v0 is ~10-14 hours of focused work. Order matters more than
splitting — Phase A is the smallest end-to-end slice that proves
the slide stack; Phase B is the smallest end-to-end slice that
proves a real call.

**Phase A — Slide surface + DSL + compile + validator (≈3-4 hours)**
- Add `@revealjs/react` to pat-web.
- Build the 6-layout React component library at
  `pat-web/src/talk/components/slide-layouts/` (`Title`, `Section`,
  `Bullets`, `TwoCol`, `ImageFull`, `Quote`, `Table`).
- Write `validateSpec(spec)`, `compileVisual(spec)`, and
  `compileTtsSource(spec)`. Pure functions in
  `pat-web/src/talk/lib/`; mirrored into `container/agent-runner/`
  so the in-container MCP tool can compile too.
- Build `<RevealDeck packetPath={...} cursor={n}/>` driven by a
  slide-state hook. 4:3 (1440x1080), `embedded: true`,
  `view: 'scroll'` fallback for narrow panes.
- Slide-bus over WS — small relay server in pat-web that routes
  `{cmd:'advance',n}` / `{cmd:'inject',spec}` from nanoclaw MCP
  tools to the React deck.
- Hand-author a tiny "hello world" 3-slide packet (`title`,
  `bullets`, `quote`) at `groups/presenter-helloworld/packet/`.
- Verify in pat-web: every layout renders cleanly at 4:3, narrow
  pane triggers scroll-view, validator rejects bad specs.

**Phase B — Scenarios tab + packet upload + presenter agent group (≈4-5 hours)**
- pat-web "Scenarios" tab with list + upload view. List shows
  provisioned scenarios; upload accepts a directory or zip.
- New host endpoint `nanoclaw/src/presentation/host-endpoint.ts`
  (~80 LOC): packet ingest, validation (shared `validateSpec`),
  `createAgentGroup` + `initGroupFilesystem` +
  `provisionMessagingGroup`, seed `CLAUDE.local.md` from
  `manifest.yaml`, return scenario id.
- New container skill `present-slides/SKILL.md` with the mission
  template (verbatim-copy discipline, advance-after-every-slide,
  off-script-from-spec on Q&A).
- New MCP tools at
  `container/agent-runner/src/mcp-tools/present.ts`:
  `audience_ready`, `start_presentation`, `end_presentation`,
  `present_advance`, `present_resume`, `present_get_slide`,
  `present_inject_slide`.
- `start_presentation` signals pat-web via the existing SSE event
  stream to open the slide iframe side-pane (mirrors
  embedded-dashboard pattern).
- Hand-author the Palisade self-replication packet from the
  pamphlet → upload via the new tab → verify it provisions cleanly
  → click the scenario → dry rehearsal of all 5 slides delivered
  verbatim, agent drives advance. Signal demo still stubbed (no
  real send).

**Phase C — Embedded actions (Signal demo) (≈1-2 hours)**
- Extend `realtime/src/banter.ts` rendition pipeline to scan output
  for `{{stage:NAME:IDX}}` markers; on match, look up the mapped tool
  in the messaging-group config, fire (sync or fire-and-forget per
  packet declaration), strip from text, continue TTS.
- New MCP tool `signal_send_demo(targets)` reading from
  `packet/contacts.yaml`.
- Add the Palisade slide-3 stage anchor to its spec; verify
  compile produces the inline marker at the right beat; verify
  Cartesia TTS isn't disrupted by marker presence (it's already
  stripped by the time TTS sees the text).
- Live test: rehearse the slide-3 delivery, watch real phones buzz at
  the right beat.

**Phase D — Interrupt + resume + live appendix (≈2-3 hours)**
- Audience interrupt during slide N: existing PAT barge-in cancels
  TTS, banter acks, request-layer routes the question to back-mind.
- Back-mind handles Q&A using `notes.off_script` (already in scope —
  reads from current slide's spec) and `deep-context.md`. Ends Q&A
  turn with `present_resume(N)`. Test prompt reliability on this.
- TTS-end-driven backstop in the channel orchestrator (≈30 LOC,
  feature-flagged on the messaging group). Fires `[advance]` if TTS
  ends + 1.5s + no audience input + no tool-call advance.
- Live-appendix demo: rehearse a question that requires a chart →
  back-mind calls `present_inject_slide({layout: 'table',
  title: '...', columns: [...], rows: [...]})` → injection +
  navigation visible within 2s → narration → resume to N.

**Deferred to backlog (was Phase 4 / Phase 5):**
- Full designer skill with subagent fan-out (outline + parallel
  authors + figure gen + deep-context curator + fact-check + critic
  + audience-simulator). v0 substitutes packet upload + validation.
- Google Meet via Recall.ai — see `plans/meet-channel-plan.md`.
  Stays out of scope until pat-web rehearsals are reliable.

### Verification milestones

Each phase ends with a real run, not just unit tests:

- **Phase A:** drop the hand-authored hello-world packet at
  `groups/presenter-helloworld/packet/`. Open pat-web, navigate
  manually via dev console. All 6 layouts render at 4:3, narrow pane
  triggers scroll-view, validator rejects deliberately-broken specs
  with actionable messages.
- **Phase B:** upload the Palisade packet via the Scenarios tab.
  Verify provisioning produces an agent group + scenario card.
  Click the scenario, run a full dry rehearsal of the Palisade
  script *without* the Signal demo. Avatar delivers all 5 slides
  verbatim, back-mind advances on its own at the end of each slide.
  `start_presentation` opens the iframe; `end_presentation` closes
  it. No interrupts.
- **Phase C:** same script with the live Signal demo on slide 3.
  Audience-member phones (real, pre-loaded into `contacts.yaml`)
  buzz at the right beat. Marker timing is sample-checked from
  TTS-stream logs.
- **Phase D:** two sub-tests:
  - *Interrupt+resume:* operator asks one scripted question per slide.
    Agent acks, answers from off-script / deep-context, calls
    `present_resume(N)`, continues from where it was.
  - *Live appendix:* operator asks a question the packet doesn't
    cover but a chart would help with ("what's the detection-rate
    breakdown by hop?"). Back-mind generates a `table` spec,
    injects within ~2s, narrates, resumes. The generated spec
    persists in `packet/.runtime/`.

## Critical files

**Existing — read before changes:**
- `docs/front-mind-design.md` — design intent + banter/chat invariant
- `plans/meet-channel-plan.md` — channel architecture for Meet
- `nanoclaw/CLAUDE.md` — skill / channel / provider patterns
- `nanoclaw/src/group-init.ts` — `initGroupFilesystem`, the seam for
  presenter-group provisioning
- `nanoclaw/scripts/init-first-agent.ts` — template for the
  end-to-end provisioning flow
- `nanoclaw/src/db/messaging-groups.ts` — `provisionMessagingGroup`,
  `createMessagingGroupAgent`
- `nanoclaw/src/db/agent-groups.ts` — agent-group CRUD
- `nanoclaw/container/skills/generate-image/` — pattern for the
  designer's image-gen subagent calls
- `nanoclaw/container/skills/self-customize/` — pattern for a
  per-agent container skill that mutates state
- `nanoclaw/container/agent-runner/src/mcp-tools/self-mod.ts` —
  pattern for an MCP tool that calls back into the host for an
  approval-gated action
- `nanoclaw/src/channels/anam-web.ts` — channel we'll ride
- `realtime/src/channel-orchestrator.ts` — where any TTS-end-driven
  auto-advance fallback would land (Phase 1/3)
- `pat-web/` — embedding target (`@revealjs/react` + slide loader)

**New:**
- `nanoclaw/container/skills/present-slides/SKILL.md`
- `nanoclaw/container/skills/design-presentation/SKILL.md`
- `nanoclaw/container/agent-runner/src/mcp-tools/present.ts` — the
  presenter API (advance, resume, inject, get-slide, audience-ready)
- `nanoclaw/container/agent-runner/src/mcp-tools/presentation-group.ts` —
  the designer's "create-presenter-group" tool
- `nanoclaw/src/presentation/host-endpoint.ts` — bridging endpoint
  the MCP tool calls (~50 LOC)
- `realtime/src/banter.ts` extension (~50 LOC) — `{{stage:...}}`
  marker parsing in the rendition pipeline; feature-flagged via
  messaging-group config so non-presenter channels ignore markers
- `pat-web/src/talk/components/RevealDeck.tsx`
- `pat-web/src/talk/components/slide-layouts/` — 8 layout components
  (Title, Bullets, CalloutsN, TwoCol, Table, ImageFull, Timeline,
  Quote)
- `pat-web/src/talk/lib/compile-visual.ts` — `compileVisual(spec) →
  React subtree`. ~20 LOC + layout dispatch.
- `pat-web/src/talk/lib/compile-tts.ts` — `compileTtsSource(spec) →
  string` (anchor → marker rewrite, validation). Mirrored in
  `container/agent-runner/` so the MCP tool can compile too.
- `pat-web/src/talk/hooks/use-slide-bus.ts` — slide command WS/SSE
- `groups/presenter-self-replication-2026-05/` — first real packet,
  hand-authored to debug the runtime before the designer is ready

## Open questions

Some of these were open in v1 and are now resolved (struck through);
keeping them visible so the design history is legible.

1. ~~**Beat-anchor reliability for embedded stage directions.**~~
   **Resolved (v2):** compile-time anchor → inline-marker rewrite,
   runtime channel parses markers deterministically. Model is on
   verbatim-copy duty only, not "decide when to fire."
2. ~~**Slide format tradeoff — markdown-pure vs HTML-freeform.**~~
   **Resolved (v2):** typed-DSL with 8-layout component library +
   shallow compile to React. Wins on tokens, Q&A retrieval, and
   validation-before-inject.
3. **Model-driven advance vs. TTS-end-driven advance.** Model-driven
   primary, TTS-end backstop. Empirical question whether the
   backstop ever fires; if it fires often, prompt needs tightening.
4. **Persistence of the slide cursor.** `packet/.cursor` as a single
   integer, written on every advance. Trivial.
5. **Concurrent audience input during slide-N delivery.** Existing
   PAT barge-in cancels in-flight TTS. Open: when audience
   interrupts mid-slide-3, did the Signal marker already fire? Make
   the tool either idempotent or pre-arm at slide-start.
6. **Cold open — how does the presenter know the audience is ready?**
   v1: (a) operator "audience ready" button in pat-web POSTs the
   kickoff. v2 extension: also recognize voice triggers ("ready when
   you are", "go ahead", "alright let's start"). Both gated through
   the same `audience_ready()` tool.
7. **Pacing / cadence within a slide.** Speakers don't read at
   uniform speed — the Palisade script has natural beats ("Some of
   you are feeling your phones buzz right now." — pause for effect).
   Either bake `<break time="700ms"/>` SSML tokens into the compiled
   TTS source (Cartesia + Anam both support), or trust TTS prosody.
   Default: bake explicit breaks at end-of-paragraph + after every
   stage marker. ~10 LOC in `compileTtsSource`.
8. **Per-presentation contact lists.** `contacts.yaml` is source of
   truth; `create_presentation_group` should add a sync step that
   pre-populates the Signal address book. Defer until exercised.
9. **Voice consistency across channels.** Anam (pat-web) ≠ Cartesia
   (phone). Same answer as `meet-channel-plan.md` Phase 3 (live
   with it; voice cloning later).
10. **Off-script tone enforcement.** Audience-simulator dry-run in
    designer is the first check; real rehearsal is the second.
    Restraint guidance lives in `tone.md`, injected into every
    presenter turn's system prompt.
11. **Designer hallucination risk.** Fact-checker subagent helps but
    isn't bulletproof. For Palisade-style high-stakes briefings,
    `fact-check.md` is surfaced for human review BEFORE
    auto-provisioning. The designer's last step should be a
    "ready for human review" hand-off, not silent provisioning.
12. **Live appendix image generation.** chatgpt-image-2 is 5-10s —
    too slow for sub-2s injection. Mitigation: live-appendix layouts
    are restricted to figure-free (`table`, `timeline`, `bullets`,
    `quote`, `callouts-N`) unless the back-mind explicitly buys time
    ("let me sketch that out — give me a moment"). Default
    `present_inject_slide` rejects specs requesting figures unless
    `allow_long_gen: true` is passed.
13. **Mid-presentation injection persistence.** Generated appendix
    slides written to `packet/.runtime/ap-NNN.yaml`. After the
    presentation ends, optionally promote them to `packet/slides/`
    with renumbering. Probably manual / on demand.

## Out of scope / backlog

- **In-presentation operator controls.** Mid-run, operator wants to
  skip a slide, add a note, or force advance. Doable later via a
  control-pane in pat-web that POSTs to the slide-bus.
- **Multi-presenter conversations.** Pat + a co-presenter agent
  trading turns. Out of scope; would need a second avatar slot.
- **Audience reactions in the loop.** Detecting laughter, confusion,
  pulling that into the presenter's prompt as live feedback.
  Interesting but speculative.
- **Pre-rendered TTS for an entire deck.** Lower-latency option — we
  ship a packet *with* MP3s already generated, so live delivery is
  audio playback + slide control, not LLM-on-the-fly. Different
  tradeoff (rehearsal-quality output, no live adaptation). Probably
  worth a separate experiment after v1 ships.
- **Slide-level analytics** — which slides got the most Q&A, where
  did the agent stumble. Useful for iterating; not on the critical
  path.
- **Speaker-view feedback to the agent.** Reveal has a built-in
  speaker-view (current + next + notes + timer). If the agent could
  see a snapshot of that view, it could self-regulate pacing. Cool
  but premature.
- **More layouts than the v1 eight.** Add layouts only when packets
  in the wild want them. Resist the urge to pre-design.
- **Themed packets / branding.** `tone.md` covers voice; visual
  theming (Palisade brand vs neutral vs presenter-specific) is a
  CSS-vars layer on top of the layout library. Trivial to add when
  needed.
- **Round-tripping audience-asked appendix slides into a permanent
  packet.** Generated `.runtime/ap-NNN.yaml` files become durable
  artifacts; manually promoting them into `slides/` post-talk is fine
  for v1, but a `promote_runtime_slide(name, position)` MCP tool
  would be a nice ergonomic later.

## References

External research that informed v2 layout decisions:

- [reveal.js layout docs](https://revealjs.com/layout/) — `r-fit-text`,
  `r-stretch`, `r-stack`, `r-vstack`, `r-hstack`. Sharp edge:
  `r-stretch` is direct-descendant-only, one-per-slide. Don't use it
  inside our grid layouts.
- [reveal.js auto-animate](https://revealjs.com/auto-animate/) — the
  cross-slide animation we use for `timeline`-style builds.
- [reveal.js scroll view](https://revealjs.com/scroll-view/) — 5.0+
  feature, our fallback for narrow embed panes.
- [reveal.js presentation-size](https://revealjs.com/presentation-size/) —
  the 1920×1080 + `embedded: true` config we land on.
- [reveal.js layout-helpers example](https://github.com/hakimel/reveal.js/blob/master/examples/layout-helpers.html) —
  canonical demo of `r-fit-text` + `r-stretch` + `r-stack` together.
  Read this before designing the components.
- [Slidev layouts](https://github.com/slidevjs/slidev/tree/main/packages/client/layouts) —
  17-layout catalog; the de-facto vocabulary for AI slide tools.
  Especially `two-cols.vue`, `image-right.vue`, `quote.vue`,
  `cover.vue` for the slot/prop convention we mirror.
- [Chen Hui Jing — customising reveal.js beyond theming](https://chenhuijing.com/blog/customising-revealjs-beyond-theming/) —
  the cleanest reveal-grid pattern using `grid-template-areas`.
- [reveal.js issue #2149](https://github.com/hakimel/reveal.js/issues/2149) —
  vertical-overflow autoshrink, open since 2018. Why we need
  compile-time validation.
- [*Talk to Your Slides*, arxiv 2505.11604](https://arxiv.org/html/2505.11604v1) —
  May 2025 survey of LLM slide tools; confirms content overflow is
  the universal failure mode and recommends the compile-time +
  render-time validation pattern we adopt.
- [Marp `bg left/right` directive](https://marpit.marp.app/image-syntax) —
  the prior-art syntax sugar for image-text layouts. We absorb it
  into `two-col` with `kind: figure`.
- [autonomee.ai Claude Code presentation plugin](https://autonomee.ai/blog/reveal-presentations-generate-slide-decks-from-claude-code/),
  [OpenSlides](https://github.com/YuxiangChai/OpenSlides),
  [zarazhangrui/frontend-slides](https://github.com/zarazhangrui/frontend-slides) —
  three working AI-slide tools that ship raw HTML output, useful as
  contrast cases (we're betting compile-step DSL + 6 layouts beats
  raw-HTML freedom on reliability).

## Demo-day risks

The Palisade briefing is the real test, so worth calling out what
could go wrong in front of an audience:

- **Embedded Signal send fails or times out** mid-paragraph. With
  the marker-driven design, the channel can wrap the tool call in a
  short timeout — if the action errors or doesn't return within ~2s,
  emit a structured log + continue TTS. The packet should also
  include an explicit recovery move on slide 3 (*"the demo didn't
  land on your phones in time — here's what I tried to do"*).
- **Audience interrupts mid-slide-3** before the Signal marker
  fires. PAT's barge-in cancels in-flight TTS at the rendition
  boundary; depending on where the cancel lands, the marker may
  not have been reached. Two mitigations: (1) make
  `signal_send_demo` idempotent (sending the same demo twice is
  safe — first call dedupes), (2) on slide-3 entry, pre-arm the
  action server-side so even if the rendered TTS doesn't make it,
  the demo still fires within ~10s.
- **Live-appendix injection produces a broken spec.** Compile-time
  validation rejects bad specs before they reach the deck, so the
  failure mode is "agent's tool call returned an error" not "deck
  is now broken." Agent prompt says: on `present_inject_slide`
  error, fall back to a `bullets` layout with a text-only
  fallback.
- **Reveal.js fails to load** in the Recall-rendered Meet page.
  Verify on a real Recall bot well before demo day (Phase 5).
- **Avatar mismatch between rehearsal (pat-web) and Meet (Anam BYO
  LLM)**. Same issue `meet-channel-plan.md` flags. Demo on pat-web
  first; Meet only after Phase 5 ships.
- **The audience asks a question the deep-context pack doesn't
  cover** AND doesn't lend itself to an appendix slide. Recovery
  template from the Palisade script (*"Honest answer: the paper
  doesn't address that. Palisade can follow up offline."*) is the
  default in the presenter's system prompt.
- **Compile cache poisoning.** If a packet was authored on Sonnet
  and then re-rendered on Opus, the compiled visuals should be
  deterministic — but if anyone edits a layout component between
  packet authoring and runtime, slides that compiled previously
  could render differently. Layout components are versioned in
  source; packet manifests pin a layout-library version. Mismatch
  is a hard error at packet-load.
