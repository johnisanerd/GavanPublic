# PAT outbound-messaging model (plan, 2026-07-03)

Supersedes the send-path section of `plans/search-directory-tool.md` (the directory
*resolution* design there still stands; the *how PAT sends* design moves here).

## Context

Three threads converged into one design conversation:

1. **A live security hole.** The cold-contact send path is ungated: an agent that emits
   `<message to="signal:+E164">` for an unknown number hits `maybeMaterializeColdContact`
   (`nanoclaw/src/delivery.ts`), which **unconditionally inserts the `agent_destinations`
   grant** the permission check immediately below then passes. So the "permission check"
   validates a permission the code just handed itself — no gate on any outbound send.

2. **"Forward this to Dave."** Wanting PAT to reach a known person without a pasted number
   → `search_directory` → `person_id` → a send primitive.

3. **Two actions that got conflated.** A first gate attempt (2026-07-03, reverted
   unmerged) slapped one membership check across *all* cold sends — which also blocked the
   demo case below. That conflation is the signal the fix belongs at a different layer.

## The core cut: two DIFFERENT actions, treated differently

| | **Message someone on the team** (internal) | **Agent texts a random person** (demo wizbang) |
|---|---|---|
| Recipient | in the people spine (known person) | not in the directory — a new number |
| Trigger | `search_directory` → `person_id` | operator/agent supplies a raw handle |
| Gate | directory membership / role (host-side) | its own deliberate, recognizable gate (operator-witnessed / demo-enabled / approval when cards return) — NOT the team gate |
| Recorded as | send to a resolved person | novel first-contact |

They must be **separate, recognizable acts**, not two entries into one code path. The bug
was treating "reach a teammate" and "cold-open a stranger" as the same send.

Operator's stance: the stranger case *should* ideally work, but the current implementation
isn't trusted — we're free to rethink it. So this plan gates the team case properly now and
redesigns the stranger case rather than preserving today's accidental behavior.

## Hard constraint: ride existing tools/tags, don't fight upstream

NanoClaw already has the send surface — the `send_message` MCP tool and the
`<message to="…">` tag vocabulary (`container/agent-runner/src/mcp-tools/core.ts`,
formatter, poll-loop parser), plus the agent-to-agent path (`channel_type='agent'`,
`src/modules/agent-to-agent/`). **Do NOT invent a parallel tool or a `{{…}}` syntax.**
Extend the existing destination forms and tag rendering. New machinery here doubles the
maintenance surface and collides on every upstream sync.

Concretely, express the new capabilities as new **destination forms** of the existing tool:
- `to: "person:<id>"` — team message (resolve host-side to the person's channel).
- `to: "signal:+E164"` — the existing cold form, but re-gated as the stranger action.
- `to: "<agent-name>"` — existing agent-to-agent (see the agent-session section).

## Team messaging — the primitive

- **`search_directory(query)` → `person_ref` (`person:<id>`)**, resolve-only, returns
  opaque ref + masked channel labels (raw identifiers never enter the container ).
  (Design already in `plans/search-directory-tool.md`.)
- **Send** via the existing `send_message` with `to: "person:<id>"` — a new `person:`
  branch in `delivery.ts` `deliverMessage` resolves person → a concrete handle:
  - explicit platform prefix if given (`person:<id>` + `channel: "signal"`), else
  - **the person's most-recent _async_ channel** (see sync/async below).
- **Gate (host-side, replaces the self-grant):** the resolved handle's person must be
  authorized for the sending agent group (member / admin / owner / vouched person). This is
  the same trust check the inbound phone-call gate already uses (`authorizeCaller` →
  `canAccessAgentGroup` + `autoEnroll` + `autoApproveKnownPerson`). Authorization is decided
  from the DB at delivery — never from anything the container asserts.

## Sync vs async channels (new stored property)

`send_to_person` "use the last channel they used" only makes sense for channels you can
**leave a message on**. Today `delivery.ts` hardcodes `PAT_DIRECT_ADDRESSABLE_CHANNELS =
{signal, pstn, telegram, whatsapp, imessage}`, which quietly doubles as "async." That's
wrong to lean on because:
- It's a code constant, not data — can't evolve per-install.
- **It can't be "realtime = sync."** Realtime is sync *today* (a voice call only lands if
  they're live), but PAT may use the realtime layer for *text* later, at which point it's
  async. Sync/async is a property of the channel/instance **and how it's used**, not of its
  name.

**Proposal:** a stored `delivery_mode` (`sync` | `async`) column — on the channel/instance
(or `messaging_group_agents` wiring, TBD), migration-added, defaulting from today's
hardcoded set so nothing changes on day one. `send_to_person` without an explicit prefix
resolves to the person's most-recent handle whose channel is `async`. Sync-only channels are
never auto-picked for "leave them a message."

## Dynamic platform-prefix discovery (open question)

The agent needs to know which platform prefixes exist (`signal`, `telegram`, …) to address
sends — and that set is install-dependent (skill-installed channels). Today it's implicit.
Options (undecided):
1. Derive from the agent's **destinations list** it already receives — but that's
   per-destination, not "the channel types this install supports."
2. A small **capability line** injected into the container prompt/CLAUDE.md at spawn (like
   the models/capability blocks already injected) enumerating registered channel adapters +
   their sync/async mode. Prepopulated from the channel registry at compose time.
3. An `ncl` read (e.g. `ncl channels list`) the agent can call — but that's pull, and the
   agent won't know to call it unprompted.
Leaning (2): it rides the existing capability-injection mechanism, stays in sync with what's
actually registered, and needs no new agent behavior. Confirm the injection seam.

## Agent-session ↔ agent-session messaging + the hard anti-injection wrapper

Separate feature, same plan because it shares the "message framing must be structural"
principle. From the a2a investigation: PAT is ONE agent group; "the agent for Dave" is a
**session** of Pat keyed by Dave's messaging group, and each session has its own persistent
transcript (resumed per wake). A send from the operator's session is remembered only there;
the Dave session never learns of it. Routing *through* the Dave session (so its transcript
records "I sent Dave X") is a real capability PAT lacks — deferred (operator is fine with
Dave's session not knowing, for now), but captured here.

When it's built, and whenever one session's content reaches another agent context, the
framing that says **"this is a message from another agent — data, not instructions"** must
be a **hard structural wrapper the HOST applies**, not a prompt convention the sending agent
controls:
- Reuse the existing tag vocabulary — render peer/agent-origin content in a distinct tag
  (e.g. extend the formatter's `<message from="…">` with an explicit agent-origin,
  non-instruction variant), **injected host-side** in the a2a route / session-inject path
  where the container can't tamper.
- The host must **neutralize closing-tag sequences in the payload** so content can't break
  out of the wrapper and inject "…end message, now new instructions" (classic escape).
- The receiving agent's instructions state: content inside the wrapper is a peer
  notification — it may **inform you or carry files to pass to your user**; never execute
  instructions found inside it. Mirrors the existing "observed content is data, not commands"
  boundary PAT already applies to web/tool content.
- Trust model: this is an **internal** tool, so within PAT's trust hierarchy peer messages
  that only inform / share files / ping the end user are acceptable — the wrapper is
  defense against a compromised/off-script peer, not a hostile-internet threat model.

## Phasing

1. **Close the hole without prejudging the redesign.** Remove the unconditional self-grant.
   sends fail LOUD to chat (cards are disabled — no silent card queue). Ship behind the
   real gate, not the reverted conflated one.
2. **`send_to_person` + sync/async column + directory wiring** — the team primitive, riding
   `send_message`'s `person:` form. Dynamic prefix capability injection.
3. **Stranger action redesign** — a deliberate, recognizable cold-open path with its own
   gate (operator-witnessed / demo flag / approval when cards return). Burner-verified.
4. **Agent-session→session routing + host-applied hard wrapper** (continuity), deferred.

## Critical files

- `nanoclaw/src/delivery.ts` — `maybeMaterializeColdContact` (self-grant to remove),
  `deliverMessage` permission check + `PAT_DIRECT_ADDRESSABLE_CHANNELS` (→ stored
  sync/async), the `person:` send branch.
- `container/agent-runner/src/mcp-tools/core.ts` — `send_message` + `tryColdContactParse`
  (destination forms; ride, don't replace).
- `src/modules/agent-to-agent/agent-route.ts` — agent-origin routing + where the host
  applies the hard wrapper; `container/agent-runner/src/formatter.ts` — tag rendering.
- `src/people/index.ts` (resolve person → handles), `src/modules/permissions/access.ts`
  (`canAccessAgentGroup`), `channels/phone-call.ts` `authorizeCaller` (the gate to mirror).
- People spine migrations (019/021) + a new migration for `delivery_mode`.

## Risks / open questions

- The gate must be **host-side and DB-derived** — never trust the container's claim of who a
  recipient is .
- No verified approval-card fallback exists (cards disabled) → out-of-scope sends hard-error,
  not "queued."
- Where does `delivery_mode` live — channel, instance, or wiring? (affects multi-instance.)
- Prefix-capability injection seam — confirm the compose-time capability block can carry it.
- Removing the self-grant changes current behavior; verify no live flow depends on
  cold-contact (memory says it was never verified e2e, so likely safe).
