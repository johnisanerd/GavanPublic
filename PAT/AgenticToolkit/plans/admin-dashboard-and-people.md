# Admin Dashboard + People Spine

**Status:** Phases 0-3 SHIPPED and on prod (2026-06). The people spine is live —
`people` / `person_identifiers` / `person_users` / `person_roles` tables (migrations 019-021),
`ncl` as the single writer, Clerk-OAuth gate on pat-frontend, conversation recall, and per-person
memory / `/personal` + `/shared` spaces. **Remaining work:** (1) the dedicated **dashboard admin
UI** (the visual people/roles CRUD surface) is still **deferred** — pending Shadcn-blocks; today the
dashboard reads people over `/admin/db` but has no rich management view; (2) **role enforcement** —
`person_roles` (admin|employee) was BUILT via migration 021 but is **NOT enforced**; pat-frontend
still gates on the operator-email allowlist (`isOperatorEmail`), not on roles.

**Supersedes:** `plans/person-identity.md` (now **DEPRECATED** — its valuable content is folded
into this plan: dashboard CRUD into Phase 1, the deferred agent-side specs into the "Deferred
agent-side specs" section below). **Related:** `plans/one-flow-well.md` §6 (visibility surfaces),
`plans/passkey-research.md` (auth, deferred).

## Context / motivation

The user (main engineer on PAT) wants a dashboard to **monitor and operate** the multi-user
agent system: see all the people PAT talks to, read their conversation history, browse their
workspace/filesystem, and do light admin (manage roles, approvals, API keys). Two forcing
constraints shaped the design:

1. **The data is on a private Fly volume** (`/data` on `pat-nanoclaw`), reachable only over
   6PN. A Vercel-hosted UI can't reach it without exposing a public data API — so the
   dashboard lives **on Fly**, where it reads the volume/DB/logs directly and only the
   authenticated UI is public.
2. **"Person" is one entity, intentionally.** Whether a human reaches PAT by phone call or by
   logging into the dashboard with Google, it's the *same* person. Email is just another
   handle (`email:gavan@palisaderesearch.org`) on that person. Dashboard access is a
   *capability* that falls out of having a verified company-domain email handle — not a
   separate identity system. This is why the **people spine** is a prerequisite, not a
   nice-to-have: it's where email lives and where access tier hangs.

## The control-plane API framing (resolves the "why is the log endpoint on the dashboard" smell)

Today `pat-frontend` looks like "an observability UI that also proxies logs." That framing is
the smell. The accurate framing:

- **`nanoclaw` is the private agent host** — admin/log API on `:8767`, the central DB, and the
  volume are all internal-only over 6PN, deliberately off the public internet.
- **`pat-frontend`'s backend is PAT's public control-plane API / bastion** sitting in front of
  that private host. It reads `v2.db` read-only and proxies nanoclaw's `:8767` logs. The React
  observability UI (Stream/Timeline tabs) is **one client** bundled into that deployment.
  `pat-trace.py` and the smoketests are **other clients** of the same API — they're not
  "depending on a dashboard," they're calling the control-plane API.

The bastion pattern (public, authenticated layer mediating access to a private agent host) is
**correct** — we keep it. The fix is to make that layer *intentional*: put auth on the **API**,
per-route, and treat every consumer (React UI, pat-trace, smoketests) as a client.

**We do not move the log endpoint.** We adopt the framing and add auth where it belongs.
Optionally, later, the API can split into its own Fly deploy separate from the static UI bundle
— nice-to-have, cheap to defer.

## Auth model

Two **independent** auth paths on the control-plane API (this is the key insight — human tiers
and machine access are separate concerns, don't conflate them):

- **Humans → Google OAuth.** Phase 0: any `@palisaderesearch.org` is in, flat (no tiering).
  The allow decision is purely the domain check. Once the spine exists, the gate also resolves
  `Google email → person_identifiers(email) → person` to know *who* is logged in (for audit /
  personalization / scoping "their own files" later) — but that resolution is identity, not
  authorization. Tiering is deferred entirely (no column in v1; see Phase 1 schema notes).
- **Machines → a scoped service credential.** Keep a service token (the current
  `PAT_VIEWER_TOKEN` lineage) but **scope it to the log/trace endpoints** that pat-trace and
  smoketests need. It is **not** a human tier. This is what kills the "token = weak auth on
  sensitive data" smell — sensitive (PII/people/transcripts/filesystem) routes require an
  OAuth session; only the log routes accept the service credential.
  - **Treat the service credential as confidential — never URL-exposed.** Historically it was
    used as a pseudo-public token (it showed up in URLs during demos). That was always wrong:
    log files capture a lot, and a credential in a query string leaks into logs/history/referrers.
    Going forward it travels in an `Authorization` header (or equivalent), never a query param,
    and is rotated out of any demo URLs. Higher-security handling should have applied from the start.

**Per-route enforcement** (mirrors TheTest's two-layer pattern, `the-test-web/lib/auth.ts` +
`proxy.ts`): a shared `requireOperator()` server-side helper called at the top of every
human route, returning `{ person } | null` → `null` ⇒ 403. Middleware enforces
"session present"; the helper enforces "allowed" (phase 0: domain check). When tiering
lands, the helper's return grows a tier field and sensitive routes add a guard — no rework.

### Future tiers (designed-for, NOT built in phase 0/1)

The user explicitly wants, *eventually*, a blast-radius distinction:

- **engineer/maintainer tier** (the user): full — browse anyone's filesystem, view/modify
  their API keys, read all transcripts.
- **employee tier**: limited — must NOT see *others'* chat transcripts or *others'* personal
  API integrations (e.g. their personal email keys). Likely sees their own stuff + non-sensitive
  views.

Phase 0/1 ship with everyone flat — **no tier column exists yet** (see Phase 1 schema). Design
the gate so a tier check slots in later without rework: `requireOperator()` returns the resolved
person, and the real access-control design (likely its own table, string-valued levels) is an
additive follow-up. Routes that touch the sensitive surfaces named above grow a tier guard in
that later phase. A future "demo / self-service" login is modeled as **a person with a
constrained tier** (possibly auto-authenticated) — never as "the token is a tier." Keeps it
sane; leaves room for the "employees log in to see/download their own files" future.

## Phasing

> **⚠️ Dashboard UI is deferred (user direction, 2026-06-22).** The user is building a dashboard
> in another project to learn from first, and wants our internal tools on a **consistent
> Shadcn + Shadcn "blocks"** look. So **do NOT invest in the bespoke HTML/React dashboard UI yet** —
> minimum-viable edits only, if needed to keep pace. Build the **backend / data / API** now; the
> visual dashboard lands later once the Shadcn-blocks pattern is settled. Convenient consequence:
> Phase 1 is almost entirely nanoclaw-side and barely touches pat-frontend.

### Phase 0 — OAuth gate over the (one) dashboard
- Put Google OAuth in front of `pat-frontend`'s human routes. Any `@palisaderesearch.org` in,
  no tiering.
- Carve out the service-credential path for the log/trace endpoints (pat-trace + smoketests
  keep working — verify both after).
- Outcome: the existing dashboard is reachable only by company Google accounts; machine tooling
  unaffected.
- **Auth library: Clerk, reusing the existing Clerk account/org** (the one TheTest uses — same
  org for sure; possibly the same app, TBD). Open sub-question is only *mechanical*: TheTest's
  Clerk recipe is Next/Vercel-flavored and pat-frontend is **Hono on Fly**, so do a short
  **Clerk-on-Hono spike** to confirm the flow is clean before wiring it in. Not blocking Phase 1.

### Phase 1 — Minimal people spine (backend-first; dashboard UI deferred)

**Scope this round = the data layer + API + tests, NOT the visual dashboard.** Concretely build:
the three tables + additive migration; `nanoclaw/src/people/` module (create person, link/unlink
handle, resolve person by identifier); the auto-enroll inbound hook; the suffix-match backfill;
an **`ncl people` CLI resource + admin API endpoint** exposing the CRUD; and a real test suite.
The bespoke dashboard views (People list, pairing UI) wait for the Shadcn-blocks pattern — see
the banner above. pat-frontend is barely touched this round (read-only as today).

**Write path (resolved):** all write logic lives in `nanoclaw/src/people/` and is the **single
source of truth**, exercised by both auto-enroll and operators. nanoclaw is the **single writer**
to `v2.db` (it already must be, since auto-enroll writes `person_users` on the inbound path).
pat-frontend stays **read-only** on `v2.db`; when the dashboard UI lands it **forwards** mutations
(auth'd) to nanoclaw's admin API rather than writing directly — no duplicated write logic, no
two-writer contention.

**Schema — three *additive* tables, ZERO edits to upstream tables** (overrides
`person-identity.md`'s `users.person_id` column + single-name shape). The whole point: keep
our footprint to brand-new tables nanoclaw doesn't know about, so an upstream sync can't clobber
us and the eventual upstream PR is "here are three self-contained tables," not "we modified your
core `users` table." See **Upstream-patch hygiene** below.

```sql
-- 1. The human. Deliberately minimal for v1 — identity + names, nothing else.
CREATE TABLE people (
  id          TEXT PRIMARY KEY,
  first_name  TEXT NOT NULL,
  last_name   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT
);

-- 2. Universal identifiers a person can be RECOGNIZED by — the auto-enroll front door.
--    Exists independent of any account; can be pre-seeded before the person ever messages.
CREATE TABLE person_identifiers (
  person_id  TEXT NOT NULL REFERENCES people(id),
  kind       TEXT NOT NULL,      -- 'email' | 'phone'
  value      TEXT NOT NULL,      -- normalized: lowercased email / E164 phone
  verified   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (kind, value)      -- an email/phone maps to EXACTLY ONE person → deterministic match
);

-- 3. Realized links from handles → person. PK on user_id (NOT a many-to-many join table):
--    enforces "each handle belongs to at most one person" without touching `users`.
CREATE TABLE person_users (
  user_id     TEXT PRIMARY KEY REFERENCES users(id),
  person_id   TEXT NOT NULL REFERENCES people(id),
  linked_at   TEXT NOT NULL,
  link_method TEXT               -- 'manual' | 'auto:phone' | 'auto:email'
);
```

- **Why a link table, not `users.person_id`.** The column was the only invasive change; moving
  it into `person_users` with `user_id` as PK gives the *identical* cardinality (one person,
  many handles, each handle linked once) while keeping the patch fully additive. Trade: a
  one-row join instead of a column read, and we clean up our own link rows if upstream deletes a
  `users` row (no FK cascade). Worth it for fork-friendliness + a home for `linked_at`/`link_method`.
- **No access/tier column in v1.** Dropped (was `access_group`, née `tier`). We don't yet know
  how access will be tiered, and a real access-control system would likely be its own table
  (and the value a string, not an int). Phase 0/1 are flat — every authenticated
  `@palisaderesearch.org` is in. Tiering is a clean additive follow-up (own table or column)
  when we actually design it; see backlog. This also keeps `people` to pure identity.
- **No `default_user_id` / `default_admin_user_id` in v1.** Dropped to the backlog — not needed
  for the dashboard, and there's already per-channel recency logic (`user_dms.last_used_at`) to
  lean on for "preferred handle" when we build delivery routing. Add back as additive columns
  (or a small preferences table) only when verification rerouting lands.
- **Names NOT NULL ⇒ auto-enroll only *links*, never *creates*.** A bare unknown inbound (phone
  number we've never seen, no name) stays unlinked (`person_users` has no row) until a human
  names + claims them in the dashboard. People are created deliberately with names + seeded
  identifiers; their channels snap on as they arrive. Preserves NOT NULL + deterministic match.
- **Auto-enroll flow:** inbound on `signal:+1555…` → strip channel prefix → normalize to
  `+1555…` → look up `person_identifiers (kind='phone', value=…)` → hit ⇒ insert
  `person_users(user_id, person_id, 'auto:phone')`. One hook on the inbound path (see hygiene §3).
- **Email as a handle:** `email:<addr>` is a normal `users` row; OAuth login resolves the person
  via `person_identifiers (kind='email')` and links it through `person_users`.
- **Backfill:** retroactively runs auto-enroll over every existing `users` row — links a
  handle to a person ONLY when its normalized identifier (E164 phone / lowercased email)
  **exactly** matches an already-seeded `person_identifiers` row. Deterministic + idempotent;
  it never creates people and never fuzzy/last-N-digit matches. (NB: this is stricter than the
  "suffix-match heuristic" phrasing in one-flow-well §5 — that prose, and capability-resolver's
  read-only grouping, both reduce to full-E164 equality anyway; the spine just makes it explicit.
  Implemented as `backfillFromUsers()`, exposed via `ncl people backfill`.)
- **API to build now (no UI):** the person CRUD + link/unlink surface as an **`ncl people`
  resource + nanoclaw admin API endpoint**, backed by `nanoclaw/src/people/`. This is what the
  deferred dashboard will consume, and what tests/seed scripts use today.
- **Local instance to beat up:** use the **normal local nanoclaw instance** (user's call) — run
  the migration, create/destroy people, exercise the `ncl people` API end-to-end. Never prod data.

---
**↓ DEFERRED dashboard UI specs (build later, on the Shadcn-blocks pattern — see banner). Kept
here as the target so the API we build now matches what the UI will need.**

- **Stack reality:** pat-frontend is **already React 19** (Vite client) with **Hono** as the
  backend API + static server (run under Bun). `@tanstack/react-table` and Radix are already
  deps. So there is **no framework migration** — "Hono vs React" was a false choice: Hono is the
  server, React is the client. UI styling will move to **Shadcn + Shadcn "blocks"** for a
  consistent internal-tools look (shared across our tools).
- **Two sections in the one app:** an **admin section** (operate the whole system — people,
  users, roles, logs) and a **"just for anyone" section** (a logged-in company user sees their
  own stuff). Same deploy, same OAuth; the section split is route-level, and maps cleanly onto
  the future tier guard. Keep it compact + deep-linkable (see the embedding note below).
- **Dashboard views (v1 = people + linking only, NOT handle creation):** People CRUD plus
  **linking existing handles** to a person — over the API above (no direct-DB writes from the UI).
  - **Person ops:** list (id, name, linked-handle count, last activity); create; edit; delete
    (confirm modal → clean up only *our* `person_users` / `person_identifiers` rows; **never**
    cascade into upstream `users`); manage `person_identifiers` (the email/phone the person is
    recognized + auto-enrolled by).
  - **Link existing handles → person:** the account-pairing UI searches *existing* `users` rows
    (by handle, and display name where the platform has one) and attaches/detaches them via
    `person_users`. **Read-and-link only — it never creates `users` rows.** This is enough for
    the spine: auto-enroll + backfill + nanoclaw's inbound upsert produce the handles; the
    dashboard's job is to group them under a person.
  - **Handle (`users` row) create / edit / delete is OUT of v1 → backlog.** nanoclaw already
    owns the user lifecycle (inbound upsert in `delivery.ts`, `cli/resources/users.ts`,
    `voice-memo.ts`, …). Reimplementing handle creation in the dashboard risks fighting that
    logic, and the user is (rightly) cautious about it. When seeding a never-seen handle is
    genuinely needed, drive nanoclaw's existing path — don't fork it. (Old person-identity §6f
    handle-create form, channel dropdown, soft-validation, delete cascade → backlog.)
- **Create-person UX (target, not all v1-blocking):** form is first name, last name, **email
  required**, phone optional → seeds `person_identifiers`. Use TanStack Table's **in-place edit**
  for the people list if it's clean to do. **Account-pairing UI** when creating/editing a person:
  a section per platform; click into one, search existing `users` rows by handle (and display
  name where the platform has one), attach them to the person inline. The "really nice pairing
  UI" is a reach goal — ship functional link/unlink first, polish second.

**↑ end deferred dashboard UI specs.**

---
- **Tests (build now):** real coverage for the spine — person CRUD, identifier uniqueness (one phone ⇒ one
  person), handle linking, auto-enroll link (not create), suffix-match backfill,
  `email→person` resolution, gate allow/deny. (User explicitly wants a test suite.)
- Defer the agent-side person features past Phase 1 — not needed for the dashboard:
  - **Verification rerouting:** own plan, `plans/verification-rerouting.md`.
  - **MCP `register_person`/`update_person_profile`:** land **admin/API-only** when built; spec separately.

### Upstream-patch hygiene (so a nanoclaw sync can't clobber us, and we can upstream later)
1. **Additive migrations only**, in their own numbered files — never edit an existing upstream
   migration. Confirm nanoclaw's migration runner ordering at build time so our files slot in
   after upstream's without renumber conflicts.
2. **All in-tree code marked `// PAT:`** (existing convention) so it greps cleanly against an
   upstream diff.
3. **Keep person logic in its own module** (`nanoclaw/src/people/`) rather than threaded through
   existing files — ideally a small number of import sites. Aim to touch the inbound path in
   one place (the auto-enroll hook), **but don't contort the design to hit exactly one call** —
   if a couple of small, clearly-marked modifications to existing files are simpler/cleaner, do
   that. Be thoughtful about LOC and greppability, not dogmatic about a single touch point. The
   PR-cleanliness goal is a tie-breaker, not a hard constraint.
4. **Eventual upstream PR** = the migrations + the `people/` module + the (few, `// PAT:`-marked)
   inbound hook call(s). Nothing forces nanoclaw to adopt opinions about *their* tables.

### Dashboard embedding / deep-linking (keep the pat-web side-by-side view working)
One app, but it must stay **compact and deep-linkable** so the existing pat-web side-by-side
view (avatar + streaming dashboard, see `reference_pat_web_dashboard_pane`) keeps working when
the admin UI grows. Concretely: stable deep-link URLs to a specific person/thread/tab, and
**query params for auto-hiding chrome** (nav/header/sidebars) so a single panel can render
near-full-frame ("full frame," not literally fullscreen) when embedded. Design the new views to
collapse gracefully rather than assuming the whole window.

### Phase 2 — Conversation recall (gated on the spine)

Today the agent has history **only within its current session**
(Claude resumes the session `.jsonl`; `messages_in` keeps prior messages as context —
`session-manager.ts:209`). There is **no cross-session / cross-channel retrieval**. Two
separable pieces:
- **Access** — read *across* a person's sessions. Source-of-truth is an **open question**
  (below); leading candidate is the durable host JSONL logs filtered to the person's threads,
  NOT the session message-bus DBs (those are operational queues, can be consumed/cleared).
- **Affordance** — the agent must know it *can*. **Leaning toward a tool, not a monolithic
  skill** (user's call this round): a `list_conversations(filters)` → metadata, then
  `fetch_conversation(id, filters)` → messages. Two-step list-then-fetch keeps payloads bounded
  and lets the agent filter (by person, channel, date, thread). If exposing the file logs as a
  read path turns out trivial, a thinner wrapper may suffice — settle in design.
- Depends on the people spine (recall "*their* conversations across channels" needs
  person → handles → threads).
- **Recent-summary tool (backlog, related):** a small async tool — e.g. `recent_summary(person?)`
  — that runs a **fast LLM** over recent conversation logs and returns a clean one-page summary,
  doing the right filtering (no raw tool calls / noise) so it's reliable for the agent to lean on.
  Possibly backed by a **nightly regeneration job** so the common case is a cache hit. Shape TBD;
  not v1.


**This is the fix for a live problem, not just a new feature.** Today PAT's agent memory is
**on and group-scoped** — `CLAUDE.local.md` (auto-loaded) + the `memory/memories/` scaffold,
mounted **RW** at `/workspace/agent` (`group-init.ts:86-98`, `container-runner.ts:379`). Because
PAT runs as a **single agent group** (`palisade-internal`, one group per install), that store is
**shared across every person** who talks to PAT: a personal fact the agent records about one
person is in-context for everyone else's sessions. No per-person scoping exists. We fix this by
*scoping* memory per person, not by disabling it.

**Why this is now tractable (the "they're hand-rolling too" insight):** nanoclaw's memory is
**plain files via Read/Edit**, NOT the Anthropic Memory tool (confirmed: no `allowedTools:
["Memory"]`). So per-person memory is just **per-person directory mounts** — the same
`buildMounts()` mechanism as `/personal` below — not a fight with SDK-fixed scoping. This
*validates* the old person-identity.md "use Read/Edit, not the Memory tool" decision; it now
becomes the foundation.

Design:
- **`/shared`** → agent-group shared space (leans `data/shared/<agent_group>/`, a dedicated
  subtree — the group dir already holds config, see OQ#5). For operational / about-PAT-itself
  facts that are fine to share.
- **`/personal`** → **per-(person, agent_group)** space — `data/people/<person_id>/<agent_group>/`
  or similar. Personal facts about that person live here. Scoped per agent group (not global) so
  palisade-internal stays isolated from any future group.
- **`/personal` is mounted only for 1:1 sessions** (in a multi-person chat "whose personal?" is
  undefined; group sessions get `/shared` only). New mount in
  `nanoclaw/src/container-runner.ts:buildMounts()`, person-keyed, cross-session.
- **Persistence doctrine:** make the target *exceptionally clear* to the agent (prompt/skill
  nudge) — person-specific facts → `/personal`; operational/group facts → `/shared`. This is what
  stops the leak going forward.
- **Migration of the current shared store:** today's `CLAUDE.local.md` / `memory/memories/` may
  already mix personal facts into the group store. Decide at build time: either leave legacy
  in place and only scope *new* writes, or do a one-time review/split. (Lower stakes while the
  user base is trusted-internal, but call it explicitly.)
- Depends on person resolution (the spine) + the `/personal` mount.

built, the cheap stopgap is a doctrine line telling the agent not to write person-specific facts
to the shared store. Decided not to hard-disable memory (PAT would forget everything between
sessions, hurting the "is this thing alive?" goal). Build Phase 3 *today* as part of this work so
the interim window is short.

## Deferred agent-side specs (carried over from the now-deprecated person-identity.md)

These are **not in v1**. Preserved here so `person-identity.md` can be deprecated without losing
the design. Build when the spine + dashboard exist and the need is real.

**Verification rerouting** → **its own plan: `plans/verification-rerouting.md`.** (Admin on PSTN
voice can't render an approval card → reroute to a channel that can.) It's coupled to the person
spine — once `person_users` exists, "approver's person → their other handles" is resolvable — but
it's a distinct feature with its own surface (`ChannelAdapter` flag, `user_dms.last_used_at`,
`pickApprovalDelivery` rewrite), so it lives separately. Build after the spine lands.

**Agent-callable MCP tools** (land admin/API-only first; agent-callable later):
- `register_person({first_name?, last_name?, link_users?: string[]}) → person_id` — create row,
  optionally link existing handles via `person_users`.
- `update_person_profile(person_id, {first_name?, last_name?, link_users?, unlink_users?}) → void`.
- `find_person({first_name?, last_name?, user_id?, channel_type?, handle?}) → person_id | null` —
  convenience wrapper so the agent needn't write DB queries.
  (Signatures updated to the v1 schema — dropped the `default_*` params.)

**Per-person memory files** — **now an active phase, see Phase 3** (no longer deferred-off). It's
than the current group-shared store. The old person-identity.md layout
(`data/people/<person_id>/memories/*.md`, opaque id, Read/Edit not the Memory tool) is the
starting point.

**Front-mind capability-context integration:** inline the current caller's person block (name,
known handles with current/default markers, memory dir, existing memory files) into the
templated capability prompt (one-flow-well §2a), so "me ending in 4959" disambiguation and
memory-awareness fall out for free. Unregistered caller → bare handle + "can be registered."

**Migration-out (if upstream ships its own canonical-user concept):** read our `people` +
`person_users` + `person_identifiers` → write upstream-shaped rows → map identifiers to whatever
upstream uses → keep memory files on disk (likely no upstream equivalent; swap our `person_id` in
the path for theirs) → drop our three tables. ~50 LOC, additive-only design keeps this cheap.

## Critical files to read
- `pat-frontend/server/` — `index.ts` (port 8787, viewer-token auth `:27`, log proxy
  `:65`/`:118`), `routes-db.ts` (`/api/db`, `/api/db/:table`), `routes-users.ts` (user CRUD),
  `routes-capabilities.ts`, `db.ts` (read-only `v2.db` opener, `CENTRAL_TABLES` whitelist).
- `nanoclaw/src/admin/index.ts` + `server.ts` — the internal admin/log API on `:8767`
  (`/admin/logs.jsonl`, `/admin/logs.tail`, per-session log/stderr slices; `PAT_ADMIN_TOKEN`).
- `nanoclaw/src/db/schema.ts` — central schema (`users` namespaced ids `:62`, `user_roles`,
  `agent_groups`, `sessions`); `nanoclaw/src/db/migrations/` (runner + version table) — confirm
  ordering so our additive migrations slot in after upstream's (hygiene §1).
- `nanoclaw/src/people/` (NEW) — the entire person module lives here; one import site, all
  `// PAT:`-marked. Inbound auto-enroll hook is the single touch on the existing inbound path.
- `nanoclaw/src/session-manager.ts` — `resolveSession` + session modes (`:85-130`); session
  dir layout; `:209` "container reads all prior messages as context".
- `nanoclaw/src/container-runner.ts` `buildMounts()` — where `/personal` + `/shared` land.
- `nanoclaw/src/modules/permissions/access.ts`, `src/command-gate.ts` — existing per-handle
  role checks (leave unchanged; tier is a separate axis).
- `TheTest/the-test-web/lib/auth.ts` + `proxy.ts` + `app/(authed)/admin/page.tsx` — OAuth
  recipe (Clerk + `requirePalisadeUser` two-layer gate). Adapt the *pattern*, swap domain check
  for `tier`, and note the framework difference (Next/Vercel → Hono/Fly).
- `plans/person-identity.md` — **DEPRECATED / superseded by this plan.** Read only for the long-
  tail detail not folded here (naming rationale, slug-dropped decision, verifiability open
  questions). Everything actionable now lives in this plan.

## Verification criteria
- **Phase 0:** browser hitting the dashboard without a Google session → redirected/denied;
  with an `@palisaderesearch.org` session → in. `pat-trace.py` and the signal/smoketest
  scenarios still pull logs via the service credential. Non-palisade Google account → denied.
- **Phase 1:** create a person, link two handles (e.g. `phone:` + `email:`), see them joined in
  the UI; suffix-match backfill groups existing users idempotently; gate resolves
  `email→person`; test suite green.
- **Phase 2:** from a fresh session, the agent can `list_conversations` for the current person
  and `fetch_conversation` a prior thread from another channel.
- **Phase 3:** in a 1:1 session, `/personal` and `/shared` are both mounted and the agent writes
  person-specific facts to `/personal`, operational facts to `/shared`; in a group session, only
  `/shared` is mounted. **Leak check:** a personal fact recorded for person A does not appear in
  person B's session context.

## Open questions (resolve before the relevant phase hardens)
1. **Recall source-of-truth** — durable host JSONL logs (filtered by thread) vs per-session
   `.jsonl` transcripts vs a new durable per-person archive. Leaning logs; confirm they're
   trivially exposable as a read path before committing to the tool shape. *(Blocks Phase 2.)*
2. **Auth library** — **user prefers Clerk** if it works cleanly on Hono/Fly (reuse TheTest
   recipe, though that's Next/Vercel-flavored). Fall back to direct Google OAuth (Auth.js/Lucia)
   if Clerk-on-Hono is awkward. Decide at phase start with a quick spike. *(Blocks 0.)*
3. **Tier boundaries** — exact route-level split between engineer and employee (which views are
   sensitive). *(Blocks the future tiering phase, not 0/1.)*
4. **Super-admin / engineer promotion mechanism** — via the dashboard or otherwise. Deferred by
   the user ("figure out later"). *(Not blocking.)*
5. **`/shared` physical home** — reuse the agent-group workspace vs a dedicated
   `data/shared/<agent_group>/`. **Finding (2026-06-22):** the agent-group dir is mounted RW at
   `/workspace/agent` (`container-runner.ts:379`) and is **not empty** — it holds `CLAUDE.local.md`
   (per-group memory), `container.json`, and composer-managed `CLAUDE.md` + `.claude-fragments`
   (nested RO mounts). Reusing it raw as `/shared` would mix shared user content with agent
   config. **Leaning: a dedicated `data/shared/<agent_group>/` subtree** (or a `shared/` subdir
   under the group dir) so config and shared content don't collide. *(Blocks Phase 3.)*

## Decisions log
- **One dashboard, not two apps.** The only reason to split was differential access; with
  "anyone from the company in" that collapses. Tiering later is a route-level check, not a
  second app.
- **Don't move the log endpoint.** Reframe pat-frontend's backend as the control-plane API /
  bastion; auth goes on the API per-route; UI + pat-trace + smoketests are all clients.
- **Auth: OAuth for humans, scoped service credential for machines — separate concerns.** The
  token is never a human tier. A future demo/self-service account is a person with a constrained
  tier.
- **People spine first, minimal.** Email is a handle; `people` is **pure identity** (id + names
  only). Build the spine + dashboard CRUD; defer agent-side person features.
- **Three additive tables, zero upstream-table edits** (`people`, `person_identifiers`,
  `person_users`) — overrides `person-identity.md`'s `users.person_id` column. Driven by the
  user's intent to carry this as a fork patch and upstream it later; additive-only survives syncs.
- **Realized link via `person_users` (PK = `user_id`), not a column on `users`.** Same 1:N
  cardinality, fully additive, plus a home for `linked_at`/`link_method`. Not a many-to-many table.
- **Universal identifiers (`person_identifiers`, PK `(kind, value)`) are the auto-enroll door.**
  Deterministic match bridges channel namespacing (`signal:`/`phone:`/`email:` → bare value).
- **Auto-enroll links, never creates** (keeps `first_name`/`last_name` NOT NULL). Unknown inbound
  stays unlinked until a human names + claims it.
- **No tier/access column in v1** (dropped `access_group`, née `tier`). Tiering is unsolved; a
  real ACL is likely its own table with string levels. Phase 0/1 are flat (domain check). Add
  additively when designed. Whatever it becomes, it's orthogonal to `user_roles` (agent owner/admin).
- **No `default_user_id`/`default_admin_user_id` in v1** — backlogged. `user_dms.last_used_at`
  already gives "preferred handle"; add these (or a preferences table) only with verification rerouting.
- **`people` is pure identity (id + first/last + timestamps).** Everything else (tier, defaults,
  memory) is additive follow-up. Smaller surface = cleaner upstream patch.
- **No framework migration — already React + Hono.** pat-frontend is React 19 (Vite) client +
  Hono API server (Bun); `@tanstack/react-table` already a dep. "Hono vs React" was a false choice.
- **Dashboard UI deferred (user direction).** User is building a dashboard elsewhere to learn from,
  and wants internal tools on a consistent **Shadcn + Shadcn "blocks"** look. Build backend/API now;
  hold the bespoke HTML/React views. Minimum-viable pat-frontend edits only, to keep pace.
- **Write path: nanoclaw is the single writer; logic in `nanoclaw/src/people/`.** Auto-enroll
  already forces nanoclaw to write these tables, so all write logic lives there (one source of
  truth), exposed via `ncl people` + admin API. pat-frontend stays read-only and *forwards* mutations
  when the UI lands — no duplicated logic, no two-writer contention. (Resolved the "how does the
  dashboard write" question — direct-write had no upside once auto-enroll makes nanoclaw a writer.)
- **Clerk, reusing the existing Clerk account/org** (same org as TheTest for sure; same app TBD).
  Only open piece is a quick Clerk-on-Hono spike (TheTest's recipe is Next/Vercel-flavored).
- **Dashboard = admin section + "anyone" section, one app.** Route-level split, maps onto the
  future tier guard. Keep compact + deep-linkable with chrome-hiding query params so the pat-web
  side-by-side embed keeps working.
- **Service credential is confidential, header-only** — never a URL/query param. Past pseudo-public
  demo usage was wrong; logs leak query strings.
- **`/personal` is per-(person, agent-group)** — overrides person-identity.md's global
  `data/people/`. **Mounted only for 1:1 sessions.** `/shared` leans dedicated subtree (agent-group
  dir is not empty — holds config).
- **Recall is a tool (list → fetch with filters), not a monolithic skill** — pending the
  source-of-truth question. A fast-LLM `recent_summary` tool (+ optional nightly cache) is backlog.
- **Dashboard v1 links handles, doesn't create them.** nanoclaw owns user lifecycle; reimplementing
  handle creation risks fighting it (user is cautious here). Handle create/edit/delete → backlog.
- **Verification rerouting is its own plan** (`plans/verification-rerouting.md`), linked from here —
  coupled to the spine but a distinct feature.
- **Per-person memory is built, not disabled (Phase 3).** Finding: PAT's group memory
  (`CLAUDE.local.md` + `memory/memories/`) is on and **shared across all users** (single agent
  not the Anthropic Memory tool), the fix is per-person dir mounts (same as `/personal`), not
  disabling. Chose scope-don't-disable so PAT keeps feeling alive. Build it today; short interim
  window covered by a doctrine line if needed.
- **person-identity.md is deprecated**, content folded here (dashboard person CRUD → Phase 1; MCP
  tools + capability-context + migration-out → "Deferred agent-side specs"; verification rerouting
  → its own plan; handle-creation → backlog; memory → off).
- **Hosting: Fly** (data is on the private volume; Vercel can't reach 6PN without a public data
  API). UI public + OAuth; data stays on the private network.

## Backlog (explicitly deferred this round)
- **Dashboard handle (`users` row) create/edit/delete** — nanoclaw already owns user lifecycle;
  v1 only *links* existing handles. Build only if seeding never-seen handles becomes a real need,
  and prefer driving nanoclaw's existing path over a parallel create UI. (Carries the old
  person-identity §6f handle form: channel dropdown from `getRegisteredChannelNames()`,
  soft per-channel validation, delete-cascade handling.)
- **Access tiering** — engineer/employee/external split; own table, string levels, route guards.
- **`default_user_id` / `default_admin_user_id`** (or a preferences table) — with verification rerouting.
- **Reach-goal create-person UX** — TanStack in-place edit; polished per-platform account-pairing
  UI with handle search. Ship functional link/unlink first.
- **`recent_summary` tool** — fast-LLM one-page conversation summary, noise-filtered, optional
  nightly regeneration for cache hits.
- **Verification rerouting, MCP person tools, per-person memory files** — see "Deferred agent-side specs."
