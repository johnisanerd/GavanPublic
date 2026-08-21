# agentic_toolkit — Project Guidelines

Generic engineering conventions (sprint workflow, commit messages, structured
logging, smokeskills, debugging discipline, etc.) live in the user-wide
`~/.claude/CLAUDE.md`, seeded from `~/Documents/AGENTS.portable.md`. This file
holds only what's **specific to PAT**.

## Mission

The Palisade Agentic Toolkit (PAT) is a real-time conversational interface layer on top of NanoClaw v2. The user-facing experience is a single agent with two cognitive modes — a fast front-mind for conversational reflex and a deliberate back-mind for actual work. Voice is the primary modality; avatar, real-time chat, and others ride the same realtime layer.

PAT serves **two purposes**, and they set different bars. **The internal tool is the current priority.**

- **Internal tool — the priority.** PAT is Palisade's own agentic assistant: reachable over Signal / Telegram / Slack / phone, with a people spine, roles & permissions, an admin dashboard, credential/MCP management, and self-serve onboarding. The bar is **leverage** — does it make people's work easier, faster, better; does it give the team superpowers? Reliability and correctness are the *floor* (people depend on it — which is why we *surface* raw infra errors to chat rather than hide them), not the point.
- **External demo — where we started.** PAT as a live voice + avatar demo for senator/policy audiences. The bar is **emotional impact** — *is this thing alive?*, decided in the first ~10 seconds; latency (30–50ms wins compound), presence, and avatar realism all serve that perception, and request/response framing is wrong for it.

Both ride the same substrate (NanoClaw + the realtime front/back-mind + channels). When a decision trades one bar for the other, say which purpose you're optimizing for.

The spec is `docs/front-mind-design.md`. It supersedes prior PAT implementations.

**Start with `docs/INDEX.md`** if you're new to the repo — it routes to the
right doc in under a minute. Other entry points: `docs/forensics.md` (pipeline
map, "where do I look when X breaks"), `docs/log-schema.md` (structured-log
wire format + `/admin/logs.*` endpoints + jq recipes), `docs/nanoclaw-internals.md`
(submodule layout + dual-git workflow + deploy implications).

`KNOWN_ISSUES.md` is the maintained live-issues tracker — check it for current
bugs/limitations. (`BUGS.md` is a stale 2026-05-12 snapshot being archived; don't
treat it as the live bug list.)

**After a context compaction**, the project re-read set is: the files you're
about to touch, `sprint/current.md`, `KNOWN_ISSUES.md`, and the relevant `docs/`.

## Layout

```
agentic_toolkit/
  nanoclaw/         # git submodule — nanoclaw-private fork (upstream=qwibitai), branch=staging
  realtime/         # front-mind library (TypeScript)
  transports/       # External-provider bridges (Cartesia voice + signal-cli daemon, Python/native)
  pat-frontend/     # observability + admin dashboard (Clerk-OAuth react-router)
  pat-web/          # avatar (Anam) talk webapp
  smoketest/        # E2E scenarios
  scripts/          # ops tooling (fly-call-log.py, pat-monitor.sh, ...)
  docs/             # design docs + INDEX.md (start there)
  plans/            # forward-looking, multi-wave plans
  sprint/           # week-by-week WIP tracking
```

`nanoclaw/` is a **git submodule** — it keeps its own standalone `.git` with both remotes (origin=`nanoclaw-private` fork, upstream=qwibitai), so the dual-git workflow is unchanged, but the parent repo pins an exact nanoclaw commit. After committing in `nanoclaw/`, bump the pin in the parent (`git add nanoclaw && git commit`), and run `bash scripts/check-submodule.sh` before deploying (see Deploying §0). All in-tree edits there are commented `// PAT:` for greppability. Upstream sync uses NanoClaw's `/update-nanoclaw` skill. For the dual-git workflow and deploy implications, see `docs/nanoclaw-internals.md`.

## Languages and runtimes

- **TypeScript** — `nanoclaw/`, `realtime/`. Node-runtime in NanoClaw's host process.
- **Python (uv)** — `transports/` only.

## People & identity

Inbound senders resolve to a canonical Person. Four central-DB tables: `people`,
`person_identifiers`, `person_users`, `person_roles` (migrations 019-021). The host CLI
`ncl` is the **single writer** — never write these tables directly (`ncl people`,
`ncl person-roles`). `person_roles` (admin|employee) is BUILT but NOT enforced —
pat-frontend still gates UI on the operator-email allowlist (`isOperatorEmail`). Auto-enroll
hook: `nanoclaw/src/modules/permissions/index.ts`; per-person memory: `personal-memory.ts`.
See `plans/admin-dashboard-and-people.md`.

## Sprint workflow — project deltas

Follows the global `sprint/` convention, with these deltas:

- Extra file: **`sprint/test-inventory.md`** — what's tested where, smoketest scenario catalog.
- Stories are short bullets, not full templates. When done, move `current.md` → `completed.md` with a one-line note on what shipped (file paths welcome).
- Multi-wave coordinated work lives in `plans/` with the parent plan tracking wave status; in-flight TaskList tasks (TaskCreate / TaskUpdate) are the source of truth for who owns what *right now*.
- Don't write per-day session journals — sprint files + the auto-memory at `~/.claude/projects/-Users-user-Projects-AgenticToolkit/memory/` cover that gap.
- Doc-archival delta: dangling `// see plans/X.md` refs to archived docs are acceptable — don't spend effort repointing them.

## Operating rules

### Investigating calls / forensics: centralized `patobs` FIRST, pat-trace for timelines, flyctl LAST
For ANY "what happened" / "what did the agent do" / "why did it X" question, **start with the centralized
observability store** — the `patobs` MCP (`query` / `schema` / `resolve_person`) or the `../pat-observability/scripts/patobs` CLI (sibling repo), which run
SQL over OpenObserve. It is the **canonical, aggregated** store: it holds structured events from **both prod AND
staging** (`env` column) with **full debug incl. `llm.call` prompt/response traces** — so it answers agent-reasoning
questions the per-instance proxy can't, and it's one query across envs. **Level knob (2026-07-03):** what ships is
whatever level each nanoclaw emits, set by the `LOG_LEVEL` Fly secret. Both prod AND staging now run `LOG_LEVEL=debug`,
so debug-level events incl. `llm.call` are present for both. (`llm.call` is realtime-only — the front-mind path.) If a
nanoclaw is flipped to `LOG_LEVEL=info`, its debug/`llm.call` stops reaching patobs (the forwarder ships the day-file
unfiltered, but `info` never writes debug to it) — that was the staging state until 2026-07-03. **⚠️ Debug suppression
poisons forensics retroactively:** absence of debug-level events (e.g. `back-mind.llm-call`) during an `info` window is
NOT evidence the thing didn't run — check the emit level and the `LOG_LEVEL` state for the window before concluding.

**⚠️ `since` is a hard scan window, not a hint — set it wide enough.** The `since` param (default **`1h`**) defines
OpenObserve's outer time-range and is **intersected** with your SQL `WHERE`; an explicit `_timestamp`/`ts` range in the
SQL **cannot widen the scan past `since`**. So a query for events older than `since` returns **0 rows even though the
data is there** — the same SQL yields 0 rows at `since:"60m"` and 17 rows at `since:"12h"`. **0 rows ≠ data gone.**
When targeting a specific `ts`, always pass a `since` that comfortably covers it. (Retention is **infinite** —
`data_retention:0` on both streams, persistent volume, no retention env; verified 2026-07-04. Data is NOT replicated
offsite though — single-node `ZO_LOCAL_MODE`; that's a backup/resilience gap, not a TTL.)

```
-- two streams: pat_events (structured nanoclaw, prod+staging) | pat_raw (raw stdout/stderr of pat-* apps)
SELECT ts, kind, source, level FROM pat_events WHERE env='staging' AND thread_id='<id>' ORDER BY _timestamp
SELECT * FROM pat_events WHERE kind='llm.call' AND session_id='<sess>'   -- the agent's actual prompt/response
SELECT timestamp,app,message FROM pat_raw WHERE app='pat-transports' AND message LIKE '%...%'  -- pat_raw has NO ts column
SELECT timestamp,app FROM pat_raw WHERE match_all('term')   -- full-text works on pat_raw (FTS keys set 2026-07-07); pat_events 400s by design
```
Use the `schema` tool if unsure of columns; nested `data.*` is flattened to `data_*`. The `/pat-logs` skill encodes the
full tiered procedure. When an agent loops/retries, pull `agent.tool_use` / `agent.tool_result` for the real error it's
reacting to.

**`scripts/pat-trace.py`** is the **rendered-timeline** view of ONE call — an interrupt-aware ASCII timeline
(overlap/orphan/gap markers, source-coded utterances, latency, tool/narration interleave). Reach for it when you want
that picture of a specific thread; it reads pat-frontend's proxy (set `PAT_FRONTEND=https://pat-frontend-staging.fly.dev`
for staging). It's a presentation layer, not the source of truth — `patobs` is.

`flyctl logs --no-tail` is a **last resort** — a rolling buffer with hours/days of unrelated history (has caused false
"user is on a call now" claims), past-retention drops, and hand-grepping. Use only when `patobs` is unreachable, or for
a non-PAT process whose stdout isn't shipped to `pat_raw`.

If you find yourself reaching for `flyctl logs | grep` or curling `/api/logs.jsonl` directly to answer a forensics
question, stop and use `patobs`.

### Naming: avoid "turn"
Avoid "turn" in PAT prompts, types, and design prose — it smuggles a strict-alternation assumption that doesn't fit PAT's realtime async multilayer reality. Say "message" / "user input", or the layer-specific name (`runBanterAck`). Leave vendor wire-format mirrors (Cartesia turn-boundary events, `*.turn-*` log-event kinds) alone.

### Deliver infra errors to chat (internal tool)
PAT is an internal tool — surfacing raw infra/agent errors in the chat channel is a feature, not a bug (immediate in-channel visibility for the operator; it's how the v2.1.19 breakage was diagnosed). Don't suppress them or swap in a generic non-leaking line. Add the structured event (`agent.query-error`) *alongside*, never instead.

### Direct edits over wrappers
This is a soft-fork of upstream nanoclaw, plus selectively-pinned npm dependencies. Prefer editing source directly over building wrapper / adapter / monkey-patch layers around it.

- **In-tree code (`nanoclaw/`, `realtime/`, `transports/`, etc.)**: edit the file. For nanoclaw specifically, mark every PAT-side change with a `// PAT:` comment for greppability against upstream sync.
- **npm packages in `node_modules/`**: don't edit in place — use `pnpm patch <pkg>@<version>`, edit the scaffold dir, `pnpm patch-commit <dir>`. The patch lands in `patches/` and is wired through `pnpm-workspace.yaml`'s `patchedDependencies`. Survives `pnpm install --frozen-lockfile` in container builds. Important: the Dockerfile must `COPY nanoclaw/patches` before `pnpm install --frozen-lockfile` or the build fails.
- **Wrapping vs editing**: wrappers around upstream code are a refactor smell here. They double the maintenance surface and obscure the actual behavior. If a single-line fix in upstream achieves the goal, edit upstream and document the why with a `// PAT:` (or for npm packages, a `// PAT:` comment in the patch).
- **Telemetry in vendored upstream**: strip it by deleting the call path (and telemetry-only helpers/imports) entirely — never rely on an env-var opt-out, which leaks on one forgotten var. Sweep `grep -rni "posthog|telemetry|analytics|distinct_id"` afterward.

### Subagents are always opus
Every Agent call for PAT work passes `model: "opus"` explicitly. No exceptions for "small" tasks. This includes `Explore`, `general-purpose`, and any specialized agent — the default-inherit behavior is not safe (an inherited sonnet/haiku subagent on a PAT problem will produce shallow diagnoses and miss subtle context that opus catches).

### Keep the dashboard DB reference in sync with the schema
`pat-frontend/src/lib/table-reference.ts` is a hand-maintained data dictionary (per-table summary + markdown long-form + per-column descriptions + doc links) powering the Database browser's tooltips and "?" reference modal. It is a **static lookup keyed by table/column name** — it does not introspect the live schema, so it goes stale silently when the schema changes (unknown tables/columns just degrade to no-tooltip / a disabled "?", so nothing breaks, but the reference quietly stops covering them).

Update it whenever you add/rename/drop a table or column. **ESPECIALLY after a nanoclaw upstream sync / upgrade** (`/update-nanoclaw`): upstream migrations routinely add or reshape tables, and that's the most likely moment for the reference to drift out of date. After any nanoclaw upgrade, diff the migrations and reconcile `table-reference.ts` (re-verify entries against the new code, and confirm any doc URLs still resolve — don't invent them). Plain language, minimal jargon, each entry self-contained.

## Deploying (Fly)

PAT runs on **Fly** (org `<redacted-fly-org>`), not Railway — there is **no git
auto-deploy**. `flyctl deploy` builds from the **working tree on disk**, not a git ref, and
the build context splices the parent repo together with the nested `nanoclaw/` submodule.

0. **`nanoclaw/` is a git submodule** (`.gitmodules`, branch=staging). It keeps its own
   standalone `.git` + both remotes (origin=fork, upstream=qwibitai), so the dual-git workflow
   is unchanged — but the parent pins an exact nanoclaw commit. After committing in `nanoclaw/`,
   **bump the pin**: `git add nanoclaw && git commit` in the parent. Run `bash scripts/check-submodule.sh`
   before deploying — it warns if nanoclaw is dirty, the pin lags on-disk HEAD, or you've drifted
   from `origin/staging`. (The deploy still reads disk, so a dirty/unbumped tree *deploys* fine —
   the check is about keeping the SHA a faithful record.)
1. **Commit + push both repos first** (parent *and* `nanoclaw/`), then bump the parent pin. The
   deploy reads disk, but pushing + bumping keeps one parent SHA a faithful, reproducible record
   of what's running.
2. **Deploy with the per-app/env toml.** Always prefix with
   `env -u FLY_API_TOKEN -u FLY_ACCESS_TOKEN` (a stray token scopes flyctl to one prod app).

   | App | Env | From | Command |
   |-----|-----|------|---------|
   | nanoclaw | staging | repo root | `flyctl deploy -c fly.nanoclaw.staging.toml --remote-only -a pat-nanoclaw-staging` |
   | nanoclaw | prod | repo root | `flyctl deploy -c fly.nanoclaw.toml --remote-only -a pat-nanoclaw` |
   | web | staging/prod | repo root | `flyctl deploy -c fly.web.staging.toml --remote-only -a pat-web-staging` |
   | transports / frontend | — | **their own dir** (`cd transports` / `cd pat-frontend`) | `flyctl deploy -c fly.staging.toml --remote-only -a <app>` |

   ✅ **`pat-frontend` no longer needs a build-arg.** The Clerk publishable key is now a plain
   runtime Fly secret `PUBLIC_CLERK_PUBLISHABLE_KEY`, injected into the page at request time as
   `window.__PUBLIC_ENV__` by the Hono server (`server/public-env.ts`). A plain `flyctl deploy`
   ships a working client. Just ensure the secret is set:
   `flyctl secrets set PUBLIC_CLERK_PUBLISHABLE_KEY=pk_... -a pat-frontend[-staging]` (same
   `pk_test_…` for both today). `CLERK_SECRET_KEY` stays a server-side secret (`@clerk/hono`).
   The `pk_` value is public — recover it from a working bundle's env if lost:
   `flyctl ssh console -a pat-frontend-staging -C "printenv PUBLIC_CLERK_PUBLISHABLE_KEY"`.
   Any other browser-facing config follows the same `PUBLIC_<NAME>` → `window.__PUBLIC_ENV__.<NAME>`
   convention (see `plans/deployment-and-credentials.md`).

   **Tiered secret prefixes** *(LIVE on staging since 2026-07-03; prod renames at next promotion)*
   — three name-prefix tiers scope where a secret is allowed to flow:
   - `PUBLIC_<NAME>` — browser-safe, runtime-injected via `server/public-env.ts` → `window.__PUBLIC_ENV__`.
   - `HOST_<NAME>` — host-process env. The boot router (`nanoclaw/src/env-prefix-router.ts`,
     first import in `src/index.ts`) strips the prefix into `process.env`; the fly-entrypoint
     `.env` bridge writes canonical names for `readEnvFile` consumers. Code always reads
     canonical names.
   - `AGENT_<NAME>` — OneCLI vault egress; container env gets a `placeholder` only
     re-verified 2026-07-03). `AGENT_` routing comes from the DB `credential_routing` table
     (nanoclaw migration 023), not a committed file.

   `.env.remote.<env>` (gitignored) is the full off-box record; `scripts/secrets-push.sh`
   ships it (and refuses unprefixed keys). See `plans/deployment-and-credentials.md`.

3. **A plain `flyctl deploy` is now reliable for container-side changes too.**
   `nanoclaw/scripts/fly-entrypoint.sh` content-hashes the `container/` build context and
   auto-rebuilds the agent-runner image on change. The old "manual `docker rmi` +
   `bash container/build.sh` on the VM" dance is **superseded** — don't do it.
4. **Secrets**: `flyctl secrets set KEY=val -a <app>` (restarts the machine). Avoid `--stage`
   — it's sticky and not auto-applied by a later deploy.
5. **Prod is the live demo system.** Treat prod deploys/restarts as consequential; after one,
   verify the OneCLI gateway is healthy on `0.0.0.0` and the host came back up.

## Tests

PAT's interesting behavioral tests:

- Front-mind interrupt while back-mind is mid-think
- Multi-event burst → bounded queue eviction → most-recent narration wins
- State rebuild after process restart mid-conversation
- Banter ↔ chat classification under ambiguous input
- End-to-end voice with Cartesia Line + cloudflared + a real phone call (later goal)

Unit tests are fine for `narration.ts` cadence math and `state.ts` log-fold determinism. Don't over-test glue.

### Smoke testing (project wiring) — AGENTIC-FIRST

Two layers, with an explicit hierarchy (operator directive 2026-07-04):

- **Interactive smokeskill — the primary mechanism.** `.claude/skills/pat-smoke-interactive/`
  (drive with `smoke-chat`, inspect with `smoke-trace`, both in `smoketest/`). One continuous
  session, heavy back-references. The agent drives, listens, and judges — closed-loop.
- **Scripted smoke checks — liveness canaries ONLY.** `smoketest/` scenarios are "open-loop
  smokes": deterministic, context-isolated, no judgment in the loop. For VOICE especially,
  keep at most 1-2 (C1 = "does it respond at all") and put everything beyond that in the
  smokeskill. Do not grow the deterministic voice suite — when tempted to add a scripted
  voice scenario, add a smokeskill step (+ any missing primitive, e.g. say /
  wait-for-next-utterance) instead.

### Driving the avatar webapp without an acoustic loop (`simUserSay`)

`pat-web` ships a dev-only TTS injector that replaces the page's mic input
with synthesized speech via Cartesia REST — so console-driven and headless
test rigs don't need the speakers→mic acoustic loop. Use it instead of
macOS `say` for any new test harness; reach for `say` only when you
specifically need to exercise the browser's AEC/NS/AGC chain.

**Enable** by appending `?simUserSay=1` to any pat-web URL (the install
is gated on that query flag and runs before the Anam SDK calls
`getUserMedia`).

**Use** from the browser console:

```js
simUserSay("hey PAT, what's the weather")
simUserSay("...", { voiceId, model, sampleRate })   // per-call override
```

First call prompts for a Cartesia API key + voice id and stashes both in
`localStorage` (`simUserSayCartesiaKey`, `simUserSayVoiceId`). The
returned promise resolves when the synthesized audio finishes playing,
so test scripts can `await simUserSay(...)` and chain.

The injector never touches the camera — if some code path requests
`{audio, video}` it satisfies the audio with the fake mic and logs a
warning instead of opening the webcam.

**Still applies:** the avatar mic mute toggle gates `track.enabled`, so
unmute in the UI before the synthesized audio will actually reach Anam.
Same misdiagnosis trap as `say`-based loops.

**Fidelity caveats:** the audio bypasses Chrome's AEC/NS/AGC chain, has
no breath / silence preamble, and is upsampled from 16kHz to the
AudioContext rate (48kHz on Mac). VAD / endpointing may fire a touch
faster than with a real human. Real enough for conversation-flow QA and
latency smoke tests; not a substitute for human-on-the-line testing
before a senator demo.

Source: `pat-web/src/lib/sim-user-say.ts`.

## Logging — project wiring

Every PAT process emits structured JSONL via `log.event(...)` (TypeScript)
or `_emit_structured(...)` (Python). Schema source of truth:
`realtime/src/log-events.ts`. Mirrors in `transports/log_events.py`
(drift test enforced) and `pat-frontend/src/types/log-events.ts`.

- Don't add a new `kind` without declaring it in `realtime/src/log-events.ts`
  AND the Python mirror. The drift test will fail otherwise.
- Don't read `data.field` without first checking `.kind` — the schema is
  per-kind.

For wire format, endpoint reference, auth, jq recipes, and "how do I reach
nanoclaw from here" — see `docs/log-schema.md`.

## External references

- NanoClaw v2 source: `https://github.com/qwibitai/nanoclaw`
- Cartesia Line SDK docs: https://docs.cartesia.ai/line/sdk/overview
- Local secrets (gitignored): `.env.agent` at repo root (`FLY_API_TOKEN` + vendor keys like Cartesia agent IDs; any Railway tokens are legacy — PAT runs on Fly).
