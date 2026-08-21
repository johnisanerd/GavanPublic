# MCP Management

Status: **design (2026-06-30), decisions locked.** Depends on the credential model in
`plans/deployment-and-credentials.md` (Pillar B) for keys.

## Why

Adding an MCP server to PAT should be **easy for a user**, not a dev chore. And we want it to move between
staging and prod safely. The good news: most of the machinery already exists — we mostly need a **promotion script**.

The reframe (locked):
- **CLI tools** (`vercel`, `agent-browser`, stdio-MCP *binaries*) = **"a dev adds it"** → they're binaries, must be
  in the image (`cli-tools.json` + rebuild). Fine — a dev task. **Unchanged**, and it's the escape hatch for the rare
  stdio-only MCP.
- **MCPs** = **"a user adds it"** → remote-first (no binary) → pure wiring → **the existing DB path.**

Verified most MCPs we'd add have **remote/streamable-HTTP** endpoints (firecrawl has a hosted MCP — *and accepts our
key*; apify is already HTTP; Google Workspace has a remote MCP). Remote ⇒ no `cli-tools.json`, no rebuild.

## Adding an MCP — use what already exists

`add_mcp_server` (the agent self-mod tool) and `ncl groups config add-mcp-server` already write
`container_configs.mcp_servers` (per-group, runtime, no rebuild). So the **add UX is:**

1. **Ask PAT to add it** (it calls `add_mcp_server`) — or `ncl`. Writes the per-group DB entry. Done for the wiring.
2. **Put the key in 1Password, named correctly** (`AGENT_<CANONICAL_NAME>`) → injected at the MCP's host by the vault.
3. **New vendor only:** a one-time dev step to add the host/header **routing row to the DB** (canonical name →
   hostPattern/header/format); boot reconciles it into the vault. Value comes from the `AGENT_<name>` secret / 1Password.
   For an *already-routed* vendor, step 1+2 is the whole thing.

**No new tables, no new scopes.** Keep the existing **per-group `container_configs.mcp_servers` JSON blob** (there's
effectively one group, `palisade-internal`, so per-group ≈ global). **No `global` scope, no `person` scope yet.**
Soft-delete = a **`deleted: true` tombstone field on the JSON entry** (no schema change) — needed so the promote can
*see* a deletion and warn instead of silently dropping it.

## Credential-gated activation (the reboot question, solved) — 2026-07-01

The end of the add flow has a timing problem: an MCP that needs a credential the operator hasn't
added yet will 401 at its handshake. This section is the design for **when/whether to restart** so
the handshake succeeds. It rests on facts established 2026-07-01 (see `sprint/backlog.md` TOP item):

- **OneCLI injects per outbound request** (values resolved live; `op://` refs resolved at runtime,
  60s in-memory cache). So a **rotated/changed value needs NO restart** — the next tool call picks it up.
- **The only reboot that matters is the container's MCP-client handshake**, which runs once at spawn.
  A handshake that 401s (credential absent) makes the client **abandon that server for the container's
  life** — live injection can't help because nothing is calling a dead server; only a fresh spawn
  re-attempts the handshake.
- **Neither OneCLI nor 1Password exposes an add/change event** (both verified 2026-07-01: OneCLI has
  no events/webhook/stream endpoint; 1P has no item-create webhook, only a Business-tier pull-only
  Events API that can't even distinguish create from edit). **We don't need one** — credential
  *existence* is checkable locally and cheaply, without touching the source service.

**Source-free existence check:**
- **Inline (today):** `GET http://127.0.0.1:10254/api/secrets` — a local OneCLI Postgres read on the
  same VM, lists secrets by `hostPattern`. **Zero downstream hit;** confirmed live. Polling every 1s
  costs nothing (localhost).
- **op:// (future):** `items.list` on the vault via the 1P SDK using a **read-only** `OP_SERVICE_ACCOUNT_TOKEN`
  — check the item *exists* by title/id, **never `items.get`** (don't decrypt the value; PAT must not
  handle the raw key — see policy note below). Hits **1Password** (the credential store, built for
  automation reads), **never** the source API. (A OneCLI test-resolve endpoint, if one exists, folds
  in; behind the queued op:// test.)

**Policy — intake is out of band (2026-07-01):** the operator adds keys directly in the 1Password app;
PAT never intakes a raw key. So the **watch-poll is the correct model** — we *detect* the out-of-band
add, we don't *cause* it. The "be-the-writer" alternative (PAT writes the 1P item → know instantly, no
poll) is **rejected** because it requires PAT to handle the key. Read-only SA only. See
[[feedback_discourage_sharing_keys_with_pat]] / `plans/onecli-1password-vault.md` banner.

**Design — split the add into `request → watch → activate`:**
1. **Request (on approve):** record a *pending activation*; **do NOT write the live MCP config or
   respawn.** Warm containers stay untouched — no broken-MCP window. Notify the user: *"Approved. Add
   credential `AGENT_<X>` / `op://…` and I'll switch it on automatically."*
2. **Watch:** a **bounded local poll** (1–5s, few-minute cap) of the source-free existence check.
3. **Activate (on present):** write the MCP config + `restartAgentGroupContainers` → the handshake
   runs *with the credential present* → succeeds first try. Notify the user: *"<name> is live."*
4. **Timeout:** notify + hand off to the 60s `host-sweep` as a slow fallback (or a one-line `ncl`
   retry). No orphaned pending state.

**Why this shape:** removes the ordering constraint entirely (approve first, add the key whenever;
auto-activates; no re-approval); the **single reboot is timed to credential-presence** so it always
succeeds and never wastes a respawn on a 401; the poll is local/cheap/bounded (it *gates one action*),
not the "lame" standing remote poll we ruled out.

**Free path (no watcher needed):** an `AGENT_<X>` **Fly secret** → `flyctl secrets set` **restarts the
host machine** → boot-reconcile writes the vault entry before containers respawn → live on boot. The
watcher earns its keep for the **direct-vault-add** and **op:// item-add** paths (interactive
"operator drops the key," no host restart).

**Presence ≠ validity:** this confirms the key *exists*, not that it's *correct* (validating would hit
the source service — the thing we're avoiding). A wrong key surfaces as a post-activation 401 **in
chat** (per "deliver infra errors to chat"), and the operator fixes the value.

**⚠️ Load-bearing assumption — verify before building the restart branch:** that the MCP client does
**not** retry a failed-handshake server mid-session (standard MCP-over-HTTP behavior). If it *does*
self-heal, the activate-restart — and possibly the whole watch loop — is unnecessary; a late key would
just be picked up within the retry interval + 60s. Cheap staging test; run it first.

**Implementation sketch (staging-first):**
- **Pending record** — `pending_mcp_activation` (small table, or reuse pending state): `agent_group_id`,
  server `name`, the full apply `payload` (transport/url/headers), `host_pattern`, `secret_name`/`op_ref`,
  `created_at`, `deadline`.
- **`applyAddMcpServer`** (`self-mod/apply.ts`) — branch: if the MCP has a `secret_name`/`op_ref` **and**
  the credential isn't present yet → enqueue pending + notify (skip config-write + respawn); else
  activate immediately (already present, or no credential needed — today's behavior).
- **Watcher** (host-side) — started on enqueue; 1–5s interval until present or `deadline`. On present →
  activate (`updateContainerConfigJson` + `restartAgentGroupContainers(id, 'mcp credential present',
  wakeMessage)`, both exist) + notify. On deadline → notify + register with `host-sweep`.
- **`credentialPresentForHost(host_pattern)`** — inline: `GET /api/secrets`, match `hostPattern` (and
  reject the placeholder). op:// variant later, behind the queued test.
- Emit structured events for the lifecycle (`mcp.activation.pending` / `.activated` / `.timeout`) —
  new kinds in `realtime/src/log-events.ts` + mirrors (drift test).

## Staging ↔ prod promotion (the one new thing to build)

A `promote` over **DB state only** (routing now lives in the DB too — see `plans/deployment-and-credentials.md` — so
there's a single promote path and no dependency on `onecli secrets list`):
- **MCP entries** — `container_configs.mcp_servers`, matched by the **stable `folder`** (not the random
  `agent_group_id`; `getAgentGroupByFolder("palisade-internal")` exists). Tombstone-aware.
- **Credential routing rows** — the install-wide routing table (canonical name → hostPattern/header/format/type).
  Promoted the same way. Each box's boot reconciles its own vault from these rows; **the vault is never read or written
  by the promote.** Values are not copied (they come from `AGENT_*` secrets / 1Password by name).

Cross-machine note: staging and prod DBs live on different Fly VMs, so the promote runs from the laptop and reaches each
DB via `flyctl ssh` + `scripts/q.ts`, then triggers `ncl groups restart` on the far side so the change materializes.

Semantics: **bidirectional** (staging↔prod either way), **additive by default** (new entries apply), **warns +
requires confirmation on any update or delete** (never silently clobber/drop — honors "don't lose data"; shows the
diff first).

## Phases
0. **http transport for `add_mcp_server`** (the gap found in recon) — the MCP tool (`self-mod.ts`) and the CLI
   (`groups.ts config add-mcp-server`) are **stdio-only** today; the type + runtime merge already support
   `transport:'http'`. Without this, "ask PAT to add a *remote* MCP" can't work. Smallest, unblocks the add-UX.
1. **The `promote` script** — DB MCP entries (folder-matched, tombstone-aware) **+** credential routing rows. DB-only,
   over `flyctl ssh`+`scripts/q.ts`, then `ncl groups restart`. Additive, warn-on-update/delete, bidirectional. No
   `onecli` dependency.
2. **Soft-delete tombstone** in the `mcp_servers` JSON + teach `add_mcp_server`/materialize to honor it.
3. **Remote-first** — flip firecrawl stdio→hosted MCP (drop its `cli-tools.json` line; confirm with one curl that the
   hosted endpoint takes our key); document remote-first; keep stdio + `cli-tools.json` as the dev escape hatch.
4. **(later)** per-person MCPs — only if/when needed; would add a person scope dimension then, not now.
5. **Credential-gated activation** — see the section above. **Test first** (does the MCP client retry a
   failed handshake?), then: `pending_mcp_activation` + `applyAddMcpServer` present-check branch +
   host-side bounded watcher (`credentialPresentForHost` over local `/api/secrets`) + activate/notify +
   sweep fallback + lifecycle log kinds. Replaces the backlog "credential-add → restart" item, which is
   reshaped by OneCLI's runtime `op://` resolution.

## Open questions
- **Routing-table shape** — new install-wide table vs a singleton config blob in `v2.db`. Boot reconciles vault from it
  (vault REST upsert via the `ONECLI_API_KEY` bearer — confirmed working). Belongs to the credentials plan; the promote
  just moves the rows.
- **gmail/gcal remote auth** — the remote Google Workspace MCP does its own OAuth; reconcile with our OneCLI-OAuth
  setup if/when we move them off the stdio stub pattern.
- **Non-dev "add" UX** — `ncl` needs dev creds; "ask PAT" covers the agent path; a dashboard action could come later.
