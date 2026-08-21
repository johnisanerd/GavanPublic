# pat-web

Fullscreen avatar conversation surface for PAT.

The avatar streams from Anam.ai. We composite it as a layered stage:

```
z=0   background      (solid, gradient, image, or events stream)
z=10  avatar          (WebGL2 — chroma-keyed Anam video, cover-fit vertical)
z=15  overlay         (foreground scrim — light leak, scanlines, sparse rain)
z=20  vignette        (Canvas2D black mask + Bayer dither — for projection)
z=30  captions
z=40  chrome          (auto-hides on idle for clean projection)
```

## Modes

Four avatar modes (`src/talk/lib/modes.ts`), picked from a chip strip
in the control bar; every other piece of state (session mode, canvas
vs blob, stand-in) is derived from the chosen mode:

- **pat** — full video avatar with PAT backend dispatch. The persona is
  created with a custom `llmId`, so the browser owns turn dispatch and
  streams over the realtime WebSocket (see Backend seams).
- **voice** — same PAT pipeline, but the avatar canvas is hidden and an
  audio-reactive SVG blob (`VoiceBlob.tsx`) stands in. For low-power
  devices or when the visual avatar would distract.
- **generic** — Anam's default hosted brain runs the whole
  conversation. No PAT backend, no banter driver — a way to stress-test
  the UI/voice/avatar plumbing with nothing standing behind it
  (`sessionMode = 'demo'`). Use this for UI/voice testing.
- **image** — chroma-key stand-in. No Anam session at all; the shader
  pulls pixels from a known-good still so the vignette/chroma controls
  can be tuned without burning an Anam concurrent slot.

Mode (and the derived visual state) persists in `localStorage`.

## Stack

- Vite 6 + React 19 + TypeScript 5.7
- Tailwind v4 (no JS config — `@theme` block in `src/index.css`)
- Hono on Bun for the server. Anam token mint + static SPA plus the
  realtime WebSocket bridge (`server/realtime-ws.ts`), scenario packet
  upload/serve (`server/scenarios.ts`), and the slide bus
  (`server/slide-bus.ts`).
- `@anam-ai/js-sdk` v4 for the avatar SDK

## Running locally

```bash
cd pat-web
bun install

# Copy env template and populate from repo-root .env.agent
cp .env.example .env
# Edit .env — set ANAM_API_KEY, ANAM_AVATAR_ID, ANAM_VOICE_ID

# Terminal 1 — Hono server (mints Anam tokens, bridges the realtime WS)
bun --env-file=.env run dev:server

# Terminal 2 — Vite dev server (proxies /api → :8788)
bun run dev

# Open http://localhost:5174
```

The Vite dev server proxies `/api/*` to the Hono server on port 8788.
Override the proxy target with `PAT_WEB_UPSTREAM=…`.

## Visual controls

The control panel (top-right, ☰) groups four sections:

- **session** — start / stop, avatar-mode chip strip (pat / voice /
  generic / image)
- **frame** — vignette presets (portrait 9:16, 3:4, square, landscape,
  soft oval), inner/outer radius, superellipse power, intensity, dither
- **chroma** — chroma key toggle, key color picker, similarity,
  smoothness, spill suppression. Useful only with a green-screen
  avatar created in Anam Lab — stock avatars won't key cleanly.
- **stage** — background preset (solid / gradient / events rain),
  overlay preset (off / scanlines / light leak / rain)

Chrome auto-hides after 3.5s of pointer idle. Move the mouse to bring
it back.

## Backend seams

In **pat** / **voice** mode the browser opens ONE realtime WebSocket
per call at session-start (`GET /api/realtime?session=<uuid>&platform_id=<id>`),
closed at session-end. `server/realtime-ws.ts` bridges it to nanoclaw's
anam-web channel adapter (`WS /anam-web/ws`, env `NANOCLAW_ANAM_WEB_URL`,
:8766 on the Fly internal net) as a thin, verbatim frame pipe:

- **browser → nanoclaw** — per user turn one
  `{ kind: "user-message", text, threadId, platformId, correlationId }`
  frame, plus `turn-ended` / `barge-in` / `session-ended` control
  frames. Forwarded verbatim (buffered until the upstream handshake
  finishes so the first turn is never dropped).
- **nanoclaw → browser** — banter `utterance.stream-{started,delta,ended,cancelled}`
  frames, streamed straight back to drive `anamClient.talk(...)`.

This WS **replaced** the old per-turn `POST /api/chat/completions`
echo-stub *and* the per-call `EventSource` on `/api/anam/banter` — the
Mode C′ refactor (2026-05-23). Out-of-band banter (narration /
back-mind rendition) now rides the same socket; it's no longer a
separate side channel. Browser-grade auth is a per-session bearer
carried in `Sec-WebSocket-Protocol: pat-bearer.<bearer>` (kept out of
the URL — query-string tokens leak via Referer / proxy logs); nanoclaw
trusts pat-web on the internal net.

In parallel the browser opens `GET /api/anam/events?session=<uuid>`,
proxied to nanoclaw `/anam-web/events` — a filtered structured-log SSE
feeding the background visualizer and the tool-card / narration
overlays. Only the chat + banter voice path moved to WS; the
structured-log path stays SSE. (`GET /api/events.tail` is a dead
legacy stub that logs a redirect note — the real channel is
`/api/anam/events`.)

### Scenario decks + slide bus

pat-web also drives operator scenario presentations, rendered as an
in-page deck iframe (`src/talk/DeckPage.tsx`; App.tsx owns the iframe
lifecycle):

- `server/scenarios.ts` — scenario packet (`manifest` + `slides[]`)
  upload / list / fetch. A pamphlet-markdown upload is Opus-translated
  → validate-retry ×3 → provisioned against nanoclaw
  `/scenarios/provision`; packets are cached read-through under
  `<data>/packets/<slug>/` so the deck loader fetches without
  round-tripping nanoclaw. The OpenRouter translator runs server-side
  so the API key never reaches the browser.
- `server/slide-bus.ts` — an SSE relay between nanoclaw MCP tools
  (producers `POST /api/slide-bus/:slug` with
  `open` / `close` / `advance` / `next` / `inject` / … commands) and the
  deck consumers (App.tsx for iframe lifecycle, DeckPage.tsx for slide
  cursor). State is keyed by `(slug, thread)` — subscribers (`?thread=`)
  and POSTers (body `thread`) must both carry the same thread
  (`anam-web-call-<sessionId>`) or messages silently drop into different
  buckets; the empty-thread bucket is the legacy/dev fallback. Per-call
  keying stops one call inheriting the last tester's sticky cursor.
  Fire-and-forget: if no consumer is connected the command is dropped
  and logged.

## Anam / avatar gotchas

Hard-won facts about the Anam SDK — don't re-derive them.

- **The SDK is browser-only, so the browser owns the Anam session.**
  `@anam-ai/js-sdk` needs `RTCPeerConnection` / `MediaStream` / DOM and
  won't run in Node without a full WebRTC polyfill; there's no
  server-to-server `talk()` REST endpoint. That's *why* pat mode
  dispatches turns from the browser (`llmId: CUSTOMER_CLIENT_V1`) and
  every banter delta round-trips the browser before reaching Anam's
  voice. Getting the browser out of the LLM path would mean Anam's
  Python SDK (aiortc) or URL-mode BYO-LLM — not a raw WS.
- **A server-side control plane over a second Anam WS is a dead end**
  (dual-WS spike, 2026-05-25). WS-B *can* `talkstream` (the persona
  speaks injected text) but receives zero inbound and drops after
  10-130s (close code 1006). Transcript / tool events (`speechText`,
  `userSpeech*`, `toolCall*`) are typed `DataChannelMessage` — they ride
  the WebRTC data channel peer-to-peer, never the WS, and only the
  browser peer can read them. Observe them via the RTC tap
  (`src/lib/anam-rtc-tap.ts`; filter `[rtc-tap]`, mirrored to
  `/api/anam/rtc-tap`). Don't re-run the spike unless Anam ships
  transcripts-on-WS or a server-side subscription.
- **`endOfSpeech` fires 90-600ms *before* audio actually ends**
  (empirical). It's the only persona-audio-end signal Anam gives — one
  event per `talk()`, no separate `audioFinished`. The anam-web
  audio-end gate still uses a `chars/13 + 200ms` estimate
  (`realtime/src/channel-orchestrator.ts`) as a demo-stable holdover
  (runs 1-4s long, adds dead air); re-wiring to `endOfSpeech` is open
  backlog.

## Deploy

Built artifacts go in `dist/`. Hono serves it from `bun run start`.
A separate Fly app per `fly launch` is the planned path — independent
deploy cadence from `pat-frontend` (the observability dashboard).
