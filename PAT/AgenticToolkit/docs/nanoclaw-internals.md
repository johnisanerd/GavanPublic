# NanoClaw submodule — the PAT view

`agentic_toolkit/nanoclaw/` is a soft-fork of
[qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw), wired into the
parent as a **git submodule** (gitlink). `.gitmodules` pins it to
`url = https://github.com/PalisadeResearch/nanoclaw-private.git`,
`branch = staging`. The submodule keeps its own standalone `.git` with **two
remotes** — `origin` = the private fork (`PalisadeResearch/nanoclaw-private`)
and `upstream` = `qwibitai/nanoclaw` — so the dual-git workflow below is
unchanged. The difference from a plain nested checkout: the parent repo now
**pins an exact nanoclaw commit** (the gitlink), and `nanoclaw/` is no longer
`.gitignore`d — it shows up in `git status` as a submodule whose recorded SHA
can lag on-disk HEAD.

For NanoClaw's own architecture, entity model, and key files, read
`../nanoclaw/CLAUDE.md` — it's authoritative. This document covers only the
PAT-side concerns of the submodule: layout, dual-git workflow, deploy
implications, upstream sync.

## Layout

```
agentic_toolkit/
  .git/                              <- parent repo
  .gitmodules                        <- pins nanoclaw commit (branch=staging)
  AGENTS.md, docs/, plans/, sprint/  <- parent-owned
  realtime/, transports/        <- parent-owned siblings of nanoclaw
  pat-frontend/, smoketest/          <- parent-owned siblings
  nanoclaw/                          <- git submodule (parent pins a commit)
    .git                             <- submodule (own .git; origin=fork, upstream=qwibitai)
    src/                             <- nanoclaw host (Node, pnpm)
    container/                       <- agent-runner (Bun, separate package tree)
    data/                            <- session DBs, logs (gitignored in nanoclaw)
    patches/                         <- pnpm patches (committed in nanoclaw)
    docs/                            <- nanoclaw's own docs
    CLAUDE.md                        <- nanoclaw's instructions (auto-loaded)
```

## Why a soft-fork and not a fork-fork

We're tracking upstream (qwibitai) closely. Every in-tree edit on the PAT
side is annotated with a `// PAT:` comment so we can grep our deltas
against upstream during sync. Sync is via the `/update-nanoclaw` skill (an
operational skill inside nanoclaw that knows how to merge in upstream
changes while preserving `// PAT:` edits).

For npm dependencies we don't fork — we use `pnpm patch <pkg>@<version>`,
which lands a diff in `nanoclaw/patches/` wired through
`pnpm-workspace.yaml`'s `patchedDependencies`. Patches survive
`pnpm install --frozen-lockfile` in container builds. The Dockerfile
**must** `COPY nanoclaw/patches` before `pnpm install --frozen-lockfile`
or the build fails.

## Dual-git workflow

Because the submodule has its own `.git`, you commit twice when a change
spans both repos — and the parent's second commit is the **pin bump** (the
`git add nanoclaw` that records the submodule's new HEAD as the gitlink):

```bash
# from agentic_toolkit/
git status                 # parent — sees realtime/, plans/, etc.; nanoclaw as a submodule gitlink

cd nanoclaw/
git status                 # submodule — sees src/, container/, patches/
git commit -m "..."
# git push   ← only when explicitly asked (private fork remote, origin/staging)

cd ..
git status                 # parent shows: modified: nanoclaw (new commits)
git add nanoclaw           # stage the bumped pin
git commit -m "..."        # parent commit, no push by default
```

Convention: **commit the nanoclaw submodule first**, then bump the pin in
the parent. That way the parent commit lands on a tree that records the
nanoclaw side already; the parent SHA points at a real nanoclaw HEAD, so
"what nanoclaw commit does this parent commit expect" is reproducible.

## Deploy: copy-the-working-tree, not git-archive

The Fly app `pat-nanoclaw` (staging: `pat-nanoclaw-staging`) is built from
`Dockerfile.nanoclaw` at the parent-repo root via the per-env tomls —
`flyctl deploy -c fly.nanoclaw.staging.toml` (staging) /
`-c fly.nanoclaw.toml` (prod). The build context **is the parent repo**, and
the Dockerfile `COPY`s the on-disk working tree (including the checked-out
`nanoclaw/` submodule) into the image. This is deliberate: it reads disk, not
the submodule's recorded commit, so a dirty or unbumped tree still deploys
what's on disk — you can ship local edits without first pushing to the fork
or bumping the pin.

Implication: **if you forget to commit a nanoclaw edit, the deploy still
ships it** (from the working tree) but the source of truth for "what
version is on Fly" is now your local disk, not any git remote. To keep the
parent SHA a faithful record: commit in `nanoclaw/`, then **bump the pin**
(`git add nanoclaw && git commit` in the parent), and run
`bash scripts/check-submodule.sh` before deploying — it warns if nanoclaw is
dirty, the pin lags on-disk HEAD, or you've drifted from `origin/staging`.
The check is about traceability, not blocking the deploy (which reads disk
regardless).

## Things the parent repo owns vs the submodule owns

| Path | Owner |
|---|---|
| `nanoclaw/src/`, `nanoclaw/container/`, `nanoclaw/scripts/` | submodule |
| `nanoclaw/patches/` (pnpm patches) | submodule |
| `nanoclaw/CLAUDE.md`, `nanoclaw/docs/` | submodule |
| `Dockerfile.nanoclaw` (at parent root) | parent |
| `fly.nanoclaw.toml` + `fly.nanoclaw.staging.toml` (per-env) | parent |
| `scripts/fly-entrypoint.sh` (sets up `.env`, OneCLI vault) | parent |
| `realtime/`, `transports/`, `pat-frontend/` | parent |
| `docs/`, `plans/`, `sprint/`, `AGENTS.md`, `BUGS.md` | parent |

The Dockerfile lives at the parent root so it can `COPY` both the submodule
(`nanoclaw/`) and the parent-owned siblings (`realtime/`) into the same
image — the host process depends on both.

## Pitfalls

- **`git pull` inside `nanoclaw/` while at v2 head**: the v2-vs-v1 banner
  at the top of `nanoclaw/CLAUDE.md` exists because pulling upstream into
  an older install corrupts the checkout. Read that banner before any
  upstream sync.
- **`pnpm install` from inside `nanoclaw/`** runs against the submodule's
  `pnpm-workspace.yaml`; **`pnpm install` from `nanoclaw/container/agent-runner/`**
  is wrong — that tree is Bun-managed (`bun install`).
- **Skipping the commit, deploying anyway**: `fly deploy` succeeds because
  the build context is the working tree, but you'll have no git pointer
  for "what shipped." Always commit nanoclaw before deploy if you care
  about traceability.
- **Editing `node_modules/`** instead of using `pnpm patch`: never. The
  edit gets overwritten on next install and won't survive the container
  build.

## Local-dev gotchas (Mac + Colima + OneCLI)

Each of these cost real debugging when running nanoclaw locally.

- **Colima only bind-mounts `$HOME`** — not `/tmp` or `/var/folders/`. The
  OneCLI SDK writes its combined CA bundle under `os.tmpdir()` (macOS →
  `/var/folders/…/T/`), which the Colima VM can't see, so Docker silently
  creates an *empty directory* at the container CA path and Node fetch rejects
  every `api.anthropic.com` call (`SELF_SIGNED_CERT_IN_CHAIN`). Fixed in-tree:
  `container-runner.ts` redirects `TMPDIR` to `$HOME/.cache/nanoclaw/onecli`
  around `onecli.applyContainerConfig()` (`// PAT:`; no-op on Linux).
- **Claude Code is Node — `SSL_CERT_FILE`/`DENO_CERT` don't apply.** The OneCLI
  SDK sets only those and mounts the CA at `/tmp/onecli-combined-ca.pem`; Node
  honors only `NODE_EXTRA_CA_CERTS`. `container-runner.ts` pushes
  `-e NODE_EXTRA_CA_CERTS=/tmp/onecli-combined-ca.pem` (`// PAT:`); without it
  claude-code aborts "Self-signed certificate detected" (re-verified true in
  `@onecli-sh/sdk` 2.2.1).
- **`tsx` doesn't auto-load `.env`.** `pnpm run dev` (= `tsx src/index.ts`)
  inherits shell env but never reads `.env`, so host-side keys (e.g.
  `ANTHROPIC_API_KEY` for the front-mind Haiku) silently miss. Source `.env`
  first, or use the wrapper.
- **Stale children hold port 8765.** dev spawns tsx + esbuild + node; killing
  the parent doesn't cascade → next launch `EADDRINUSE`. Also
  `data/circuit-breaker.json` escalates a "startup not clean" backoff toward
  ~15min after force-kills.
- **`scripts/nanoclaw-dev.sh`** codifies the host-side items (sources `.env`,
  reaps `:8765`/tsx/esbuild PIDs, clears the circuit-breaker). Idempotent.
- **OneCLI**: daemon `curl -fsSL https://onecli.sh/install | sh` (ports
  10254/10255/5432, all 127.0.0.1); CLI `…/cli/install | sh`; point the CLI at
  the local daemon with `onecli config set api-host http://127.0.0.1:10254` +
  add `ONECLI_URL=…` to `.env`. Dashboard UI at `http://127.0.0.1:10254`.
- **OneCLI secret types**: `anthropic` (native injection) and `generic` (needs
  `--header-name`, usually `--value-format 'Bearer {value}'`; X-API-Key vendors
  like Cartesia omit the value-format). **Auto-created agents start in
  `selective` secret mode** → run
  `onecli agents set-secret-mode --id <agent-group-id> --mode all`, else the
  proxy won't inject despite the vault holding the key + host-pattern.

## Runtime internals (host process)

### Fly secrets → `.env` bridge

`src/env.ts:readEnvFile` reads `/app/nanoclaw/.env` **from disk by design** —
this keeps secrets out of the per-session containers `container-runner.ts`
spawns (they never inherit host secrets). `flyctl secrets` land in `process.env`
only, so they don't satisfy `readEnvFile`. `nanoclaw/scripts/fly-entrypoint.sh`
§3.5 regenerates `/app/nanoclaw/.env` on **every boot** from an allowlist
(`SECRET_KEYS`), chmod 600 (chown 1000 later so the node user can read it).
**Add any new channel's token var to `SECRET_KEYS`** or the channel factory
silently no-ops on prod (Signal did exactly this). Distinct from OneCLI — these
are host-adapter creds, not agent-tool creds.

### outbound.db / inbound.db polling (the "firehose")

The host learns of new rows by **polling SQLite, not push** — deliberate,
because the two DBs are bind-mounted host↔container and WAL's mmapped `-shm`
doesn't refresh across the mount. Three load-bearing invariants
(`session-manager.ts`): `journal_mode=DELETE`; host **opens-writes-closes per
op** (close invalidates the container's page cache); **one writer per file**.
This rules out `update_hook` / WAL-notify. `src/delivery.ts` polls running
sessions every `ACTIVE_POLL_MS` (now **25ms** — the old 1000ms "1s floor" is
gone) and sweeps idle ones every `SWEEP_POLL_MS = 60_000`. PAT impact: mid-task
narration latency tracks the active-poll cadence, not a push signal — and the
front-mind Haiku covers the immediate-reflex gap regardless. (For an
already-running container, the agent-runner's follow-up poller pushes pending
inbound at its own tick.)
