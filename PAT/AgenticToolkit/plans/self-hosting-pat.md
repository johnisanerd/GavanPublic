# Self-Hosting PAT for Voice/Slack-Driven Development

> **Status: agreed.** First concrete user of the persistent-workspaces
> substrate. Load-bearing prereq is the bash-cancellation fix in
> `BUGS.md`. Not yet broken into waves; sits behind the current multi-agent
> feature buildout.

> **The deeper primitive is** [persistent-workspaces.md](./persistent-workspaces.md):
> per-channel cwds where the SDK's auto-memory and CLAUDE.md and
> `--resume` already provide most of what we need. Self-hosting is one
> instance — the workspace's cwd is `agentic_toolkit/`. The same primitive
> serves the user's blog, research notes, or any other repo.
>
> Pairs with [outbound-callback-and-resume.md](./outbound-callback-and-resume.md) —
> the dev loop benefits enormously from being able to restart nanoclaw without
> dropping the call you're using to drive it. Read all three together;
> workspaces is the substrate, callback is the UX glue, self-hosting is
> the first user.

## Headline summary

The headline path is **clone-on-spawn into `additionalMounts`, dev mode flag on
the agent group, separate `pat-dev` Fly app**. NanoClaw v2 already has every
primitive we need: per-session containers (`container-runner.ts:106`),
`additionalMounts` allowlist that lands hostPaths under `/workspace/extra/<name>`
(`modules/mount-security/index.ts:334`), trust gates on `install_packages` /
`add_mcp_server` only (`modules/self-mod/`), three Slack admins wired
(`PAT_OWNER_PHONES`-equivalent for Slack), and Claude Agent SDK runs on Bun in
the back-mind. The container already has `git` and `claude-code` itself.
**Toolchain gaps to close**: `pnpm` reachable for `node` user, `flyctl`, `gh`,
GitHub PAT + Fly token routing through OneCLI vault. **Load-bearing
prerequisite**: the bash-cancellation 5-edit fix in `BUGS.md` — without it,
"never mind, stop the install" is impossible. **Most surprising finding**: the
back-mind container has **no concept of an "agent's own source tree"** —
`/workspace/agent` is the agent group's working directory (notes,
conversations), not a code checkout. The agent today literally has no path to
read `realtime/src/log-events.ts`. Self-hosting is a workspace-bootstrap
problem, not a permissions problem.

---

## 1. Context

PAT today runs Opus 4.7 inside a per-session Bun container that the user
reaches via voice (Cartesia → voice-transport → nanoclaw → `docker run`) or
Slack (chat-sdk-bridge webhook → nanoclaw → same container). The container runs
Claude Agent SDK headless and writes structured detail rows to `outbound.db`
for the front-mind narration brain to consume. **The technology to run an
agentic dev loop already exists end-to-end.** What's missing is wiring: the
back-mind has no source tree mounted, no `flyctl`/`gh`/`pnpm`, no notion of
"this is your codebase, here are PRs," and the trust gate would fire on every
`pnpm install`. Closing those gaps unlocks "talk to PAT, watch it ship." Voice
is for steering and status; Slack is for actual code work (paste, code blocks,
threading, scrollback). Both ride the same back-mind.

---

## 2. Current state audit

### What works today (cited)

- **Per-session container spawn**: `nanoclaw/src/container-runner.ts:106`
  (`spawnContainer`) with mounts at `/workspace`, `/workspace/agent`,
  `/app/src` (agent-runner code, RO).
- **`additionalMounts` machinery**: `nanoclaw/src/container-config.ts:37`,
  validated via `nanoclaw/src/modules/mount-security/index.ts:192-334` (lands
  at `/workspace/extra/<name>`). Requires an allowlist at
  `~/.config/nanoclaw/mount-allowlist.json`; default-blocked patterns in
  `DEFAULT_BLOCKED_PATTERNS` include `.env`, `id_rsa`, etc.
  (`mount-security/index.ts:39-57`). **This is the right hook for mounting
  the repo.**
- **Approval primitive**: `nanoclaw/src/modules/approvals/primitive.ts:164`
  (`requestApproval`). Today only `install_packages` and `add_mcp_server` use
  it (`modules/self-mod/request.ts:20,66`). The handler registry is
  general-purpose (`primitive.ts:57`).
- **Admin gating** for slash commands: `nanoclaw/src/command-gate.ts:38`
  covers only `/clear /compact /context /cost /files`. The Bash tool itself is
  **not** behind the trust gate today — the SDK is invoked with
  `permissionMode: 'auto'` and `allowDangerouslySkipPermissions: true`
  (`container/agent-runner/src/providers/claude.ts:418-419`).
- **OneCLI for tool secrets**: `container-runner.ts:475-487` injects
  `HTTPS_PROXY` + `NODE_EXTRA_CA_CERTS` so back-mind API calls route through
  the agent vault.
- **Owner auto-elevation by phone**: `modules/permissions/realtime-owners.ts`
  reads `PAT_OWNER_PHONES`. Same pattern would work for `PAT_OWNER_SLACK_IDS`.
- **Slack adapter wired**: `nanoclaw/src/channels/slack.ts:11` via
  `@chat-adapter/slack`, threaded posting + DMs supported
  (`supportsThreads: true`).
- **Persistent dockerd state on Fly**: `Dockerfile.nanoclaw:88` sets
  `data-root: /data/docker`, so per-agent-group images survive deploys
  (`fly.nanoclaw.toml:37`).

### What's missing (cited)

- **No source mount of `agentic_toolkit/`**.
  `container-runner.ts:262-355` (`buildMounts`) mounts: session DBs, `agent`
  group folder, `/app/src` agent-runner (RO), `/app/skills` (RO),
  `/home/node/.claude` (RW), `/app/CLAUDE.md` (RO). Nothing covers the actual
  PAT codebase.
- **No `pnpm` reachable for `node` user in the agent container**.
  `nanoclaw/container/Dockerfile:94-99` enables `corepack` + installs
  Vercel/agent-browser/claude-code globally via `pnpm install -g`, but `pnpm`
  itself isn't on PATH for `node` user invocations — `corepack` is enabled at
  root and `PNPM_HOME=/pnpm` is set, so it's reachable, but never tested for
  agent use.
- **No `flyctl`, no `gh`** — neither is in the Dockerfile.
- **No GitHub PAT or Fly token routing**. `PAT_OWNER_PHONES`-style env-var
  bridging in `nanoclaw/scripts/fly-entrypoint.sh` (per memory
  `reference_pat_nanoclaw_env_bridge.md`) covers Slack/Discord/admin tokens
  but no dev-tool tokens.
- **No "trusted workspace" concept**. The trust gate today is binary
  per-action (`install_packages` always gated regardless of whether you're in
  dev mode).
- **Bash cancellation broken** (`BUGS.md:149-219`). Five-file fix specced;
  not yet implemented. Without it, `pnpm install` runaways are uncancelable
  except by `killContainer` which nukes the whole back-mind session.
- **Self-modification chicken-and-egg**: `pat-nanoclaw` Fly app runs
  `min_machines_running = 1`, single-machine SQLite (`fly.nanoclaw.toml:64`).
  One bad deploy bricks the running agent.
- **No `IDENTITY.md`/`SOUL.md`-equivalent per agent group folder**. Per-group
  memory is `CLAUDE.local.md`, but there's no convention for "you are PAT
  working on PAT" framing — the back-mind today thinks it's a generic
  NanoClaw assistant per `nanoclaw/container/CLAUDE.md`.

---

## 3. Five subsystems to build/modify

### 3.1 Workspace bootstrap

> See [persistent-workspaces.md](./persistent-workspaces.md) for the
> generic primitive. This section is what's specific to self-hosting:
> the workspace's checkout is `agentic_toolkit/`, the channel binding is
> `#pat-dev` (or local-dev DM), and the SDK cwd is the repo root so
> `CLAUDE.md` → `@AGENTS.md` is read automatically.

**Recommendation**: Clone-on-spawn the `agentic_toolkit/` repo into the
per-agent-group folder once, mount via `additionalMounts` at
`/workspace/extra/agentic_toolkit`. Push back to feature branches via `gh`.
**Both local dev and Fly use the same path** because `additionalMounts` works
identically. **SDK reads `CLAUDE.md` and `~/.claude/projects/<cwd>/memory/`
for free** — no bespoke memory format here.

Concrete shape:

1. New agent group `pat-dev` created via existing flow
   (`scripts/init-first-agent.ts`).
2. First-spawn hook in `nanoclaw/src/group-init.ts` (`initGroupFilesystem`)
   does `git clone --branch main git@github.com:palisaderesearch/agentic_toolkit.git`
   into `groups/pat-dev/repo/` if missing.
3. `groups/pat-dev/container.json` adds:
   ```json
   "additionalMounts": [
     { "hostPath": "<groupDir>/repo", "containerPath": "agentic_toolkit", "readonly": false }
   ]
   ```
   The path validator at `mount-security/index.ts:200` rejects absolute
   container paths and prefixes with `/workspace/extra/` — clean.
4. Allowlist at `~/.config/nanoclaw/mount-allowlist.json` gets a single entry
   granting RW under `<groupDir>/repo`. (On Fly, `<groupDir>` is
   `/data/nanoclaw/groups/pat-dev/`; the allowlist file ships baked into the
   image or is generated by `fly-entrypoint.sh`.)

**Alternatives considered**:

- *Mount host repo directly* — works locally
  (`/Users/user/Projects/AgenticToolkit/agentic_toolkit`), fails on Fly because
  the host IS a Fly Machine. Asymmetric, breaks parity.
- *Thin client over SSH to user's laptop* — too brittle ("walking around the
  block" implies the laptop is closed).
- *Pre-populate `/workspace/agent` with the repo* — collides with existing
  agent-group memory semantics in `container/CLAUDE.md`. Keep `agent/` for
  notes/`CLAUDE.local.md`, separate path for code.

**Diffs back out**: agent runs `git push origin <branch>` from inside the
container. GitHub PAT injected via OneCLI vault (preferred) or `.env` bridge
(fallback).

**Scope**: medium. Needs `group-init.ts` clone hook, allowlist file
generation, and a documented path for first-time setup of the GitHub PAT.

### 3.2 Toolchain access

**Recommendation**: Extend `nanoclaw/container/Dockerfile` to install `flyctl`,
`gh`, ensure `pnpm` is reachable from `node` user. Use OneCLI vault for both
GitHub and Fly tokens.

Concrete shape:

1. `Dockerfile` add (around line 94, after corepack):
   ```
   RUN curl -L https://fly.io/install.sh | sh && \
       mv /root/.fly/bin/flyctl /usr/local/bin/flyctl
   RUN curl -fsSL https://github.com/cli/cli/releases/download/.../gh_linux_amd64.tar.gz | tar xz -C /usr/local
   ```
   Both pinned to exact versions, following the `CLAUDE_CODE_VERSION` ARG
   pattern at `Dockerfile:23-26`.
2. Update memory's allowlist of `SECRET_KEYS` in `fly-entrypoint.sh` (per
   `reference_pat_nanoclaw_env_bridge.md`) to include `GITHUB_TOKEN` and
   `FLY_API_TOKEN` if we go env-var route. **Preferred**: register them as
   OneCLI vault secrets matching `api.github.com` / `api.fly.io` host
   patterns, then no `.env` bridge needed and the proxy injects them per-call.
3. Verify `pnpm` works as `node` user: today `PNPM_HOME=/pnpm` is set globally
   (`Dockerfile:92-93`) so reachable, but corepack-managed `pnpm` may need
   `corepack prepare` per-user. Add a smoke step.

**Scope**: small. Image rebuild only.

### 3.3 Trust gates (approval-fatigue problem)

**Recommendation**: Add per-agent-group `trustLevel` field
(`standard` / `dev`) on the agent group. In `dev` mode, **whitelist** a
curated set of common dev commands (`pnpm install/build/test`,
`git commit/push`, `gh pr create`, `flyctl deploy`) at the SDK-tool level via
a custom `PreToolUse` hook in the Bash path. Keep
`install_packages`/`add_mcp_server` (which mutate the container image) gated
regardless. Add an explicit blocklist of genuinely-destructive commands.

Concrete shape:

1. New module `nanoclaw/src/modules/permissions/dev-mode.ts`:
   - `isDevTrusted(agentGroupId)` reads `agent_groups.trust_level` (new
     column, migration).
2. In `container/agent-runner/src/providers/claude.ts:224` (`preToolUseHook`):
   - If tool is `Bash` and group is dev-trusted, classify command via prefix
     list. Pass-through for whitelisted; gate via `requestApproval()` for
     blocklisted (see below); pass for everything else.
3. **Whitelisted prefixes** (don't even ack): `pnpm test`, `pnpm build`,
   `pnpm typecheck`, `pnpm install` (read package.json deltas), `git status`,
   `git diff`, `git log`, `git add`, `git commit`, `git fetch`,
   `git pull --ff-only`, `gh pr view`, `gh pr list`, `gh issue list`,
   `flyctl status`, `flyctl logs`, `tsc --noEmit`, `bun test`.
4. **Always-gated even in dev mode** (real approval card):
   - `git push --force` / `git push -f`
   - `flyctl deploy` (production app); `flyctl secrets unset/set` for prod
   - `flyctl machine destroy/restart -a pat-nanoclaw`
   - `rm -rf` outside `/workspace/extra/agentic_toolkit/`
   - `pnpm publish`, `npm publish`
   - Any `docker` command (we're in a container; this would target host
     dockerd)
   - `dropdb`, raw `sqlite3` writes against the central DB
5. The block/allow predicate is data-driven so it can evolve; lives in a
   JSON config in `groups/pat-dev/`.

**Alternatives**:

- *Wide-open dev mode* (no gates at all) — too dangerous; one bad
  `git push --force-with-lease origin main` ruins your week.
- *Per-tool-call confirmation* (every Bash gets approval) — exactly the
  fatigue problem we're avoiding.
- *Per-workspace trust at the SDK level* — Claude Agent SDK doesn't have
  this concept upstream; we'd be re-implementing.

**Scope**: medium. ~150 LOC, one DB migration, a JSON config schema, plus
tests against representative command lists.

### 3.4 Self-modification safety

**Recommendation**: Two-app model — `pat-nanoclaw-dev` (separate Fly app,
separate volume) for the dev loop; `pat-nanoclaw` (current prod) for live
calls. Local-first dev path stays viable for radical changes.

Concrete shape:

1. **New Fly app `pat-nanoclaw-dev`** mirroring `fly.nanoclaw.toml` with its
   own volume, its own image tag, no production phone number wired. Slack DM
   points to the dev app via a separate workspace (or a different bot user).
2. **Prod stays untouched** by the dev loop until the user explicitly says
   "deploy to prod" — at which point PAT runs
   `flyctl deploy -c fly.nanoclaw.toml -a pat-nanoclaw --remote-only` against
   the **prod** app config.
3. **Local-first dev path**: `scripts/nanoclaw-dev.sh` (already exists at
   `agentic_toolkit/scripts/nanoclaw-dev.sh`) handles the `pnpm run dev`
   loop. PAT-on-laptop talks to local nanoclaw on `127.0.0.1:8765`. Fast
   iteration without a Fly redeploy.
4. **Recovery story**: if `pat-nanoclaw-dev` bricks itself mid-edit, the user
   has two escape valves — (a) Slack DM to the prod bot ("undo the last
   commit on dev"), (b) `flyctl machine restart -a pat-nanoclaw-dev` from
   the laptop. The dev app's container runner uses the same
   image-tag-by-agent-group mechanism (`container-runner.ts:548`), so a bad
   self-edit only borks the per-group image, not the host image.
5. **Branch hygiene**: PAT works on feature branches by default. `main` is
   push-protected on GitHub (already standard). PR-based promotion to prod
   via `gh pr create --base main`.

**Alternatives**:

- *One app, blue/green deploy* — Fly supports it but adds operational
  complexity for marginal benefit. The dev loop's appetite for being "broken
  sometimes" is much higher than prod's.
- *Continuous staging* — auto-deploy `main` to staging on every push. Nice
  but slower feedback loop than the explicit-deploy model; defer.

**Scope**: medium-large. New Fly app (small), Slack bot user split
(small-medium — touches owner-allowlist), explicit deploy commands documented
(small).

### 3.5 Voice vs Slack ergonomics

**Voice-first commands** (route via front-mind classifier, not Opus):

- "what's the last test that failed?" → tail logs from session folder + read
  back via banter
- "what are you working on?" → read `git status` + current branch summary
- "go ahead" / "ship it" → confirms the most recent gated approval
- "stop" / "cancel that" / "never mind" → cancel-request kind (BUG.md fix)
- "what did you just edit?" → tail `git diff --stat`

These extend the front-mind classifier in `realtime/src/haiku.ts` (per
`BUGS.md:194-198`) to emit new intents beyond `banter|chat|cancel-request` —
add `status-check` with sub-types. Each routes to a host-side handler that
reads the session folder and replies via banter rendition without ever
forwarding to Opus.

**Slack** (already wired via `nanoclaw/src/channels/slack.ts:11`):

- Threaded posts already work (PAT's patch to `@chat-adapter/slack`).
- Add slash commands via the chat-sdk-bridge:
  - `/diff` → `git diff --stat HEAD`
  - `/test [name]` → `pnpm test [name]`, post output
  - `/branch <name>` → `git checkout -b <name>`
  - `/deploy` → triggers approval card for `flyctl deploy`
  - `/logs [N]` → tails last N events from `host-YYYY-MM-DD.jsonl`
- Slack-side admin allowlist mirrors `PAT_OWNER_PHONES` — three Slack
  admins are already wired per task brief.

**Dashboard surfaces** (`pat-frontend.fly.dev`):

- Live `pnpm test` output stream (a new SSE endpoint that pipes container
  stdout for the test process).
- Current branch + diff (`git status` snapshot).
- Deploy history (`flyctl releases list`).
- These are read-only views on existing structured logs — minimal new state.
  Add new `kind` values to `realtime/src/log-events.ts` (with Python mirror
  per AGENTS.md drift rule): `dev.test-result`, `dev.git-status`,
  `dev.deploy`.

**Scope**: small (voice classifier extension, ~30 LOC) + medium (Slack slash
commands wiring, ~100 LOC) + medium (frontend new views, similar to existing
dashboard).

### 3.6 Live-reload mid-call (asymmetric: front-mind yes, back-mind no)

The dev loop's killer UX would be **edit code while talking to PAT, hear
the change immediately, no call drop**. Achievable for one of the two
minds, infeasible for the other.

**Front-mind (host process) — plausible.** Each user turn calls
`frontMindOnUserTurn()` fresh; no persistent classifier state across
turns. voice-transport already SSE-reconnects with backoff
(`reference_voice_transport_quirks.md`). The Cartesia call itself is
voice-transport↔Cartesia and is untouched by a nanoclaw restart. Session
DBs survive on disk. The back-mind container keeps running — `docker run`
doesn't die when the host dies, the poll loop just keeps reading
`outbound.db`. So `tsx watch` → host restart → SSE reconnect → next user
turn classifies through the new code. Best case: invisible.

Worst case for front-mind: user just spoke, request-layer is mid-flight
(Sonnet ~3s), host restarts → that decision is lost, user's turn drops on
the floor. **Mitigation** (~50 LOC, generally hardening): write inbound
row *before* invoking request-layer with a "decision pending" flag; on
boot, replay any undecided rows.

**Back-mind (container process) — much harder, probably not worth
chasing.** SDK query is one long stream; Opus session state lives in the
SDK's process memory. Code at `/app/src` is mounted RO but Node only
loads modules once. Killing+respawning the container drops the active
task. You'd need either checkpointable SDK sessions (doesn't exist) or
upstream SDK live-reload support (doesn't exist). Don't pursue.

**The asymmetry is convenient.** Front-mind is where the *conversational*
behavior lives (banter prompts, classifier rules, narration cadence) —
exactly what you'd want to tweak while talking to PAT. Back-mind work
(actual coding) is naturally between-call anyway.

**For longer/destructive restarts** (Fly redeploy, container respawn,
crash) the right answer isn't live-reload, it's a graceful end-and-callback
via the [outbound-callback plan](./outbound-callback-and-resume.md). PAT
says "I'm restarting, calling you right back," ends the call, dials back
on boot with resume context.

**Scope**: small for front-mind hot reload (`tsx watch` is already
configured, ~50 LOC for inbound-row replay-on-boot resilience). Defer
until Phase 1 settles.

---

## 4. Phasing

### Phase 1 — MVP "talk to PAT, have it edit its own code" (≤2 days of focused work)

Prerequisite (load-bearing): **ship `BUGS.md` Bash cancellation fix first**.
Without it, none of this is usable.

Then:

1. Create `pat-dev` agent group, configured locally only (laptop-resident
   nanoclaw).
2. Add clone-on-spawn hook in `group-init.ts` for the agentic_toolkit repo.
3. Drop `additionalMounts` entry into `groups/pat-dev/container.json` and
   create `~/.config/nanoclaw/mount-allowlist.json` entry.
4. Pre-populate `groups/pat-dev/CLAUDE.local.md` with the "you are PAT,
   working on your own codebase" framing + project context slice from
   `AGENTS.md`.
5. Smoke-test: voice call → "PAT, read AGENTS.md and tell me what's in the
   operating rules section" → expect a real read.
6. Smoke-test 2: Slack DM → "PAT, run `pnpm test` in `realtime/`, paste
   results" → expect actual test output in thread.

No image rebuild, no Fly changes, no trust-gate work, no separate dev app.
Just enough to verify the bootstrap.

### Phase 2 — Production-grade ergonomics (1 week)

1. Toolchain in image: `flyctl`, `gh`, verified `pnpm` (Dockerfile edits,
   ARG-pinned versions).
2. `pat-nanoclaw-dev` Fly app (separate from prod).
3. Trust-gate `dev-mode.ts` module + DB migration + whitelist/blocklist
   config.
4. OneCLI vault entries for `GITHUB_TOKEN` and `FLY_API_TOKEN` with
   appropriate host patterns.
5. Slack admin allowlist for owner-elevation (mirror `PAT_OWNER_PHONES`).
6. Front-mind voice intent extensions (`status-check` with sub-types).
7. Slack slash commands `/diff /test /branch /logs /deploy`.
8. New log-event kinds for dev surfaces (`dev.*`), frontend dashboard rows.
9. **Outbound callback Phase 1 (Slack)** from
   [outbound-callback-and-resume.md](./outbound-callback-and-resume.md) —
   so a redeploy of `pat-nanoclaw-dev` mid-Slack-conversation auto-resumes
   instead of going silent. Cheap and proves the primitive.

### Phase 3 — Stretch (1+ week, defer until 1 and 2 settle)

- Parallel sessions: PAT works on two feature branches concurrently (uses
  NanoClaw's existing per-thread session model — `sprint/backlog.md:140-167`).
- Deploy history dashboard pane.
- Live `pnpm test --watch` view streamed to the dashboard.
- Auto-summarized sprint state into agent's session memory on each spawn (so
  PAT recalls "we shipped X yesterday, Y is in progress").
- Agent self-edits to its own front-mind code (not just back-mind) — much
  more dangerous, requires Phase 2's two-app model to be hardened.
- **Front-mind hot-reload mid-call** (section 3.6) plus **outbound callback
  Phase 2 (voice)** — together these make "edit and hear it instantly on
  the live call you're driving with" a reality, with graceful end+dial-back
  for the cases hot-reload can't cover.

---

## 5. Open questions

1. **GitHub PAT scope**: do we use a fine-grained PAT (repo-only) or a
   classic with broader scope? Fine-grained is cleaner but doesn't support
   all `gh` operations (some require classic). Worth verifying which `gh`
   calls PAT will actually make.
2. **Where does the secret bridge go**: OneCLI vault host-pattern matching
   for `api.github.com` and `api.fly.io` is the cleanest, but it's not
   verified that OneCLI's pattern matcher handles git's HTTPS-clone
   basic-auth flow (the credential helper expects token-as-password, not
   Bearer header). May need a fallback to plain `.env` for git/`gh` and
   OneCLI for `flyctl` API calls.
3. **Local laptop persona**: when PAT-on-laptop is editing code, does
   `pat-dev` agent group share the agentic_toolkit repo with the user's
   actual checkout? **Probably yes via direct mount of
   `~/Projects/AgenticToolkit/agentic_toolkit` rather than clone-on-spawn**, but
   only locally — Fly path stays clone-on-spawn. Worth a config flag rather
   than two code paths.
4. **Voice cancellation correlation**: when user says "cancel that," which
   task is "that"? The current 5-edit fix in `BUGS.md` cancels the entire
   SDK query. For the dev loop, that nukes the whole session. The `Task`
   subagent path in `sprint/backlog.md:255-291` is probably the right
   long-term answer but isn't ready.
5. **Test-running observability**: `pnpm test` output is gigabytes for
   full-tree runs; what's the right truncation policy for the back-mind's
   own consumption? (The `previewToolResult` head/tail at `claude.ts:36-72`
   is 5KB which is fine for dashboard but the back-mind needs more for
   actually parsing test failures.)
6. **`pnpm patch` workflow inside the container**: AGENTS.md mandates
   `pnpm patch` for npm-package edits. Will that survive being run from the
   container's filesystem with a different uid/gid mapping than the host's
   pnpm cache? Worth a smoke test before claiming the dev loop is "fully
   featured."
7. **Multi-session concurrency on dev app**: if PAT is editing files while a
   smoketest run is also editing the same agent-group folder, do they
   collide? The existing per-session SQLite isolation only covers
   `inbound.db`/`outbound.db`. Per-agent-group `groups/<folder>/` is shared.

---

## Critical Files for Implementation

- `nanoclaw/src/container-runner.ts` — mount construction
- `nanoclaw/src/modules/mount-security/index.ts` — `additionalMounts`
  validator
- `nanoclaw/container/Dockerfile` — toolchain installs
- `nanoclaw/container/agent-runner/src/providers/claude.ts` — preToolUseHook
- `nanoclaw/src/modules/approvals/primitive.ts` — approval registry
- `nanoclaw/src/group-init.ts` — clone-on-spawn hook
- `nanoclaw/scripts/fly-entrypoint.sh` — secret bridge
- `realtime/src/haiku.ts`, `realtime/src/router.ts` — voice intent extensions
- `nanoclaw/src/channels/slack.ts` — slash-command wiring
- `BUGS.md` — Bash cancellation prerequisite
