# PAT smoke-test coverage plan (2026-07-03)

Enumerated by a Fable agent + validated against what's been built/proven this session.
Three channel families — **rest** (realtime text over `/inbound`+`/outbound` SSE, no audio),
**call** (real Cartesia voice WS, full acoustic loop), **signal** (rig burner → PAT). Truth
of what exists = `smoketest/src/scenarios/registry.ts` (16 scenarios); `sprint/test-inventory.md`
is stale.

## Feature → observability quick-map
Back-mind tools (`container/agent-runner/src/mcp-tools/`): `send_message`/cold-DM, `send_file`,
`edit_message`/`add_reaction`, `publish_file` (`file.published`/`file.served`), `send_voice_memo`
(`signal.send-acked`; rig `inbound.voice-memo`), scheduling, recall, presentation, `create_agent`,
`ask_user_question`/`send_card`, self-mod (`mcp.activation-*`), `ncl`, MCP-backed exa/context7/
firecrawl/apify (`agent.tool_use/tool_result` in patobs), memory `/personal`/`/shared` (reply-only,
no kind), image gen. Front-mind (`realtime/src/`): banter (`banter.called/.rendered`), request-layer
(`request-layer.decided`), narration (`narrator.fired`), barge-in (`bargein.received/.propagated`,
`back-mind.cancelled`), streaming rendition (`utterance-end` `content.source='banter-rendition'`),
error surfacing (`error.surfaced`/`agent.query-error`), TTS/STT (`tts.*`/`stt.user-said`).
Channel: phone-call gate (`permissions.caller-refused`, refusal plays over greeting), signal
(ACI/PNI dual identity — assert E164 OR UUID; `signal.send-acked/-failed`, `signal.health-*`,
inbound voice-memo → ElevenLabs Scribe), people (`people.upserted/.auto-enrolled/.auto-approved`).

## Candidate paths (EXISTS = in registry; NEW = to build)

### rest  (`platform_id='smoketest'`; caller `realtime:smoketest` must be a group member)
- **R1 baseline** (EXISTS) — "2+2" → ack ≤8s + chat "4" ≤90s. Proves the whole spine. ¢
- **R2 publish-file** (EXISTS) — nonce file → URL → fetch 200+nonce; tampered exp→404. ¢¢
- **R3 barge-in** (EXISTS ×4) — pivot before A's chat → B answered, A dropped. ¢
- **R4 capability-description** (EXISTS, trace) — 5 probes vs registry. ¢ (needs PAT_ADMIN_TOKEN)
- **R5 recall** (NEW) — "what did we discuss last time?" → recall tool_use → coherent. ¢¢
- **R6 memory** (NEW) — "remember codeword NONCE" → next turn recalls it. ¢
- **R7 scheduling** (NEW) — "remind me in 2 min" → tool_use → fire → delivered → cancel. ¢¢ (slow)
- **R8 install-failure-recovery** (EXISTS) — honest failure report. ¢
- **R9 self-knowledge** (EXISTS) — ≥3 real components, no fabrication. ¢
- **R10 cold-outbound-dispatch** (EXISTS) — `--channel-probe` dummy adapter. ¢
- **R11 MCP-live** (NEW) — "search web for X" → exa tool_use → sourced answer. ¢¢
- **R12 error-surfacing** (NEW) — guaranteed-404 → raw error in chat, not hidden. ¢

### call  (SSE tap is BLIND on call threads → assert via audio delta or patobs)
- **C1 call-baseline** (EXISTS) — greeting >0 bytes; turn → ≥44,100 fresh agent PCM ≤75s. $$
- **C2 STT/trace cross-check** (NEW) — `stt.user-said`≈sent + `tts.agent-said`. +¢
- **C3 barge-in mid-utterance** (NEW) — 2nd turn while agent PCM arriving → `bargein.received`. $$
- **C4 narration during tool work** (NEW) — interim narration audio + `narrator.fired`. $$
- **C5 unknown-caller refusal** (NEW) — non-member call → spoken refusal + `permissions.caller-refused`. $$ (use a dedicated gated mg, don't mutate the main group)
- **C6 teardown** (NEW add-on) — WS close → `call.ended`/`session.closed`. +¢ (VERIFY path first)

### signal  (rig → PAT; LIVE on staging as of 2026-07-03)
- **S1 ping round-trip** (EXISTS `signal-prod-inbound`; proven by hand on staging today) —
  `routing.message-routed` (user `signal:{E164|UUID}`) → `routing.message-delivered`. ¢¢
- **S2 reply capture** (EXISTS best-effort → promote to hard assert). 
- **S3 publish-file over Signal** (NEW) — ask via rig → URL → fetch. ¢¢
- **S4 voice-memo OUT** (NEW) — "send me a voice memo saying X" → rig `inbound.voice-memo`. ¢¢
- **S5 voice-memo IN** (NEW) — rig voice note → Scribe transcript → reply. ¢¢ **(needs rig send ext)**
- **S6 attachment OUT** (NEW) — `send_file` → rig `inbound.attachment`. ¢¢
- **S7 image IN** (NEW) — rig image + "what's in it?" → descriptive reply. ¢¢ **(needs rig send ext)**
- **S8 reaction** (NEW, cheap) — "react 👍" → rig `inbound.reaction`. ¢
- **S9 unknown-sender** (NEW, staging) — unregistered burner → dropped, no route. ¢
- **S10 typing** (opportunistic, free) — rig sees `inbound.typing.started` during S1.

## Quick vs thorough
- **rest quick (~60-90s):** Tier-0 pulse (health + patobs freshness) → `baseline` alone.
- **rest thorough (fail-fast order):** baseline → memory → publish-file → recall →
  capability-description → topic-switch + one barge-in → task-stack → error-surfacing →
  install-failure → self-knowledge → MCP-live → scheduling (last; slow, leaves state).
- **call quick:** `call-baseline` as-is (PASS ~9s).
- **call thorough:** ONE WS session, multi-probe `call-thorough` (baseline → C2 → C4 → C3;
  C6 teardown in finally). C5 refusal = separate scenario w/ a dedicated gated mg.
- **signal quick:** S1 + S2-as-hard-assert (one round-trip proves receive→route→container→deliver→rig).
- **signal thorough:** S1+S2 → S8 → S3 → S6 → S4 → S5+S7 (after rig ext) → S9. S10 free in S1.

## Invocation design
Add a `SUITES` map beside `SCENARIOS` in `registry.ts` (`rest-quick`, `rest-thorough`,
`call-quick`, `call-thorough`, `signal-quick`, `signal-thorough`; suites carry the transport so
`--call` is implicit) + a `--suite=` flag in `cli.ts`. `--suite=quick` = rest-quick + call-quick +
signal-quick(if creds). `/pat-smoke` maps operator intent → `--suite` instead of hand-listing
scenarios. Missing-cred scenarios skip-with-note (reported explicitly, never silently).

## STATUS 2026-07-03/04
- ✅ **#1 log-check helper** — `smoketest/src/log-check.ts` (`awaitLogEvent` +
  `logEventCheck`), backed by pat-frontend `/api/logs.jsonl` (the proxy the tsx
  runner can reach; patobs MCP stays for interactive agent forensics). Missing
  viewer token → skip-with-note.
- ✅ **#3 SUITES + `--suite`** — `registry.SUITES` + `selectSuite` + cli
  `--suite=<name>`; `--list` shows suites. rest/call/signal × quick/thorough +
  cross-channel quick|thorough.
- ⚠️ **Signal TRANSPORT is broken** (rig B2B decrypt desync — KNOWN_ISSUES;
  fix = re-register the rig burner, operator-gated). So S1/S2/S3/S4/S6 (rig-side
  assert) are **parked, SID-only**; the signal-* suites resolve empty (honest).
  **S8 reaction dropped** — `add_reaction`/`edit_message` advertised on signal
  but `deliver()` no-ops them (logged as a bug).
- ✅ **Signal FEATURES covered another way** — `SS1 signal-sim-outbound` +
  a simulated-Signal **capture channel** (`nanoclaw/src/channels/signal-sim.ts`,
  `HOST_PAT_TEST_OUTBOUND_ADAPTER=1`, LIVE on staging). Exercises the full real
  plumbing (cold-contact routing → delivery loop → send_voice_memo → **real
  Cartesia synth** → adapter) minus the signal-cli wire. voice-memo + attachment
  both PASS. Publish covered channel-agnostically by R2.

## Recommended next-build order (Signal promoted — staging is live)
1. **`patobsCheck` helper** for `check` steps — highest leverage; unblocks ALL call-thread +
   signal trace asserts (SSE is blind on calls), aligns with the patobs-first rule.
2. **Env-parameterized `signal-inbound`** (staging defaults: PAT `+15550100004`, patobs
   `env='staging'`; `PAT_ENV=prod` available) + shared `smoketest/src/signal-rig.ts` client
   (current scenario inlines ~300 LOC of HTTP/WS). Gives signal-quick immediately; closes #20's
   "make it a real scenario" gap. Switch its assertion off `/api/logs.jsonl` → patobs.
3. **`SUITES` manifest + `--suite` flag**; repoint `/pat-smoke` (Tier-4 un-staled 2026-07-03).
4. **Cheap signal thorough** needing no new rig capability: reaction , publish-over-signal
   , attachment-out , voice-memo-out .
5. **Rig `/send` attachment/voice-note extension** → then voice-memo-in  + image-in .
6. **Cheap rest scenarios:** memory (R6), recall (R5), error-surfacing (R12).
7. **`call-thorough`** (one WS session, multi-probe) + `sendUserTurnOverlapping()`.
8. Later: `wait-audio` Step kind, `call-refused` gated-mg scenario (C5), unknown-sender ,
   personal-memory-over-signal (S11 — also exercises the KNOWN_ISSUES stale-identity /personal
   mount bug), scheduling-roundtrip (R7), mocked-LLM unit tests pinning `judge.ts`/
   `simulated-user.ts` (no tests today = silent drift risk that invalidates every judged tier).

**Added paths (v2):** S11 personal-memory over Signal (Smoke McGee tells PAT a nonce fact →
new session → recall); R10 staging variant = cold `send_message` to the rig burner over REAL
Signal, asserted on the rig WS (vs the dummy-adapter `--channel-probe`).

## Harness primitives already in place (this session)
`check` step kind; `isBackMindReply` (streaming rendition); call audio-level asserts +
2s greeting quiet-window; caller-gate members (`realtime:smoketest`, `pstn:websocket`);
`/pat-smoke` skill tiers 0-4. Gaps: no patobs-backed check helper yet; rig `/send` text-only;
`judge.ts`/`simulated-user.ts` untested.
