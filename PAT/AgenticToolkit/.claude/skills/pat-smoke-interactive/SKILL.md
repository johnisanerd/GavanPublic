---
name: pat-smoke-interactive
description: >
  YOU run an interactive, judgment-driven smoke test of a deployed PAT — the
  way a sharp human QA operator would: send a message, look at what came back
  AND what happened internally, use judgment, adapt, chase anything that feels
  off. Invoke after a staging deploy, for "smoke it yourself", "actually go
  through PAT", "does this feel right end-to-end". This is NOT the scripted
  `pnpm run smoke` suite — here the agent IS the tester and the grader.
---

# pat-smoke-interactive — you are the smoke tester

The scripted suite (`/pat-smoke`) drives fixed scripts and grades with an LLM
judge. **This skill is different: you drive PAT turn-by-turn with your own
judgment.** A smoke test exists because a smart operator goes through the
product, notices things, and decides "is this actually good." You are that
operator. An Opus agent is a perfectly good one — lean into it.

Work through the steps below. Each has an **Intention** (what you're verifying
+ what *good* looks like), a **Do**, a **Verify** (which primitive to look at),
and **Judgment** (what to weigh, red flags). Don't robotically execute — if a
step surprises you, chase it with the inspection primitives before moving on.
Adapt the wording; the intentions are the contract, not the exact strings.

## Primitives (run from `agentic_toolkit/smoketest/`)

- **Drive PAT:** `npx tsx src/chat.ts "<message>" --thread=smoke1`
  → prints PAT's reply on stdout. Stable `--thread` keeps ONE conversation.
  Send `npx tsx src/chat.ts "/clear" --thread=smoke1` to reset the session.
- **Inspect internals:** `npx tsx src/trace.ts --tools` (which MCP tools fired +
  their inputs/results), `npx tsx src/trace.ts --since=10m` (routing, errors,
  deliveries). This is "what actually happened server-side" — trust it over
  the chat reply.
- **See user-facing signal outbound:** `npx tsx src/trace.ts --captured`
  → renders what a (simulated) Signal user would have received: 🎤 voice memos
  *with their spoken text*, 📎 files, 💬 replies. This is your "what am I
  getting from signal" pane.
- **Drive a REAL VOICE CALL (agentic — the primary way to test voice, 2026-07-06):**
  `npx tsx src/call.ts start` → dials staging over the real Cartesia leg (TTS →
  STT → front/back-mind → TTS), prints the call thread when live. Then converse
  turn-by-turn:
  - `npx tsx src/call.ts say "<text>"` — speak (async; queues the clip). Add
    `--wait` to block until fully spoken — exits 3 with the reason if the clip
    was interrupted/failed. A failed say also auto-surfaces loudly on your NEXT
    say/listen, so you can't miss a swallowed turn.
  - `npx tsx src/call.ts listen [--timeout 60]` — blocks until PAT's NEXT spoken
    utterance appears in the trace, prints it (exit 2 on timeout; flags
    `[interrupted mid-utterance]` if it was cut off). Repeatable — each call
    returns the next utterance (banter acks and answers arrive as separate
    utterances; keep listening).
  - `npx tsx src/call.ts status` / `hangup` — hangup flushes `call.wav` (both
    sides mixed) into `smoketest/artifacts/` for human listening.
  Env self-bootstraps from `.env.agent`; daemon log at `smoketest/.call-daemon.log`.
  Run the SAME walkthrough steps below over voice — plant facts, back-reference,
  judge the answers. **Caller identity (since the 2026-07-06 pre-auth deploy):**
  with `SMOKE_PREAUTH_TOKEN` in `.env.agent`, smoke calls auto-pre-auth as
  **Smoke McGee** (`pstn:+15005550006`, person-linked → `/personal` mounts;
  same person as the sim-signal rig, so voice+signal share per-person memory
  BY DESIGN). `SMOKE_PREAUTH=0` reverts to anonymous `realtime:websocket`
  (no person, no `/personal`; facts land in shared group memory). Note which
  identity each call ran as — don't mis-attribute behavioral deltas.
  **Reading `listen` output (learned 2026-07-06):**
  - `<emotion value="…">`, `<break time="…"/>`, `<spell>`, `[laughter]` in an
    utterance are **legit Cartesia Sonic-3 inline voice tags** (see
    `realtime/src/prompts/_voice-tags.ts`) — Cartesia renders them as affect,
    NOT speech. Do not report them as leaks. **Layer tags ARE leaks**:
    `<current_back_mind_progress>`, `<back_mind_result>`, `<narration>`,
    `<request_layer>` etc. spoken in an utterance means a front-mind layer
    violated its DO-NOT-EMIT clause — confirm at the wire with
    `kind='cartesia.agent-text-sent'` in patobs (word-by-word stream; if the
    tag text appears there, the caller heard it).
  - `listen` often prints the same sentence 2-3×. Some of that is trace
    rendering, but narration + banter-render genuinely DO speak near-identical
    content back-to-back (verify true duplication via the
    `cartesia.agent-text-sent` word sequence, not the listen printout).
  - Utterances arrive in this typical order per ask: banter ack ("lemme…") →
    0-N narration status lines → the render of the back-mind answer. Budget
    2-4 `listen` calls per substantive ask; `--timeout 90` for tool-heavy asks.
  - **After a barge-in, `listen` prints the FULL queued text of the
    interrupted utterance** even though the caller only heard part of it —
    ground truth for "what was actually heard" is `cartesia.agent-turn-boundary`
    (the interrupted turn's `edge=stop` lands within ms of `bargein.received`).
- **Barge-in probe recipe (2026-07-06):** ask for a ~60s spoken answer
  (`--wait`), sleep ~12-15s so PAT is mid-answer, `say` an interruption
  WITHOUT `--wait`, then listen. Judge three things: (1) mechanical cut —
  `bargein.received` → interrupted turn `edge=stop` should be near-instant
  (17ms observed); (2) the interruption gets answered; (3) re-anchoring —
  PAT won't proactively offer to resume (observed), but "where were we?"
  should restore exact position (it did, including its own pending question).
- **Verify real side-effects:** `curl` a published URL, etc. (plain Bash.)
- **Deep dive when needed:** the `patobs` MCP (`query`). Staging now runs
  `LOG_LEVEL=debug`, so **`llm.call` (the agent's raw prompt/response) IS in
  patobs on staging** — use it to see exactly what the model was sent/returned.
  For routing/continuity questions, `request-layer.decided` (`data_decision` =
  `noop` | `forward` | `wake` + `data_reason`) is the fastest signal (steps 8–9);
  `agent.tool_use`/`agent.tool_result` show tool calls.

Below, `chat "…"` / `trace …` are shorthand for those `npx tsx src/…` commands.

## Setup (once)

1. `cd agentic_toolkit/smoketest`.
2. Creds auto-load from repo-root `.env.agent` (`smoke-trace` pulls the
   viewer token; `smoke-chat` defaults to the tunnel). No manual export needed.
3. Tunnel to the deployed host (rest channel is 6PN-internal):
   `env -u FLY_API_TOKEN -u FLY_ACCESS_TOKEN flyctl proxy 8765:8765 -a pat-nanoclaw-staging &`
   Wait until `curl -s http://127.0.0.1:8765/` responds — ANY JSON reply,
   including `{"error":"not found"}`, means the tunnel is live (that's just the
   root path 404ing). (If a tunnel is already up on :8765, use it.) For the
   **signal layer**, also tunnel the sim inbound:
   `env -u FLY_API_TOKEN -u FLY_ACCESS_TOKEN flyctl proxy 8769:8769 -a pat-nanoclaw-staging &`
   (confirm `curl -s http://127.0.0.1:8769/health` → `{"ok":true,...}`).
4. Capture mode: the voice-memo/attachment steps need
   `HOST_PAT_TEST_OUTBOUND_ADAPTER=1` on `pat-nanoclaw-staging` (the
   simulated-Signal capture channel; see KNOWN_ISSUES for why the real rig is
   parked). It's set on staging by default — you'll confirm it *implicitly* at
   steps 5–6 (if `trace --captured` shows the 🎤/📎, it's on). Don't grep a
   `capture-enabled` event; it fires once at boot and won't be in the window.
5. Pick a fresh thread id (e.g. `smoke1`). No `/clear` needed to start — a
   fresh thread id IS a fresh session.

## What you'll see in the trace (benign noise to ignore)

The rest tunnel's `/inbound` ingests as the **realtime (phone-call) channel**,
so the trace shows `inbound.received phone-call` and delivers to
`phone-call:smoketest` — that's expected, not a bug. You'll also see recurring
`MESSAGE DROPPED — unknown sender (approval requested)` and periodic
`call.timed-out idle_ms:300002`. **None of that blocks real work** — ignore it;
judge on the actual tool calls / captured outbound / replies. Also: `smoke-chat`
prints `[source: front-mind | back-mind | admin]` to stderr so you know which
path answered.

**Concurrent-session cross-talk (2026-07-06):** if ANOTHER live call/session
is running on staging (parallel agents do this), `smoke-chat` can print a
front-mind utterance from THAT thread as your "reply" (e.g. a `[source:
front-mind]` non-sequitur on a `--layer=signal` ask, which normally never
routes front-mind). Before reporting it as a PAT bug, check `llm.call` rows
around that ts for a foreign `thread_id` — your real reply usually lands in
`trace --captured` seconds later.

## Which layer to drive (`--layer`) — front-mind vs straight-to-back-mind

Two paths reach PAT; you can smoke EITHER (or both):
- **`--layer=realtime`** (default) — a phone/anam-style turn: exercises the
  **front-mind** (banter/request/narration) → back-mind. Use when you care about
  the two-mind orchestration and the front↔back bridge (the continuity steps 8–9
  live here — that's where the memory-bridge bug shows). Transport: `/inbound`
  via the :8765 tunnel.
- **`--layer=signal`** — inject a REAL Signal-style inbound that routes
  **straight to the back-mind (no front-mind)** and read the captured Signal-out
  — genuine Signal in AND out. Use when you want the back-mind + tools directly,
  without front-mind routing in the way (cleaner/more deterministic for capability
  checks). Transport: the sim inbound on the **:8769 tunnel**; needs capture mode
  (`PAT_TEST_OUTBOUND_ADAPTER=1`). `smoke-chat --layer=signal "..."`.

Same back-mind + same MCP tools either way; the difference is whether the
front-mind is in the loop. For a thorough pass, run the capability steps on
`signal` (isolate the back-mind) AND the continuity steps on `realtime` (exercise
the bridge).

`--layer=signal` transport note: if `smoke-chat` can't reach the sim inbound,
export `SIGNAL_SIM_BASE_URL=http://127.0.0.1:8769` explicitly.

**Identity per layer (verified 2026-07-06):** the sim-signal sender resolves to
a REAL person (`person-c45b8b2e…`) on staging → the `/personal` mount IS
present, so reset-survival and per-person memory are fully testable on the
signal layer (the old "person_id: null → skip" caveat applies to the
realtime/voice smoke sender, not signal). The voice caller
(`realtime:websocket`) has no `/personal`; its back-mind writes facts to the
**shared agent-group memory** (`~/.claude/projects/-workspace-agent/memory/`
inside the container) — which the signal person's sessions ALSO read/write.
Consequence: facts planted on one layer bleed to the other **and get
misattributed as the other person's own facts** (bidirectionally verified
2026-07-06). Treat cross-layer recall as a shared-memory-leak probe, not a
continuity feature.

## Randomize plants with REAL entropy — never from your head

LLM testers are semi-deterministic: across runs you will invent the same
"type" of codeword (BLUEHERON-ish) and the same simple questions. Against a
system with persistent transcripts/memory that produces FALSE PASSES — a
rerun planting last run's codeword can "pass" continuity by recalling the
PREVIOUS run's plant. (Live proof 2026-07-06: the tester independently chose
`BLUEHERON-*` again and PAT surfaced the Jul-4 run's `BLUEHERON-42` — which
was itself a *confabulated* value that had been persisted.)

1. **Generate values from the shell**, e.g.
   `echo "CODENAME-$(openssl rand -hex 3)"` / `echo "$RANDOM"`. Plant THAT
   exact string; verify recall against it character-for-character. Also roll
   the codeword PREFIX (don't keep BLUEHERON): pick from a pool with
   `$((RANDOM % N))`.
2. **Roll question/task variants** instead of choosing: keep small pools
   (arithmetic: {2-digit sum, multiplication, percentage}; publish-file
   content topics; memo phrasings) and select with `$((RANDOM % N))`. Pools
   keep steps comparable across runs; the roll kills determinism.
3. **Never reuse a value that appears anywhere in the thread's prior
   history.** If PAT's recall matches an OLD plant instead of today's, that
   is a FINDING (stale-memory bleed / cross-run contamination), not a pass.

## THE RUN IS ONE CONTINUOUS CONVERSATION — do NOT reset mid-way

**The entire walkthrough happens on a single thread (`smoke1`) as one
accumulating session. Do NOT `/clear` between steps.** The realism is the
whole point: a real user does thing after thing after thing, and the system has
to hold the thread together. You will **plant facts early and refer back to
them later** — that's what catches the state/continuity bugs isolated calls
never surface. The ONLY reset in this run is the explicitly-labeled
Reset-survival section at the very end.

## The walkthrough (use judgment at each; keep going back-to-back)

### 1. Liveness + honest self-knowledge
- **Intention:** PAT is up and describes its *real* capabilities, not a
  generic-assistant hallucination. Good = names things it can actually do
  (Signal/Telegram, publish files, voice memos, web search, remember people).
- **Do:** `chat "hey — who are you, and what can you actually do for me?"`
- **Verify:** the reply (`smoke-chat` prints it whether the front-mind answered
  inline or it forwarded to the back-mind). **Judgment:** coherent + specific +
  accurate? Red flags: invents capabilities it lacks, generic "I'm an AI
  assistant" boilerplate. A genuine `NO REPLY` (rare) → cold-start; re-send once
  and check `trace`.

### 2. Plant facts to reference later (the continuity seed)
- **Intention:** establish session state you'll verify the system still holds
  many turns later, WITHOUT resetting.
- **Do:** `chat "before we get going, hang onto two things for me: my project codename is BLUEHERON-<nonce>, and the file I'm about to have you publish is what I'll call my 'lunch order'. got both?"` (pick a unique `<nonce>`).
- **Verify:** it acknowledges both facts. **Judgment:** did it actually
  register them, or just say "sure"? You'll test recall at steps 8–9.

### 3. Basic reasoning (fast path)
- **Intention:** the front-mind answers a trivial question correctly + tersely.
- **Do:** `chat "quick one: what's 17 times 4? just the number"`
- **Verify:** reply. **Judgment:** correct (68), concise. A rambling essay for
  a trivial question is a smell.

### 4. publish_file — real tool-chain + real side-effect
- **Intention:** the publish chain works AND the URL actually serves. (This is
  the "lunch order" file from step 2 — you'll ask about it later.)
- **Do:** `chat "create a file containing exactly the line SMOKE-<nonce>, publish it with a 2 hour expiry, and reply with just the link"`.
- **Verify:** `curl` the URL → **200 + your nonce**; refetch with
  `&exp=9999999999` → **404** (tamper rejected); `trace --tools` shows
  `publish_file`. **Judgment:** clean link, no invented extra work / leaked
  mechanics?

### 5. Voice memo out — real Cartesia synth (captured)
- **Intention:** the voice pipeline (Cartesia synth → m4a → delivery) works;
  spoken content matches intent.
- **Do:** `chat "send me a voice memo to signal:+15555550123 saying: smoke test <nonce>, the voice pipeline is healthy"`
- **Verify:** `trace --captured` → 🎤 with **audio bytes > 0** and the **spoken
  text** you asked for; `trace --tools` → `send_voice_memo`. **Judgment:** text
  matches? Did PAT *avoid* echoing pipeline status ("Queued.", "Sent ✓") as
  chat — the memo IS the message.

### 6. File attachment out (captured)
- **Intention:** PAT produces a real file and sends it as an attachment.
- **Do:** `chat "make a short text file and send it to the destination named rig-a as a file attachment"`
- **Verify:** `trace --captured` → 📎 file; `trace --tools` → `send_file` (to
  `rig-a`). **Judgment:** actually attached vs. dumped text into chat.

### 7. Web / MCP tool
- **Intention:** an MCP tool is wired end-to-end and grounds the answer.
- **Do:** `chat "search the web and tell me one recent headline about <a current topic>"`
- **Verify:** `trace --tools` shows the MCP tool (e.g. `mcp__exa__…`); the reply
  reflects it. **Judgment:** grounded in a real call, or confabulated with no
  tool use (a fail)?

### 8. CONTINUITY back-reference #1 — what YOU told it (NO clear!)
- **Intention:** the system still holds what you said at step 2, in the SAME
  context — real conversational memory, not a fresh lookup.
- **Do:** `chat "quick memory check — what's my project codename?"`
- **Verify:** recalls `BLUEHERON-<nonce>` from step 2. **Judgment:** exact
  in-context recall = good. Wrong nonce / "I don't have that" = a continuity
  failure — and the diagnostic is NOT "did the session reset." Check
  `request-layer.decided` in `patobs`: if the step-2 plant was handled
  `decision=noop` (front-mind inline), it likely **never reached the back-mind**,
  so a step-8 recall that `forward`s to the back-mind hits a container that never
  saw the fact and **confabulates** a plausible-but-wrong nonce. That
  front-mind↔back-mind bridge gap is a real, known failure mode (KNOWN_ISSUES) —
  confirm via the noop-vs-forward decisions, not the session id.

### 9. CONTINUITY back-reference #2 — what IT did (NO clear!)
- **Intention:** the system remembers what IT did earlier this session, tied to
  your framing — not just what you said.
- **Do:** `chat "what did I nickname that file you published earlier, and what was in it?"`
- **Verify:** recalls it was the "lunch order" (step 2) with the `SMOKE-<nonce>`
  content (step 4). **Judgment:** connecting its own earlier action to your
  earlier framing is real session coherence — the thing a realistic run tests.

### 10. Error surfacing (transparency)
- **Intention:** PAT surfaces the *real* infra/tool error to chat rather than a
  sanitized line — a deliberate feature (AGENTS.md).
- **Do:** `chat "run the shell command 'cat /etc/definitely-not-a-real-file' and tell me exactly what happened"`
- **Verify:** `trace --tools`/`--since=5m` shows the failure; the reply names
  the *actual* error. **Judgment:** transparent (good) vs. vague "something went
  wrong" (bad).

### 11. Coherence + honesty under a multi-part ask
- **Intention:** handles a small multi-step request and is honest about any
  failures rather than confabulating success.
- **Do:** `chat "summarize what you and I just did this whole session in 4 bullets, and if anything failed or felt off, say so plainly"`
- **Verify:** reply vs. what you actually observed across steps 1–10.
  **Judgment:** accurate, admits failures you saw, no invented successes — and
  note whether it reflects the WHOLE continuous session (good) or only the last
  turn (a memory/continuity smell).

### 12. Final sweep
- **Do:** `trace --since=20m` (internal) and `trace --captured`.
- **Judgment:** scan the whole session for anything unexpected — surfaced errors
  you didn't cause, `dropped_message`, `signal.send-failed`, a tool that fired
  that shouldn't have, latency that felt wrong. Chase anything odd.

## Tool-coverage sweep — enumerate the live surface at run time

The single "Web / MCP tool" step under-covers a multi-server surface. **Never
hardcode the tool list — a hardcoded list is a silent coverage hole.**
Enumerate live, then exercise each wired server with one meaningful,
judgeable task. Judge the CONTENT of each result, not that a tool_use fired.

1. **Enumerate from three sources and cross-check:**
   - patobs: `SELECT data_servers FROM pat_events WHERE env='staging' AND
     kind='agent.mcp-servers' ORDER BY _timestamp DESC LIMIT 1` — what the
     container ACTUALLY connected (ground truth).
   - Group config (read-only): `env -u FLY_API_TOKEN -u FLY_ACCESS_TOKEN
     flyctl ssh console -a pat-nanoclaw-staging -C "sh -c 'cd /app/nanoclaw
     && node dist/cli/client.js groups list'"` then
     `... groups config get --id <ag-id>` → `mcp_servers` block.
   - Ask PAT itself ("inventory time: list your tool servers and major
     tools") — judges self-knowledge AND surfaces non-MCP surfaces (image
     gen via OpenRouter, Cartesia, kernel browser) the config won't show.
2. **One judgeable task per server** — pick tasks whose answers YOU can
   verify independently (curl the same page, know the fact). Proven set
   (2026-07-06, all passed):
   - **exa**: "using exa specifically, search for RFC 9110 and quote its
     exact title" → "HTTP Semantics"; verify `mcp__exa__web_search_exa`
     fired.
   - **context7**: "pull the Hono docs, how do you create an app instance,
     quote the docs" → `new Hono()`; verify resolve-library-id + query-docs.
   - **apify**: "use apify's rag-web-browser to load https://example.com,
     give the exact H1" → "Example Domain"; verify
     `mcp__apify__apify--rag-web-browser` (+ get-dataset-items).
   - **firecrawl**: `firecrawl_search` for a current headline AND
     `firecrawl_scrape` a fixed page quoting a checkable sentence.
   - **image gen** (non-MCP; generate-image skill → OpenRouter): "generate a
     solid red triangle centered on white, send as attachment AND publish
     with 2h expiry" → curl the published PNG and **Read it visually** —
     judge the actual pixels, don't stop at byte counts.
   - **nanoclaw core**: already covered by walkthrough steps 4-6
     (publish/memo/file/send_message) + the scheduling probe below.
3. **Verify attribution in one query:** `SELECT ts, data_tool FROM pat_events
   WHERE env='staging' AND kind='agent.tool_use' AND data_tool LIKE 'mcp__%'
   AND ts > '<sweep start>' ORDER BY _timestamp` — confirms the RIGHT server
   answered each ask (PAT substituting firecrawl for exa = a routing finding).
4. **Report a coverage matrix**: server/tool → exercised? → worked? → quality
   verdict, explicitly listing wired-but-broken and wired-but-unexercised.

## Non-enumerable capabilities checklist — hand-curated, keep it current

No enumeration can discover BEHAVIORS. This list exists precisely because of
that — **capability changes MUST update this checklist in the same change.**
Each item: probe recipe + whether it's runnable-solo or operator-gated. Never
skip silently: anything not run goes in the scorecard as NOT COVERED.

- **Time-based behaviors** (runnable-solo): early in the signal run, have PAT
  schedule a reminder ~5-8 min out containing a shell-random token
  (`SCHED-$(openssl rand -hex 3)`); keep working; near the end verify it
  FIRED (`trace --captured` shows the token; `mcp__nanoclaw__schedule_task`
  result shows the run-at). The capability is "it fires later", NOT "the
  tool call succeeded". (2026-07-06: fired 3s after target. Also exercise
  list/cancel occasionally.)
- **Realtime dynamics** (runnable-solo, voice): (a) barge-in recovery — say
  something WHILE PAT is mid-answer; judge: does it stop, yield, resume or
  re-anchor sensibly? (b) narration cadence during a slow back-mind task —
  are fillers informative or repetitive noise (cf. narrator-repetition bug)?
  (c) routing quality — mixed multi-part utterances (see voice section).
- **Approval flows** (OPERATOR-GATED): action/credential/self-mod approvals
  are multi-party — need an operator or test-admin in the loop. List as NOT
  COVERED unless one is available.
- **Identity & cross-channel continuity** (partially solo): person resolution
  per channel, `/personal` mount presence, cross-layer fact bleed (plant on
  one layer, probe on the other — currently a shared-memory-leak probe),
- **Session lifecycle** (solo with care): reset-survival (`/clear` →
  persistent recall); state rebuild after container restart is
  OPERATOR-GATED on staging etiquette (don't bounce machines mid-shared-use).
- **Gating behavior** (partially solo): unknown-sender refusal AUDIBILITY on
  voice; role-scoped commands (`/clear` admin gate).
- **Proactive/outbound-initiated** (solo via scheduling; broader proactive
  behaviors operator-gated).
- **Load/concurrency + inbound media** (voice-memo-in / image-in): currently
  rig-blocked — keep on the list, mark NOT COVERED each run until the rig or
  a sim-inbound-media path exists.

## Voice-layer walkthrough — adaptations that survived contact (run 2026-07-06)

Run the same steps 1-11 on ONE call, with these voice-specific deltas:

- **Nonces:** STT mangles them — "BLUEHERON VX52" transcribes as
  "BLUEHERONVX52", "SMOKE dash VX52" became a file containing lowercase
  `smoke-vx52`. Don't fail an "exactly"-check on casing/joins; judge semantic
  fidelity. Say nonces as plain letter-number words, expect lossy joins.
- **Step 2 (plant) — probe the bridge with a MULTI-PART utterance.** The
  nastiest reproducible failure mode (2026-07-06): an utterance where one
  fragment is banter-answerable ("what's 17×4?") and another fragment carries
  a memory-relevant instruction ("keep both — they're two different
  projects") gets decided `noop` ("banter answered inline") and the
  instruction is **silently dropped** — the back-mind later contradicts you
  with full confidence. Deliberately send one combined turn like that, then
  verify with `request-layer.decided`: a `noop` on a turn carrying an
  instruction = the 🔴 bridge bug. (Single-purpose "remember X" turns now
  route `forward` correctly — reason: "back-mind has cross-session memory
  banter cannot write to" — so the bug hides in mixed turns.)
- **Step 4 (publish):** say "don't read the URL out loud" (it honors this);
  pull the real URL from patobs
  (`kind='agent.tool_result' AND data_tool='mcp__nanoclaw__publish_file'`,
  field `data_output_summary`) and curl it yourself.
- **Steps 5-6 (memo/attachment):** a voice memo to destination `rig-a` FAILS
  (`ensureUserDm: no adapter for channel` warn in pat_events) — tool result
  still says "dispatched", the failure arrives async and the agent falls back
  to text. That's a good honesty probe: does the RENDER admit the fallback
  even though the NARRATION already claimed "both sent"? (2026-07-06: render
  honest, narration confabulated success — narration speaks before results
  exist, judge accordingly.)
- **Step 11 (summary):** expect the first summary to cover only the recent
  window — challenge it ("you missed most of the call") and judge the
  RECOVERY; 2026-07-06 the challenged re-summary was complete and honest
  about the failed memo. First-pass laziness + honest recovery ≠ first-pass
  honesty; report both.
- **Wire-truth for anything suspicious:** `cartesia.agent-text-sent` is the
  word-by-word stream actually sent to TTS — use it to confirm leaks,
  duplication, and what the caller really heard. `llm.call` rows
  (`data_layer` = `banter:ack` | `request-layer` | `narration` |
  `banter:render`) attribute any bad text to the exact layer.

## Reset-survival — BEST-EFFORT, the ONE place you `/clear` (a DIFFERENT thing)

Steps 8–9 (in-context continuity) are the PRIMARY continuity proof and always
run. This section tests *persistent per-person memory* — a separate mechanism
that must survive a session reset — and is **best-effort with two known
caveats** on the anonymous smoke sender:
- `/clear` is **admin-gated**; the smoke sender (`realtime:smoketest`) may get
  `Permission denied: /clear requires admin access`. If so, note it and SKIP —
  don't treat it as a PAT failure.
- The REALTIME smoke sender resolves to `person_id: null`, so the per-person
  `/personal` memory mount is absent (writes fall back to session memory). True
  cross-reset per-person recall can only be verified with a *resolved person*
  sender. **On `--layer=signal` this caveat does NOT apply** (2026-07-06): the
  sim-signal sender IS a resolved person, `/clear` works ("Session cleared."),
  and a genuine pass looks like: plant → agent `Write`s
  `/personal/misc_facts.md` → `/clear` → recall turn does Bash+`Read` of
  `/personal/…` before answering (check `agent.tool_use` rows post-clear —
  a recall with NO memory read is the spurious-pass smell).
- **If you can run it:** `chat "remember for later: my desk plant is named FERN-<nonce2>"` → `chat "/clear"` → `chat "what's my desk plant's name?"`; recall of `FERN-<nonce2>` after the clear = pass. **This is the only `/clear` in the run.**
- **Beware a SPURIOUS pass:** verify the `/clear` actually reset something. If
  `patobs` shows `/clear` was handled `decision=noop` (front-mind inline) with no
  container respawn, then a post-clear recall is coming from the still-warm
  front-mind window, NOT persistent memory — that proves nothing and is NOT a
  pass. A real pass requires the clear to have taken effect AND the recall to come
  from persisted per-person memory.

## Report

Write a judgment-based summary — not just pass/fail counts:

- One line per capability: ✅ / ⚠️ / ❌ + **evidence** (quote the reply or the
  trace line that convinced you).
- A dedicated **CONTINUITY** verdict: did the system hold the thread across the
  back-to-back session? Did in-context recall (steps 8–9) AND persistent memory
  (reset-survival) both work? This is the thing the continuous run exists to
  prove.
- Call out anything that *technically worked but felt off* (tone, latency,
  over-eager tool use, leaked status) — the judgment a scripted suite can't give.
- End with an overall call: **would you ship this?** If not, the blocker + the
  exact `trace`/`patobs` evidence.

If a step fails, don't just mark it red — use `trace --tools` / `patobs` to get
the real cause and put THAT in the report. You found it; say what it is.
