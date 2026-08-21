# Persistent Workspaces — Per-Channel Coding Desks

> **Status: agreed.** Substrate plan — `self-hosting-pat.md` is the first
> user, `outbound-callback-and-resume.md` is the UX glue. Not yet broken
> into waves; design is settled but implementation is downstream of the
> current multi-agent feature buildout.

## The unlock

The conversational thread is the wrong unit of state. Today, every PAT
session spins up a fresh container with an empty `/workspace`, and when the
thread ends the work evaporates. The deeper primitive is a **persistent
workspace** that:

- lives independently of any single thread/call/session
- binds to a **channel** (Slack channel, DM, owner-elevated phone identity)
- accumulates code checkouts, agent memory, in-flight branches, scratch
  notes across many conversations
- is what a coding agent treats as "where I work" when it spawns into it

Once workspaces are first-class, self-hosting is just one instance: a
workspace whose checkout happens to be `agentic_toolkit/`. Helping the user
on their Hugo blog is another workspace. Pair-programming on a colleague's
repo is a third. Research notebooks with ad-hoc scripts and notes is a
fourth. Same primitive, four use cases.

This is the real architectural unlock — not self-hosting specifically.
[self-hosting-pat.md](./self-hosting-pat.md) and
[outbound-callback-and-resume.md](./outbound-callback-and-resume.md) both
become much cleaner once this exists.

## Leverage existing Claude Agent SDK primitives — don't reinvent

The SDK already provides almost every piece of "persistent per-cwd agent
memory." Our job is to **bind channels to cwds**, not to build a new
memory system. What's already there:

| Primitive | What it gives us | Source |
|---|---|---|
| `CLAUDE.md` at cwd | Project context, stable identity, `@filename` includes | SDK reads automatically when invoked at that cwd |
| `CLAUDE.local.md` | Gitignored per-checkout overrides | SDK reads automatically |
| Auto-memory at `~/.claude/projects/<cwd-hash>/memory/` | Persistent per-cwd memory: `MEMORY.md` index + freeform `*.md` files (user/feedback/project/reference). Already in active use for *this* repo (40+ files at `~/.claude/projects/-Users-user-Projects-WebCode/memory/`). | SDK auto-loads on every spawn at that cwd |
| Session transcripts at `~/.claude/projects/<cwd-hash>/<session-id>.jsonl` | Full conversation history, resumable | Created automatically; `claude --resume <id>` / `--continue` re-attaches |
| Hooks (PreToolUse, PostToolUse, SessionEnd, UserPromptSubmit) | Programmatic lifecycle taps | Configurable via SDK hooks API |
| Slash commands | First-class command surface | Already used (`/clear`, `/compact`); custom skills register here |
| Subagents | Launch isolated sub-contexts | Already exposed; useful for parallel exploration within a workspace |

**The translation**: a "workspace" in our plan is just a cwd. Persisting
state across threads in that workspace is what auto-memory already does.
"Resume after restart" is what `--resume` already does. We don't build any
of this — we just route channels to the right cwd before invoking the SDK.

What we **do** still need to build:

1. **Channel→cwd binding** (NanoClaw schema + router change) — SDK has no
   concept of "Slack channels" or "phone calls."
2. **Workspace registry with switch commands** (host-side handler + voice
   intent + slash command) — SDK has no concept of multiple cwds at once.
3. **Mount the workspace cwd into the container** (NanoClaw container-runner
   change, plus auto-memory dir mount-through so the host and container
   share memory).
4. **Cwd→memory path correlation** — auto-memory paths are derived from
   cwd via hashing; if container cwd is `/workspace/extra/agentic_toolkit`
   but host cwd is `/Users/user/Projects/AgenticToolkit/agentic_toolkit`,
   memory dirs diverge. Either symlink or set the path explicitly.
5. **`scratchpad.md` is gone from this plan** — we use the
   user/feedback/project/reference memory types the auto-memory system
   already standardizes.

## Example workspaces

| Workspace | Bound to | What's inside |
|---|---|---|
| `pat-dev` | Slack `#pat-dev` channel + owner phones in dev mode | `agentic_toolkit/` git clone, PAT's own `CLAUDE.md`, in-flight branches |
| `gavan-hugo-blog` | Slack DM with Gavan | `hugo-blog/` clone, blog-specific style notes, draft posts |
| `helping-mike` | Slack DM with Mike (when added as collaborator) | Mike's project clone, "what we're working on with Mike" memory |
| `research-2026-q2` | Slack channel `#research` | Ad-hoc Python scripts, notebooks, Markdown notes, no git |
| `default` | Owner phone (PSTN), no channel binding | A general-purpose scratch workspace for "PAT, just figure something out" |

A given channel can have multiple workspaces; switch via voice/slash command.
A given workspace lives until explicitly archived.

## Workspace as a first-class primitive

A workspace is just a **cwd** the SDK runs in, plus minimal metadata for
the channel-binding layer (which is NanoClaw's concern, not the SDK's).

The cwd contains whatever the project naturally holds:

```
<workspace-cwd>/
  CLAUDE.md             # SDK auto-loads — workspace identity + project context
  CLAUDE.local.md       # gitignored, SDK auto-loads — per-checkout overrides
  .git/                 # if it's a git repo (most workspaces will be)
  ...                   # the actual project files
```

And the SDK **automatically** maintains alongside, at
`~/.claude/projects/<encoded-cwd-path>/`:

```
~/.claude/projects/<encoded-cwd-path>/
  memory/               # auto-memory: MEMORY.md index + per-topic *.md
  <session-id>.jsonl    # resumable session transcripts
```

NanoClaw v2 already has `groups/<name>/` per agent group, with a folder
mounted at `/workspace/agent`. The changes are:

1. **Workspace ≠ agent group** (today they're conflated). An agent group is
   "who I am as an assistant"; a workspace is "what I'm working on."
2. **Multiple workspaces per agent group** (today one folder per group).
3. **Channel binding** is a new concept — `messaging_groups` get a
   `default_workspace_id` column.
4. **Workspace switching** at thread time — a thread can override the
   default workspace, and "switch workspace" is a recognized command.
5. **Auto-memory dir mount-through**: the back-mind container needs the
   host's `~/.claude/projects/<encoded-workspace-path>/memory/` mounted at
   the matching path inside the container. Either symlink or use the SDK's
   memory-path override (verify in §Open questions). This is what makes
   memory genuinely persistent across container respawns.

## Memory model — leveraging SDK-native primitives

Three layers of state, decreasing volatility, **all backed by mechanisms
the SDK already runs**:

### Per-thread

`outbound.db` and `inbound.db` rows. Conversation log, tool calls, results.
Lifetime: until thread is archived. **Already correct, NanoClaw concern.**

### Per-workspace auto-memory (SDK-native)

The SDK's auto-memory directory at `~/.claude/projects/<cwd-hash>/memory/`
is **exactly** what we need. The user's own auto-memory for the WebCode
project (40+ files at `~/.claude/projects/-Users-user-Projects-WebCode/memory/`
including `feedback_*`, `project_*`, `reference_*`) is what a future PAT
back-mind would read on spawn into that cwd.

Adopt the same conventions inside back-mind workspaces:

- `MEMORY.md` is an index, ≤200 lines, auto-loaded on every spawn
- Per-topic memory files with frontmatter: `feedback_*`, `project_*`,
  `reference_*`, `user_*`
- Updated by the agent (or via hook) when something durable happens —
  decisions made, conventions set, current-state snapshots

This is what survives across threads. "PAT, what were we working on?"
becomes "read MEMORY.md for the current workspace, summarize the
project_*currently-active* entry" — same as how Claude Code itself
already remembers prior sessions today.

### Workspace `CLAUDE.md` (also SDK-native)

The SDK auto-loads `CLAUDE.md` from cwd. We just write it. Example for
the `pat-dev` workspace (which would live at the agentic_toolkit/ repo
root and is in fact `agentic_toolkit/CLAUDE.md`, already present):

```md
@AGENTS.md
```

Done. The SDK reads, follows the include, gets the full project context.
No new mechanism required.

### Session resume across restart (SDK-native)

`claude --resume <session-id>` and `--continue` already exist for picking
up a prior conversation. NanoClaw's per-session container could persist
the SDK session ID alongside the workspace, and on respawn invoke
`--resume <id>` to restore the exact prior conversation context — Opus
state included, modulo whatever the SDK's resume actually preserves.

This sidesteps the "back-mind hot-reload is impossible" finding from
self-hosting §3.6 — we don't need hot-reload if **respawn picks up where
the prior session ended.** Worth verifying what `--resume` actually
preserves (full message history? cached tool results? just transcript?).

## Per-channel binding

Slack channels and DMs are natural workspace homes:

- **`#pat-dev` channel** → `pat-dev` workspace. Anyone in the channel
  contributing to PAT lands in the same workspace.
- **DM with user** → workspace named after user (or last-explicit-switch);
  defaults to `default` if never set.
- **Phone calls** → owner-elevated identity (`pstn:+E164`) maps to a
  preference table; defaults to `default`.

Implementation: `messaging_groups` table grows `default_workspace_id`. The
session-resolution path in `nanoclaw/src/router.ts` reads it when no
override is present.

## Workspace switching

Mid-conversation:

- **Voice**: "PAT, switch to the blog" → front-mind classifier emits
  `switch-workspace` intent (extends `realtime/src/haiku.ts`); handler
  updates the thread's active workspace and posts a banter ack ("on it,
  switching to the blog"). Next user turn spawns a container into the new
  workspace.
- **Slack**: `/workspace blog` slash command. Or `@PAT switch to blog`
  natural language.
- **Implicit**: posting in a channel with a default workspace just uses
  that workspace. No command needed for the common case.

Switch carries no migration of in-flight work — each workspace is its own
filesystem. Switching mid-tool-call should warn ("you're mid-`pnpm install`
in pat-dev, finish or cancel first?").

## Mapping onto NanoClaw v2 primitives

Most pieces are already there, just need re-shaping:

| New concept | Existing primitive | Change required |
|---|---|---|
| Workspace folder | `groups/<id>/` + `additionalMounts` | Allow multiple per agent group |
| Workspace mount | `additionalMounts` allowlist (`mount-security/index.ts:334`) | Workspace cwd is the standard mount |
| Channel binding | `messaging_groups` table | New `default_workspace_id` column |
| Workspace switch | `router.ts` session resolution | Honor thread-level override |
| Identity / project context | `CLAUDE.md` at cwd | **SDK auto-loads — zero new code** |
| Persistent agent memory | `~/.claude/projects/<cwd>/memory/` | **SDK auto-loads — mount-through to container** |
| Session continuity across restart | `claude --resume <id>` | **SDK feature — store last session id, replay on respawn** |
| Tokens (git/fly/etc.) | OneCLI vault | Per-workspace credential namespace |

The biggest single piece is the **multiple-workspaces-per-agent-group**
decoupling. Today an agent group's folder *is* the agent's workspace.
Splitting them is a small DB migration and a router change.

**Three of the five rows above** (CLAUDE.md, auto-memory, session resume)
are zero-implementation — we just route the SDK's cwd correctly and
mount the right host paths into the container. The remaining work is
NanoClaw plumbing (channel binding, switching, multiple-per-group), which
is the part the SDK genuinely cannot do for us.

## Workspace lifecycle

- **Create**: voice/slack command "PAT, new workspace for the Hugo blog,
  clone https://github.com/me/hugo-blog into it." Front-mind routes to a
  host-side handler; clone-on-create. No back-mind container needed.
- **List**: "PAT, what workspaces do I have?" → reads workspace registry,
  reads each `scratchpad.md` ## Now line, summarizes.
- **Archive**: workspaces aren't auto-deleted. Explicit
  "archive the helping-mike workspace" command moves it to `groups/.archived/`
  to keep the registry clean. Reversible.
- **Delete**: only on explicit "delete the X workspace, I'm sure." Gated
  through the approval primitive (`modules/approvals/primitive.ts`).

## Phasing

### Phase 1 — Single workspace per agent group, SDK-native memory (~3 days)

Goal: prove that the auto-memory system works for back-mind across thread
boundaries. Almost zero new mechanism — we're just plumbing existing SDK
behavior.

1. **Set the back-mind cwd** to the workspace path before invoking the
   SDK in `container/agent-runner/src/providers/claude.ts`. Today cwd is
   `/workspace/agent`; for `pat-dev` it'd be
   `/workspace/extra/agentic_toolkit`. Single config-driven change.
2. **Mount the auto-memory directory through**: host's
   `~/.claude/projects/<encoded-workspace>/memory/` → container's
   `/home/node/.claude/projects/<encoded-workspace>/memory/`. NanoClaw
   already mounts `/home/node/.claude` (`container-runner.ts:262-355`);
   verify the project sub-path is preserved or symlinked correctly.
3. **Persist the SDK session id** alongside the workspace and pass
   `--resume <id>` (or `--continue` for the most recent) on respawn.
   This is what makes "same conversation across container restarts"
   real. Verify what `--resume` actually preserves before claiming
   anything.
4. **Workspace-level `CLAUDE.md`** already exists in the repo
   (`agentic_toolkit/CLAUDE.md` → `@AGENTS.md`). Verify it's read when
   cwd is the repo root.
5. Smoke: thread A says "we agreed to use foo over bar." Thread B (next
   day, same workspace) — agent reads the auto-memory it wrote in A,
   knows the convention, doesn't ask again.

Zero new memory format invented. Zero parallel scratchpad system. The
existing 40+ memory files at the user's WebCode auto-memory dir are the
template — back-mind would write the same shape, and the same `MEMORY.md`
index would be exhaustive on every spawn.

### Phase 2 — Multiple workspaces, channel binding (~1 week)

1. DB migration: workspaces table with `(id, name, agent_group_id,
   git_remote)`. `messaging_groups.default_workspace_id` foreign key.
2. Router honors workspace selection; container spawn passes workspace path
   as the mount.
3. Slash command `/workspace <name>` and voice `switch-workspace` intent.
4. Workspace creation flow ("PAT, new workspace for X, clone Y").
5. Smoke: switch between two workspaces in a single Slack channel; verify
   the agent loads different CLAUDE.md and scratchpad.

### Phase 3 — Polish (~1 week, deferred)

1. **PostToolUse / SessionEnd hooks** (SDK-native — no new mechanism) to
   prompt the agent to write a memory entry after significant work
   (commit, deploy, decision). The auto-memory system already has
   conventions for the four memory kinds (user/feedback/project/reference);
   the agent applies them.
2. Workspace listing command with summaries pulled from each
   `MEMORY.md`'s most recent `project_*` entries.
3. Workspace archive/delete flows.
4. Cross-workspace search ("PAT, did we ever look at X in any workspace?")
   via grep across active workspaces' memory dirs.
5. Per-workspace credential namespace (separate GitHub PAT for blog vs
   PAT itself) — needs OneCLI extension.

## Interaction with adjacent plans

### vs [self-hosting-pat.md](./self-hosting-pat.md)

Self-hosting becomes "create a workspace named `pat-dev`, clone
`agentic_toolkit/` into it, bind to Slack `#pat-dev`." Everything in the
self-hosting plan's §3.1 (Workspace bootstrap) collapses into "use the
generic workspace mechanism."

### vs [outbound-callback-and-resume.md](./outbound-callback-and-resume.md)

Resume context becomes much richer. Today's "summarize last 3 outbound
rows" becomes "read scratchpad's ## Now section." The agent can resume
**across** thread boundaries — yesterday's work continues today, even if
the thread is fresh.

### vs back-mind hot-reload (covered as infeasible in self-hosting §3.6)

Workspaces *plus* the SDK's `--resume` sidestep most of why hot-reload
mattered. If state survives restart on disk (auto-memory) and the SDK's
session is genuinely resumable, you don't need to keep the in-process
Opus session alive — spawn a new container, `--resume <id>` from the
same workspace cwd, the agent picks up. The seam between "current call"
and "next call" becomes thin. (Pending verification of what `--resume`
preserves; flagged in Open questions.)

## Open questions

1. **What does `claude --resume` actually preserve?** Full message
   history is documented; less clear whether tool-result caches and SDK
   internal state survive. Read SDK source (`@anthropic-ai/claude-code`
   in `node_modules/`) or test empirically. If `--resume` is "replay
   transcript into a fresh model context" it's good enough for our use
   case; if it's "rehydrate exact session state including pending tool
   calls" that's even better but probably not essential.
2. **Auto-memory cwd hashing**: SDK derives the project dir from cwd via
   a hash/encoding (the user's is `-Users-user-Projects-WebCode`,
   which is path-with-slashes-replaced). Verify the encoding rule, then
   either symlink container path → host hashed dir, or pass an explicit
   project-root override if the SDK supports one.
3. **Workspace identity vs agent identity**: today the agent's identity
   (PAT name, voice persona) is per-agent-group via `CLAUDE.local.md`.
   Workspaces are per-project. Does PAT change voice when working on the
   user's blog vs working on itself? Probably no — PAT stays PAT. So
   identity is agent-group-scoped, *project context* is workspace-scoped.
2. **Concurrent threads in same workspace**: two phone calls active at
   once, both targeting `pat-dev`. Filesystem collisions on `repo/`?
   Per-thread checkout copies are heavy; per-thread feature branches with
   `git worktree` is cleaner. Worth a look.
3. **Which file does the scratchpad live in vs `CLAUDE.md`?** Tempting to
   merge them, but `CLAUDE.md` is intent-of-the-author (stable) and
   scratchpad is intent-of-the-agent (volatile). Keep separate; include
   one from the other.
4. **Workspaces with no git remote** (research notebooks, scratch
   workspaces): worth a separate "kind" field so flows like
   `git push`/`gh pr create` are skipped automatically.
5. **Discovery**: how does the user know what workspaces they have? The
   listing command is sufficient for power users; weak for first contact.
   Auto-include "you have N workspaces" in periodic banter? Probably no
   — too noisy.
6. **Channel-vs-workspace mismatch**: someone posts in `#pat-dev` but
   they actually want to ask about the blog. Override syntax matters.
   `@PAT in blog: ...` or just first-line "switching to blog briefly"?
7. **Cross-workspace memory**: if scratchpads are siloed, the agent loses
   "I did similar work on the blog last week" while in `pat-dev`. Maybe
   a meta-scratchpad at the agent-group level for cross-cutting recollection.

## Critical files

- `nanoclaw/src/group-init.ts` — initial workspace creation hook
- `nanoclaw/src/router.ts` — workspace resolution per thread
- `nanoclaw/src/container-runner.ts:262-355` — buildMounts, where the
  workspace path joins the mount list
- `nanoclaw/src/modules/mount-security/index.ts:192-334` —
  additionalMounts validator
- `nanoclaw/src/claude-md-compose.ts` — CLAUDE.md chain assembly
- `nanoclaw/src/db/` — schema for workspaces table + messaging_groups
  migration
- `realtime/src/haiku.ts` — front-mind intent extension for
  `switch-workspace`
- `realtime/src/router.ts` — host-side handler for switch-workspace and
  new-workspace commands

## Verification

Phase 1: voice call into PAT → "what were you working on?" → agent reads
its own `scratchpad.md` and reports. Make a change, ask again next call,
expect updated answer.

Phase 2: in Slack `#pat-dev`, message "PAT, what's open?" → answer about
agentic_toolkit. In Slack DM with same user, message "PAT, what's open?"
→ different (blog) answer. Channel binding selected the right workspace
without explicit switch.

Phase 3: PAT auto-updates scratchpad after a commit. List workspaces via
slash command shows current state of each. Archive an old workspace.
