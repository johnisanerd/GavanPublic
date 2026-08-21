# One Flow, Well

**Status:** speculative — captures intent, verified facts, open questions, and candidate work for the operator-demo focus. Scope and sequencing not yet committed. Updates expected as decisions land.

**Last updated:** 2026-05-20

## Why this exists

Management asked for one thing working well before any new feature work. The "one thing" is a specific end-to-end demo (described below). Everything in this plan exists to make that demo bulletproof, observable to the operator, and re-runnable.

Two cross-cutting themes:
1. **Pat needs accurate self-knowledge** — both to answer "how do you work" honestly when asked, and to avoid refusing things it can actually do.
2. **The operator needs visibility** — into agent groups, capabilities, sessions, file/DB state — both to debug and to grok.

## The demo flow (the spine)

The user story everything is in service of:

0. **A new operator is registered with Pat.** Pat knows them by phone and recognizes a small set of Signal handles they can be reached at. How registration happens reliably is itself an open question — see Q7.
1. Operator picks up their Apple Watch, calls Pat (PSTN). Pat recognizes them.
2. Banters with Pat briefly.
3. Asks Pat questions about itself — its architecture, capabilities.
4. Asks Pat to do real work: "find a recent research paper of ours, generate an infographic, make it funny / cartoon-style. Send it to the Signal number ending in 4959." The "ending in 4959" disambiguates from the small set of known Signal handles — Pat doesn't have to resolve "me," it just has to pick from a list.
5. Pat asks a clarifying question if needed, then confirms it's going to do it.
6. Operator **hangs up**. Work continues server-side.
7. Infographic lands on the specified Signal number a few minutes later.

**MVP**: steps 0–7 above. Disambiguation by suffix is the MVP "me" resolution.
**Stretch A**: third-party recipient (a Senator) — a Signal number not in the known set.
**Stretch B**: operator calls back later, asks for a modified version, gets it.
**Reach 1**: Pat acknowledges with a rough ETA ("on it, ~3 min") before the operator hangs up. Reach because it requires dynamic prompt templating to know the ETA — folded into §2a / Q4.
**Reach 2**: Pat does not spontaneously ping the third-party afterward (only relevant if Stretch A is in).

## What we know works today (verified)

| Step | Status | Notes |
|---|---|---|
| Step 0 — operator registration | ❌ | No reliable repeatable flow today. Whatever's there has accreted manually. PSTN-side has `PAT_OWNER_PHONES` env-var auto-elevation; Signal has no equivalent. The "how" is itself an open question — see Q7. |
| PSTN call → banter | ✅ | Voice-transport + realtime layer working in prod. |
| Pat answers about itself | ⚠️ | Only as far as hand-maintained prose at `realtime/src/prompts/_back-mind-capabilities.ts` goes. Front-mind doesn't see `agent_group_id`; back-mind has no architectural docs mounted. |
| Real work (research + infographic) | ✅ | Back-mind container has WebSearch + image-gen via OpenRouter. |
| Clarifying question | ✅ | `ask_user_question` MCP tool exists, voice-renderable. |
| Hang-up and keep working | ✅ | Container doesn't terminate on call-end. Delivery polls keep firing. Confirmed via `nanoclaw/src/host-sweep.ts` + `nanoclaw/src/delivery.ts` review. |
| Acknowledge-with-ETA | ❌ | No existing primitive. Downgraded to reach goal — folded into dynamic prompt templating (Q4). |
| Cold-contact Signal send (any new handle) | ❌ | **Never actually verified working end-to-end** despite many attempts. Code paths exist (`nanoclaw/src/delivery.ts:263` cold-contact materialization), but real-world delivery has not been confirmed. New burner phone available for fresh testing. |
| Send to known Signal handle (already registered) | ⚠️ | Mechanically should work but depends on step 0 being solved and on Pat seeing the known-handles list in its templated context (Q2/Q4). |
| Admin approval card flow end-to-end | ⚠️ | Code primitives exist (`src/modules/approvals/primitive.ts`) but not known-good in practice; critical dependency for Q3. |
| Operator hangs up, then calls back to modify | ⚠️ | Each call gets a NEW `thread_id` → new session. Operator can't continue the original conversation — they'd be starting fresh. |
| No future spontaneous pings | ❌ | `agent_destinations` grant from cold-contact is persistent today; needs change to gate on approval. |

## Open questions to answer before code

These are decisions, not facts. Recommendations are starting points; the user weighs in.

**Q1. Per-agent-group capabilities — real or simplifying assumption?**
*Reality:* Per-group axes are real (MCP servers, mounts, packages, skills selection, provider, channel access). In current installs both example groups have `"skills": "all"` and empty MCP servers, so variation is unexercised.
*Recommendation:* Treat capabilities as per-group from the start. Thread `agent_group_id` through the front-mind context — independently useful, no extra cost over same-for-everyone.

**Q2. "Me" resolution — simplified to disambiguation from a known list.**
*Reality:* Real cross-channel identity unification is hard and gets avoided. The operator only has 5–6 Signal handles registered total.
*Recommendation:* Don't resolve "me." The operator says "send it to the Signal number ending in 4959" — Pat picks from the small list of known handles. The list goes into the dynamically-templated front-mind context (Q4). Confirmation pattern as fallback when ambiguous. This sidesteps identity unification entirely for the MVP.

**Q3. Outbound approval shape for new recipients — gated on whether admin approval cards actually work end-to-end.**
*Reality:* Cold-contact send has never been verified working in practice despite many attempts. Admin approval card flow isn't yet known-good either. Both must be proved out before anything downstream is meaningful.
*Recommendation (if and only if approval cards actually work):* Drop the first-vs-future distinction. Every send to a never-registered handle requires admin approval. Once approved, the handle is **registered** and subsequent sends to it route through normal known-handle delivery without re-asking. Per-message approval after registration is explicitly not the goal — that's overkill and adds friction. Critical gating dependency: until approval cards are reliable, this whole branch is blocked.

**Q4. Dynamic prompt templating — done well, deterministic-first.**
*Framing:* Dynamic prompt generation is a muscle worth building, not a corner to cut. The same machinery is needed in several places — front-mind capabilities, back-mind architecture, ETA hints, known-recipients list, "channel + platform ID in context window" wiring, future expansions. The previous instinct to do this in an ad-hoc way (and prior pushback on doing it properly) was wrong; the right approach is to do it well from the start.
*Recommendation:*
- **Deterministic by default.** A `realtime/src/capabilities.ts` (and counterparts as needed) module walks the channel registry, container.json MCP server map, skill selection, agent group identity, registered known Signal handles, ETA hints, and renders a structured block.
- **LLM at build time only if a specific part is significantly easier or better that way.** E.g. natural-language paraphrasing of capability blurbs for the front-mind voice context. Build-time, not runtime, to keep latency deterministic.
- **Applied to:**
  - Front-mind (minimal, intersection-of-capabilities-and-agent-group). Explicit don't-hallucinate carve-outs.
  - Back-mind (extensive: architectural docs auto-mounted RO at `/app/docs` and referenced from CLAUDE.md).
  - Known-recipients list for "me" disambiguation (Q2).
  - ETA hints when available (Q6).
  - Anywhere else where the prompt needs to vary by what's actually wired up.

**Q5. Smoke-test scope — one canonical, or folder for many?**
*Recommendation:* Set up the folder structure (`smoketest/use-cases/<name>/`), fill only the operator-demo one for now. Folder is cheap; future use-cases will want the same shape.

**Q6. Acknowledge-with-ETA — reach goal, piggybacked on dynamic templating.**
*Recommendation:* Downgraded from MVP to reach. If we have any ETA hint (from request-layer classifying the task, prior similar tasks, or any heuristic source), inject it into the templated front-mind context (Q4). Front-mind banter renders it as part of the acknowledgment. No new primitive needed beyond the templating work — that's why it folds in cleanly.

**Q7. Operator registration (step 0) — how does a new operator get reliably onboarded?**
*Reality:* No reliable flow today. Owner-elevation only covers PSTN (via `PAT_OWNER_PHONES` env var); Signal-side has no equivalent. Whatever works currently has accreted manually.
*Candidate shapes:*
- (a) A `scripts/register-operator` CLI: takes phone + signal-handle(s), seeds `users`, `user_roles`, `messaging_groups`, `user_dms`, optionally `agent_destinations`. Idempotent. Run by the install operator.
- (b) Self-service via voice: operator calls Pat from PSTN (already auto-elevated via env var), says "register my Signal at +1808...4959", Pat writes the rows via a registration MCP tool. End-user-admin pattern.
- (c) End-user pairing (long-term shape from §6): operator initiates from one channel, confirms on another.
*Recommendation:* Start with (a). It's conceptually the inverse of the smoke test's scrub script, so the two are natural twins. (b) follows naturally once (a) exists and the dynamic templating (Q4) exposes a "register a handle for me" tool to the front-mind.

## Goal areas

None are committed — they're shapes to evaluate before deciding sequencing.

### 1. Smoke-test pattern (the gate)

**Goal:** A human-driven, repeatable verification that the demo flow works end-to-end. When edge cases surface, capture them as additions to the playbook.

**Shape:**
- `smoketest/use-cases/operator-to-signal/`
  - `scrub.ts` — deterministic state reset. Deletes `pstn:+E164` + `signal:+E164` user rows, their `user_roles`, their `messaging_groups`, their `user_dms`, their `agent_destinations`, optionally their session folders. Takes E164 as arg.
  - `playbook.md` — numbered human checklist. Each step has: action, success criterion, "if it fails, check X" pointer.
  - `runs/<date>.md` — append-only log of past runs and outcomes.
- `scripts/smoketest` wrapper — `smoketest run operator-to-signal +E164` runs scrub, prints playbook, prompts for human "done / failed" marks per step, persists to `runs/`.
- Distinct from `smoketest/scenarios/*.ts` (the existing automated harness — those stay for CI; this is for human verification of the demo gate).

**Out of scope:** Auto-running the test on a cadence. CI integration. Anything not human-driven.

**Open question:** Dashboard-button trigger, or always shell? Default: shell first.

---

### 2. Self-knowledge — front-mind and back-mind

Two artifacts. Different shapes. Different purposes. Both are concrete first instances of the dynamic prompt templating muscle (Q4).

#### 2a. Front-mind capability context

**Goal:** Front-mind doesn't refuse things Pat can actually do. Can answer simple "can you X?" questions accurately. Carries every piece of dynamic context the front-mind needs to behave well without a back-mind round-trip.

**Shape:**
- `realtime/src/capabilities.ts` — runtime introspection: registered channel adapters (via `getRegisteredChannelNames()` in `nanoclaw/src/channels/channel-registry.ts`), MCP servers wired in `container.json` for this agent group, selected skills, agent group identity.
- Renders a structured block that replaces hand-maintained `_back-mind-capabilities.ts`.
- Injected into `request-layer.ts` and `banter.ts` prompts.
- Explicit carve-outs: "If asked about a capability not in this list, say you can't do it directly and offer to consult back-mind. Do not hallucinate."
- Thread `agent_group_id` through the request-layer context for per-group scoping.

**Also carried in the same templated block:**
- The list of known Signal/PSTN handles for the current caller's E164, computed via suffix-match heuristic (§5). Powers "me ending in 4959" disambiguation (Q2).
- The inbound channel + platform ID for this thread (§4 caller-identity wire feeds this in).
- Any ETA hints when available. **There is no separate acknowledgment-with-ETA goal area** — ETA is just another field in this block. Front-mind banter voices it naturally when present.

**Out of scope:** Real-time updates as channels are added (refresh on container spawn is fine).

#### 2b. Back-mind architectural context

**Goal:** Back-mind can accurately answer "how do you work" / "what's your architecture" / "what's the relationship between PAT and NanoClaw."

**Shape:**
- Auto-mount canonical docs into container at `/app/docs` (RO). Candidates (~12-15k tokens total, top 5 ~8-10k):
  - `agentic_toolkit/AGENTS.md`
  - `agentic_toolkit/docs/INDEX.md`
  - `agentic_toolkit/docs/front-mind-design.md`
  - `agentic_toolkit/docs/nanoclaw-internals.md`
  - `agentic_toolkit/nanoclaw/README.md`
  - `agentic_toolkit/nanoclaw/CLAUDE.md`
  - `agentic_toolkit/nanoclaw/docs/architecture.md`
  - `agentic_toolkit/nanoclaw/docs/agent-runner-details.md`
- Reference from composed CLAUDE.md so the agent knows they exist and can `Read` them on demand.

**Out of scope:** Inlining the docs in CLAUDE.md (too token-heavy). Auto-regenerating docs from code.

**Open question:** Is "capability description smoke test" — verify Pat can accurately describe its own capabilities — its own use case?

---

### 3. Outbound approval gate for cold contacts

**Goal:** Agent attempts to send to a never-registered handle → owner approval. After approval, the handle is registered and subsequent sends to it are normal known-handle sends (no further approval per send).

**Critical dependency:** the admin approval card flow has to actually work reliably end-to-end. Neither the approval card delivery nor the cold-contact send have been verified working in practice. **Verification of both is a prerequisite to any further work here.** Until they're proven, this whole branch is blocked.

**Shape:**
- Before `maybeMaterializeColdContact` in `nanoclaw/src/delivery.ts:263`, fire `requestApproval` with action `outbound_cold_contact`, payload `{target_handle, channel, message_preview, agent_group_id, justification}`.
- New handler in `nanoclaw/src/modules/cold-outbound/` registers with the approvals primitive. On approve → run materialization + deliver. The handle is now registered; future sends to it route through normal known-handle delivery without re-asking.
- On reject → system message back to agent.

**Out of scope:** Approval flow for agent-to-agent sends. Approval flow for known-handle sends (no change needed). Per-message approval after a handle is approved — explicitly not the goal.

---

### 4. Caller identity / channel+platform-id always in context

**Goal:** Every thread's prompt context unconditionally includes the inbound channel + platform ID. Not optional. The agent should never have to guess who's talking to it.

**Shape:**
- `transports/main.py` POST `/inbound` always includes `caller_number` in the payload (today it's conditional — that's the bug).
- `messages_in.content` carries `senderId: "pstn:+E164"` consistently.
- `nanoclaw/container/agent-runner/src/formatter.ts` surfaces channel + platform ID in the agent's prompt block at least once per thread. Doesn't need to be repeated on every message — just needs to be present in the context window somewhere the agent will see it.
- This is also the source the front-mind's templated capability context (§2a) reads for "me" disambiguation.

**Out of scope:** Repeating identity on every message (noisy). Cross-channel identity unification — see §5.

---

### 5. Cross-channel identity — suffix-match heuristic as MVP

**Long-term shape:** see [`plans/person-identity.md`](./person-identity.md) for the full Person concept (`people` table, per-person memory files, verification rerouting, dashboard CRUD). This section captures the demo's minimum-MVP path only — pure compute, no schema. Both are compatible: the demo can ship on this MVP and the Person concept can land later without rework.

**Goal (MVP):** When the operator says "me on Signal," Pat can resolve that to the right Signal handle without DB schema changes or identity unification.

**Shape (MVP, suffix-match heuristic):**
- Pure-function helper: takes a `pstn:+E164` and returns any matching `signal:+E164`, `whatsapp:+E164`, etc. by suffix match on the E164.
- **No DB storage** — pure compute over existing `users` rows. This is the property that makes it cheap enough to just always do.
- Two implementation surfaces, not mutually exclusive:
  - (a) **Auto-populate into templated context:** when rendering §2a's capability block, run the suffix match on the caller's identity and include the matched handles. Default path.
  - (b) **Agent-callable:** a `find_other_channels_for_user` MCP tool / skill the agent invokes on its own initiative ("I have the caller's phone; let me check if I have a Signal for them too").

**Why suffix-match is fine for now:** Channels we actually care about right now are phone-bearing (PSTN, Signal). The heuristic is reliable inside that universe. Limitations only bite when we add channels that don't carry E164.

**Long-term shapes (post-MVP, when we need cross-channel identity beyond phone-bearing channels):**
- **Alias table.** `user_aliases (canonical_user_id, channel_type, handle)`. Schema lift; retrofit needed.
- **End-user pairing flow.** Owner DMs themselves a code on the new channel, replies via existing channel to confirm.

**For the demo:** Suffix-match heuristic only. Document the limitation. Defer the schema lift indefinitely until something forces it.

---

### 6. Visibility / dashboard surfaces

**Goal:** Operator can grok what's going on without SSH-ing into a SQLite DB.

**Update cadence:** Push-based event hooks ideal; tight 1–2s pull acceptable as fallback. More real-time = easier to debug. Even sub-second pulls aren't crazy if they're cheap (SQLite reads are microseconds).

**Unifying primitive:** **active-thread context that carries across tabs.** Pick a thread once — every other tab filters/highlights to that thread's agent group and session. Today `useDashboardState` tracks `knownThreads` but selection is transient (in-memory React, no localStorage); rebuilding this with URL-param persistence is the cross-cutting first step. This filtering across tabs is probably also enough to obviate the data-lineage moonshot (see 6e).

#### 6a. Conversation Lens (priority)
New pat-frontend tab. Pick a thread → see: agent_group identity, session_id, messaging_group, users involved + roles, `agent_destinations` ACL for that agent, last N inbound/outbound rows, "scrub-state" button (calls the same scrubber as the smoke test).
Done = "what does this agent know about me right now" answerable by clicking, not by querying SQLite.

#### 6b. Capability tab
What this agent group has access to: channels, MCP tools, skills, external MCP servers. Visually distinguished from "globally installed but not wired to this group."
Source: the same `realtime/src/capabilities.ts` introspection that feeds front-mind (§2a).
Sub-goal: make the skills-vs-tools distinction legible. (It's a 10-category taxonomy — see the taxonomy section below for the underneath, but the UI itself can simplify the presentation.)

#### 6c. Filesystem tab
Per-agent-group: what's in `nanoclaw/groups/<folder>/`. Per-session: what's in `nanoclaw/data/v2-sessions/<ag>/<sess>/`. Read-only. With active-thread context: highlight "this thread's files" vs the global view.

#### 6d. Database tab
Read-only browser over central `v2.db` tables (`users`, `agent_groups`, `sessions`, `user_roles`, `agent_destinations`, `messaging_groups`). With active-thread context: highlight rows that pertain to the selected thread.

#### 6e. Data-lineage view (probably not needed)
Was a moonshot: highlight which DB cells a thread can read. Probably obviated by the active-thread context filtering across 6a–6d — if "this thread's stuff" is already visually distinguished in every tab, the cell-level view doesn't add much. Drop unless a concrete use case re-surfaces it.

#### 6f. People tab (demo-prep prerequisite)
CRUD UI for `people` rows AND `users` rows (per-channel handles) AND person↔user linkage AND memory file browsing. **Not deferred** — needed for demo prep so the operator can seed themselves and a few test contacts (including handles that have never DM'd Pat) without raw SQL. Full design at [`plans/person-identity.md`](./person-identity.md) (Dashboard CRUD section). Depends on the Person concept being implemented; if we ship the suffix-match-only MVP without `people` (§5), the people-side defers but the users-CRUD side is still useful (handles that haven't messaged Pat yet need to exist as `users` rows for the agent to be able to dispatch to them).

**Open question:** Build 6a first as the unblock, or build 6b (capability tab) first since it directly serves demo step 3? Default: 6a first; capability tab follows. 6f follows whenever the Person concept lands.

---

### 7. Cross-thread retrieval tool

**Goal:** When a new session starts — e.g., operator calls back after a hangup, fresh thread, fresh session — the agent can pull context from prior sessions with the same platform ID. Even though true session continuity doesn't exist.

**Shape:**
- Tool or skill — implementation choice TBD. Agent-callable, not auto-inlined into every prompt.
- Returns: recent inbound + outbound from prior sessions matching the caller's platform ID. Bounded by recency (last N sessions or last X days).
- Implementation: queries central `sessions` table for sessions with matching `messaging_groups → platform_id`, reads relevant content from those sessions' `inbound.db` and `outbound.db`.
- The agent invokes when relevant ("the caller is `pstn:+E164`; do I have any prior threads with them?") — keeps the prompt clean by default and pulls history only when useful.

**Why this matters for the demo:** Call-back-with-mod (Stretch B) doesn't need true session continuity if the agent can reach back across threads. Operator calls back → fresh session → agent sees "I have a thread with this caller from 5 minutes ago about an infographic" → reads it → continues the work. Different mechanism, same outcome.

**Out of scope:** Auto-inlining cross-thread context into every prompt (too noisy). Real session-continuity proper. Mid-query interruption.

---

## Skills vs tools — the taxonomy underneath the UI

The user said they don't understand the difference. Reality check: there isn't a clean binary. There are 10 distinct capability-bearing concepts in NanoClaw v2:

| Category | Type | Where on disk | Agent-callable? | Per-group or install-wide? |
|---|---|---|---|---|
| Container skills | passive instruction-load | `nanoclaw/container/skills/<name>/` | No (shape behavior) | Per-group (via `container.json:skills`) |
| Operational skills | host-side workflow | `nanoclaw/.claude/skills/<name>/` | User-invoked via Claude Code | Install-wide |
| Feature skills | branch-merge install | `nanoclaw/.claude/skills/add-*/` | User-invoked | Install-wide effect |
| Utility skills | self-contained code | `nanoclaw/.claude/skills/<name>/` | User-invoked | Install-wide |
| In-tree MCP tools | agent-callable | `nanoclaw/container/agent-runner/src/mcp-tools/*.ts` | Yes (`send_message`, etc.) | Install-wide |
| SDK-native tools | agent-callable | filtered by `claude.ts` allowlist | Yes (`Bash`, `Read`, `Edit`) | Install-wide |
| External MCP servers | agent-callable | `container.json:mcpServers` | Yes (`mcp__<server>__<tool>`) | Per-group |
| Slash commands | gated text | `nanoclaw/src/command-gate.ts:14-15` | Pass-through, admin, or filtered | Per-group (via `user_roles`) |
| Channel adapters | host-side transport | `nanoclaw/src/channels/<name>.ts` | No (agent uses `send_message` → routes here) | Install-wide on host; per-group wiring |
| Permissions & approvals | gating system | `nanoclaw/src/modules/permissions/`, `modules/approvals/` | No | Per-group (via `user_roles`, `agent_destinations`) |

**Working definition of "capability"** for the UI: any discrete affordance the agent can invoke, or the operator can configure, that affects what this agent group can do. Organized by: (1) passive behavior, (2) agent-callable actions, (3) operator-configurable surfaces, (4) observability points.

---

## Cross-cutting principles

- **Dynamic prompt generation is a muscle, not a corner to cut.** This system needs templated, intersection-aware prompts in many places — front-mind capabilities, back-mind architecture, known-recipients list, ETA hints, caller identity, future expansions. Build it well. Deterministic-first; LLM-at-build-time only where a specific section is significantly easier or better that way. Avoid runtime LLM templating where it adds latency or nondeterminism. (Specific application: "auto-generate over hand-maintain" — static prose lies; runtime introspection doesn't.)
- **Verify with the smoke test, not in your head.** Every gap above is provable by a step in the playbook that fails.
- **Visibility is the unblock.** The operator can't grok the system without it, and can't trust the demo without grokking. Push hooks or tight pull — real-time > batched.
- **End-user admin > centralized admin > dashboard.** When designing approval / pairing / config flows.
- **MVP first; stretch later.** Step 0 + steps 1–7 in the simple form → ship. ETA, Senator-targeting, call-back-with-mod, cancellation can land later.

## Deliberately deferred (and why)

- **Cross-channel identity unification beyond suffix-match.** Suffix-match heuristic (§5) covers phone-bearing channels; alias table or end-user pairing only matters when we add channels that don't carry E164.
- **Per-call thread continuity / true session-reuse on call-back.** Cross-thread retrieval tool (§7) is the practical alternative for the demo's Stretch B — fresh session can pull from prior threads via tool call instead.
- **Mid-query interruption.** Back-mind doesn't support it; new messages queue and process after current query. Not blocking the demo. Related to cancellation (below).
- **Cancellation of in-flight back-mind work.** Reach goal. Related to call-back-with-mod: if the operator calls back to redirect, the original work may need to be cancelled rather than completed-then-superseded. Worth investigating but not on the MVP path.
- **Approval flow for agent-to-agent sends.** Separate problem.
- **Per-message approval after a handle is approved.** Once approved, treated as known. Explicitly not in the goal.
- **Data-lineage cell-highlighting view (was 6e).** Probably obviated by active-thread context filtering across the dashboard tabs.
- **Capability-description smoke test as its own use case.** Plausible second use-case after the demo gate.
- **Streaming docs into CLAUDE.md inline.** Mount + reference, don't inline (token cost).

## Decision log (things we explicitly learned)

- Per-agent-group capabilities are real (5+ axes), but underexercised in current installs.
- Hang-up-then-deliver works today.
- Call-back-with-mod doesn't need true session continuity if a cross-thread retrieval tool (§7) exists. That's the path we're pursuing.
- Caller-identity wire needs the inbound channel + platform ID always in the thread's context window. Today it's conditional in the `/inbound` POST — that's the gap.
- Back-mind sees only group folder + composed CLAUDE.md; no architectural docs mounted; auto-injection feasible but not wired.
- Skills vs tools is a 10-category taxonomy, not a binary distinction.
- Dashboard has 2 tabs (logs, timeline). No cross-tab active-thread state, no DB/FS browsers. Push hooks or 1–2s pull cadence preferred for any new surfaces.
- `agent_destinations` cold-contact grant is persistent — direct cause of the "no spontaneous future pings" failure mode, fixed by gating cold-contact materialization on owner approval.
- Cold-contact Signal send has never been verified working end-to-end despite many attempts. Admin approval card flow isn't known-good in practice either. Both are critical-dependency prerequisites for §3.
- ETA acknowledgment is not its own goal area — folds into the templated front-mind capability context (§2a).
- "Me" resolution simplified to disambiguation from a small list of known Signal handles. Operator says "ending in 4959", Pat picks. No identity unification needed for MVP.
- Cross-channel identity: suffix-match heuristic (compute, not stored) is the MVP path — phone-bearing channels (PSTN + Signal) are all we care about for now.
- Dynamic prompt templating is now a first-class principle — done well, deterministic-first, LLM-at-build-time-only-where-significantly-better. Prior pushback on doing it properly was wrong.
- Cancellation of in-flight work is reach. Probably needed eventually for call-back-with-mod.
- Data-lineage cell-highlighting view is probably not needed if active-thread context filtering across tabs is the simpler way.
