# Deploy CLI — a self-guiding, SHA-pinned deploy tool

Status: **DEFERRED (2026-06-30).** Superseded for the near term by the streamlined
`plans/deployment-and-credentials.md` (submodule + credential routing — the high-value core
without this stateful state-machine). Kept as the heavier future vision (gates, `.deploys/`,
agentic smoke) for if/when deploy automation + PAT self-mod justify it.

## Context

Tonight's prod promotion exposed the deploy footgun class: `flyctl deploy` reads the **local working tree** (not reproducible), the Clerk `--build-arg` was omitted → a keyless client shipped (blank login), plus the usual `.internal`/`.flycast` + bun/pnpm traps. Deploys are manual `flyctl` across ~4 app-families spanning 2 repos, with the procedure living in operators'/agents' heads (which evaporates on compaction).

**Goal:** a deploy tool that *is the runbook* — a fresh agent who knows nothing except "this CLI exists" can run it and be walked through a correct, reproducible deploy by the tool's own gates and error messages. It's also the seam for Pat self-mod later (an MCP wrapper over the same gates) — **self-mod is out of scope for v1**, but the design keeps that seam clean.

## Design principles

- **The tool is the runbook.** The procedure lives in the tool's gates + self-guiding error messages, in *one place* — not scattered across AGENTS.md / memory / agent context. Survives compaction. Every gate failure must be **specific + actionable** ("SHA not on `main`; push/merge then re-run") — that craft is what makes it amnesiac-proof.
- **SHA-pinned, not working-tree.** You deploy an *exact commit*. The working tree is the only dirty input; `flyctl --remote-only` already builds clean, so pinning the SHA is the real reproducibility fix.
- **Stateful via `.deploys/<id>.json` (local = source of truth).** Read-after-write consistent, zero dependencies, drives the state machine. **Also** fire-and-forget emit `deploy.*` events to the observability store as a *projection* (queryable history via `patobs`) — but the tool never *depends* on reading the store (ingest latency + availability make it a bad primary).
- **Deliberate progression.** `deploy continue <id>` advances one gate at a time — a conscious "I did the thing, proceed" (forcing function), resumable, and amnesiac-recoverable via `status`/`list`.
- **No staging→prod pipeline.** Each env is an independent target with the same gates. Prod is deliberate because you *explicitly* invoke `env=prod` (optional one-line confirm), not because of any cross-env coupling.

## CLI surface

```
deploy start    <app> <env> <sha>   → mint <id>, run gates, stop at first blocker (with the actionable msg)
deploy continue <id>                → attempt the next gate/action; clear → advance
deploy status   <id>                → current state + EXACT next action   (the amnesiac re-orient)
deploy list                         → recent deploys + their states
deploy rollback <id>                → flyctl releases rollback (recovery; records a reason)
```

## State machine (symmetric for staging + prod)

```
CREATED → BRANCH_OK → CREDS_OK → DEPLOYED → SMOKE_OK → DONE
terminals: BUILD_FAILED · SMOKE_FAILED (→ rollback) · ROLLED_BACK · ABANDONED
```

## The gates

1. **BRANCH (deterministic).** The SHA is on the env's branch (`staging`→`staging`, `prod`→`main`). Block: "SHA <x> not on `main` (prod deploys from main). Push/merge, then re-run."

2. **CREDS (agentic diff-check — NO manifest).** The tool knows the currently-deployed SHA (from the last successful `.deploys` record for `(app,env)`) and emits:
   > "Deployed = `<deployedSha>`, new = `<newSha>`. Diff them and confirm any NEW creds are shipped: `git diff <deployedSha>..<newSha>` — watch for new `process.env.*` / `ARG` / `import.meta.env.*` / `mcpServers` keys / vault hosts; ensure they're set as Fly secrets / build-args / vault entries."
   - You read the diff, verify, then `deploy continue <id>` = your **attestation** "checked, creds up."
   - **Optional grep-sharpener:** the tool runs the diff + greps for cred-shaped additions and presents a *candidate list* (explicitly **non-exhaustive** — catches static `process.env`/`ARG`/`import.meta.env`/`mcpServers`, misses dynamic/indirect/transitive/MCP-key needs). It shrinks how often you reach a failed smoke; it is **not** the gate.
   - Coverage is **layered**: grep hint → you read the diff → **smoke is the backstop** (a genuinely-missing cred → broken behavior → smoke fails → rollback). Reliability comes from the smoke, not the grep. (A real per-app manifest is the tighter alternative if this ever proves too loose — deliberately deferred given the smoke backstop.)

3. **DEPLOY (action, atomic).** Clean SHA checkout → splice (parent ⊕ nanoclaw) → `flyctl deploy --remote-only` with the app's toml + build-args. Build-args are **derived from the Dockerfile `ARG` lines** (the Dockerfile *is* the build-arg manifest — zero drift). On success → `DEPLOYED` (live); on failure → `BUILD_FAILED` with the error. Note: Fly has no staging slot — the new version is **live before smoke runs**, so a failed prod smoke means a brief live-broken window → rollback. (Optional future refinement: split build→release for a pre-cutover pause; default is the single atomic deploy.)

4. **SMOKE (agentic).** `DEPLOYED` → `SMOKE_PENDING`: the tool reports the smoke recipe; **you** inject a synthetic message, read the observability store, and *judge* health (interpret the kind-sequence + anything anomalous — not a brittle assert). `continue` records the verdict → `SMOKE_OK`, or `SMOKE_FAILED` → offers `deploy rollback <id>`.

## Per-app registry

The tool's knowledge, per app: `{ toml, dir, env→branch, buildArgs (derived from Dockerfile ARG) }`.
Apps (×staging variants): **pat-nanoclaw** (needs the parent⊕nanoclaw splice), **pat-web**, **pat-transports**, **pat-frontend**.

## The splice

`pat-nanoclaw`'s build context = parent ⊕ nested `nanoclaw/` (separate git repos). Start simple: `deploy start <app> <env> <parent-sha> [--nanoclaw-sha <sha>]`, defaulting nanoclaw to its env-branch tip. **Upgrade path: make `nanoclaw` a git submodule** so one parent SHA pins both repos (fully reproducible; the rollback unit for self-mod later) — its own small hardening step, not a v1 blocker.

## Scope

- **One tool**, living in the parent `agentic_toolkit` (the deploy driver — owns the tomls + the splice). Not duplicated per-repo.
- **Two repos spanned:** `agentic_toolkit` (→ pat-web/transports/frontend) + nested `nanoclaw` (→ pat-nanoclaw).
- **~4 app-families** (×2 staging).
- **Out of scope (v1):** the `pat-observability` stack (separate local-only repo, off-the-shelf image); the **MCP wrapper** for self-mod (the seam — same gates, agent-callable, gated).

## Build phasing (implementation order — by value/de-risk)

1. **Skeleton + reproducible build.** CLI (`start/continue/status/list`), `.deploys/<id>.json` state machine, per-app registry, **BRANCH gate** + **DEPLOY** (clean SHA checkout → splice → `flyctl --remote-only` + build-args). Kills the working-tree + wrong-flags/build-args class day one. Validate on staging first; trust for prod once proven. (CREDS = warn-stub, SMOKE = manual here.)
2. **CREDS gate** — the agentic diff-check (deployed-SHA lookup + diff instruction + `continue` attestation) + optional grep-sharpener.
3. **SMOKE gate** — `SMOKE_PENDING` state + the agentic smoke handoff + rollback path.
4. **Store projection** — fire-and-forget `deploy.*` events keyed by deploy-id → deploy history queryable via `patobs`. Additive; local stays source-of-truth.
5. **(Later) MCP wrapper** — same gates, agent-callable → the self-mod seam.

## Open decisions

- **Execution host:** local clean-checkout deploy tool (simplest now, laptop-bound) vs. always-on runner / GitHub Actions `workflow_dispatch` (needed eventually for Pat self-mod). Build the tool/flow host-agnostic; start local.
- **Splice mechanism:** clone-both-at-refs (v1) vs. nanoclaw-as-submodule (one SHA pins both — the clean end state).
