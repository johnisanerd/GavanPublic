# Connect a 1Password vault to OneCLI (per-agent-group credentials)

> **Status: planned, not executed.** Drafted 2026-06-29.

> **⚠️ Policy (2026-07-01, operator): 1Password credential intake stays OUT OF BAND.** The operator
> adds keys directly in the 1Password app — **never through PAT**, `ncl secrets add`, or a dashboard
> form. The goal is to *discourage sharing raw API keys with PAT*. Consequences: use a **read-only**
> service account (OneCLI resolves at egress; the host at most checks *existence* via `items.list`,
> never decrypting a value). **P3 (write path) and the per-person "add my key" dashboard form are OFF**
> unless this policy is revisited. This makes `op://` the *aligned* model — the only path where PAT
> never touches the raw key — and reframes the inline-value flow (paste `AGENT_<X>` to PAT, as done for
> Exa) as a **stopgap to migrate off**. See [[feedback_discourage_sharing_keys_with_pat]] in memory.

> **⚠️ Correction (2026-07-01): OneCLI resolves `op://` natively at runtime** (docs verbatim; our
> gateway's secret schema carries `valueSource`/`opRef` — verified live). This **contradicts §"How
> credentials reach containers today" below** ("OneCLI has no native external-vault backend") — that
> was wrong/stale. The reconciler therefore **shrinks from "push values" to "ensure the host→op_ref
> mapping exists"** (OneCLI pulls the value live, ~60s cache, never persisted). Not yet confirmed
> end-to-end on our box (config REST endpoints 404'd — likely dashboard-only); see `sprint/backlog.md`
> TOP item for the two queued tests.

## Context

Today, giving an agent group a new outbound credential is a multi-step, tribal
dance. Per credential an operator must:

1. Obtain the raw key.
2. `onecli secrets create --name … --type generic --value <raw> --host-pattern …`
   with the correct injection header + value format — metadata that lives only
   in a memory/wiki file (`groups/palisade-internal/wiki/references/reference_onecli_vault_pat.md`).
3. `onecli agents list | jq` to find the OneCLI agent id for the group.
4. Read the agent's current `secret-ids`, **merge** (because `set-secrets`
   replaces the whole list), `onecli agents set-secrets …`.
5. The raw value now lives in OneCLI's Postgres, frequently *also* duplicated
   into Fly secrets. There is no single source of truth.

We want: **drop a credential into a 1Password vault → it's available to that
agent group's containers.** No code, no deploy, no jq.

### How credentials reach containers today (load-bearing facts)

- **OneCLI is the vault + egress proxy.** Containers get `HTTPS_PROXY` pointed at
  the gateway and send requests with *no* auth header; the gateway injects the
  real credential by matching the request host against registered secrets.
  Raw keys never enter container memory.
  (`nanoclaw/src/container-runner.ts:638-652`, `applyContainerConfig`.)
- **The OneCLI "agent" == the nanoclaw agent group.** The OneCLI agent
  identifier is always the agent group id (`container-runner.ts:147`), created
  on spawn via `ensureAgent({ identifier: agentGroupId })`.
- **Scoping is per-agent via secret mode.** `all` = inject every host-matching
  secret (no real scoping). `selective` = inject only assigned `secret-ids`.
  `set-secrets` *replaces*, so callers must read-merge-write.
- **Hard constraint:** `@onecli-sh/sdk` (v2.2.1) has **no secrets API** — only
  container-config, `ensureAgent`, approvals, provisioning. Secret CRUD exists
  only via the `onecli` CLI, the web UI, or the gateway REST endpoints
  (`POST /api/secrets`, `/api/agents/<id>/secrets`). So any 1Password
  integration is a **bridge we build**, not a config flag. OneCLI has no native
  external-vault backend.

## Design: one 1Password vault per agent group, reconciled into OneCLI

1Password is the source of truth for credential values. A host-side reconciler
reads the vaults (1Password JS SDK + a service-account token) and makes OneCLI
match. **The 1Password vault structure carries the group-scoping** — no tags,
no custom "which group" metadata.

### Vault layout

| Vault | Maps to | Contents |
|---|---|---|
| `pat-<agentGroupId>` (e.g. `pat-palisade-internal`) | one agent group | secrets only that group gets |
| `pat-common` | **all** agent groups | shared creds (Anthropic, OpenRouter, …) |

- **Staging vs prod:** separate service accounts, separate vault sets
  (`pat-staging-<group>` / `pat-staging-common`, or simply a staging SA that
  can only see staging vaults). Keeps blast radius per-env, fits the existing
  staging/prod split (`plans/staging-prod-split.md`).
- **One service account** per env, granted access to that env's vaults. The
  service-account token is the **single bootstrap secret** that must remain a
  Fly secret (chicken-and-egg) — everything else moves into 1Password.

### Item shape — near-zero metadata

A normal item is just **title + secret value + website**:

| 1Password item attribute | Maps to | Notes |
|---|---|---|
| concealed `credential`/`password` field | secret value | the raw key |
| native **website / URL** | `hostPattern` | hostname extracted from the URL — *native* field, not custom |
| (none) | header + value format + type | OneCLI default `Authorization: Bearer {value}`, plus a small built-in exception map (below) |

**Injection exception map** (in code, ~5 lines — not per-item metadata):

| Host | Type | Header / format |
|---|---|---|
| `api.anthropic.com` | `anthropic` | auto `x-api-key`, strips inbound `Authorization` |
| `api.cartesia.ai` | `generic` | `X-API-Key: {value}` |
| `github.com` | `generic` | `Basic` (git smart-HTTP) — see `/add-github` |
| _default_ | `generic` | `Authorization: Bearer {value}` |

Escape hatch: a power user can override per item by adding optional
`onecli-header` / `onecli-format` / `onecli-type` fields; the reconciler reads
them if present, otherwise falls back to the map. The common case never needs
them.

### Reconciler logic (host-side only — must never run inside a container)

1. Auth to 1Password with `OP_SERVICE_ACCOUNT_TOKEN`.
2. `vaults.list()` → keep vaults matching the env's `pat-*` convention. Map
   `pat-<group>` → that group; `pat-common` → all groups.
3. For each item (`items.list` → `items.get` for decrypted fields), derive the
   desired OneCLI secret: name `op:<vault>:<itemTitle>`, value, hostPattern
   (from website), injection (exception map / overrides).
4. Reconcile against `GET /api/secrets`:
   - missing → create
   - changed → update (**verify gateway update endpoint exists; else delete+recreate**)
   - present, prefix `op:`, no longer backing a 1Password item → **prune**.
     Only ever prune `op:`-prefixed secrets — never touch hand-made/bootstrap ones.
5. Reconcile scoping: for each agent group, desired secret-id set = its own
   vault's secrets **+** `pat-common`'s secrets. `ensureAgent`, set
   `secretMode=selective`, `set-secrets` the computed set. The reconciler is
   authoritative for any group that has a `pat-<group>` vault; groups without
   one are left untouched (hand-managed).
6. Emit structured logs under a new `kind: 'secrets.sync.*'`
   (`realtime/src/log-events.ts` + Python mirror).

### Triggers / where it runs

Host process on `pat-nanoclaw` (raw values present — host-only, never container).

- **On boot:** call from `scripts/fly-entrypoint.sh` after the existing OneCLI
  health gate (§2.5), before the service starts serving.
- **On demand:** `ncl secrets sync [--dry-run]` (new resource in
  `src/cli/resources/`).
- **Periodic:** optional later via `host-sweep` (e.g. every N min).

### End-state workflows

- **Add a credential to a group:** create a Login/API-Credential item in that
  group's `pat-<group>` vault, paste the value, set the website to the API host.
  `ncl secrets sync` (or wait for next boot). Containers can call that host
  immediately — no code, no deploy.
- **New agent group is self-service:** `ncl groups create` → reconciler
  `vaults.create({ title: "pat-<group>" })` (SDK supports it; the SA
  auto-accesses vaults *it* creates). ⚠️ A vault a human creates in the
  1Password app is **not** visible to the SA until explicitly granted — so
  vault creation must go through the reconciler/`ncl`, not the UI.
- **Optional nicer front door (P3):** `ncl secrets add --group foo --host
  api.x.com --value …` writes the 1Password item for you (SDK `items.create`,
  needs a read-*write* SA) then syncs — operator never opens the 1Password app.

## Per-person vaults (extension)

The same model extends down one level: a vault per **PersonID**, scoped to that
person's 1:1 sessions only. This mirrors the Phase-3 per-person *memory* design
(`src/personal-memory.ts`) — credentials are the same shape with a different
injection target.

### The hook already exists

`resolveSessionPerson(session)` (`src/personal-memory.ts:85`) returns the single
person id for a 1:1 session, or `null` for group/anonymous sessions. Per-person
memory already uses it to mount `/personal` only in 1:1s.

### The one code change

OneCLI scopes by "agent" = the identifier passed at spawn, today always
`agentGroupId` (`container-runner.ts:147`). Make it person-scoped for 1:1s:

```
identifier = resolveSessionPerson(session)
  ? `${agentGroupId}--${personId}`   // 1:1 → person agent
  : agentGroupId                      // group / anonymous → group agent
```

Reuses the existing resolver; group/anonymous sessions are untouched.

### Vault hierarchy mirrors the memory-mount hierarchy

| Memory mount | 1Password vault(s) | Reaches |
|---|---|---|
| `/shared` (always) → group | `pat-common` + `pat-<group>` | every agent in the group |
| `/personal` (1:1 only) → person | `pat-person-<personId>` | only that person's 1:1 agent |

Reconciler secret sets:
- group agent (`<group>`) = `pat-common` + `pat-<group>`
- person agent (`<group>--<person>`) = `pat-common` + `pat-<group>` + `pat-person-<person>`

Enumerate persons from the people spine (`ncl people list`) to pre-scope;
`ensureAgent` is idempotent and self-populates person agents on first 1:1 spawn.

### Trust posture (trusted-internal — matches per-person memory)

The intended use is low-friction: a person drops their own access key (email
API key, personal service token, etc.) into their vault so the agent can use it
on their behalf inside their 1:1. Trust assumptions follow the existing
per-person *memory* model — no new ceremony.

1. **No hard gate by default.** Person-scoped injection rides the same
   person↔session binding `/personal` memory already uses
   (`resolveSessionPerson` → the `person_users` link). In the normal flow those
   links are minted by the pairing-code flow (`link_method='pairing'`), which is
   redeemed against a logged-in OAuth session — i.e. proof-of-possession,
   verified by construction. No extra ceremony needed.
2. **The trust lever is `person_users.link_method`, not
   `person_identifiers.verified`.** (That `verified` column governs the
   secondary auto-enroll recognition door and isn't even consulted by
   `resolvePersonByIdentifier`.) If a stricter gate is ever wanted for a
   high-value key, restrict person-scoped injection to `link_method='pairing'`,
   which excludes the one non-OAuth path: `autoEnroll` on the **phone-call
   channel** (`phone-call.ts:295`) links by raw caller-ID against a seeded phone
   identifier, with no proof. Narrow (voice + seeded phone identifier only);
   irrelevant unless you enroll by caller-ID.
3. **Never to group sessions** — same rule as `/personal`. A person's private
   credential must never reach a multi-person session.

### Transport caveat

OneCLI injects by matching outbound **HTTPS** host. Email/service access over
API (Gmail API, Microsoft Graph, most modern APIs) rides the proxy cleanly;
raw IMAP/SMTP (993/587) is a different transport and is out of scope for
host-pattern injection.

### Who drops the key

Near-term: operator-mediated, or the people-management dashboard grows an
"add my key" form that writes to the person's vault via the SDK (needs the
read-write SA from P3). A service-account-owned vault isn't directly usable
from the person's own 1Password app unless explicitly shared, so the dashboard
is the natural self-serve surface.

Cost: OneCLI-agent count and 1Password-vault count scale with people
(negligible at current scale; watch 1Password plan vault limits later).

## Phasing

- **P0 — Vault + SA setup.** Create the `pat-common` + `pat-<group>` vaults and
  the per-env service account (with create-vault capability if we want
  self-service group provisioning). Document the item convention. Store
  `OP_SERVICE_ACCOUNT_TOKEN` as a Fly secret on `pat-nanoclaw` (+ `-staging`).
- **P1 — Reconciler.** `nanoclaw/src/modules/secrets-sync/`: 1P client
  (`@1password/sdk`), thin OneCLI REST client for `/api/secrets` +
  `/api/agents/<id>/secrets` (SDK can't do secrets), reconcile + scope +
  `--dry-run`. **First verify** the gateway's update/delete secret endpoints
  against the running gateway — docs only show `POST`.
- **P2 — Triggers.** `ncl secrets sync` verb + on-boot call in fly-entrypoint.
- **P3 (optional) — Write path.** ❌ **OFF per the out-of-band policy banner above** — the operator
  adds keys directly in 1Password; PAT must not write items (that requires a read-write SA and makes
  PAT handle the key). Only revisit if the policy changes. (Original idea: `ncl secrets add` creates
  the item, then syncs.)
- **P4 — Migrate.** Move the existing 7 registered hosts into the vaults, flip
  opted-in groups to `selective`, delete duplicate Fly secrets per the existing
  "don't keep both Fly secret and vault entry" rule.
- **P5 (per-person, optional) — Person-scoped vaults.** Person-scope the OneCLI
  agent identifier for 1:1 sessions; add `pat-person-<personId>` vaults to the
  reconciler. No hard gate (trusted-internal; bindings are pairing/OAuth-proven
  via `person_users.link_method='pairing'`). Depends on Phase-3
  per-person memory being live. See "Per-person vaults" above.

## Open questions / verify before building

1. **Gateway secret update/delete endpoints** — confirm they exist; otherwise
   reconcile via delete+recreate (and accept a brief injection gap on rotate).
2. **Read-only vs read-write service account** — read-only is simplest/safest
   and covers P0–P2; read-write only needed for P3's `ncl secrets add` and for
   reconciler-driven `vaults.create`. Recommend read-write scoped to the PAT
   vaults so group self-service works; revisit if the broader write surface is
   a concern.
3. **`pat-common` fan-out cost** — every group gets every common secret. That's
   the intended model (shared infra creds), but means a group can reach any
   common host. If a group must be denied a common cred, move it out of
   `pat-common` into the specific groups' vaults.
4. **Rotation semantics** — on value change, `set-secrets` is a no-op
   (scope unchanged) but the secret value update must propagate; confirm the
   gateway picks up the new value per-request without a container restart
   (it should — it looks up secrets per request).

## Critical files

- `nanoclaw/src/container-runner.ts` — `ensureAgent` + `applyContainerConfig`
  (agent==group, proxy wiring). Lines ~147, ~638-652.
- `nanoclaw/setup/onecli.ts`, `nanoclaw/setup/auth.ts` — existing
  `onecli secrets create` usage; model the REST client on these.
- `nanoclaw/.claude/skills/init-onecli/SKILL.md` — current manual secret +
  agent-scoping flow (the thing this plan automates), incl. the safe-merge
  `set-secrets` pattern.
- `nanoclaw/scripts/fly-entrypoint.sh` §2.5 — OneCLI boot/health gate; hook the
  on-boot sync after it.
- `nanoclaw/src/cli/resources/` — add the `secrets` resource (`sync`, later `add`).
- `groups/palisade-internal/wiki/references/reference_onecli_vault_pat.md` —
  current host table; source for P4 migration, retire after P3.
