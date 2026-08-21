# Swap avatar action timeline tag

**Status:** planned 2026-05-18. Not started. Stretch / demo-optional.

## Context

Stretch demo capability: during a presentation, the action timeline can
swap both the visible avatar AND the voice mid-call, e.g. to deliver an
influence-campaign demo in-character with a different persona + regional
accent. The action tag:

```xml
<swap_avatar uuid="<anam-persona-uuid>" voice="<cartesia-voice-uuid>"/>
```

Investigation (2026-05-18) verdict:
- **Voice swap:** trivial. Cartesia accepts a `{type:'config', tts:{voice_id}}`
  message mid-call; first-class wire-protocol feature. ~15 LOC on
  `transports/main.py`.
- **Avatar swap:** moderate. Anam's SDK has NO hot persona swap —
  `setPersonaConfig` is a plain field assignment that takes effect only
  on `startSession`. Mid-call swap requires teardown + reconnect:
  black-frame → token mint (~300-800ms) → WebRTC ICE/SDP → first frame
  (~1.5-3s on warm path). Not visually smooth but workable for a
  dramatic beat.
- **Mirror agent** (two simultaneous avatars at different volumes):
  rabbit hole. Anam binds one WebRTC peer per session; multi-stream
  needs WebAudio routing + breaks lip-sync. Documented in
  `sprint/icebox.md`. SKIP.

User decision (2026-05-18): swap = both voice AND avatar required (no
voice-only stub).

## Architecture

### Tag

```xml
<swap_avatar uuid="<persona-uuid>" voice="<voice-uuid>"/>
```

Both attributes required. Parser is already permissive on self-close
tags; no parser change needed.

### Action stream layer

Add to `ScenarioAction` discriminated union in
`realtime/src/scenario-action-stream.ts`:

```ts
| { type: 'swap-avatar'; persona_id: string; voice_id: string }
```

Add `handleSelfClose` branch on `tag === 'swap_avatar'`. Validates both
attributes present; emits action with `unknown-tag` fallback if not.

### Orchestrator dispatch

`realtime/src/channel-orchestrator.ts` `emitActionEvent` adds
`case 'swap-avatar'` for logging; `fireDispatcher` passes through.
`scenarioActionDispatcher` opt receives the action.

### anam-web channel dispatch (`nanoclaw/src/channels/anam-web.ts`)

`dispatchScenarioAction` adds:

```ts
case 'swap-avatar':
  // Broadcast a new banter event kind to the browser. Browser handles
  // the teardown + reconnect via use-anam-session.
  await broadcastBanter(threadKey, {
    kind: 'avatar.swap-requested',
    data: { persona_id: action.persona_id, voice_id: action.voice_id },
  });
  // Also send Cartesia voice-swap directly via transport so phone-mode
  // (if mixed) and any non-Anam audio path picks up immediately.
  await postTransportConfig(threadKey, { voice_id: action.voice_id });
  break;
```

### Browser-side reconnect (`pat-web/src/talk/hooks/use-anam-session.ts`)

Subscribe to `avatar.swap-requested` banter events. Handler:

1. Capture current `<video>` frame as poster (`<canvas>.drawImage(video)`).
2. Cross-fade the poster image in (CSS, ~250ms) covering the avatar.
3. Call existing `stop()` (already drops banter SSE, EventSource,
   talkStream pointer).
4. Call extended `start({mode, videoEl, background, overridePersonaId,
   overrideVoiceId})` which:
   - Fetches a new Anam session token via `/api/anam/session-token` with
     the override persona/voice in the request body.
   - Re-establishes WebRTC, banter SSE, talkStream binding.
5. On `SESSION_READY` event from new Anam session, cross-fade the poster
   back out, revealing the new avatar.

### Session-token endpoint (`pat-web/server/index.ts`)

Accept optional `personaId` / `voiceId` in the request body; pass through
to Anam's token mint API. Default to env-configured defaults if absent.

### Voice swap on phone channel (`transports/main.py`)

Add an endpoint `POST /voice/update-call` accepting `{voice_id}`. Looks
up the active Cartesia WS session for the call; sends
`{type:'config', tts:{voice_id}}` over the `_send_lock`'d websocket.
~15 LOC.

For anam-web mode, Cartesia voice swap is implicit in the new Anam
session token (which carries its own voice config). The direct
`postTransportConfig` call above is a no-op when there's no separate
Cartesia transport in play — leave as a defensive belt for hybrid modes
later.

## Phases

**Phase 1 — MVP (~120 LOC, 4-6h)**
- Tag parser support (no change required, just doc in vocab list).
- ScenarioAction union extension.
- Orchestrator dispatch + log events
  (`scenario.action` already covers; no new kind needed).
- anam-web `dispatchScenarioAction` branch.
- Cartesia voice-swap endpoint on `transports/main.py`.
- Browser-side teardown + reconnect (no crossfade polish).
- Session-token endpoint accepts overrides.
- Manual test: drive a fake `<swap_avatar/>` tag through a session,
  confirm avatar swaps within ~3s, voice swaps immediately.

**Phase 2 — Crossfade polish (+6-10h, defer unless demo demands it)**
- Poster image capture + CSS crossfade in/out.
- State machine to suppress banter events during the gap.
- Audio gate (mute Cartesia output) until `SESSION_READY` on new
  session.

**Total Phase 1: 4-6h. Phase 1+2: 10-16h.**

## Critical files

- `realtime/src/scenario-action-stream.ts` (lines 40-49 union, 204-270
  selfClose dispatch)
- `realtime/src/channel-orchestrator.ts` (lines 1191-1234
  emitActionEvent)
- `nanoclaw/src/channels/anam-web.ts` (lines 162-224
  dispatchScenarioAction)
- `pat-web/src/talk/hooks/use-anam-session.ts` (line ~465 banter event
  handler; `start()` overload)
- `pat-web/server/index.ts` (lines 99-183 session-token endpoint)
- `transports/main.py` (line 433 `_send_message_output` area; add
  `/voice/update-call`)

## Verification

- Unit: parser handles `<swap_avatar/>` with both attrs, rejects with
  unknown-tag fallback if either absent.
- Unit: ScenarioAction emitted correctly.
- Manual (Phase 1): force a `<swap_avatar/>` in a test packet; confirm
  visible avatar swaps and voice changes within 3s.
- Manual (Phase 2): same test; confirm no black-frame, smooth crossfade,
  no audio glitch.

## Open questions

- **Where do persona+voice UUIDs come from?** The agent emitting
  `<swap_avatar uuid voice/>` needs to know valid UUIDs. Options:
  (a) hardcode a small enum of personas in SKILL.md (test/demo only),
  (b) expose a `list_personas` MCP tool that returns available UUIDs,
  (c) configure per-packet in `manifest.yaml` (`alternate_personas`
  block). For demo, (a) is simplest. Long-term (c).
- **Authentication on Cartesia voice swap?** The transports' WS is
  already authenticated to the call; the new `/voice/update-call`
  endpoint needs the same call-id auth pattern. Reuse existing pattern.
- **Does back-mind know when to emit the swap?** Per `manifest.yaml`
  authoring — author script puts the tag in the appropriate
  `notes.spoken` anchor, gets emitted as a verbatim sequence.

## Skipped

`<spawn_mirror_agent/>` — see `sprint/icebox.md`. Anam concurrency,
WebAudio mixing, lip-sync coupling. 2-3 days minimum, full of unknowns.
Alternative if absolutely needed: second `<audio>` element playing
pre-rendered Cartesia at gain 0.4 with no avatar.
