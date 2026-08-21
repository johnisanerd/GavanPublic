# Upgrade & Ops Simplification Plan

**Status:** partially executed (proposed 2026-06-24). **§5f — centralize all logs into one sink —
SHIPPED 2026-06-25** as the **patobs / pat-observability** stack (OpenObserve; `pat_events` +
`pat_raw` streams; prod+staging via `env`; queried via the `patobs` MCP / `../pat-observability/scripts/patobs`
CLI / `/pat-logs` skill). That is now the canonical forensics surface — §5a–e are largely obsolete
per §5f's own note. **Still open:** §3 (`readEnvFile` → `process.env` fallback), §1 / §6b
(post-deploy smoke test as a required staging gate), §4 (agent-image rebuild reliability), §6a
(preflight script).
**Motivation:** the nanoclaw **v2.1.19 prod upgrade** (from v2.0.30) cascaded into ~5 separate breakages, each requiring deep manual forensics (`flyctl logs` + `fly ssh console` + base64'd remote scripts) because observability was poor and failures were silent. Prod could not produce an agent reply on *any* channel for hours. Full incident detail: memory `project_v2119_prod_upgrade_fallout_2026_06_25.md`.

This plan turns that night's pain into concrete, prioritized engineering. Each item is marked **[quick win]** (hours, no new infra) or **[bigger]** (a day+ or a new moving part).

## The five failures (root causes, grounded in code)

1. **Signal channel silently never started.** `readEnvFile` (`nanoclaw/src/env.ts:11`) reads `.env` from disk **only — no `process.env` fallback**. On Fly, secrets land in `process.env`, so `scripts/fly-entrypoint.sh` regenerates `.env` from a hardcoded `SECRET_KEYS` allowlist (line 222). That allowlist had drifted: `SIGNAL_*` was absent → signal's factory (`src/channels/signal.ts:1575`) read empty config → returned `null` → channel skipped. (Fixed: `SIGNAL_*` + others added to the allowlist, fly-entrypoint.sh:237.)
2. **OneCLI gateway `/v1/agents` → 404.** Prod ran a stale gateway image (served `/api/agents`); `ensureAgent` failed → no container could spawn → no reply on any channel. (Fixed by re-running the OneCLI installer on the VM.)
3. **OneCLI gateway re-bound to `172.17.0.1`** by that installer → host (`127.0.0.1:10254`) got "fetch failed". The entrypoint already has a §2.5 normalizer (fly-entrypoint.sh:143-153) but the installer ran *outside* boot. (Fixed manually with `ONECLI_BIND_HOST=0.0.0.0`.)
4. **Agent couldn't run Claude, and the error was delivered as Pat's reply.** agent-runner hardcoded `pathToClaudeCodeExecutable: '/pnpm/claude'`; the v2.1.19 claude-agent-sdk ships its own bundled native binary and rejects the shim → `"Claude Code native binary not found at /pnpm/claude"`. That string reached the user because **`poll-loop.ts:301-308` writes `Error: ${errMsg}` as a `kind:'chat'` outbound message**. (Fixed: removed the override, `container/agent-runner/src/providers/claude.ts:619`.)
5. **Agent-image staleness/cache footguns.** The srchash auto-rebuild (fly-entrypoint.sh:186-210) covers `container/agent-runner` + `skills` + `Dockerfile` + `build.sh`, but buildkit's COPY context was stale (needed `docker builder prune`); AND the running group spawns a **per-group image tag** `${BASE}:${agentGroupId}` built `FROM ${CONTAINER_IMAGE}` + apt packages (`src/container-runner.ts:694,708`), so rebuilding `:latest` doesn't reach a group until `ncl groups restart --rebuild`.

**Recurring themes:** silent failures (no error surfaced); bad observability (the dashboard `/admin/logs.jsonl` returned ~nothing — see §5); unmet prereqs discovered post-deploy; manual VM surgery; and **staging never exercised an agent end-to-end**, so the broken agent image shipped to prod unnoticed.

---

## 1. Post-deploy smoke test [bigger — highest value]

A scripted end-to-end check, run after every nanoclaw deploy, that **fails loudly** if the system can't actually serve a reply. This single artifact would have caught 4 of the 5 failures at deploy time instead of via live user messages.

**Where it lives:** `scripts/post-deploy-smoke.sh` (parent repo `scripts/`, alongside `pat-trace.py`). Runs from the operator's machine against a target app (`-a pat-nanoclaw[-staging]`), using `fly ssh console -C` for in-VM checks and the admin HTTP surface for the round-trip. Exit non-zero on any failed assertion; print a one-line PASS/FAIL per check.

**Checks (each maps to a failure above):**

| # | Check | Catches | How |
|---|-------|---------|-----|
| A | **All expected channels started.** Compare the set of `channel.startup-summary` started-channels (new event, see §2) against an expected list (`PAT_EXPECTED_CHANNELS` env or a checked-in manifest). FAIL if any expected channel is in SKIPPED. | Failure 1 (signal) | hit `/admin/logs.jsonl?kind=channel.startup-summary` after boot |
| B | **OneCLI gateway healthy.** `fly ssh console -C "curl -fsS http://127.0.0.1:10254/v1/agents"` returns 200 (not 404, not connection-refused). | Failures 2 & 3 | one ssh curl |
| C | **Agent can spawn + actually run Claude.** Inject a synthetic message to a dedicated smoke-test agent group and assert a real reply round-trips within N seconds — NOT an `Error:` string. | Failure 4 (claude binary) + 2 | see below |
| D | **Per-group image is current.** For each live agent group, assert its `image_tag` was built `FROM` the current `:latest` (compare image `Created` timestamps via `docker image inspect`). | Failure 5 | ssh + docker inspect |

**Check C, the load-bearing one.** There is already a smoketest agent scaffold: `scripts/init-realtime-smoketest-agent.ts`. Reuse it. The round-trip:
1. Insert a `kind:'chat'` inbound for the smoke-test messaging group (via `ncl` over the `/admin/ncl` bridge, already enabled in prod via `PAT_ENABLE_NCL_HTTP=1`, or a tiny `/admin/smoke` endpoint).
2. Poll the smoke group's `outbound.db` (or `/admin/sessions/<id>/host-log.jsonl`) for a `kind:'chat'` reply.
3. **Assert the reply text does NOT start with `Error:`** — this is exactly the failure-4 signature (`poll-loop.ts:307`). A naive "did we get *any* reply" check would have passed on the broken binary because the error WAS delivered as a reply.

**Wire it into the deploy.** Add a `pnpm run deploy:nanoclaw:staging` / `:prod` wrapper (or extend the AGENTS.md "Deploying" table) that runs `flyctl deploy … && scripts/post-deploy-smoke.sh -a <app>`. A deploy that smoke-fails is treated as a failed deploy.

---

## 2. Kill the silent failures [quick win]

Three concrete edits so a missing channel / a dead agent / a bad claude-init is *loud structured data*, never silence-or-leaked-to-user.

**2a. Channel startup summary event.** `initChannelAdapters` (`src/channels/channel-registry.ts:124`) already logs per-channel `log.warn('Channel credentials missing, skipping')` (line 129) and `log.info('Channel adapter started')` (line 168) — but there's no aggregate assertion of the *expected* set, and a single warn in a boot stream is easy to miss. Add, after the loop, one summary event:
```ts
log.event({ kind: 'channel.startup-summary',
  started: [...activeAdapters.keys()],
  skipped: skippedChannels /* [{channel, reason}] */ });
```
Collect `skippedChannels` inside the loop (the null branch at line 128 and the catch at line 169). Declare `channel.startup-summary` in `realtime/src/log-events.ts` + the Python mirror (drift test). This is the event check A reads.

**2b. Agent errors stay in chat (operator decision, 2026-06-25) — but ALSO become structured data.** `poll-loop.ts:301-308` writes `content: { text: 'Error: ${errMsg}' }` as a `kind:'chat'` row. **KEEP that chat delivery as-is.** PAT is an internal tool and raw infra/agent errors in the channel are a *feature* — immediate, in-channel operator visibility (it's how the v2.1.19 `/pnpm/claude` break was diagnosed). The ONLY change here is **additive**: also emit a **structured** `kind:'agent.query-error'` event (errMsg, errKind, sessionId, threadId) so the dashboard + post-deploy smoke test (check C) can see the failure without reading `container.stderr.log` by hand. Do **not** suppress infra/init errors from chat, and do **not** swap in a generic "something went wrong" line — the raw error reaching the operator is the point. (See memory `feedback_infra_errors_in_chat`.)

**2c. Claude-init failure is a first-class structured event.** When the provider's `query()` throws because the SDK can't resolve its binary / can't reach the gateway, that's an infra error (2b) — but also stamp a distinct `kind:'agent.claude-init-failed'` at the point of failure in `providers/claude.ts` so the dashboard and smoke-test check C can see *why* the round-trip failed without parsing `container.stderr.log` by hand.

---

## 3. Fix the `.env` allowlist drift [quick win — do this one first]

**Decision: make `readEnvFile` fall back to `process.env`, and keep the entrypoint's `.env` generation as-is.** Justification:

- The other two options are worse. *Deriving the allowlist from `grep 'readEnvFile([' src` at build time* is brittle (multi-line calls like `signal.ts:1575` don't grep cleanly; it couples the entrypoint to source-text shape). *A startup assertion that every readEnvFile key is present* produces false alarms (many keys are legitimately optional — `WHATSAPP_TOKEN`, `SLACK_*` when those channels aren't wired).
- The original rationale for `.env`-only ("keep secrets out of child-process inheritance," `env.ts:7-9`) is **already moot on Fly**: secrets are in `process.env` for the whole host process regardless. The child-process isolation that matters is the *container* boundary, and containers get secrets via the OneCLI gateway, not env inheritance. So a `process.env` fallback costs nothing we still have.

**Change (`src/env.ts:11`):** after parsing `.env`, for any requested key still missing, fall back to `process.env[key]`. `.env` wins when present (preserves local-dev `.env` overrides). This makes the entrypoint allowlist a *performance/redaction nicety*, not a correctness dependency — a future channel that reads a new secret works the moment the Fly secret is set, with **zero entrypoint edits**, which is the whole class of bug that bit us.

**Belt-and-suspenders [quick win]:** keep §2a's startup summary, so even if a *channel-specific* secret is genuinely unset, the SKIPPED list + smoke check A flags it loudly.

---

## 4. Fix agent-image rebuild reliability [mostly quick wins]

The srchash mechanism (fly-entrypoint.sh:186-210) is sound in principle but had two gaps:

**4a. Buildkit COPY-context staleness [quick win].** `nanoclaw/CLAUDE.md` already documents that `--no-cache` doesn't invalidate stale COPY context and you must `docker builder prune`. Make it automatic: when the entrypoint detects a srchash change (the rebuild branch, line 197-209), run `docker builder prune -f` *before* `bash container/build.sh`. The prune is cheap relative to a full rebuild and removes the "rebuilt but shipped stale files" footgun entirely. (The srchash already correctly covers `container/agent-runner` — verify this in the smoke test's check D regardless.)

**4b. Per-group `:ag-` images don't track `:latest` [bigger].** This is the subtle one. A group runs `${BASE}:${agentGroupId}` (`container-runner.ts:708`), built `FROM ${CONTAINER_IMAGE}` (`:latest`) + the group's apt/npm packages. Rebuilding `:latest` on deploy does **not** rebuild the group image, so the group keeps running old agent-runner code until `ncl groups restart --rebuild`. Two-part fix:
- **Detect staleness:** at boot (or in a deploy step), for each group with a per-group image, compare `docker image inspect -f '{{.Created}}'` of `:ag-…` vs `:latest`. If the base is newer, the group image is stale.
- **Auto-rebuild on base change:** when the srchash rebuild fires (4a), enumerate groups with per-group images and rebuild each `FROM` the fresh `:latest` (reuse the existing per-group build path in `container-runner.ts:694-728`), then `ncl groups restart` them so the new image is picked up. Gate behind a flag (`PAT_AUTO_REBUILD_GROUP_IMAGES=1`) initially so it's opt-in until proven. Smoke check D asserts the result.

**4c. Document the model [quick win].** Add a short "two-layer image model" note to `docs/build-and-runtime.md`: `:latest` (base, srchash-rebuilt on deploy) vs `:ag-<group>` (per-group, base + packages, rebuilt only on self-mod or `restart --rebuild`). The night was partly confusion about why a rebuilt `:latest` didn't take effect.

---

## 5. Observability: make `/admin/logs.jsonl` actually usable [quick win]

**Why it returned ~nothing.** Two compounding causes, both grounded:
1. **Default level filter excludes `debug`** (`src/admin/index.ts:786-797`: default level set is `{info,warn,error,fatal}`). Many of the cascade's most useful traces (`llm.call`, token deltas) are debug and were filtered out unless the caller passed `?include_debug=1`. The *operator didn't know to.*
2. **The cascade's decisive failures weren't in the host log at all.** The claude-binary error lived in the per-session `container.stderr.log` (served separately at `/admin/sessions/<id>/container-stderr.log`), and channel-skip was a `log.debug` inside signal's factory *before* reaching the registry's warn. The host day-file (`data/logs/host-<date>.jsonl`, written by `log.ts:75`) genuinely had little in it right after a fresh-deploy boot.

**The deeper framing — logs live on THREE surfaces; the dashboard reads only one.** Almost nothing this session was *never captured* — it was *scattered*, and the decisive signals were never on the surface we look at:
1. **Host structured stream** — `/admin/logs.jsonl` / the day-file. What the dashboard reads. Filtered to non-`debug` by default.
2. **Per-session container stderr** — `data/v2-sessions/<id>/container.stderr.log` (the agent / Claude-Code init errors, e.g. the `/pnpm/claude` failure). Separate files, served at a URL you have to know; NOT aggregated into #1.
3. **External transports daemon** — signal-cli's own stdout/stderr on `pat-transports`, reachable ONLY via `flyctl logs -a pat-transports` / SSH. The sealed-sender decrypt NPEs (`getServerGuid` / `getSender` null) lived here, entirely outside the dashboard — and the daemon runs `--no-receive-stdout`, so even successful receives aren't echoed.

Every decisive signal during the incident was on surface #2 or #3; the dashboard only sees #1 (filtered). So the work is **routing / structuring / surfacing existing data into one queryable place + relaxing the default filter** — NOT "start logging things we don't." The only genuinely-*new* emissions needed are the signal `decrypt-failed` / `daemon-health` events (surface #3 → structured; see `plans/signal-debugging-infra.md` P1) and the `channel.startup-summary` (§2).

**Fixes:**
- **5a [quick win].** Make the dashboard's default log view request `?include_debug=1` (or add a prominent toggle that's ON by default for the forensics view) — and document in `docs/log-schema.md` that a bare `/admin/logs.jsonl` pull deliberately hides debug. Cheap, removes the "dashboard is empty" trap.
- **5b [quick win].** The structured events from §2 (`channel.startup-summary`, `agent.query-error`, `agent.claude-init-failed`) are all `info`/`error` level → they show in the default view. This is the bulk of the win: the events you need at 2am are now *in the default feed*.
- **5c [bigger].** Surface `container.stderr.log` in the dashboard timeline, not just at a separate URL you have to know exists. Even a "view container stderr" link per session in `/admin/monitor` would have saved an hour. The data already exists (`handleSessionStderrServe`, `admin/index.ts:559`); it just isn't linked from the UI.
- **5d [quick win].** Extend `pat-trace.py` past anam-only: the memory note flags "pat-trace is anam-only; `/admin/logs.jsonl` returned ~4 lines." A `--boot` / `--deploy` mode that pulls the last boot's `channel.startup-summary` + any `agent.*-error` events would make post-deploy triage a one-liner.
- **5e [quick win — the operator explicitly asked for this]. A better logs/forensics SKILL.** The `/pat-logs` skill (`reference_pat_logs_skill`) encodes a tiered host-log order but does NOT teach the **three-surface model** above, which is exactly what cost hours this session. Rewrite it so any "what happened" question routes to the right surface without re-derivation: (1) host stream via `/api/logs.jsonl` *with* `include_debug`; (2) the failing session's `container.stderr.log` (`/admin/sessions/<id>/container-stderr.log`); (3) the external daemon via `flyctl logs -a pat-transports` — including the `--no-receive-stdout` gotcha and the signal NPE signatures (`getServerGuid` / `getSender` null). Lead with the "dashboard looks empty? → it's the debug filter or the wrong surface" trap. This is the single highest-leverage *doc* fix — it turns "where do I even look at 2am" into a checklist, and it's why this whole §5 + the signal-observability work belongs together.
- **5f [bigger — the STRATEGIC fix; operator's explicit direction]. Centralize ALL logs into one sink. ✅ SHIPPED 2026-06-25 as patobs / pat-observability.** Built as a self-hosted **OpenObserve** sink (option (a)-equivalent, own infra) with two streams — `pat_events` (structured nanoclaw events, prod+staging via the `env` column, incl. `llm.call` debug traces) and `pat_raw` (raw stdout/stderr of the pat-* apps). Queried via the `patobs` MCP (`query`/`schema`/`resolve_person`) or the `../pat-observability/scripts/patobs` CLI or the `/pat-logs` skill. This is now the canonical forensics surface (see AGENTS.md "Investigating calls / forensics"), which makes §5a–e largely obsolete as predicted below. Original design intent retained for the record: §5a–e make the three *existing* surfaces individually reachable — but the real goal is that **there shouldn't BE three places to look.** Every PAT process already emits structured JSONL; ship them all to ONE queryable store.
  - **Sources to capture:** (1) every Fly app's stdout/stderr — nanoclaw host, the `pat-transports` signal daemon, pat-frontend — via Fly's org-wide log stream; (2) the per-session `container.stderr.log` files *inside* the nanoclaw VM (these are files, NOT on the Fly stream, so they need a tail/forwarder running on that VM).
  - **Sink options:** **(a) self-hosted on Fly** — a small Grafana **Loki** + **Vector/Alloy** machine. Keeps potentially-sensitive data (handles, message content) in our own infra, cost-bounded; the operator explicitly OK'd "in Fly on one of these machines." **(b) managed SaaS** (Datadog / Axiom / Better Stack / Grafana Cloud) — least ops, but **external egress of sensitive message content** → a real privacy decision for an internal comms tool. **Lean (a)** unless ops-simplicity decisively wins; if (b), scrub/limit message bodies first.
  - **Mechanism (verify current Fly mechanics at impl time):** Fly exposes a per-org **NATS log stream**; the Fly-native path is a `fly-log-shipper` / **Vector** instance subscribing to it and forwarding to the sink — that captures all app stdout/stderr in one shot. Add a Vector/Alloy tail of `data/v2-sessions/*/container.stderr.log` on the nanoclaw VM to fold in surface #2.
  - **Win:** ONE place (Grafana + LogQL, or the SaaS UI) where `kind`-filtered structured events *and* raw container/daemon stderr all live — no more "which of three surfaces, on which machine, with which filter." This makes §5a–e (and the `/pat-logs` skill, §5e) largely obsolete: the skill collapses to "open the dashboard / Grafana."

---

## 6. Upgrade playbook + prereq gating [bigger]

The exact prereqs flagged *before* the deploy (OneCLI gateway bump, agent-image rebuild) are what bit, one by one — because nothing forced them to pass first.

**6a. Preflight script `scripts/preflight-nanoclaw-deploy.sh` [bigger].** Must pass before a prod nanoclaw deploy; run it from the deploy wrapper (§1) ahead of `flyctl deploy`:
- **OneCLI gateway version** ≥ required (the version that serves `/v1/agents`). Check via `fly ssh console -C` against the *currently-running* prod gateway and against the version the new code expects (pin an `ONECLI_MIN_VERSION` constant in code).
- **Secrets/.env keys present:** for the channels you expect to run, assert the Fly secrets exist (`flyctl secrets list`) — catches "TELEGRAM_BOT_TOKEN never set" before deploy. Once §3 lands this is a softer check, but still valuable as a pre-deploy sanity gate.
- **Migration direction:** confirm the new schema_version ≥ current and that a **volume snapshot exists** (forward-only migrations, no clean rollback — memory note). Refuse to deploy prod without a fresh snapshot id.

**6b. Staging parity — staging must exercise an agent end-to-end [bigger, important].** The single biggest miss: prod and staging shared the same broken `pathToClaudeCodeExecutable`, but staging has no live messaging so its broken agent image went unnoticed. Fix by running the §1 smoke test (especially **check C**, the synthetic round-trip) against **staging** as a required gate before prod. Staging doesn't need a real channel — the smoke test injects a synthetic message to the smoke-test agent group, which is exactly the missing coverage. This is the highest-leverage *process* change: it turns staging from "deploys cleanly" into "actually serves a reply."

**6c. Write the playbook [quick win].** A short `docs/upgrade-recovery.md` addendum (the file exists): the canonical order — snapshot → preflight → deploy staging → smoke staging → deploy prod → smoke prod → verify OneCLI on 0.0.0.0 — with the exact commands. Replaces tribal knowledge with a checklist.

---

## 7. Reduce manual VM surgery [mix]

Which of the night's manual steps can be made idempotent/automatic:

| Manual step that night | Fixable? | How |
|---|---|---|
| OneCLI gateway upgrade (installer re-run) | **Partial [bigger]** | The entrypoint §2.5 already bootstraps if *missing*, but not if *stale-but-running*. Add a version check: if the running gateway's version < `ONECLI_MIN_VERSION`, re-run the installer (which preserves vault volumes on `/data`). Gated by a flag so an unattended boot can't surprise-upgrade prod. Until then, §6a's preflight at least *catches* it before deploy. |
| 0.0.0.0 rebind | **Already automatic [done]** | Entrypoint §2.5 (fly-entrypoint.sh:143-153) normalizes any non-0.0.0.0 binding to 0.0.0.0 on every boot. The night's manual rebind was because the installer ran *outside* boot; folding the upgrade into the entrypoint (row above) makes the rebind fire too. |
| `docker builder prune` | **Automatic [quick win]** | §4a — run it in the entrypoint when a rebuild is triggered. |
| Per-group `:ag-` rebuild | **Automatic [bigger]** | §4b — enumerate + rebuild group images when `:latest` changes. |
| `.env` regeneration drift | **Eliminated [quick win]** | §3 — `process.env` fallback removes the need to touch the entrypoint for new secrets. |

---

## Priorities (what to do, in order)

**Highest leverage (do first):**
1. **§3 `readEnvFile` → `process.env` fallback** [quick win] — kills the entire allowlist-drift bug class in ~5 lines; failure 1 can't recur.
2. **§2b add a structured `agent.query-error` event** [quick win] — keep the chat error delivery (operator wants infra errors in-channel — it's how this break was caught); just emit the structured event alongside so the dashboard + smoke test can read it. ~5 additive lines in `poll-loop.ts`, no behavior change to chat.
3. **§1 + §6b post-deploy smoke test run against staging as a required gate** [bigger] — turns "staging deployed clean" into "an agent actually replied," catching failures 2/4/5 before prod. This is the structural fix for "under-prepared upgrade."

**Then:** §2a/§2c structured startup+error events (feeds the smoke test and the dashboard) → §5a/§5b observability defaults → §4a builder-prune + §4c docs → §6a/§6c preflight + playbook → §4b/§7 per-group image automation.

## Files this plan touches (for the implementer)

- `nanoclaw/src/env.ts:11` — `process.env` fallback (§3)
- `nanoclaw/container/agent-runner/src/poll-loop.ts:301-308` — KEEP chat error delivery; ADD `agent.query-error` structured event alongside (§2b)
- `nanoclaw/container/agent-runner/src/providers/claude.ts` — `agent.claude-init-failed` structured event (§2c; no suppression — chat delivery stays)
- `nanoclaw/src/channels/channel-registry.ts:124-172` — `channel.startup-summary` event (§2a)
- `nanoclaw/realtime/src/log-events.ts` + Python mirror — declare new kinds (§2)
- `nanoclaw/scripts/fly-entrypoint.sh:186-210` — `docker builder prune` on rebuild; per-group image rebuild; OneCLI version check (§4a, §4b, §7)
- `nanoclaw/src/container-runner.ts:694-728` — reuse per-group build path for §4b
- `nanoclaw/src/admin/index.ts:786-797` — default-view debug toggle (§5a); link container-stderr in `/admin/monitor` (§5c)
- new: `scripts/post-deploy-smoke.sh`, `scripts/preflight-nanoclaw-deploy.sh` (§1, §6a)
- existing reuse: `scripts/init-realtime-smoketest-agent.ts` (smoke check C), `scripts/pat-trace.py` (§5d)
- docs: `docs/build-and-runtime.md` (§4c), `docs/upgrade-recovery.md` (§6c), `docs/log-schema.md` (§5a); AGENTS.md "Deploying" table (deploy wrapper)
