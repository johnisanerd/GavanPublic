# Deployment + Credentials

Status: **design (2026-06-30), decisions locked.** Streamlined — the heavier stateful deploy-CLI
(`plans/deploy-cli.md`) is **deferred**. Two pillars: deploys **reproducible** (submodule) and
credentials **one prefix-routed model**.

## Why

Tonight's prod promotion exposed the whole deploy-pain class at once:
- `flyctl deploy` ships the **local working tree** → an uncommitted edit / wrong branch / mismatched
  `nanoclaw/` sub-repo silently goes to prod.
- The **Clerk publishable key** was a build-arg that wasn't re-passed → a keyless client shipped (blank login).
- **Three unrelated credential mechanisms** (build-args / Fly secrets / OneCLI vault) to hold in your head,

Intent: **a deploy is fully determined by one commit, and a credential's *name* declares where it goes.**

---

## Pillar A — Reproducible deploys (submodule)

**Intent:** one SHA fully determines a deploy; never ship a dirty working tree.

- Make **`nanoclaw/` a git submodule** of the parent → the parent SHA *pins the exact nanoclaw commit*.
  "What nanoclaw shipped" becomes a reviewable pointer, not "whatever was on disk."
- Deploy from a **clean checkout of the SHA** (`git worktree` + `git submodule update`), not the working tree.
- **The bump:** submodules don't auto-follow — after committing in `nanoclaw/`, you make a small parent commit
  (`git add nanoclaw && commit`) that advances the recorded pointer. That commit *is* the bump; it's the workflow tax,
  and it's exactly what makes one parent SHA = one reproducible deploy + a clean rollback unit.
- **Staleness is explicit, never silent:** `git submodule status` shows the pin; `cd nanoclaw && git fetch &&
  git log HEAD..origin/<branch>` shows how far behind. To take latest: `git submodule update --remote` + bump.
  **The deploy should WARN if the pin ≠ the branch tip** ("deploying nanoclaw N commits behind"). (See the
  memory: *always check submodule status when deploying.*)

Small pillar, removes the biggest foot-gun, no deploy-CLI machinery.

---

## Pillar B — One credential model (prefix routing)

**Intent:** the **prefix declares trust tier + destination**, enforced by tooling. The prefix lives *only* in the
secret-name layer; the **router strips it** so tools see their canonical names.

| Prefix | Goes to | Reaches |
|---|---|---|
| `PUBLIC_` | client bundle (runtime-injected) | browser |
| `HOST_` | host process env | host/server only |
| `AGENT_` | OneCLI vault (egress injection); **stripped from container env** | agent — never held raw |

**Naming rule: `<TIER>_<CANONICAL_NAME>` — keep the full well-known name, don't shorten.**
`AGENT_ANTHROPIC_API_KEY` (not `AGENT_ANTHROPIC`), `HOST_CLERK_SECRET_KEY`, `PUBLIC_CLERK_PUBLISHABLE_KEY`.
The router strips the tier → the SDK still gets `ANTHROPIC_API_KEY`, the server still gets `CLERK_SECRET_KEY`,
the client global gets `CLERK_PUBLISHABLE_KEY`. Tools never see a renamed/shortened var — safest with defaults.

**Storage:** all three tiers are **Fly secrets** (incl. `PUBLIC_*` — public, but still a Fly secret; prefix decides
*routing*, not storage). Values are also expressible in **`.env.remote`** (gitignored), later swappable for
**1Password** (same names, fetched by name — convention unchanged).

**Routing lives in the DB (`v2.db`), NOT the vault and NOT a committed file.** A small install-wide routing table holds
per-credential `name` (canonical) → `hostPattern` + `headerName` + `valueFormat` + `type`. The DB is the declarative
source of truth; the **OneCLI vault is a derived runtime cache** that the boot router reconciles from the DB (the vault
still does the actual egress header-injection — only the *truth* moves to the DB). Why DB not vault: it rides the same
DB staging↔prod promote as MCP entries (one path), and removes the dependency on `onecli secrets list` (which we found
gated behind gateway auth). Values come from the `AGENT_<name>` secret; routing comes from the DB row, matched by name.

**Dual-use keys = just duplicate** — a key needed host-side *and* agent-side gets both `HOST_X` and `AGENT_X`
(same value, two entries). Simple, fine.

**Boot router** reads the `{PUBLIC,HOST,AGENT}_*` secrets, strips the prefix, routes:
- `PUBLIC_` → client injector (`window.__PUBLIC_ENV__`; pat-frontend — **done, Phase 1**).
- `HOST_` → **both** the `.env` file (for `readEnvFile` consumers like `ANTHROPIC_BASE_URL`) **and** the launched
  process env (for `process.env` consumers). This is also what lets config currently stuck as Fly secrets move to
  `fly.toml [env]` as `HOST_*` — the router is the `process.env`→`.env` bridge that `readEnvFile` needs.
- `AGENT_` → upsert the vault entry (value from the secret, **routing from the DB row matched by name**) + **strip from
  container env**.

**Concrete wins:**
- **Build-args eliminated.** Clerk publishable key → `PUBLIC_CLERK_PUBLISHABLE_KEY`, injected into the page at
  runtime by the (already-present) Hono server via a synchronous `<script>` in `<head>` (no async flash). The
  `VITE_` build-arg + `ARG` line are deleted; no more re-pass-every-deploy.
- **closed.** `ANTHROPIC_API_KEY` → `AGENT_ANTHROPIC_API_KEY` → vault (entry already exists for
  `api.anthropic.com`), placeholder in the container env, real key injected at egress → agent can't read it.
  (Verify on staging first: SDK Anthropic calls route through the gateway, and the placeholder passes any
  `sk-ant-…` format check.)

## Phases (rough order, by relief)
1. ✅ **`PUBLIC_` runtime injection** — Clerk build-arg killed; runtime-injected `window.__PUBLIC_ENV__`. **DONE + live on
   staging** (2026-06-30). Server `server/public-env.ts`; dev vite plugin; Dockerfile build-arg removed.
2. **Submodule + clean-SHA-checkout deploy** (+ the staleness warn).
3. **DB routing table + `AGENT_` → vault (derived) + strip from container env** — close this, starting with
   `ANTHROPIC_API_KEY`. First verify empirically whether the key is even exposed in a container today (in-tree code
   suggests it isn't — may be mostly placeholder-activation). Build the routing table; reconcile vault from it at boot.
4. **The `{PUBLIC,HOST,AGENT}_` router (additive)** — keep the existing `SECRET_KEYS` allowlist, add the prefix loop
   alongside (non-destructive; see `sprint/backlog.md` for the eventual big-bang cleanup). `HOST_` writes `.env`+process.
5. **(later) 1Password** as the value backend for the `AGENT_`/`HOST_` values (names unchanged).
