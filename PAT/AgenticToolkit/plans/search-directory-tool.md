# search_directory — "Forward this to Dave" (plan, 2026-07-03)

## Context

Operator ask: a simple agent tool so PAT can resolve a person reference
("Dave") to enough to **send them a Signal message**, with a
**non-approval-card** scoping story. Options requested, not one answer.

**⚠️ The send path is already ungated (verified in source 2026-07-03).** The agent
can TODAY send Signal/SMS to any E.164 with zero approval: `send_message(to:
"signal:+E164")` → `tryColdContactParse` (`container/agent-runner/src/mcp-tools/core.ts:69`)
→ host `maybeMaterializeColdContact` (`delivery.ts:461`) **unconditionally auto-grants**
an `agent_destinations` row (`delivery.ts:356-360`) so the permission check
(`delivery.ts:471-482`) passes. So this project is **not "relax a gate so Dave is
reachable" — it's "add the FIRST gate" to a path open to the whole E.164 space**, and
give the agent a directory so it stops needing pasted numbers. The gate belongs on the
send path, host-side (nothing the container asserts can authorize a send), and must
**replace** the auto-grant. This is tracked as a 🔴 security finding in backlog.md — the
gate should land regardless of whether the directory UX ships.

Today the agent can only address (a) the current chat, (b) `agent_destinations`
local names, (c) raw `signal:+E164` cold-contact (the ungated path above) — and it has no
way to look a person up. The people spine (`people`, `person_identifiers`,
`person_users`, `person_roles`) exists and is populated; `person_roles`
(admin|employee) is **built but enforced nowhere** — this feature would be its
first enforcement point. Approval cards are currently **disabled** (2026-06-25
pairing-code switch), so any "fall back to a card" path silently black-holes —
v1 must hard-deny with a clear message instead.

## Tool shape (two tools, resolve ≠ send)

**`search_directory({ query })`** → resolves against `people.display_name` +
`person_identifiers` (case-insensitive substring; ≤5 matches returns a
disambiguation list). Returns per match:

```json
{ "person_ref": "person:p-...", "name": "Dave Smith",
  "channels": ["signal"], "relationship": "employee",
  "can_send": true }
```

**Privacy rule: raw identifiers (E164s, UUIDs, emails) never enter the
agent gets an opaque `person_ref` + channel *kinds*; the host resolves the ref
at send time.

**`send_to_person({ person_ref, text })`** (or `person:<id>` as a new
`send_message`/destination target type — decide at build time; separate tool is
simpler v1). Host handler: person → best identifier for an available channel
(signal first) → existing DM machinery. Same trusted-ctx pattern as
`files publish` (ncl custom op or delivery action; agent group + session from
CallerContext, never args).

## Scoping options (who is discoverable/sendable WITHOUT a card)

| | Gate | Tables | Pros / cons |
|---|---|---|---|
| **(a) same agent group** | sender's `ctx.agentGroupId` ∩ target's users via `agent_group_members`/`user_roles` → `person_users` | existing | Tightest; zero new config. But "Dave" fails unless he's wired to THIS group — poor fit for "forward to a colleague". |
| **(b) admins/owners** | target person has a user with owner/admin `user_roles` | existing | Tiny surface, safe bootstrap. Team-of-admins works today. |
| **(c) employees** | `person_roles.role IN ('admin','employee')` | existing, needs backfill (Gavan is sole holder) | Matches the internal-tool intent ("anyone at Palisade"). First real use of person_roles; requires role hygiene via `ncl person-roles grant`. |
| **(d) per-group allowlist** | new `agent_destinations` rows with `target_type='person'` | small migration | Explicit ACL, reuses the destination primitive + its projection; more operator upkeep. |
| **(e) tiered** | (b)∪(c) silent; others → approval card | — | The eventual right answer, but cards are disabled → v1 would black-hole. Defer until cards return. |

**Recommendation: (c) with (b) as the de-facto bootstrap** — discoverable =
sendable = persons with `person_roles` admin|employee; backfill roles for the
current team first. Enforcement lives **host-side in the custom-op handler**
(same place `files publish` trusts ctx), never in tool descriptions. Non-role
persons: `can_send:false` + a message telling the agent to ask the operator —
no silent drops, no cards.

## Send path — v1 constraint

`user_dms` cold-DM cache + existing messaging groups make sends to **already-
known DMs** safe and boring. True cold-contact Signal send was **never verified
end-to-end** (one-flow-well memo; gated behind burner-phone verification) and
unknown-sender replies black-hole on prod. So:

- **v1: send only when a DM route already exists** (user_dms hit or an
  existing 1:1 messaging group for one of the person's users). Else return
  "no established DM with Dave — ask the operator to have Dave message PAT
- Cold-contact initiation = its own later phase, behind the one-flow-well
  verification gate.

## v1 in a half-day

1. `ncl directory search` custom op (resource `directory`, access `open`,
   whitelisted for `cli_scope=group` like `files`) — resolve + role-gate +
   DM-route check; returns person_refs only.
2. `send_to_person` as a delivery action (mirror `send_voice_memo`'s
   host-handler pattern) resolving person_ref → route → adapter send; emits
   `directory.sent` (+ mirrors) or reuses `outbound.sent`.
3. Two MCP tools wrapping the above (`search_directory` sync via ncl;
   `send_to_person` fire-and-forget via messages_out).
4. Role backfill: `ncl person-roles grant` for current team; tests for the
   gate (role present/absent, no-DM-route, ambiguous name).

Risks: role backfill forgotten → everything `can_send:false` (loud, safe);
name collisions (disambiguation list covers); privacy of `relationship` field
(kind-level only, fine).
