# Dashboard Permissions — centralized, identity-aware authorization for `pat-frontend`

**Status:** sketch for review (2026-06-23). Pre-implementation. Decisions below are LOCKED unless
the OPEN QUESTIONS section reopens them.

**Related:** `plans/admin-dashboard-and-people.md` (the people spine + dashboard plan this builds on —
Phase 0 auth, Phase 1 spine, Phase 2 recall, Phase 3 per-person memory). This plan is the
**authorization layer** that plan defers ("design the gate so a tier check slots in later").

## Goal

Move `pat-frontend` from today's **binary** auth (a shared viewer token; an `@palisaderesearch.org`
domain check) to a **centralized, identity-aware, role-based** permission system where:
- every query/mutation flows through **one chokepoint** that auto-resolves the caller's `person`
  from the Clerk session and enforces a declared right;
- the caller's **role** (from `person_roles`) maps — via a **code constant** — to what they can do,
  expressed as `resource:action:scope` with coarse (`*:read:all`) and row-scoped (`*:read:own`)
  variants;
- it composes cleanly with — in fact, sets up — a *future* convergence of Pat's **runtime**
  authority into the same `person_roles` table, without doing that migration now.

## Locked decisions (baked into this plan)

1. **Roles live in `person_roles(person_id, role, granted_by, granted_at)`** — additive table,
   migration **`021-pat-person-roles.ts`**, `// PAT:`-marked, nanoclaw-owned. `role` is an enum
   **starting with `'admin'` and `'employee'`** (`owner` etc. addable trivially later; names are
   cheap to change). The table deliberately takes the `person_roles` name because the user intends to
   eventually deprecate `user_roles` → `person_roles` and converge **runtime** authority into it —
   **but not now** (see Verification B).
2. **role → capability mapping lives in a CODE constant, not the DB.** e.g. `admin` → full access
   (all resources, read+write, `all` scope); `employee` → read-only, `own`-scoped. **Per-person
   assignment is data** (`person_roles` rows); **the role *definition* is reviewed/versioned code.**
   Rationale: definitions change with *features* (code), assignments change with *ops* (data).
3. **Login verifies the email and auto-creates + links the person on first login.** No manual
   pre-seeding. First dashboard login from an `@palisaderesearch.org` Google account **creates a
   `person`** and links an **`email:<addr>` identifier with `verified=1`**. (Conditional on Clerk
   handing us a name — see Verification A.)
4. **`person` is the unit of authority for the dashboard.** The chokepoint resolves Clerk → person →
   `person_roles` → capability. `user_roles` (the runtime, handle-keyed axis) stays untouched this
   round.
5. **Bootstrap is explicit — NO env var.** Seed the user (Gavan) one `person_roles` row as `admin`
   via `ncl`, once. **Empty table = no dashboard access until a role is granted.** Managing roles is
   an admin-only write that goes through `/admin/ncl` (a small `ncl roles` resource backed by a
   single-writer `src/person-roles/` module, mirroring `src/people/`).
6. **Atomic per-right grants are DEFERRED** (see "Later / escape hatch"). Roles + a code-defined
   mapping are the model now; a `person_grants` table only appears if/when role definitions need to be
   runtime-editable or per-person exceptions proliferate.

---

## Current-state map (file:line)

Two unrelated auth regimes coexist in `pat-frontend/server/`, split by route:

- **Human/operator (Clerk) — exactly one route wired.** `clerkMiddleware` mounts only on
  `HUMAN_ROUTES = '/api/me'` (`pat-frontend/server/index.ts:57-66`). `requireOperator(c)`
  (`server/auth.ts:48-80`) resolves `userId`+`email` from the Clerk session (falling back to
  `clerk.users.getUser`, `auth.ts:68-76`), then applies the pure domain gate `isOperatorEmail()`
  (`auth.ts:27-33`). **Binary; identity stops at the email string** (`auth.ts:79`). Dev bypass
  `ADMIN_DEV_NO_AUTH=1` (`auth.ts:49-51`).
- **Machine/viewer-token — every data route, inline, no identity:**
  - `GET /api/logs.jsonl`, `GET /api/logs.tail` (`index.ts:101-253`) — proxy nanoclaw `:8767`,
    swapping the viewer token for `PAT_ADMIN_TOKEN`.
  - `GET /api/db`, `GET /api/db/:table` (`routes-db.ts:28-83`) — read-only browse of the
    `CENTRAL_TABLES` whitelist (`db.ts:208-223`).
  - `GET /api/capabilities` (`routes-capabilities.ts:232-237`) — static stub.
  - **Mutations exist and are a problem:** `POST/PUT/DELETE /api/db/users` (`routes-users.ts`) write
    **directly to `v2.db`** via a lazily-opened RW handle (`db.ts:getDbRw`, `184-200`), guarded by
    the *same* viewer token. The DELETE hand-rolls a cascade across
    `user_roles`/`agent_group_members`/`user_dms`/`person_users` (`routes-users.ts:189`).

**Two structural smells.** (1) Data is **not scoped at all** — any token-bearing caller sees every
table/log/user; the viewer token is one shared secret granting read **and** write. (2) The
`routes-users.ts` write path is a **second direct writer to `v2.db`**, contradicting the
single-writer doctrine (`admin-dashboard-and-people.md:126`, decisions log 462-466).

## Reuse map — existing primitives vs. the one new table

| Concern | Reuses (existing) | Location |
|---|---|---|
| Scope-enforcement *pattern* (caller → scope → row filter) | `ncl` dispatch: `caller:'host'` bypasses; `caller:'agent'` → `cli_scope` + post-handler row filter by `scopeField` | `nanoclaw/src/cli/dispatch.ts:42-101`, `:150-172` |
| Declarative "which column is the scope key", fail-closed | `ResourceDef.scopeField` | `nanoclaw/src/cli/crud.ts:55-60` |
| Clerk email → person resolution | `resolvePersonByIdentifier('email', addr)` (no `users` row needed); `getPersonByUser('email:<addr>')` | `nanoclaw/src/people/index.ts:187`, `:225` |
| "own" row-scoping for conversations | `resolveHandles` (person → handles → messaging_groups → sessions) — already written | `nanoclaw/src/conversations/index.ts:54-67` |
| Person create / identifier link / handle link (single writer) | `createPerson`, `addIdentifier`, `linkHandle`, `deletePerson` | `nanoclaw/src/people/index.ts` |
| Single-writer module shape for a new resource | `src/people/` + `ncl people` (`cli/resources/people.ts`) — copy the pattern for `src/person-roles/` + `ncl roles` | `nanoclaw/src/people/index.ts`, `cli/resources/people.ts` |
| Mutation channel (dashboard never writes `v2.db` directly) | `POST /admin/ncl` → `dispatch(frame, {caller:'host'})`, gated `PAT_ENABLE_NCL_HTTP=1` + fail-closed on `PAT_ADMIN_TOKEN` | `nanoclaw/src/admin/index.ts:1108`, gate `:1171-1184` |
| Agent-runtime authority (left untouched this round) | `user_roles` + `canAccessAgentGroup` + `hasAdminPrivilege` | `nanoclaw/src/modules/permissions/access.ts:21-28`, `db/user-roles.ts` |
| **NEW — dashboard authority** | **`person_roles` table** (migration 021) + `ncl roles` resource + a code-side `ROLE_CAPS` map | this plan |

**Only one genuinely-new persistent artifact: `person_roles`.** It is the person-keyed authority
axis, which **no existing table represents** today — `user_roles` is the handle-keyed *runtime*
authority (who runs `ncl` / approves / admins agent groups). Everything else is wiring of existing
primitives. The role→capability *definition* adds **no table** — it's a code constant.

---

## The authorization model — roles + a code-defined capability map

### Roles (data, per-person)

`person_roles` holds **assignments**: one row per (person, role).
```
person_roles(person_id, role, granted_by, granted_at)
```
`role` enum starts as `{'admin', 'employee'}`. A person with no row has **no access** (empty table =
locked down; the one seeded `admin` row is the bootstrap).

### Capabilities (code, per-role)

A reviewed/versioned **code constant** maps each role to a set of `resource:action:scope` capabilities:
```ts
// pat-frontend/server/authz.ts  (code, not DB)
const ROLE_CAPS: Record<Role, Capability[]> = {
  admin:    ['*:*:all'],        // every resource, read+write, unscoped
  employee: ['*:read:own'],     // read-only, own-scoped, for resources that define `own`
};
```
- `resource` ∈ `{conversations, files, users, people, logs, db, capabilities, roles}`.
- `action` ∈ `{read, write}`.
- `scope` ∈ `{all, own}`. `all` = unrestricted; `own` = filtered to the caller's person.
- `*` is a wildcard expanded at load time against the known resource/action lists.

**`all` dominates `own`.** A route declares the *minimum* capability (`conversations:read:own`); a
role whose caps include `conversations:read:all` (or `*:*:all`) satisfies it and the scoper applies no
filter. Evaluation: the route's declared right is satisfied iff the caller's role-derived cap set
contains the exact right OR the same `resource:action:all`.

**Why code, not DB, for the map:** role *definitions* (what `employee` may see) evolve as features
land — that's a code change, reviewed in a PR. Role *assignments* (who is an `employee`) change as
people join/leave — that's an ops action, a `person_roles` row via `ncl`. Splitting them this way
keeps the security-relevant definition in version control and the churny part in data.

---

## The central chokepoint — `requireRight()`

One helper replaces every inline token/domain check. It (1) resolves the caller's `person` from the
Clerk session once per request, (2) looks up the person's role(s) in `person_roles`, (3) derives the
cap set from `ROLE_CAPS`, (4) checks the declared right and returns a **scope context** the handler
passes to the query layer.

```ts
// pat-frontend/server/authz.ts  (NEW)
export type Role = 'admin' | 'employee';

export interface Caller {
  person: Person;                 // resolved Clerk email → person (auto-created on first login)
  roles: Role[];                  // from person_roles (RO SELECT)
  scopeFor(resource: string, action: 'read' | 'write'): 'all' | 'own' | null; // from ROLE_CAPS
}

/** Returns Caller on success; writes 403 and returns null on failure
 *  (no person, no role, or role's caps don't cover the declared right). */
export async function requireRight(
  c: Context,
  right: `${string}:${string}:${string}`,
): Promise<Caller | null> { /* resolve person → roles → ROLE_CAPS → evaluate all⊇own */ }

/** Separate path for machines (pat-trace, smoketests). Header-only. NOT a person. */
export function requireServiceToken(c: Context): boolean { /* Authorization: Bearer <token> */ }
```

Route, before (`routes-db.ts:53-58`):
```ts
const t = c.req.query('token') ?? '';
```
Route, after:
```ts
const caller = await requireRight(c, 'db:read:own');
if (!caller) return;                         // 403 already written
const scope = caller.scopeFor('db', 'read'); // 'all' | 'own'
```

This is the dashboard-side analogue of `dispatch.ts`'s single chokepoint: same shape (caller → scope
decision → row filter), different process. Two chokepoints total — `requireRight` (humans),
`requireServiceToken` (machines) — exactly the "two independent auth paths" the people plan calls for
(`admin-dashboard-and-people.md:51-68`).

## Row-scoping ("own") — one predicate per resource, in the query layer

The `own` filter lives in **one place per resource**, not re-implemented per endpoint. Reuse
`conversations/index.ts:resolveHandles` as the template.

```ts
// pat-frontend/server/db.ts  (extend)
function ownPredicate(caller: Caller, resource: string): { sql: string; params: unknown[] } | null {
  if (caller.scopeFor(resource, 'read') === 'all') return null; // no filter
  const handles = handlesForPerson(caller.person.id);           // RO SELECT from person_users
  switch (resource) {
    case 'users':         return { sql: `id IN (${qs(handles)})`, params: handles };
    case 'conversations': /* forward to nanoclaw `ncl conversations list --person-id <id>` */;
    case 'files':         /* path prefix data/people/<person_id>/ (Phase-3 /personal layout) */;
    default:              throw new Error(`no own-predicate for ${resource}`); // fail closed
  }
}
```

- **conversations:** do not reimplement — the dashboard supplies `--person-id = caller.person.id` and
  nanoclaw's recall scopes inherently.
- **files:** maps onto the Phase-3 `/personal = data/people/<person_id>/<agent_group>/` layout
  (`admin-dashboard-and-people.md:318-323`); the scope key is literally the path prefix.
- **users / DB tables:** filter `users` to the caller's handles. Non-person tables (`agent_groups`,
  `messaging_groups`) have **no `own` meaning** → they define no `own` variant and require `:all`
  (admin-only).
- **Fail-closed rule** (mirrors `dispatch.ts:155-159`): a resource that offers `own` MUST register a
  predicate; a route declaring `:own` for a resource with no predicate → `requireRight` denies.

## Mutations vs. queries — same gate, writes forward to nanoclaw

`requireRight(c, 'people:write:all')` gates a write identically to a read — but the **write never
touches `v2.db` directly**. It forwards to `POST /admin/ncl` (`admin/index.ts:1108`), the sanctioned
single-writer channel. Write-specific concerns:
- **Audit:** stamp `caller.person.id` in a structured `kind:'dashboard.mutation'` log *before*
  forwarding — the bridge runs `caller:'host'`, so nanoclaw can't see which human acted.
- **Who can manage roles:** granting/revoking `person_roles` is `roles:write:all` (admin-only),
  executed via the `ncl roles` resource so writes stay single-writer.

---

## Phase A — cleanup + identity (no new table; unblocks now)

**Goal:** every request carries a resolved `person`; sensitive routes need OAuth not a token; the
single-writer rule is restored. No `person_roles` table yet — Phase A stands up the chokepoint and
identity plumbing; the role lookup returns "no role → deny" until Phase B seeds the table. (During
Phase A dev, the existing `ADMIN_DEV_NO_AUTH=1` bypass keeps local work unblocked.)

1. **Clerk → person resolution in the new `requireRight`.** Normalize the Clerk email,
   `resolvePersonByIdentifier('email', email)` via the existing RO `getDb()`. On a hit, the caller's
   `person` is set. On a miss, **auto-create + link on first login** (locked decision 3) — see the
   login-create path below. (Conditional on Verification A.)
2. **Mount Clerk on all human routes**, not just `/api/me` (`index.ts:57-66` → broaden
   `HUMAN_ROUTES`). Keep the streaming log routes off the person middleware.
3. **`requireRight` chokepoint** + **`requireServiceToken`** (header-only). Migrate `/api/db`,
   `/api/db/:table`, `/api/capabilities` off the inline viewer-token check to `requireRight`.
   Restrict the service token to **log/trace routes only** (`/api/logs.jsonl`, `/api/logs.tail`).
4. **Kill the direct `routes-users.ts` writer.** Rewrite POST/PUT/DELETE to `requireRight(c,
   'users:write:all')` → forward to `ncl users-create/update/delete` over `/admin/ncl`. Drop
   `getDbRw` from `db.ts` (the hand-rolled cascade is replaced by nanoclaw's own logic). Per the
   no-legacy rule, delete the direct path rather than keep both.
5. **Login-create path** (the new write on first login): on a person-miss for a valid
   `@palisaderesearch.org` session, call `/admin/ncl` to `people-create {first_name, last_name}` then
   `people-add-identifier {person-id, kind:'email', value:<addr>, verified:true}`. Idempotent: a
   second login resolves the now-existing identifier and skips the create. (See Verification A for the
   name dependency + fallback.) Note: creating the *person* does not grant a *role* — a freshly
   auto-created person still has no `person_roles` row and is denied data access until an admin grants
   one. (Acceptable: the bootstrap admin is seeded directly; later joiners get a role from an admin.)

**Phase-A files:** `auth.ts` (grow person resolution + login-create), NEW `authz.ts`
(`requireRight`/`requireServiceToken`/scope, `ROLE_CAPS` stub), `index.ts` (Clerk on all human
routes; service token header-only on logs), `routes-db.ts` + `routes-capabilities.ts` (token →
`requireRight`), `routes-users.ts` (rewrite → `/admin/ncl`, drop `getDbRw`), `db.ts` (`getDbRw`
removed; add `ownPredicate` skeleton).

## Phase B — `person_roles` + `ncl roles` + first own-scoping

1. **Migration `021-pat-person-roles.ts`** (additive, `// PAT:`):
   ```sql
   CREATE TABLE person_roles (
     person_id  TEXT NOT NULL REFERENCES people(id),
     role       TEXT NOT NULL,   -- 'admin' | 'employee'  (enum, extend in code)
     granted_by TEXT,            -- person_id of the granting admin (audit)
     granted_at TEXT NOT NULL,
     PRIMARY KEY (person_id, role)
   );
   CREATE INDEX idx_person_roles_person ON person_roles(person_id);
   ```
2. **`src/person-roles/` module + `ncl roles` resource** (`nanoclaw/src/cli/resources/roles.ts`),
   mirroring `src/people/` + `ncl people`: list/get `open`; grant/revoke `approval`-gated, **not** on
   the group-scope whitelist (`dispatch.ts:51`) so group-scoped agents can't touch it. All writes go
   through the single-writer module.
3. **Seed the bootstrap admin** once: `ncl roles grant --person-id <gavan> --role admin` (after the
   login-create path has produced Gavan's person, or seed the person first). This is the **only**
   bootstrap — no env var.
4. **`requireRight` reads `person_roles`** (RO SELECT) and maps role → caps via `ROLE_CAPS`.
5. **First `own` predicates:** `conversations` (forward `--person-id`) and `users`. An `employee` sees
   only their own threads; an `admin` (`*:*:all`) sees everything. This delivers the admin/employee
   split (`admin-dashboard-and-people.md:84-92`).

## Phase C — full RLS coverage

- Extend `own` to `files` (the Phase-3 `/personal` subtree) and any new resource.
- Per-resource **write** rights flow through the same gate (`people:write:all`, `users:write:all`,
  `roles:write:all`).
- Optional: lift the predicate registry to a shared `{ resource, ownPredicate, caps }` spec (the
  `ResourceDef`/`scopeField` idiom raised to the dashboard) so a new resource declares its scoping
  once. At this point "row-level" = every resource has an `own` predicate and every route declares a
  right. (SQLite has no engine-level RLS; this *is* the RLS.)

The progression is **monotonic**: `scopeFor()` already returns `all|own` in Phase A; B populates
`person_roles`; C adds predicates. No rework — exactly the "the helper's return grows a field,
sensitive routes add a guard, no rework" property the people plan promises
(`admin-dashboard-and-people.md:73-74`).

## Later / escape hatch — atomic per-right grants (DEFERRED)

Roles + a code-defined `ROLE_CAPS` are the model **now**. Introduce a `person_grants` table (atomic
`resource:action:scope` rows attached to a person, layered on top of the role) **only if** one of
these actually bites:
- **Role definitions need to be runtime-editable** (change what `employee` can see without a deploy).
  Today that's a code change, which is *desirable* (reviewed) — flip only if ops genuinely needs it.
- **Per-person exceptions proliferate** (e.g. "this one employee may also read all conversations").
  A handful is fine as a new named role; if they sprawl into one-offs, atomic grants are the cleaner
  shape.
The `requireRight`/`scopeFor` chokepoint and the `own`/`all` machinery are **unchanged** by this — a
grants table would just be an additional source merged into the cap set. Designed-for, not built.

---

## Verification A — Does Clerk hand us first + last name? (gates the login-create path)

**Decision 3 (auto-create person on first login) is conditional on getting a real name.** Verified
against the installed SDK and Clerk docs:

- **The field exists.** `@clerk/backend@^3.7.1` (installed) exposes on the `User` resource:
  `readonly firstName: string | null` and `readonly lastName: string | null`
  (`pat-frontend/node_modules/@clerk/backend/dist/api/resources/User.d.ts:82,86`). `fullName` is also
  `string | null`. So `clerk.users.getUser(userId)` — already called in `auth.ts:70` — returns them.
- **Google OAuth *can* populate them.** Clerk's `/oauth/userinfo` returns `given_name` / `family_name`
  from the provider (Clerk docs, single-sign-on guide), which Clerk maps to `firstName` / `lastName`.
- **BUT they are nullable and conditional.** Names are only filled if **"First and last name" is
  enabled in the Clerk instance settings** AND Google actually supplied them. Clerk's own OAuth guide
  documents a `missing_requirements` flow precisely because OAuth sign-ups can land without a name.
  Google usually supplies given/family name for workspace accounts, but this is **not guaranteed**.

**⚠️ USER ACTION ITEM (verify in the Clerk dashboard before Phase A ships the login-create path):**
confirm the reused Clerk instance has **"First and last name" enabled** (and that the
`@palisaderesearch.org` Google Workspace returns names). If confirmed, the login-create path uses
`user.firstName` / `user.lastName` directly.

**Fallback (if a name can be null at create time)** — pick one at build time:
- **(preferred) Derive a placeholder from the email local-part** (e.g. `gavan@…` → first_name
  `"gavan"`, last_name `"(unverified-name)"`), create the person so login is never blocked, and
  surface a "needs name" flag in the dashboard for an admin to correct via `ncl people update`. Note:
  `people` requires `last_name` NOT NULL (`migration 019`, `people/index.ts:54-55`), so a placeholder
  last_name is mandatory — do not pass empty.
- **(stricter) Block create until a name is present** — redirect first-time users with no name through
  Clerk's `missing_requirements` form. Cleaner data, worse first-login UX. Not recommended for an
  internal tool.

Either fallback keeps Phase A unblocked; the choice is a UX call, flagged in OPEN QUESTIONS.

## Verification B — Forward-compatibility: `person_roles` is the convergence target

The user does **not** want to change Pat's runtime credential system (`user_roles`, the access gates,
`gateCommand`) now — but **intends to eventually deprecate `user_roles` → `person_roles`** and
converge runtime authority into the same table the dashboard uses. This plan is deliberately built so
that convergence is *natural*, not a rewrite. Audit result:

**The end-state is a MERGE into `person_roles`, not two tables forever.**
- **`person_roles` is person-keyed from day one.** PK `(person_id, role)`; `requireRight` resolves
  Clerk → person → `person_roles`. When runtime authority later converges, the runtime check-sites
  resolve handle → person (via `getPersonByUser` / `resolvePersonByIdentifier`, already used here) and
  read the **same** `person_roles` table. The dashboard is the *first* consumer; runtime becomes the
  *second*. Same table, same key, no schema fork.
- **For now the two axes stay distinct but aligned.** `user_roles` (runtime, **handle-keyed**) stays
  untouched this round; `person_roles` (**person-keyed**) governs dashboard authority. The future
  migration reads existing `user_roles` rows, resolves each handle → person, writes the equivalent
  `person_roles` rows, repoints the runtime check-sites, and drops `user_roles`. Additive design keeps
  this cheap.
- **Clerk → person resolution is reusable verbatim.** The handle→person resolver the runtime
  check-sites will need is the *same* primitive `requireRight` uses — building it for the dashboard now
  de-risks the convergence.

**The one real guardrail — do not couple to the handle-keyed axis:**
- **DO NOT** decide dashboard access by reading `user_roles` (e.g. "is this handle an owner?"). Dashboard
  authority is decided **only** by `person_roles` (person-keyed). Reading `user_roles` would bind the
  dashboard to the handle-keyed axis we're trying to converge *away* from, making the merge harder.
- The bootstrap is an explicit `person_roles` row (decision 5), not a read of `user_roles` and not an
  env var — so even the bootstrap path stays person-keyed and on the convergence track.

**`PAT_OWNER_PHONES` is a handle-keyed hack the future runtime→person migration deletes — not now.**
It grants an *owner* `user_role` to a phone *handle* on first inbound (`permissions/index.ts:111-144`)
— inherently handle-keyed, the exact thing per-person runtime authority replaces (owner becomes a
property of the *person*, resolved from any handle). Leave it untouched this round; it's a known
teardown target when runtime authority converges into `person_roles`.

**Conclusion:** by naming the table `person_roles` and keying everything on `person.id`, Phase A/B set
up the eventual convergence rather than fighting it. The single guardrail (never read `user_roles` for
dashboard decisions) is the only thing to hold.

---

## OPEN QUESTIONS / decisions still needed

1. **Verification A — Clerk name settings.** Confirm "First and last name" is enabled on the reused
   Clerk instance and that the Workspace returns names. If not guaranteed, pick the fallback
   (placeholder-from-email vs. block-until-name). *Blocks the Phase-A login-create path.*
2. **`db` resource granularity.** Is `db:read:all` a single right for the whole table browser, or do
   sensitive tables (`person_identifiers`, `sessions`) need their own `:all` rights distinct from
   benign ones (`agent_groups`)? Probably fine to ship coarse in Phase A/B and split in Phase C.
3. **Auto-create on login = a write triggered by a read-ish request.** Confirm we're comfortable that
   `GET /api/me` (first login) performs a `/admin/ncl` write. Alternative: lazily create only when the
   user first hits a route that needs a `person`. Recommend create-on-`/api/me` for simplicity.

> **Accepted (not open):** the **service-token cutover** — restricting the service credential to
> log/trace routes only is a behavior change for any tooling that currently hits `/api/db` with the
> viewer token; **the user has accepted this risk.** Still do a quick who-calls-what sanity check on
> the smoketests / `pat-trace` / scenario harness during implementation, but it is not a blocker.
