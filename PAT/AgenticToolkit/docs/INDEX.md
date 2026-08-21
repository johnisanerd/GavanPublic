# PAT docs — index

Entry point for new agents (human or LLM). Goal: find your slice in under
a minute. If something's missing or misleading, edit this file.

## Where am I?

```
agentic_toolkit/                       <- this is the parent repo
  AGENTS.md                            rules + conventions (read first)
  KNOWN_ISSUES.md                      live issue tracker
  docs/                                deep dives — start here (INDEX.md, forensics, log schema, ...)
  plans/                               forward-looking design (see status header)
  sprint/                              week-by-week WIP (current / backlog / completed)
  realtime/                            front-mind library (TypeScript)
  transports/                     Cartesia Line bridge (Python, uv)
  pat-frontend/                        observability dashboard (Hono + React)
  nanoclaw/                            git submodule: NanoClaw v2 fork (nanoclaw-private)
  smoketest/                           E2E scenarios
  scripts/                             ops tooling (fly-call-log.py, pat-monitor.sh, ...)
```

## Start here

| Question | File |
|---|---|
| What is PAT, what's the design? | `docs/front-mind-design.md` (the spec) |
| What rules govern my edits? | `../AGENTS.md` |
| Where does the pipeline run, where do I look when X breaks? | `forensics.md` |
| How do I read / parse the structured logs? | `log-schema.md` |
| What's the relationship between this repo and `nanoclaw/`? | `nanoclaw-internals.md` |
| What's in flight this week? | `../sprint/current.md` |

## Deep dives (in this dir)

| File | When you'd read it |
|---|---|
| `front-mind-design.md` | Canonical front-mind / back-mind spec. Architectural decisions and invariants. |
| `forensics.md` | Pipeline diagram, log file inventory, "where do I look when X breaks" recipes. |
| `log-schema.md` | Structured-log wire format, `/admin/logs.*` endpoints, jq recipes. |
| `nanoclaw-internals.md` | High-level: how the submodule is laid out, dual-git workflow, deploy implications. |
| `legacy-research/` | Pre-rewrite research notes — historical context only, no current architecture. |

## Plans (forward-looking, in `../plans/`)

Each plan has a `Status:` header at the top:
- **agreed** — committed, scoped, may be partially shipped
- **speculative** — sketch / direction-setting, not committed
- **shipped** — landed; kept for the record (header reflects when)

| Plan | Topic |
|---|---|
| `persistent-workspaces.md` | Substrate: per-channel cwds + SDK auto-memory binding |
| `self-hosting-pat.md` | First user of persistent workspaces: PAT edits its own code |
| `outbound-callback-and-resume.md` | UX glue: PAT dials back on deploy / restart |
| `meet-channel-plan.md` | Google Meet audio/video channels, Recall.ai bot |
| `deployment-and-credentials.md` | Tiered secret prefixes + runtime browser-env injection |
| `admin-dashboard-and-people.md` | People spine (people/person_identifiers/...) + dashboard |

## Sprint tracking (in `../sprint/`)

| File | Purpose |
|---|---|
| `current.md` | What's actively in progress this week |
| `backlog.md` | Pending work, not yet started |
| `completed.md` | Append-only record of shipped work |
| `icebox.md` | Speculative / long-term — don't act without prompting |
| `test-inventory.md` | What's tested where, smoketest scenario catalog |

## NanoClaw submodule (in `../nanoclaw/`)

`nanoclaw/` is a **git submodule** — a soft-fork of `qwibitai/nanoclaw`
(origin=`nanoclaw-private`, upstream=qwibitai, branch=staging) with its own
`.git`; the parent pins an exact commit. Its internal docs are authoritative
for NanoClaw v2 mechanics:

| File | Purpose |
|---|---|
| `../nanoclaw/CLAUDE.md` | NanoClaw architecture, entity model, key files |
| `../nanoclaw/docs/architecture.md` | Full architecture writeup |
| `../nanoclaw/docs/db-session.md` | Per-session `inbound.db` + `outbound.db` schemas |
| `../nanoclaw/docs/isolation-model.md` | Three-level channel isolation model |

For the parent-repo perspective on the submodule (what we ship, dual-git
workflow, deploy gotchas), see `nanoclaw-internals.md`.
