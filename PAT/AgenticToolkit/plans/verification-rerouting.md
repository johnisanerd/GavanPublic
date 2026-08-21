# Verification / Approval-Card Rerouting

**Status:** design (extracted from the deprecated `plans/person-identity.md` 2026-06-22). Pre-implementation.
**Depends on:** the people spine (`plans/admin-dashboard-and-people.md`, Phase 1) — specifically
`person_users`, so "this approver's *other* handles" is resolvable. Build after the spine lands.

## Problem

The demo scenario: an admin is on a **PSTN voice call**. The system needs to deliver an
approval / verification card. PSTN voice can't render interactive cards. The system should
**reroute** the card to one of that admin's *other* channels that can (Signal, Telegram, …).

Today nothing does this — `pickApprovalDelivery` prefers the same channel kind and has no notion
of "this is the same human on a different channel."

## Design — three pieces (~60 LOC + one constant per adapter)

1. **Verifiability flag on `ChannelAdapter`.**
   - Add `supportsVerificationCards?: boolean` to the interface (`nanoclaw/src/channels/adapter.ts`).
   - PSTN voice → `false`. Signal / Telegram / Discord / Slack → `true`. Declared per-adapter at
     registration. ~10 lines + one constant per adapter file.
   - **Unknown adapter defaults `true`** — non-card-capable channels opt *out* explicitly.

2. **Per-channel recency on `user_dms`.**
   - Add `last_used_at TEXT` column (cheap ALTER). Updated by the host in `nanoclaw/src/delivery.ts`
     after each successful delivery to a `(user_id, channel_type)` pair. ~15 lines.
   - Doubles as the general "preferred handle" signal — which is why the people spine can defer
     `default_user_id` / `default_admin_user_id` out of `people`.

3. **Rerouting in `pickApprovalDelivery`** (`nanoclaw/src/modules/approvals/primitive.ts:103`).
   - Walk the approver's **person** → their other handles (via `person_users`) → filter to
     channels where `supportsVerificationCards === true` → sort by `last_used_at` DESC
     (**NULLs last** — never-used-but-capable channels are valid, lowest priority) → return the
     top one's messaging group. ~30 lines, replacing the existing same-channel-kind preference loop.
   - **No verifiable channel?** Fall back to existing behavior (return any reachable channel, even
     if non-verifiable) and **log a warning**. Better to deliver a card that may render poorly than
     to drop the approval entirely.

## Open questions (carried from person-identity.md)
1. **Default verifiability of an unknown adapter** — resolved above: default `true`.
2. **Recency for never-used channels** — resolved above: `last_used_at` NULL sorts last, still eligible.
3. **Person with no verifiable channels** — resolved above: fall back + warn.

## Notes
- Mark all in-tree edits `// PAT:` for greppability against an upstream sync (same hygiene as the
  people spine).
- If the spine ships before this, the suffix-match fallback (one-flow-well §5) gives a less precise
  "any suffix-matched user with a verifiable channel" version; the person-spine version is exact.
