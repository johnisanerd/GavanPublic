# Credential → MCP activation — implementation spec (execution runbook)

Status: **✅ SHIPPED + VERIFIED on staging, 2026-07-01** (nanoclaw `8b7ed95`, parent `e8aebaa`).
Steps 0–6 done; Step 7  deliberately not pulled forward; prod promotion held for review.
E2E: boot reconcile clean (8 routes untouched, 0 errors); parked probe stayed pending while its
credential was absent; vault add → `mcp.activation-activated` + config write + respawn. Harness
latency was 47s (direct DB insert bypasses the enqueue kick); the real approval path kicks → ~4s.
Design/rationale live in
`plans/mcp-management.md` (Phase 5 "Credential-gated activation") + `plans/onecli-1password-vault.md`
(policy banner). This doc is the **ordered build plan** a fresh context executes.

## Decision (why this exists)

Build a **clean inline/`AGENT_` credential system now** — do not wait for 1Password. Structure it so
op:// is a **drop-in later** (two seams), but assume 1P may not happen soon and the system must be
clean without it. Operator's call: *"you can implement it… I want a clean system if we don't [get to 1P]."*

**Policy (load-bearing):** 1Password credential intake stays **out of band** — operator adds keys
directly, never through PAT. The raw key should live in as few places as possible; PAT-the-agent never
sees it (OneCLI injects at egress). See `feedback_discourage_sharing_keys_with_pat` memory. So: the
`AGENT_<X>` value source is the **interim** (raw value in a Fly secret → host → vault); op:// is the
target (value only in 1P). Both sit behind the same seams.

## Compatibility contract (do NOT violate — this is the whole point)

**Two seams** — every source-specific behavior goes behind exactly these, nothing inlines it:
1. `resolveVaultSecretSpec(route) → VaultSecretSpec | null` — produces the `POST /api/secrets` body.
   - *inline impl (build now):* value from `process.env['AGENT_' + route.secret_name]`; `null` if unset.
   - *op:// impl (later):* `{ opRef, injectionConfig }`, no value pushed.
2. `credentialAvailable(route) → Promise<boolean>` — "will the MCP authenticate if we handshake now?"
   - *inline impl (build now):* `GET /api/secrets`, is there an entry for `route.host_pattern`?
   - *op:// impl (later):* `items.list` on the vault (title/id only — **never `items.get`**, policy).

**Three invariants** (already true — keep them): DB `credential_routing` is source of truth, vault is a
derived cache; routing metadata (host/header/format) is source-agnostic; `secret_name` is the stable
join key.

**Non-goals / do NOT build (anti-speculation):** no `op_ref` column, no 1P SDK code, no `items.list`
today, no read-back-the-value features, no "be-the-writer" write path. op:// schema/impls land when 1P
is actually wired (cheap migration then).

## What survives op:// vs. throwaway (so you know what's load-bearing)

| Piece | Survives op://? |
|---|---|
| `credential_routing` table (mig 023, shipped) | ✅ |
| Seam functions, reconcile skeleton, existence check, activation watcher | ✅ (swap the two impls) |
| **`AGENT_` env → push value** (inline impl of seam #1) | ❌ throwaway — keep it minimal, isolated |

---

## Build order

### Step 0 — GATE: does an MCP-over-HTTP client retry a failed handshake mid-session?
**Run this first — it decides how much of Steps 4–5 exist.** If the container's MCP client re-attempts a
server that 401'd at startup (self-heals), we may not need activation-restart at all (a late key is
picked up within retry + 60s), and the watcher collapses to "just wait."

Test (staging, cheap): wire an http MCP with a **bad/missing** credential so its handshake 401s → confirm
its tools are absent (container stderr MCP-connect chatter at
`data/v2-sessions/<ag>/<sess>/container.stderr.log`, or ask staging PAT "list your tools"). Then make the
credential valid **without restarting the container** (POST a real vault entry). Wait ~2 min. Observe: do
the tools appear without a restart?
- **Self-heals** → Steps 4–5 shrink: no restart on activate; watcher only writes config (or nothing).
- **Does not** → Steps 4–5 as written (restart on activate).
Record the result in this doc before building 4–5.

> **✅ RESULT (2026-07-01, settled from source — deep-read of agent-runner + SDK v0.2.116):**
> **Does NOT self-heal → restart on activate is required.** Mechanism (not timing, so source is
> decisive): the agent-runner opens ONE long-lived streaming `query()` and **pushes** every later
> message batch into it (poll-loop.ts:389-394 explicitly: keeping the query open avoids re-spawning
> the SDK subprocess per turn). MCP connections belong to the `claude` subprocess, established once
> per `query()` open; a failed handshake sets status `failed` with **no retry** within the open
> query, and the runner never calls the SDK's `reconnectMcpServer`. A new `query()` (fresh subprocess
> + fresh handshakes) only happens on slash-command abort, query error, or container respawn. Also:
> config (`container.json`) is memoized at process start — a config change needs a respawn regardless.
> Two corollary findings: (1) SDK v0.2.116 **discards** the claude subprocess's stderr (spawned with
> stdio 'ignore' absent DEBUG_CLAUDE_AGENT_SDK) — the "MCP-connect chatter lands in
> container.stderr.log" claim in nanoclaw CLAUDE.md is stale; (2) the runner ignores the init
> message's `mcp_servers` statuses. Both fixed by the new `agent.mcp-servers` event (emitted from the
> init handler via the @@PATEVENT@@ sentinel) — which is also the empirical observable used by the
> e2e acceptance test.

### Step 1 — OneCLI vault REST client (host-side)
`nanoclaw/src/modules/credentials/onecli-vault.ts`. Raw `fetch` (the `@onecli-sh/sdk` has **no** secrets
API). Base `${ONECLI_URL}` + `Authorization: Bearer ${ONECLI_API_KEY}` (both from `src/config.ts:40-41`).
- `listSecrets(): Promise<VaultSecret[]>` — `GET /api/secrets`.
- `upsertSecret(spec): Promise<void>` — `POST /api/secrets` (create; check if update needs PUT/PATCH — the
  create-secret schema is `{name,type,value,hostPattern,pathPattern?,injectionConfig?}`; confirm update
  endpoint against the live gateway, else delete+recreate).
- `deleteSecret(name): Promise<void>`.
Model the curl shape on `scripts/seed-routing-from-vault.py` (proven). Non-fatal on network error (log).
**Acceptance:** unit-mockable; a live `listSecrets()` from the host returns the current entries (incl. exa).

### Step 2 — The two seams
`nanoclaw/src/modules/credentials/sources.ts`.
- `resolveVaultSecretSpec(route)` — inline impl per contract; `null` when `AGENT_<secret_name>` unset.
  Maps `route.{host_pattern,header_name,value_format,type}` → `{name:route.name, type, value, hostPattern,
  injectionConfig:{headerName,valueFormat}}`.
- `credentialAvailable(route)` — inline impl: `listSecrets()`, match `host_pattern`. (Confirm `/api/secrets`
  doesn't return the raw value; existence-by-host is the signal since we only create the vault entry when a
  real value exists — see Step 3.)
**Acceptance:** unit tests for both (env set/unset; host present/absent).

### Step 3 — Reconcile (routing → vault)
`nanoclaw/src/modules/credentials/reconcile.ts` → `reconcileCredentials({dryRun}): ReconcileSummary`.
- For each `listCredentialRoutes()` (from `src/db/credential-routing.ts`): `spec = resolveVaultSecretSpec`;
  non-null → `upsertSecret(spec)`; `route.deleted` → `deleteSecret(route.name)`; null spec → skip (count as
  "awaiting value").
- Emit `secrets.reconcile.summary` (created/updated/deleted/awaiting).
- Hook at boot in `src/index.ts` after `runMigrations(db)` (new step "1d"), **non-fatal** (log + continue;
  vault may be transiently down). Boot needs no restart (containers cold at boot).
**Acceptance:** dry-run prints intended changes; live run makes `/api/secrets` match the routing table.

### Step 4 — Affected-groups lookup + activate
`nanoclaw/src/modules/credentials/activation.ts`.
- `groupsUsingHost(hostPattern): string[]` — `getAllContainerConfigs()` (`src/db/container-configs.ts`),
  parse `mcp_servers`, return `agent_group_id`s whose http entry URL host matches `hostPattern`.
- `activateMcp(pending)` — write the MCP config entry from the stored payload via
  `updateContainerConfigJson(agentGroupId,'mcp_servers',…)`, then (per Step 0 result)
  `restartAgentGroupContainers(id,'mcp credential present',wakeMessage)` (`src/container-restart.ts`), notify.
**Acceptance:** given a routing row + a group referencing its host, `groupsUsingHost` finds it; `activateMcp`
writes config + restarts.

### Step 5 — Credential-gated activation flow
Migration `024-pat-pending-mcp-activation.ts`: table `pending_mcp_activation`
(`agent_group_id, name, payload JSON, host_pattern, secret_name, status, created_at, deadline`).
- **`applyAddMcpServer`** (`src/modules/self-mod/apply.ts`): if the MCP has `secret_name` **and**
  `!credentialAvailable(route)` → **enqueue pending + notify** ("add `AGENT_<X>`, I'll activate
  automatically"), **skip config-write + respawn**. Else → activate immediately (today's write+restart path).
- **Watcher** (host-side, `src/modules/credentials/watcher.ts`): on enqueue start a bounded poll
  (interval 3–5s, deadline ~5 min) of `credentialAvailable`; on present → `activateMcp` + mark done + notify
  (`mcp.activation.activated`); on deadline → mark timed-out + notify (`mcp.activation.timeout`).
- **host-sweep fallback** (`src/host-sweep.ts`): each 60s, re-check pending rows not done → activate. Catches
  keys added long after the deadline (and survives host restart — rehydrate from the table).
- Log kinds `mcp.activation.pending|activated|timeout` → add to `realtime/src/log-events.ts` +
  `transports/log_events.py` + `pat-frontend/src/types/log-events.ts`; run drift test
  (`cd transports && uv run python test_log_events_match.py`).
**Acceptance (trace-based, staging):** approve an MCP whose `AGENT_` key is absent → pending + notify, no
broken container; set the key → within a poll cycle the MCP activates and PAT can call it (verify in `patobs`).

### Step 6 — `ncl credentials` resource
`nanoclaw/src/cli/resources/credentials.ts` (register in `resources/index.ts`): `reconcile [--dry-run]`
(calls Step 3), `list` (routing rows + vault-presence). Mutating verb → `access:'approval'` per the ncl
safety model (reads `'open'`).
**Acceptance:** `ncl credentials reconcile --dry-run` shows the diff; `list` shows routing + presence.

### Step 7 (optional, security) — ANTHROPIC out of container env
Separate from MCP activation but same machinery: add an `anthropic` routing row so the key is vault-injected,
and strip `ANTHROPIC_API_KEY` from the container env (`src/container-runner.ts` env assembly;
`src/egress-lockdown.ts` is related). Only pull forward if is a priority now; else it rides op://.

---

## Deploy / verify (staging-only, prod untouched)
- Container-side changes (agent-runner) ship via deploy (bind-mounted src). Host changes (`src/`) need the
  image — a plain deploy handles both (`fly-entrypoint.sh` content-hashes + rebuilds).
- Deploy: `env -u FLY_API_TOKEN -u FLY_ACCESS_TOKEN flyctl deploy -c fly.nanoclaw.staging.toml --remote-only
  -a pat-nanoclaw-staging` from repo root. Run `bash scripts/check-submodule.sh` + bump the pin first.
- Verify via `patobs` (`secrets.reconcile.*`, `mcp.activation.*`, `agent.tool_result`).
- **Do NOT deploy to prod** without explicit review (credential paths + migration 024 on prod).
