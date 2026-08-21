# Doc cleanup — staleness fixes + aggressive archiving (2026-06-30)

**Status:** ✅ EXECUTED 2026-06-30 (Phases 1–7 + memory 8a done; 8b/8c deferred). All changes are
in the working tree, **uncommitted** — review with `git status` / `git diff`, then commit when ready.
Audit complete + operator-approved 2026-06-30. **Operator decisions locked:**
(1) archiving = **zip-and-remove**, and **dangling references are acceptable** (do NOT chase
down / repoint the `// see plans/X.md` code comments or passive doc links that point at
archived files — leaving them is fine); (2) bias is **less documentation over inaccurate
documentation** — when in doubt, cut. Only two things are load-bearing enough to preserve
before deleting (Phase 1 guards).

## Context

A full staleness audit (8-cluster fan-out + adversarial verification, 2026-06-30) found the
repo's *active* surface healthy (AGENTS.md, sprint/current.md, the June plans were refreshed in
the last week) but three stale pockets: (a) the three May-12 `docs/` guides still teach the
deprecated `/admin/logs.jsonl`+flyctl forensics flow and the pre-submodule nanoclaw model;
(b) `realtime/` + `pat-frontend/` + `pat-web/` READMEs describe stub/scaffold states the code
outgrew; (c) ~17 shipped/superseded plans + dated snapshots + scratch notes still read as
pending work. Today's AGENTS.md edit also introduced two fresh errors (a `scripts/patobs` path
that doesn't exist; a Layout line still calling nanoclaw `pat/main`).

### Ground truth the executor should assume (so no re-investigation is needed)
- Repo = `agentic_toolkit/`, branch `staging`. `nanoclaw/` is now a **git submodule**
  (`.gitmodules` branch=staging, origin=`PalisadeResearch/nanoclaw-private`, upstream=qwibitai),
  converted 2026-06-30. The outer `/Users/user/Projects/AgenticToolkit` is NOT a git repo.
- **Forensics canon (2026-06-30):** centralized **patobs** (OpenObserve; MCP `query`/`schema`/
  `resolve_person` or CLI `../pat-observability/scripts/patobs`) is FIRST; `scripts/pat-trace.py`
  for a single-call timeline is SECOND; `flyctl logs` LAST. `/admin/logs.jsonl` + `/admin/logs.tail`
  still exist in `nanoclaw/src/admin/index.ts` but are the underlying host surface, no longer primary.
- prod front-mind = **Cerebras zai-glm-4.7** via the official SDK (`realtime/src/llm-provider.ts`,
  `reasoning_effort='none'`). Old Llama/Haiku/qwen/gpt-oss references are superseded.
- People spine LIVE on prod: `people`/`person_identifiers`/`person_users`/`person_roles`
  (migrations 019-021); `ncl` is the single writer; `person_roles` built but NOT enforced.
- pat-frontend = Clerk-OAuth react-router dashboard; Clerk key is a **runtime** Fly secret
  `PUBLIC_CLERK_PUBLISHABLE_KEY` (via `server/public-env.ts` → `window.__PUBLIC_ENV__`); the
  build-arg was killed. `realtime/src/haiku.ts` + `router.ts` were deleted (commit 99c457c);
  replaced by `banter.ts` / `llm-provider.ts` / `request-layer.ts`.

⚠️ **Runtime-prompt caution:** Phase 5/6 edit files under `pat-prompts/` — those are the live
agent's system text, not human docs. After editing, sanity-check prompt assembly (grep where
`pat-prompts/*.md` is read) — a wrong edit changes production behavior.

---

## Phase 1 — Guards (do FIRST; the only steps that prevent real work-loss)

- [ ] **G1** — Before zipping `smoketest/E2E_PLAN.md`: confirm its still-open scenarios
  (NS3 anam-web runner already at `backlog.md:1108`; **NS4, NS5, Slack**) are captured in
  `sprint/backlog.md`; add a one-liner for any that aren't.
- [ ] **G2** — Before zipping `plans/multi-agent-feature-buildout.md`: its two deferred
  follow-ups (**Signal attachment-relay**, **wiki awareness**) are NOT in backlog/icebox
  (verified — grep empty). Add a one-line `sprint/backlog.md` entry for each.

Everything else that points at an archived file (code comments, `outbound-callback` plan link,
etc.) is **intentionally left dangling** per operator decision — do not chase them.

## Phase 2 — `AGENTS.md` (single editing pass)

- [ ] **L7** — delete the broken `(archived under ~/Projects/agent-toolkit-archive/…)` parenthetical.
- [ ] **L19** — Layout: `nanoclaw/` → `# git submodule — nanoclaw-private fork (upstream=qwibitai), branch=staging`.
- [ ] **L30** — reword "separately-versioned git repo" → submodule (own `.git` + both remotes;
  parent pins an exact commit); cross-ref deploy §0 / `scripts/check-submodule.sh`.
- [ ] **L17-28** — add `pat-web/  # avatar (Anam) talk webapp` to the Layout block.
- [ ] **L61** — `scripts/patobs` → `../pat-observability/scripts/patobs` (sibling repo). MCP names stay.
- [ ] **L266** — `.agent-secrets`: lead with `FLY_API_TOKEN` + vendor keys; note Railway entries are legacy.
- [ ] **ADD — "People & identity"** section:
  > Inbound senders resolve to a canonical Person. Four central-DB tables: `people`,
  > `person_identifiers`, `person_users`, `person_roles` (migrations 019-021). The host CLI
  > `ncl` is the **single writer** — never write these tables directly (`ncl people`,
  > `ncl person-roles`). `person_roles` (admin|employee) is BUILT but NOT enforced —
  > pat-frontend still gates UI on the operator-email allowlist (`isOperatorEmail`). Auto-enroll
  > hook: `nanoclaw/src/modules/permissions/index.ts`; per-person memory: `personal-memory.ts`.
  > See `plans/admin-dashboard-and-people.md`.
- [ ] **ADD — tiered secret prefixes** (mark **in-progress until closes**):
  > `PUBLIC_<NAME>` (browser, runtime-injected via `server/public-env.ts` → `window.__PUBLIC_ENV__`);
  > `HOST_<NAME>` (host process env); `AGENT_<NAME>` (OneCLI vault egress, stripped from container).
  > `AGENT_` routing comes from the DB `credential_routing` table (nanoclaw migration 023), not a
  > committed file. (Phase 3, in progress — see `plans/deployment-and-credentials.md`.)
- [ ] **ADD — live-issues pointer**: `KNOWN_ISSUES.md` is the maintained tracker; `BUGS.md` is a
  stale 2026-05-12 snapshot (being archived) — don't treat it as the live bug list.

## Phase 3 — Core `docs/` rewrites (biggest accuracy wins)

- [ ] **`docs/nanoclaw-internals.md`** — rewrite opening (L5-7 "not a submodule / pat/main /
  gitignored" → submodule, staging, parent pins commit) + deploy section (bump-pin +
  `check-submodule.sh`). KEEP the dual-git commit-twice / `//PAT:` / pnpm-patch content.
- [ ] **`docs/forensics.md`** — lead with **patobs** (canonical; `pat_events`+`pat_raw`; `env`
  column; `llm.call` traces) → `pat-trace.py` per-call → demote `/admin/logs.*` + `fly-call-log.py`
  to a "local-dev / last-resort" subsection (endpoints still exist — don't delete). Replace the
  hardcoded model table (Haiku/Sonnet/Opus) with role names; note prod fast-tier = Cerebras zai-glm-4.7.
- [ ] **`docs/log-schema.md`** — add a top "Canonical query surface" (patobs SQL over
  `pat_events`/`pat_raw`, prod+staging via `env`) + `pat-trace.py` + `/pat-logs` skill; demote
  `/admin/logs.*` to the underlying host API. Fix `source` enum (add `host`, `pat-web-browser`)
  and `level` enum (add `debug`) to match `realtime/src/log-events.ts`.

## Phase 4 — Component READMEs (rewrite to reality)

- [ ] **`realtime/README.md`** — kill the "scaffolded / stubs / `TODO(realtime)` /
  `haiku.ts`/`router.ts`" framing (0 TODO markers, 37 real files, those two deleted). Document
  the live architecture (`banter.ts`, `llm-provider.ts`, `request-layer.ts`,
  `channel-orchestrator.ts`, `timeline/`, `narration-manager`, `scenario-action-stream`, …).
  Keep the valid Notes block (`kind='banter'`, `sender='realtime-agent'`).
- [ ] **`pat-frontend/README.md`** — rewrite to the Clerk-OAuth react-router dashboard
  (`/database` = the `/admin/db` browser, `/people`, `MyHandlesView`, `SessionLayout`; server has
  `auth.ts`/`people.ts`/`public-env.ts`/`routes-db.ts`/`routes-people.ts`/`pairing-targets.ts`;
  hook is `use-event-buffer.ts`). Document deploy secrets `PUBLIC_CLERK_PUBLISHABLE_KEY` (runtime)
  + `CLERK_SECRET_KEY`; state the build-arg was killed; note `?token=` survives only for iframe embeds.
- [ ] **`pat-web/README.md`** — rewrite Modes + Backend-seams: anam-web is live via a per-call
  WS bridge (`server/realtime-ws.ts` → nanoclaw `/anam-web/ws`) with banter `utterance.stream-*`
  frames, plus `server/slide-bus.ts`, `server/scenarios.ts`, `src/talk/` deck UI. Keep the
  z-layer compositing / visual-controls sections.

## Phase 5 — Medium-severity cleanups

- [ ] **Plan status headers (keep the plan, fix the header):**
  - `plans/admin-dashboard-and-people.md` — Phases 0-3 shipped/on-prod; remaining = dashboard UI
    (deferred, Shadcn-blocks) + role enforcement (`person_roles` built, not enforced).
  - `plans/meet-channel-plan.md` — fix every `realtime.ts` → `phone-call.ts` (renamed 2026-05-14),
    incl. the broken file:line at L73; the Meet/Recall.ai channel itself is still unbuilt (keep that).
  - `plans/upgrade-and-ops-simplification.md` — §5f SHIPPED (2026-06-25); mark L3 "partially
    executed"; keep the open tail (§3 `readEnvFile`→`process.env`, §1/§6b smoke gate, §4 image
    rebuild, §6a preflight).
  - `plans/signal-keepalive-and-reregister.md` — split status: keep-alive half SHIPPED 2026-06-25
    (**as a weekly self-send — diverges from §3.2's no-self-send recommendation**); §4
    re-registration runbook still unexecuted.
- [ ] **`sprint/test-inventory.md`** — replace deleted `haiku*.test.ts`/`router.test.ts` (Tier 1)
  and `haiku.live.test.ts` (Tier 2) with `banter*.test.ts`/`request-layer*.test.ts` +
  `request-layer.live.test.ts`/`narration.live.test.ts`; add the 7 missing realtime tests
  (`bash-parse`, `channel-orchestrator-timeline`, `channel-orchestrator.timeline-wired`,
  `error-surfacing`, `llm-http-instrumentation`, `scenario-action-stream`, `tag-stream-parser`);
  drop the "single Haiku front-mind" framing + L338 back-ref.
- [ ] **`sprint/backlog.md`** — delete 3 already-shipped items (staging/prod split L1081,
  Firecrawl MCP L264, per-call phone thread-isolation L713); update the L1272 "separate repo /
  gitignored / CI clones nanoclaw-private" note → submodule (`git submodule update --init` /
  `--recurse-submodules`, still needs a deploy key).
- [ ] **`pat-prompts/PAT-SENDING-RULES.md`** *(runtime prompt)* — L16-18: parser allowlist is
  `signal|pstn|telegram|whatsapp|imessage`; telegram/pstn are live. Drop "only signal / others
  fail"; scope "live today" to `signal/pstn/telegram`; note slack/discord/teams aren't
  prefix-addressable.
- [ ] **`docs/INDEX.md`** *(minimal — operator doesn't rely on it; fix only the wrong bits):*
  L11 BUGS→KNOWN_ISSUES; L18/L31/L72-85 sub-repo→submodule; L33/L54 sever the
  `multi-agent-feature-buildout` "current plan" pointer → `sprint/current.md`; drop the archived
  plans from its plans table. (Adding the 4 missing live docs is optional.)
- [ ] **`BUGS.md`** — migrate the still-substantive TTS-coalescing write-up (bug 5) + re-verify
  the 2 open bugs into `KNOWN_ISSUES.md`; then **ZIP `BUGS.md`** (Phase 7). Note the stale internal
  refs it carries: deleted `haiku.ts`/`router.ts`; narration gates actually at `narration.ts:494`/`:531`.

## Phase 6 — Low-severity (obvious-only, per operator)

- [ ] `plans/streaming-pivot-pipeline.md` — provider substrate note (L4-7, L468-472) → decided:
  Cerebras zai-glm-4.7 (`realtime/src/llm-provider.ts`). Keep the pivot architecture (unbuilt).
- [ ] `sprint/current.md` — mark Phase-2 submodule (daa3f3e) + Phase-3 `credential_routing`
  (386a429 / migration 023) **DONE** (both shipped same-day, just after current.md's commit).
- [ ] `pat-prompts/PAT-ARCHITECTURE.md` *(runtime prompt)* — add one line: patobs (OpenObserve,
  via patobs MCP / CLI / `/pat-logs` skill) is the canonical aggregated forensics surface;
  demote pat-trace to the single-call view.
- [ ] `trace-e2e/README.md` — remove the phantom `repeat-asked.test.ts` entry (never committed).
- [ ] `plans/presenter-channel-plan.md` — one-line status fix (presenter runtime shipped to prod;
  remaining = dedicated presenter channel transport + designer skill). *(Full 55KB slim = later.)*

**Deliberately skipped** (not obvious / behavior decisions): `pat-prompts/PAT-AGENT.md` missing
`PAT-TELEGRAM.md` import; `docs/front-mind-design.md` appendix `file:line` anchor re-verification.

## Phase 7 — Archive (zip-and-remove; dangling refs intentional)

Create `archive/` at repo root; move originals into these zips and delete them from the tree.
Zips of markdown are tiny — commit them as the record. **Leave all inbound references dangling.**

- [ ] `archive/root-snapshots-2026-05-12.zip` ← `SMOKE-TEST-2026-05-12.md`,
  `SESSION-REVIEW-2026-05-12.md`, `BUGS.md` (after its Phase-5 merge into KNOWN_ISSUES.md).
- [ ] `archive/plans-shipped-may-2026.zip` ← `plans/`: `channel-orchestration-dedup.md`,
  `refactor-bundle-2026-05-14.md`, `streaming-banter-pipeline.md`, `voice-transport-cartesia-rethink.md`,
  `narration-gating-plan.md`, `presenter-tag-stream.md`, `presenter-orchestration-locus.md`,
  `timeline-architecture.md`, `timeline-runtime-and-scenarios.md`, `multi-agent-feature-buildout.md`,
  `staging-prod-split.md`.
- [ ] `archive/plans-front-mind-llm-swap-chain.zip` ← `plans/front-mind-cerebras-swap.md`,
  `plans/front-mind-llm-swap.md`.
- [ ] `archive/plans-shipped-june-2026.zip` ← `plans/person-identity.md`, `plans/log-centralization.md`,
  `plans/pairing-handle-linking.md`, `plans/dashboard-ui-replication.md`.
- [ ] `archive/sprint-scratch-2026-05.zip` ← `sprint/scratch-scenario-ext.md`,
  `sprint/scratch-timeline-core.md`, `sprint/integration-e2e-audit.md`.
- [ ] `archive/completed-spikes.zip` ← `smoketest/E2E_PLAN.md`, `transports/scripts/path-a-spike.md`,
  `transports/scripts/path-a-spike.py`.
- [ ] **Relocate** the 627MB `../agentic_toolkit.zip` (full node_modules backup, 216k files) →
  `~/pat-archives/` (out of the working-tree parent). Do NOT commit it anywhere in-repo.

**Left in place (verified correct / intentional):** `docs/legacy-research/` (already walled off),
`sprint/archive-2026-05.md`, `sprint/completed.md`, `sprint/icebox.md`, and all `nanoclaw/*.md`
(upstream-tracked — never edit in-tree; `nanoclaw/AGENTS.md` is a symlink to upstream `CLAUDE.md`).

## Verification (after execution)

- `AGENTS.md`: no `pat/main`, no `scripts/patobs`, no dead archive path; grep `people`/`ncl`/
  `PUBLIC_`/`KNOWN_ISSUES` all resolve to the new sections.
- `docs/forensics.md` + `docs/log-schema.md`: `patobs` appears before any `/admin/logs.jsonl`.
- `realtime/README.md`: no `haiku.ts`/`router.ts`/`TODO(realtime)`.
- `plans/` no longer contains any archived filename; `archive/*.zip` present; `../agentic_toolkit.zip` gone.
- Runtime prompts: prompt-assembly still loads `pat-prompts/*` without error; `PAT-SENDING-RULES`
  no longer claims "only signal".
- No deploy is part of this plan.

## Verified healthy — do not audit again
`CLAUDE.md` (root + nanoclaw), `KNOWN_ISSUES.md`, `transports/README.md`, `realtime/TIMELINE.md`,
`scenarios/SCENARIOS.md`, `test-viewer/README.md`, `docs/{security-review,
onboarding-new-user,front-mind-design}.md`, `sprint/{completed,archive-2026-05,icebox}.md`, and the
live forward plans (`deploy-cli`, `deployment-and-credentials`, `mcp-management`, `observability-proxy`,
`verification-rerouting`, `dashboard-permissions`, `outbound-callback-and-resume`, `one-flow-well`,
`signal-debugging-infra`, `narration-prompt-fix`, `opacity-narrow-fixes`, `swap-avatar`, `passkey-research`,
`web-access-fly-machine`, `telegram-account-and-sidecar`, `onecli-1password-vault`).

## Phase 8 — Memory index (`MEMORY.md`) cleanup

Audits the auto-memory at `~/.claude/projects/-Users-user-Projects-AgenticToolkit/memory/`
(separate from the repo; same staleness disease — over the 24.4KB cap + self-contradicting entries).

**8a — A–C EXECUTED 2026-06-30.** Index was 27.1KB (over cap → only partial load). Fixed:
- **Pruned 8 superseded index lines** (each superseded by a newer entry still in the index):
  nanoclaw-upgrade-"not-deployed" (→ v2.1.19 fallout); the latency/model saga
  latency-sprint + Llama-fix + Cerebras-gpt-oss + front-mind-substrate (→ zai-glm-4.7 fast-path);
  nanoclaw-"sub-repo" (→ submodule); pat-trace-"FIRST" (→ patobs-first); pairing-"not-deployed"
  (→ pairing shipped).
- **Fixed 4 contradictions:** dashboard-DEFERRED vs rebuilt; `/api/logs.jsonl`-canonical vs patobs
  (also fixed the body of `feedback_pull_full_logs.md`); submodule "(planned)" vs done; trimmed the
  oversized back-mind-prompt-assembly line. `feedback_check_submodule_on_deploy.md` body was already
  current. Result: back under the 24.4KB cap, no self-contradictions in the loaded index.

**8b — VERIFY + PRUNE — EXECUTED 2026-07-01.**
- Verified `openclaw|railway` = **0 references** in code/config → pruned the 8 OpenClaw/Railway-era
  entries (railway workflow, prod-state "railway up", railway autodetect bug, openclaw workspace-
  identity / plugin-dev / v0.2-integrations / claws-backup / external-repos).
- Fast-tier: `llm-provider.ts` is `FAST_MODEL`-env-driven (not code-verifiable); left the fast-path
  entry flagged rather than asserting a change. Kept the Llama/undici entry — the OpenRouter/Groq
  fast-path still exists, so that dispatcher gotcha is a latent trap, not dead.
- Trimmed the voice-memos + staging-env entries (dropped the ELEVENLABS + OneCLI-bind bits now living
  in docs, incl. the stale `172.17.0.1` → docs carry the correct `0.0.0.0`).

**8c — DEEPER SWEEP — done as part of the promotion pass (2026-07-01).**
- Orphaned topic files garbage-collected (12 removed; files↔index reconciled).
- Clusters consolidated by *promoting* the durable gotchas into repo docs then pruning the memory
  entries — Signal → `docs/signal.md`, Anam → `pat-web/README`, etc. (see the b013708 commit).
- Also de-hardcoded the Signal ACI/PNI UUIDs from docs (they shift on re-registration; documented how
  to find them instead — commit 24aea11).
- Net: memory index 97 → ~37 entries; durable knowledge now lives in docs (one source of truth).
