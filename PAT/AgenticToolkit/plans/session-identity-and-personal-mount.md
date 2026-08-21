# Session identity correctness & per-person `/personal` mount

Status: proposed (2026-07-01). Owner: TBD (coordinate with the in-flight code work).
Related: `KNOWN_ISSUES.md` → "Per-person `/personal` memory dir silently fails to
mount on stale-identity sessions".

## Context

`/personal` (per-person memory) is mounted at container spawn from
`session.user_id` (`nanoclaw/src/personal-memory.ts:86-116` →
`resolveSessionPerson` → `getPersonByUser(session.user_id)`). `session.user_id`
is **written once at session creation and never re-derived**
(`session-manager.ts`). So if that frozen value is empty or doesn't resolve to a
person, `/personal` is silently omitted (only `/shared` mounts; nothing errors).
The agent still greets by name because the name comes from `users.display_name`,
a separate source — hence the "right name, no personal memory" symptom.

Two independent defects feed this:

1. **Junk identity minted at the source (phone-call).** On a call, the front-mind
   **banter ack** row is emitted *before* the back-mind forward, and it wins the
   session-creation race. The banter row (`recordBanter`,
   `nanoclaw/src/channels/phone-call.ts:1204-1211`) carries **no `senderId`** — its
   `sender` is the literal `'pat'`. The sender resolver
   `extractAndUpsertUser` (`nanoclaw/src/modules/permissions/index.ts:94-97`,
   **upstream** code) namespaces any bare handle, so `'pat'` → **`phone-call:pat`**.
   The session is stamped with that; the later chat-forward row (which *does* carry
   the real `pstn:<number>`) reuses the same per-thread session and never updates
   the frozen field. Net: **every** phone session is stale, and a junk
   `phone-call:pat` `users` row exists (prod: 1 users row, 8 closed sessions pinned
   to it, 3 real `pstn:` users sitting unused — verified 2026-06-30).

2. **Write-once `session.user_id` can't self-correct.** Even when a later row (or a
   later person-link) has the right identity, the session can't catch up. This is
   the general axis behind the legacy stale rows (Signal/Slack pre-people-spine,
   link-after-first-contact, Signal handle-form drift on a public channel).

### Not currently reachable ≠ not worth fixing
Under our gated `unknown_sender_policy` config, defect #2 doesn't create *new*
stale rows for chat channels (unknown senders are refused before a session
exists). But defect #1 (phone-call) reproduces on **every** call by construction,
and defect #2 reopens the moment a channel goes `public`/`allow` or a session
moves public→private. See KNOWN_ISSUES for the full reopening matrix.

## Goals / non-goals

**Goals**
- The right `user_id` (and therefore the right person) is attached to a session
  **from creation**, independent of which row wins the race.
- Nothing downstream can silently fabricate a junk identity.
- Legacy stale rows cleared as a one-time backfill — explicitly NOT an ongoing
  self-heal mechanism (person resolution already happens live at spawn; see Phase 2).
- Minimize fork-sync surface (prefer PAT-side seams; upstream a PR rather than
  carry drift where possible).

**Non-goals**
- **Runtime identity self-heal** (mutating `session.user_id` from message traffic) —
  explicitly rejected as unnecessary magic + a leak risk; see Phase 2.
- The pairing-UX hole (code from an already-authorized handle is swallowed into
  chat) — related, tracked separately below, not in scope here.
- Reworking the banter-before-forward ordering (it's correct; the fix is to make
  the banter row identity-honest, not to reorder).

## Plan

### Phase 1 — Attach the real caller identity to the banter row  ★ the actual fix
- **File:** `nanoclaw/src/channels/phone-call.ts` — `recordBanter` callback (~:1204-1211).
- **Change:** add `senderId` to the emitted content object, mirroring
  `forwardToBackMind` (:1196). `senderId` (`pstn:<callerNumber>` or
  `realtime:<platform>`) is already in scope at :1106. The `sender`/`from` display
  field stays `'pat'` — that's *who is speaking*; `senderId` is *whose session this
  is*. Those are different things; conflating them is the bug.
- **Effect:** whichever row creates the session, it now carries the authoritative
  `pstn:<number>` → session stamped correctly from creation → `/personal` mounts and
  attribution is right from turn one. **Zero upstream files touched.**
- **Also audit:** `nanoclaw/src/channels/anam-web.ts` for the same
  `recordBanter`-without-`senderId` pattern (anam-web visitors are anonymous uuids
  so no person resolves, but the identity-correctness principle is the same — fix if
  present).

### Phase 2 — Rely on live resolution; do NOT build a self-heal mechanism
The instinct to add a "self-correcting session identity" layer is a trap. Most of it
already happens for free, and the part that doesn't isn't worth building — it's
unnecessary magic that mutates identity from message traffic, i.e. a leaky
abstraction, and it fails *unsafe*.

**Why it's mostly free:** `resolveSessionPerson` calls
`getPersonByUser(session.user_id)` **at every container spawn**, reading
`person_users` live. The session row stores a *handle*, not a person — the
handle→person link is resolved fresh each spawn. So "link-after-first-contact"
self-heals with zero heal code: a session stored with a correct-but-unlinked handle
(e.g. `signal:+E164`) starts mounting `/personal` on the next spawn the moment the
link exists. Chat channels already store correct handles; Phase 1 makes phone-call do
the same. So after Phase 1 the ONLY wrong/empty-handle sessions are legacy
pre-people-spine rows — a finite, one-time set.

**What we actually do instead:**
- **Rely on existing live resolution** for link-after-contact. No code.
- **One-shot backfill** for the finite legacy wrong/empty rows (the live ones were
  fixed 2026-06-30; script the remainder if we care — most are dormant).
- **Optional — restart-on-link:** if the warm-container delay (below) ever annoys us,
  then when an operator links a handle, restart that handle's live session container
  so `/personal` appears immediately instead of on next spawn. Controlled,
  off-hot-path, touches exactly one session. This is the ONLY "healing" worth adding,
  and only if the delay proves to be a real annoyance.

**Considered and REJECTED — runtime identity self-heal** (mutating `session.user_id`
from message traffic, whether at spawn or on inbound):
1. **Leaky abstraction / unnecessary magic.** It re-implements, on the hot path, a
   resolution that already happens live at spawn. Load-bearing behavior that silently
   mutates identity from traffic is exactly the implicit magic we don't want.
2. **Fails unsafe.** The current bug fails *safe* (`/personal` merely absent). A heal
   that picks the wrong person mounts X's `/personal` into Y's session — the exact
   leak bug is a bad trade.
3. **Doesn't fix the live mount anyway.** Mounts are set at `docker run`; a warm
   container keeps its mounts until it respawns. The heal changes data, not the
   running container — no better than free live-resolution on the next spawn.
4. **Hot-path coupling.** A spawn-side heal has to reach into the session's messages
   to find "the live sender," reintroducing the venue-vs-handle mismatch
   (`phone-call:<num>` vs `pstn:<num>`) the mount code avoids by trusting `user_id`.

### Phase 3 — Refuse to fabricate identity  (defense-in-depth, upstream)
- **File:** `nanoclaw/src/modules/permissions/index.ts:94-97` (**upstream**).
- **Change:** don't namespace a bare handle that is the agent itself / has no real
  handle. If the row is agent-authored (`sender === 'pat'`, or an agent-authored
  kind) with no `senderId`, `return null` instead of minting `<channel>:pat`.
  `null` = "not from a user" (honest, recoverable); the fabricated id is silent
  garbage that looks valid.
- **Fork decision:** this is upstream code and a latent trap for *any* nanoclaw
  user, not just us. **Prefer upstreaming as a PR** over carrying it as fork drift.
  With Phase 1 done, this is belt-and-suspenders, not urgent.

### Phase 4 — Clean up the junk  (after Phase 1 ships + is verified)
- Snapshot the prod volume first.
- Delete the lone `phone-call:pat` row from `users` (it will not be recreated once
  Phase 1 stamps real `pstn:` handles). Optionally prune the 8 closed sessions
  pinned to it (harmless history; leave or drop). The 3 real `pstn:` user rows are
  fine — keep.
- Re-run the active-session identity audit (see below) to confirm zero
  empty/unresolvable rows remain on channels we care about.

## Verification (trace-based, per repo doctrine)

Drive real I/O, assert on the structured event stream (patobs / `pat-trace`):
1. Place a phone call from a **person-linked** number. Assert:
   - `session.created` (or `routing.message-routed`) carries `user_id = pstn:<number>`
     — **not** `phone-call:pat`.
   - The spawned container has `/personal` mounted (ask PAT "do you have `/personal`?"
     mid-call, or check the mount log).
   - No new `phone-call:pat` row appears in `users` after the call.
2. Place a call from an **unlinked** number: `user_id = pstn:<number>`, person
   unresolved, **no** `/personal` (correct — not a known person), and it is refused
   by the gate under the current `request_approval` policy.
3. Link-after-contact (proves the "free" self-heal, no heal code): a session storing a
   correct-but-unlinked handle (e.g. `signal:+E164`) → create the `person_users` link
   → assert `/personal` mounts on the **next container spawn** with no code change
   (live resolution at spawn). If a warm container is up, confirm it appears after the
   next respawn (or, if restart-on-link is built, immediately).

Active-session identity audit query (read-only) used during this investigation:
```sql
SELECT s.id, mg.channel_type, mg.is_group, s.user_id,
       CASE WHEN s.user_id IS NULL OR s.user_id='' THEN 'STALE: empty'
            WHEN pu.person_id IS NULL THEN 'STALE: no person'
            ELSE 'ok:'||pu.person_id END AS person_status
FROM sessions s
JOIN messaging_groups mg ON mg.id=s.messaging_group_id
LEFT JOIN person_users pu ON pu.user_id=s.user_id
WHERE s.status='active' ORDER BY mg.channel_type;
```

## Tradeoffs / decisions

- **Phase 1 alone fixes the live bug** and is PAT-side/zero-upstream — do it first,
  independent of the rest.
- **Phase 2 is deliberately "build nothing new."** Live resolution at spawn already
  handles link-after-contact; a runtime identity self-heal is rejected as unnecessary
  magic (leaky abstraction) that also fails unsafe (wrong-person leak). One-shot
  backfill for legacy rows; optional restart-on-link only if the warm-container delay
  proves annoying.
- **Phase 3** should ideally be an upstream PR, not fork drift — the junk-minting
  line is upstream and bites anyone on nanoclaw.
- Ordering is intentionally not touched — the banter ack legitimately precedes the
  forward; the fix makes the row honest, not reordered.

## Related / deferred (out of scope)

- **Pairing-UX hole** (`modules/permissions/index.ts:189`): pairing-code redemption
  only fires inside `handleUnknownSender` (i.e. for *denied* senders), so a code sent
  from any already-authorized/linked handle is silently swallowed into chat. Needs
  either "you're already linked / can't pair here" feedback, or a direct-link path on
  the dashboard. Track separately.
