# PAT Channel Architecture: Phone, Google Meet (audio + video later)

> **Status: speculative.** No Meet/Recall.ai work has started. Phase 1
> (rename realtime → `phone-call.ts` + orchestration extraction) shipped
> 2026-05-14 — the phone-call channel now lives at
> `nanoclaw/src/channels/phone-call.ts`. Use the rest as design direction
> for the next channel push, not as a committed wave.

## Context

Adding PAT to Google Meet — audio first, video avatars later — and expecting Teams to follow. The phone-call channel adapter at `nanoclaw/src/channels/phone-call.ts` (originally `realtime.ts`) was built as a single overloaded thing: it handles HTTP/SSE transport, front-mind orchestration (banter → request-layer → onInbound), and narration polling all in one file. Voice-transport (Cartesia Line on PSTN) talks to it as `platform_id='local'`.

Two issues for the next phase:
1. As we add Meet/Teams, the v2 idiom is one channel adapter per channel kind (Slack, Discord, Telegram, etc. are each ~20-30 LOC registration shims). The "realtime" name hides what's actually a phone-call channel.
2. The orchestration logic inlined in `/inbound` will be needed by every voice channel.

Architectural shape: **channel adapters describe the surface (phone call, Google Meet audio, Google Meet video). Providers (Cartesia, Recall.ai, Anam) are internal composition details.** Recall.ai is the shared "be a participant in a Meet" mechanism for Meet-based channels; what differs is what runs inside the bot's rendered page (Cartesia for audio; Anam in BYO LLM mode for video, where Anam owns the voice loop and our endpoint is the LLM).

This shape matches v2's existing pattern — the Teams chat adapter is 22 LOC because the actual Teams logic lives in `@chat-adapter/teams`. Our voice adapters will be similarly thin because the heavy lifting lives in language-specific sidecars (Cartesia Line is Python-only; Recall bots run on Recall's infrastructure).

Phases below describe **order of work**, not abstraction barriers — all three are scoped together. Shared abstractions like `createRecallBridge` are designed with all phases in view from the start; the implementer should make whatever abstractions fit the full set, not artificially defer them between phases.

## Architecture

**Channel adapters** (in `nanoclaw/src/channels/`, one file each, idiomatic v2 thin registration):

| Channel | Provider stack | Sidecar |
|---|---|---|
| `phone-call` | Cartesia Line (PSTN/SIP/WebRTC) | `transports/` (existing, renamed scope) |
| `google-meet-audio` | Recall.ai bot rendering a minimal page that pumps Cartesia STT/TTS in and out | `meet-transport/` (new) |
| `google-meet-video` | Recall.ai bot rendering an Anam-driven page (Anam STT/TTS/face/voice in BYO LLM mode; our endpoint is the LLM) | `meet-transport/` (extended) |

**Per-call isolation comes from NanoClaw's per-thread session model.** Each call (PSTN, Meet, Teams) gets a distinct `thread_id`; with `session_mode='per-thread'` on the messaging-group wiring, that maps 1:1 to a session row → session DB folder → container. Concurrent calls don't share state; detail rows and banter history don't bleed across calls. The sidecar generates `thread_id` per call (e.g. the Cartesia `call_id` or Recall bot id) and includes it on `/inbound` POSTs.

**Internal composition** (in `realtime/`, shared across channels):
- Front-mind orchestration: `banter.ts` (Haiku banter — three flavors), `request-layer.ts` (Sonnet routing), `state.ts` (working memory), `narration.ts` (NarrationBrain). All three kinds of banter (reflex / narration / back-mind result rendition) flow through Haiku.
- `createRecallBridge(...)` — Recall.ai bot lifecycle helper, shared between `google-meet-audio` and `google-meet-video`. Designed for both from day one: knows how to create/teardown a bot for a Meet URL, point it at a hosted page, route audio. The page contents differ per channel.

## Phasing

### Phase 1 — Rename realtime to phone-call; orchestration extraction

> **Status: shipped 2026-05-14 via `plans/channel-orchestration-dedup.md`.**
> The rename happened (`channel_type='realtime'` stays in DB for compat),
> and the orchestration extraction landed as a `ChannelOrchestrator`
> class in `@agentic-toolkit/realtime` that both channel adapters
> delegate to. See `sprint/completed.md` and
> `reference_pat_channel_architecture.md` memory.

- ~~Rename `nanoclaw/src/channels/realtime.ts` → `nanoclaw/src/channels/phone-call.ts`.~~ Done. Channel registry name stays `'realtime'` for DB compat.
- ~~Pull the inline `/inbound` orchestration block (banter → request-layer → onInbound classification) into a function in `realtime/src/`.~~ Done — `ChannelOrchestrator.handleUserMessage`.
- Update voice-transport to point at the new channel name and emit prefixed platform_ids. Use `pre_call_handler` to read `CallRequest.from_/to/metadata` and pick the right prefix (`pstn:` vs `web:` vs Cartesia-direct). **Still pending** — voice-transport hasn't been updated for the prefix scheme yet.
- Smoketest: existing T3 scenarios still pass.

### Phase 2 — google-meet-audio channel + createRecallBridge

- New `nanoclaw/src/channels/google-meet-audio.ts` — registration shim, talks HTTP/SSE to `meet-transport`.
- New `meet-transport/` sidecar (sibling of voice-transport): wraps Recall.ai REST + WebSocket APIs via `createRecallBridge`. Bot lifecycle (create on demand for a given Meet URL, tear down at end), audio routing.
- **Hosted page is required.** Recall.ai's Output Media API streams a webpage's audio+video into the meeting; there is no audio-only path ([source](https://docs.recall.ai/docs/stream-media)). The Phase 2 page is minimal: placeholder image as the "video," `getUserMedia` to receive meeting audio, WebSocket to backend pumping STT chunks → `/inbound`, audio element receiving Cartesia TTS chunks via WebSocket from `/outbound` SSE.
- Channel calls the same orchestration function from Phase 1. Same NarrationBrain, same back-mind, same state synthesis. Cognition layer is unchanged. STT is **Cartesia Ink** (decision: consistent with PSTN), TTS is Cartesia Sonic.
- `createRecallBridge` lives in `realtime/src/recall-bridge.ts`. Designed knowing Phase 3 will reuse it for the avatar-driven page; the bridge separates "Recall bot lifecycle + audio routing" (shared) from "page contents" (channel-specific).
- Smoketest: new scenario for `google-meet-audio`. Behavior parity with phone-call baseline.

### Phase 3 — google-meet-video channel (Anam in BYO LLM mode)

Goal: avatar in Meet, with Anam owning the voice loop and our endpoint as the LLM.

- New `nanoclaw/src/channels/google-meet-video.ts` reusing `createRecallBridge`.
- Hosted page embeds Anam's JS SDK in **BYO LLM mode**. Anam owns: STT, TTS, face, voice, VAD-driven interruption, persona memory. We own: a `/v1/chat/completions` (OpenAI-compatible SSE) endpoint that runs front-mind logic and routes to back-mind. No Cartesia in this path; we accept a different voice on Meet vs PSTN as a short-term tradeoff (revisit via voice cloning in Anam Pro tier if it matters enough).
- **Banter is the only voice.** Anything Pat says to the user is generated by Haiku, regardless of the trigger. Three kinds, one model:
  - Conversational reflex (`bantererOnUserTurn` in `banter.ts`)
  - Narration of in-flight back-mind work (`NarrationBrain` in `narration.ts`)
  - Re-rendered back-mind chat rows (`bantererRenderBackMindResult` in `banter.ts` — takes the Opus output + last user turn, returns a Pat-voice rendition; raw Opus text stays in outbound.db as audit record)
- **Sonnet (request-layer) and Opus (back-mind) never produce text the user hears directly.** Sonnet's job is the routing decision (forward / banter / silent); Opus's job is to produce answer text that Haiku then re-renders. This is already how today's phone-call channel works — see the rendition step in `nanoclaw/src/channels/phone-call.ts` (`bantererRenderBackMindResult` path, ~L586-637).
- **Each banter utterance is a discrete LLM turn** (Haiku), same shape as today's voice-transport (`AgentSendText` per yield). We don't stream tokens within a turn — Cartesia today doesn't, and there's no reason to with Anam. Each banter event fires as a complete `/chat/completions` response, consumed by Anam's TTS as one utterance:
  - User-turn-end → Anam STT → POSTs `/v1/chat/completions` → endpoint runs reflex banter (Haiku) → returns text → Anam speaks it. Sub-second.
  - In parallel: request-layer (Sonnet) decides if back-mind needs waking. If yes, dispatch via `onInbound`. Sonnet's decision never produces audible text.
  - Detail row arrives during back-mind work → narration brain fires (Haiku) → emits a banter turn → Anam speaks it.
  - Back-mind chat row arrives → re-rendered through `bantererRenderBackMindResult` (Haiku) → emit rendition as a banter turn → Anam speaks it.
- **Avatar + voice are persona attributes.** Persona registry maps persona name → `{ avatarId, voiceId }`. Multiple personas expected (e.g. one masculine voice, one feminine). The values currently in `.env.agent` / `nanoclaw/.env` are the template for the first persona; production wiring registers many.
- **Cognition layer mostly unchanged.** `realtime/src/banter.ts`, `request-layer.ts`, `state.ts` keep doing what they do. `realtime/src/narration.ts` simplifies — `ttsBusyDurationSec` math drops out because Anam tracks its own speaking state and won't deliver our next turn until it's free. The silence ceiling, bounded queue, and detail-row observation all stay.
- **VAD-driven interruption is Anam's.** When user speaks mid-utterance, Anam aborts our HTTP stream and fires a new turn shortly after. Backend cleans up in-flight back-mind work on stream close — same shape as today's `cancel_filter = [UserTurnStarted]` in voice-transport, just over HTTP instead of Python async generators.
- Cost at Anam Growth tier: $0.12/min ($7.20/hr) with 2000 min/mo included; Pro tier $0.11/min with 5000 included. Billed by the second.

## Critical files

**Existing — read before changes:**
- `nanoclaw/src/channels/phone-call.ts` — the (renamed) phone-call adapter; still the fat reference for orchestration flow
- `nanoclaw/src/channels/adapter.ts` — `ChannelAdapter` interface
- `nanoclaw/src/channels/channel-registry.ts` — registration system
- `nanoclaw/src/channels/index.ts` — barrel
- `nanoclaw/src/db/messaging-groups.ts` — messaging_group schema
- `realtime/src/banter.ts`, `request-layer.ts`, `narration.ts`, `state.ts` — front-mind orchestration to factor
- `realtime/src/index.ts` — public surface
- `transports/main.py` — sidecar pattern to mirror; `CallRequest.from_/to/metadata` carry call-origin info we currently ignore
- `nanoclaw/docs/architecture.md` — channel adapter contract
- `nanoclaw/CLAUDE.md` — channel/provider self-registration patterns
- `docs/front-mind-design.md` — design intent

**New — Phase 1:**
- `nanoclaw/src/channels/phone-call.ts` (renamed from realtime.ts)
- New module in `realtime/` for the extracted orchestration function

**New — Phase 2:**
- `nanoclaw/src/channels/google-meet-audio.ts`
- `realtime/src/recall-bridge.ts` (the shared bridge)
- `meet-transport/` (new sidecar service)
- Hosted page for Phase 2 (placeholder image + audio I/O — minimal HTML+JS)

**New — Phase 3:**
- `nanoclaw/src/channels/google-meet-video.ts`
- Hosted page for Phase 3 (Anam SDK + getUserMedia + audio I/O)

## Out of scope / backlog

- **`BanterProvider` interface** — only one banter implementation today (Haiku). Add when a real second one appears.
- **Provider abstraction within a channel** — same logic. MeetingBaaS as Recall alternative, Twilio as Cartesia alternative, etc. Extract the seam when we have a concrete second user.
- **Per-call session lifecycle in NanoClaw's `ChannelAdapter` contract** — threads handle this today; revisit if/when ephemeral channels accumulate features that don't fit the contract.
- **Teams audio/video** — mechanically same as Meet (Recall supports both). Same shape: `teams-meeting-audio.ts`, `teams-meeting-video.ts`, both reusing `createRecallBridge`.
- **CLI/REST trigger to point Pat at a Meet URL.** A nice dev affordance — `pat-meet join <meet-url>` (or `POST /meet/join` on a dev endpoint) that spins a Recall bot for that URL on the right messaging group. Way nicer than scripted scenario configs for ad-hoc testing.
- **Two-bot end-to-end test harness.** Two Recall bots in a Meet — one is Pat, the other is a scripted "user" running TTS over scripted prompts. Captures Pat's audio for diff against expected behavior. Fully automated end-to-end Meet testing without a human.
- **Anam server-side option** — could run Anam from `meet-transport/` Python instead of in a browser page; their Python SDK supports it. Would eliminate the hosted-page hop. Defer until hosting the page is painful.

## Verification

**Phase 1:**
- All existing tests pass (T1-T3) after renaming + extraction.
- Live PSTN call to existing Cartesia number still works end-to-end (front-mind ack < 1s, narration during back-mind think, back-mind reply spoken).
- New unit tests for the extracted orchestration function.

**Phase 2:**
- New smoketest scenario for `google-meet-audio` channel using a Recall bot in a real (test) Meet.
- Behavior parity with phone-call baseline scenarios (front-mind ack timing, narration cadence, back-mind reply correctness).
- Manual end-to-end test: dial a Google Meet, talk to Pat, hear ack within 1s, hear narration, hear back-mind reply.
- `createRecallBridge` interface holds up — Phase 3 reuses it without modification.

**Phase 3:**
- Visual A/V sync verification — the avatar lipsync looks right in Meet (audio and lip movement aligned). This is Anam's job; we just need to confirm.
- End-to-end latency: first speaking-avatar frame in Meet ≤ 1.0s after user-turn-end on conversational reflex turns.
- Same behavioral parity with phone-call baseline (all three kinds of banter behave the same: reflex, narration, back-mind result).
- Confirm Anam's BYO LLM mode delivers per-turn TTS sub-300ms first-byte after our endpoint returns a complete response. This is what their pipeline is designed for; verify in their playground before locking it in.
- Per-turn isolation works as expected — banter turns of different kinds (reflex, narration, back-mind result) interleave cleanly without Anam dropping or reordering.

## Open questions

1. ~~Phase 1 platform_id prefix scheme.~~ **Resolved: prefix from the start.** All platform_ids include their transport prefix (`pstn:`, `web:`, `meet:`, `teams:`).
2. ~~Phase 2 STT choice.~~ **Resolved: Cartesia Ink** for consistency with PSTN.
3. ~~Phase 2 hosted-page complexity.~~ **Resolved: hosted page is required** — Recall doesn't allow audio-only output without a webpage. Phase 2's page is minimal (placeholder image + audio I/O via WebSocket); Phase 3's page has Anam.
4. Phase 3 — voice consistency: Pat sounds different on PSTN (Cartesia) vs Meet (Anam). Acceptable short-term; revisit via Anam voice cloning (Pro tier) if it becomes painful.
5. Phase 3 — persona registry shape: one map per agent group, or a global registry indexed by persona name? Decide when we add the second persona.
6. Phase 3 — persona is bound at session creation in Anam (no documented mid-call swap). Per-meeting personas work fine. If alternating man/woman *within* one call ever matters (could be a fun safety-demo thing), that's an Anam roadmap question or a custom-page-level swap of two pre-warmed Anam sessions.
