# Scenarios

`@agentic-toolkit/scenarios` packages the named, pre-configured agent
experiences PAT runs end-to-end — presentations, walkthroughs, future
demo formats. Each scenario bundles:

- A **content packet** (slides, tone, deep context) provisioned into
  the agent's container at session start.
- A **domain extension** for the timeline runtime, contributing the
  scenario-specific action vocabulary.
- A **per-kind UI surface** (today: reveal.js-flavored deck renderer
  for the presentation kind).

This doc is the entry point. The end-to-end design — including
in-flight phases like reveal-HTML-as-canonical and `<timeline_span/>`
hydration — is `plans/timeline-runtime-and-scenarios.md`.

## What a scenario is

A scenario is the marriage of:

1. **A packet** — markdown + YAML + assets describing the experience.
   `nanoclaw/groups/<slug>/packet/` is the on-disk shape; it's
   provisioned into `/workspace/agent/` on session bring-up.
2. **An agent identity** — `CLAUDE.local.md` in the group dir sets the
   agent's role, voice, and the rules it follows. Imports
   `_packet-bundle.md` (auto-generated at provision) so the content
   rides in the system prompt.
3. **A delivery contract** — currently `tag-stream`: the agent's chat
   reply is wrapped in `<timeline>...</timeline>` containing the
   action sequence the host plays out.
4. **A UI surface** — for presentations, a reveal.js deck rendered by
   `pat-web` with audience-facing slides.

## The presentation kind

The first and only scenario kind today. Files of interest:

- `src/presentation/slide-spec.ts` — the per-slide shape: layout,
  content, fragments, anchors. Today's authored format is YAML; the
  reveal-HTML-as-canonical migration (Phase 6) will replace it with
  authored HTML and an extractor that derives the agent view.
- `src/presentation/validate-spec.ts` — schema check + the
  human-readable error tree.
- `src/presentation/compile-tts.ts` — produces the per-slide spoken
  text the agent uses in `<verbatim>` splices. Will retire once
  banter-dispatch handles voice-shaping per-`<say>` and the deck is
  the only authored source.
- `src/presentation/react/` — the audience-facing deck renderer
  (consumed by `pat-web/`).
- `src/presentation/fixtures/` — canonical demo packets.
- `src/presentation/timeline-actions.ts` — the
  **`scenarios.presentation`** ActionDomainExtension. Registered at
  module load via `registerActionDomain` from
  `@agentic-toolkit/realtime`. Owns the scenario action vocabulary.

## The domain extension

`scenarios.presentation` claims the §3.11 canonical tags from
`plans/timeline-runtime-and-scenarios.md`:

- `<next_slide/>`, `<prev_slide/>`, `<nav_slide_{up,down,left,right}/>`,
  `<goto_slide n="N" v="V"?/>`
- `<next_fragment/>`, `<prev_fragment/>`
- `<ask_for_questions/>`

Plus nine **legacy aliases** for back-compat with existing packets
(`slide_next` → `next_slide`, `frag_next` → `next_fragment`,
`slide_go_to` → `goto_slide`, etc.). Both forms produce the same
internal action.

### Lifecycle

1. **Module load** — `import '@agentic-toolkit/scenarios/presentation'`
   anywhere in the host process runs the side-effect
   `registerActionDomain(scenariosPresentationExtension)`. Nanoclaw does
   this from `nanoclaw/src/channels/anam-web.ts` near orchestrator
   construction.
2. **Parse** — when the parser encounters a tag the base interpreter
   doesn't recognize, it consults `findExtensionFor(tag)`. Our
   `matches()` claims our tags; `parseAction()` returns the
   `TimelineAction` variant.
3. **Dispatch** — the sequencer calls `extension.dispatch(action,
   ctx)`. The extension reads `ctx.host.scenarioActionDispatcher` and
   delegates the actual side effect (slide-bus POST, etc.).

### Why a registry pattern

Because future scenarios will want their own actions. A robotics demo
might contribute `<drone_move_to lat lon alt/>`; an agentic-coding
walkthrough might contribute `<dispatch_subagent prompt/>`. Each
package registers its own extension; the runtime stays neutral.

## Packet provisioning

The host packs everything an agent needs to deliver a scenario into
its container at session start:

```
nanoclaw/groups/<scenario-slug>/
  packet/
    manifest.yaml           # slug, title, slide_count, delivery_mode
    slides/<n>.yaml         # per-slide spec (today's YAML format)
    tone.md                 # voice / personality guide
    deep-context.md         # audience-Q&A primer (free-form prose)
    audience-qa.md          # legacy structured Q&A (Phase 6: retires)
  CLAUDE.local.md           # agent system prompt
  _packet-bundle.md         # auto-built at provision time
```

The provision step compiles the packet on demand from these sources.
See `nanoclaw/src/presentation/` for the runtime side.

## Authoring a new presentation

The current happy path (until Phase 6 reveal-HTML-as-canonical lands):

1. Create `nanoclaw/groups/<slug>/packet/manifest.yaml` with
   `delivery_mode: tag-stream`.
2. Author each slide as `nanoclaw/groups/<slug>/packet/slides/N.yaml`
   following the schema in `src/presentation/slide-spec.ts`. Include
   `notes.spoken` for verbatim splices.
3. Write `tone.md` (Pat's voice for this scenario) and
   `deep-context.md` (everything the agent needs to handle audience
   Q&A).
4. Write `CLAUDE.local.md` modeled on the existing examples (e.g.
   `nanoclaw/groups/presenter-ai-self-replication-palisade-2026/`).
   Import `_packet-bundle.md` at the bottom.
5. Validate locally — `pnpm --filter @agentic-toolkit/scenarios test`
   covers the schema validator + fixture round-trips.

## Roadmap

- **Reveal HTML as canonical** (Phase 6) — author slides as reveal.js
  HTML with `<timeline>` and `<context>` blocks in
  `<aside class="notes">`. An extractor derives the agent view
  (`<presentation_slide>` XML). Drops the YAML format and the
  structured `notes.off_script.faq[]` schema.
- **`<timeline_span/>` hydration** — back-mind emits short span
  references; host inline-expands from the authored timeline. Resolves
  the per-slide token cost.
- **Future kinds** — walkthroughs, multi-step demos, robotics
  sequences. Each adds a sibling under `src/<kind>/` and registers its
  own domain extension.

## Files at a glance

- `src/presentation/timeline-actions.ts` — domain extension.
- `src/presentation/timeline-actions.test.ts` — extension tests.
- `src/presentation/smoke-packet.test.ts` — end-to-end smoke-packet
  delivery (old + new tag forms produce identical sequences).
- `src/presentation/slide-spec.ts` — slide schema.
- `src/presentation/validate-spec.ts` — schema validator.
- `src/presentation/compile-tts.ts` — spoken-text compiler.
- `src/presentation/react/` — audience-facing deck renderer.
- `src/presentation/fixtures/` — canonical demo packets.

## See also

- `@agentic-toolkit/realtime` `TIMELINE.md` — the runtime this
  extension plugs into.
- `plans/timeline-runtime-and-scenarios.md` — the design doc.
