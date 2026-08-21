/**
 * pat-web — Hono server.
 *
 * Three responsibilities:
 *   1. Serve the built React SPA from dist/.
 *   2. Mint Anam session tokens. Returns the session token AND a fresh
 *      per-page `sessionId` (uuid) for the browser to use as the
 *      `X-Pat-Session-Id` header on the backend.
 *   3. Bridge the browser's realtime WebSocket (one per call, opened at
 *      session-start, closed at session-end) to the nanoclaw anam-web
 *      channel adapter on :8766 (env `NANOCLAW_ANAM_WEB_URL`). The WS
 *      replaces the prior per-turn `POST /api/chat/completions` + the
 *      per-call EventSource on `/api/anam/banter`. Browser frames in,
 *      banter SSE rows out — see `server/realtime-ws.ts` for the bridge.
 *
 * Tokens & secrets:
 *   - ANAM_API_KEY  is the base64("<key-id>:<secret>") form. We never
 *     send it to the browser; the browser only gets the short-lived
 *     sessionToken Anam returns.
 *   - ANAM_AVATAR_ID / ANAM_VOICE_ID identify the persona.
 *   - ANAM_DEFAULT_LLM_ID is optional — used in 'demo' mode to pin a
 *     specific Anam-hosted brain; omitted, we let Anam pick its default.
 *
 * Backend wiring:
 *   - In 'pat' mode the browser opens ONE WebSocket
 *     `GET /api/realtime?session=<uuid>&platform_id=<id>` at the start
 *     of the call. Per user turn it sends a single JSON frame
 *     `{ kind: "user-message", text, threadId, platformId, correlationId }`
 *     which the server forwards to `NANOCLAW_ANAM_WEB_URL/anam-web/message`.
 *     The WS receives `utterance.stream-*` JSON frames piped from
 *     nanoclaw's `/anam-web/banter` SSE.
 *   - In parallel, the browser opens `/api/anam/events?session=<uuid>`,
 *     which proxies to `/anam-web/events?session=<uuid>` and forwards
 *     a filtered structured-log stream (rendition / narration deltas,
 *     tool cards, state transitions). Structured-log path stays SSE —
 *     only the chat + banter voice path moves to WS.
 */
import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { serveStatic } from 'hono/bun';
import { createBunWebSocket } from 'hono/bun';
import type { ServerWebSocket } from 'bun';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHmac } from 'node:crypto';
import { registerSlideBus } from './slide-bus';
import { registerScenarios } from './scenarios';
import { openRealtimeBridge } from './realtime-ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(__dirname, '..', 'dist');
const INDEX_HTML = join(DIST_DIR, 'index.html');

const PORT = Number(process.env.PORT ?? 8788);
const ANAM_API_KEY = process.env.ANAM_API_KEY ?? '';
const ANAM_AVATAR_ID = process.env.ANAM_AVATAR_ID ?? '';
const ANAM_VOICE_ID = process.env.ANAM_VOICE_ID ?? '';
// Anam SDK v4 rejects "legacy" session tokens — every ephemeral
// personaConfig must include an llmId. This is the id Anam uses in
// their own quickstart for a generic hosted brain; we use it as the
// demo-mode fallback when the operator hasn't set ANAM_DEFAULT_LLM_ID.
const ANAM_QUICKSTART_LLM_ID = '0934d97d-0c3a-4f33-91b0-5e136a0ef466';
const ANAM_DEFAULT_LLM_ID = process.env.ANAM_DEFAULT_LLM_ID || ANAM_QUICKSTART_LLM_ID;
const ANAM_SESSION_TOKEN_URL = 'https://api.anam.ai/v1/auth/session-token';

// Pin video quality at session start. Per Anam's April 2026 release
// notes, sessionOptions.videoQuality accepts 'high' or 'auto'. 'high'
// starts at maximum bitrate immediately; 'auto' ramps up from low.
// We default 'high' because we're targeting a single-viewer projector
// surface, not a fan-out broadcast.
const ANAM_VIDEO_QUALITY = (process.env.ANAM_VIDEO_QUALITY ?? 'high') as 'high' | 'auto';

// nanoclaw anam-web channel adapter endpoint. Defaults to localhost
// (dev mode); set NANOCLAW_ANAM_WEB_URL in Fly secrets for prod.
const NANOCLAW_ANAM_WEB_URL = process.env.NANOCLAW_ANAM_WEB_URL ?? 'http://127.0.0.1:8766';

// PAT: nanoclaw admin server (where the structured-log ingress lives).
// Defaults to localhost:8767 (the dev admin server port; see
// nanoclaw/src/admin/server.ts). pat-web proxies browser-emitted
// log events to `/admin/log-event` here so they land in the unified
// host JSONL stream — no separate browser→server log channel.
const NANOCLAW_ADMIN_URL = process.env.NANOCLAW_ADMIN_URL ?? 'http://127.0.0.1:8767';

// PAT: per-session bearer registry for the browser → pat-web realtime
// WebSocket. Minted at `/api/anam/session-token` time alongside the Anam
// session token, returned to the browser, and validated on the WS upgrade
// via `Sec-WebSocket-Protocol: pat-bearer.<bearer>`. Tokens-in-URLs leak
// via Referer / proxy logs, so we never put it in a query string.
//
// Stateless HMAC-signed bearer. Earlier we used an in-memory Map but
// it broke in prod — Bun's runtime evidently runs multiple processes
// (mint accumulates entries 1, 2, 3...; consume on a parallel request
// sees map_size: 0). HMAC removes the state entirely: bearer is
// base64url(`<sessionId>:<platformId>:<ts>:<sig>`), signature is
// HMAC-SHA256 over `<sessionId>:<platformId>:<ts>` keyed by a server
// secret derived from ANAM_API_KEY (env-shared across all processes,
// no separate secret to manage). Verification recomputes the
// signature locally — no lookup, no shared state, no race.
const BEARER_TTL_MS = 5 * 60 * 1000; // 5 minutes
const BEARER_SECRET = (() => {
  const key = process.env.ANAM_API_KEY ?? '';
  if (!key) {
    // No ANAM_API_KEY at startup is itself a fatal misconfiguration
    // surfaced elsewhere — random salt here is just a safety net so
    // mint/verify still match within one process if the key is missing.
    return randomUUID();
  }
  return key;
})();

// Separator `|` chosen because platformId routinely contains `:` (e.g.
// `anam-web:b41a50c4-...`) — using `:` as our delimiter produced more
// than the expected 4 parts when splitting and silently rejected
// every bearer in prod 2026-05-23.
const BEARER_SEP = '|';

function signBearerPayload(payload: string): string {
  return createHmac('sha256', BEARER_SECRET).update(payload).digest('hex');
}

function mintSessionBearer(sessionId: string, platformId: string): string {
  const ts = Date.now().toString();
  const payload = `${sessionId}${BEARER_SEP}${platformId}${BEARER_SEP}${ts}`;
  const sig = signBearerPayload(payload);
  return Buffer.from(`${payload}${BEARER_SEP}${sig}`).toString('base64url');
}

/** Verify a stateless bearer. Returns the session/platform pair it was
 *  minted with, or null if malformed / expired / signature mismatch.
 *  Does NOT mutate any state — safe to call from any process. */
function consumeSessionBearer(
  bearer: string,
  sessionId: string,
  platformId: string,
): { sessionId: string; platformId: string } | null {
  let decoded: string;
  try {
    decoded = Buffer.from(bearer, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const parts = decoded.split(BEARER_SEP);
  if (parts.length !== 4) return null;
  const [sid, pid, tsStr, sig] = parts;
  if (sid !== sessionId || pid !== platformId) return null;
  const ts = parseInt(tsStr, 10);
  if (!Number.isFinite(ts)) return null;
  if (Date.now() - ts > BEARER_TTL_MS) return null;
  const expected = signBearerPayload(`${sid}${BEARER_SEP}${pid}${BEARER_SEP}${tsStr}`);
  // Constant-time compare to avoid timing oracles.
  if (sig.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return null;
  return { sessionId: sid, platformId: pid };
}

const SYSTEM_PROMPT_DEMO = [
  'You are pat — a calm, curious, slightly wry research assistant.',
  'Keep replies under 30 words. Speak the way you would in a real',
  'conversation. Don\'t over-explain. Don\'t list. If asked who built',
  'you, you can mention Palisade Research.',
].join(' ');

const app = new Hono();

// Hono's bun-native WebSocket helper. Use BOTH `upgradeWebSocket` (the
// middleware that wraps Bun's server.upgrade correctly so Fly's proxy
// sees a clean HTTP 101 response) AND `websocket` (the per-WS dispatcher
// Bun expects on the server config). The earlier "direct server.upgrade"
// path returned a Response after the upgrade, which Fly proxy saw as
// "HTTP body, but socket already hijacked" → 1006 close on the browser
// side. The middleware doesn't expose `Sec-WebSocket-Protocol` echo so
// we put the bearer in the query string instead — fine here because
// pat-web is HTTPS only, the URL never escapes browser history, and
// WebSocket upgrades don't send a Referer.
const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>();

// ── Health check (no auth, used by platform probes) ────────────────
app.get('/healthz', (c) => c.text('ok'));

// ── Public-endpoint gate (webapp W1/W2/W5/W6/W7, security) ──────────
// pat-web is a PUBLIC app, and these POST endpoints let an anonymous internet
// caller provision nanoclaw agent groups + burn OpenRouter/Opus (scenarios),
// mint billable Anam sessions + drive the back-mind (session-token), drive a
// live demo deck (slide-bus), poison the log stream (log-event), or kill other
// sessions (barge-in / session-ended). Gate them behind PAT_WEB_TOKEN.
//   OPT-IN: when PAT_WEB_TOKEN is unset the endpoints stay open (current public
//   behavior) so shipping this is non-breaking; set the secret + share it in the
//   demo URL (?token=…) to lock the app down. This is a SEPARATE token from the
//   CRM-log-reading PAT_VIEWER_TOKEN — NEVER reuse that one here . Token via
//   ?token= or the X-Pat-Web-Token header (the browser reads it from its URL).
const PAT_WEB_TOKEN = process.env.PAT_WEB_TOKEN;
const GATED_POST_PREFIXES = [
  '/api/anam/session-token',
  '/api/scenarios',
  '/api/slide-bus',
  '/api/log-event',
  '/api/anam/barge-in',
  '/api/anam/session-ended',
];
app.use('*', async (c, next) => {
  if (PAT_WEB_TOKEN && c.req.method === 'POST' && GATED_POST_PREFIXES.some((p) => c.req.path.startsWith(p))) {
    const t = c.req.query('token') ?? c.req.header('x-pat-web-token') ?? '';
    if (t !== PAT_WEB_TOKEN) return c.text('unauthorized', 401);
  }
  await next();
});

// Slide bus — relay between nanoclaw presenter MCP tools and the
// deck iframe in pat-web App.tsx. POST /api/slide-bus/:slug for
// producers; GET /api/slide-bus/:slug/events for SSE subscribers.
registerSlideBus(app);

// Scenarios — operator-facing list/upload/fetch endpoints. Calls
// OpenRouter for pamphlet → DSL translation and nanoclaw's
// /scenarios/provision endpoint for materialization.
registerScenarios(app);

// ── Anam session token mint ────────────────────────────────────────
// PAT: avatar background presets exposed to the client. The client
// stores the user's pick in localStorage and sends `background` in
// the POST body — we map slug → real Anam avatar id here so the
// browser never sees the secret-style avatar id directly. Falls
// through to the legacy ANAM_AVATAR_ID env-var when the client sends
// nothing (back-compat with smoketests / older clients).
const AVATAR_PRESETS: Record<string, string> = {
  'green-screen': '9ceb3b93-4e2f-4642-a7ea-594a96d869f4',
  office: '840056d9-7e9c-409f-954c-366615ce7d45',
};

app.post('/api/anam/session-token', async (c) => {
  if (!ANAM_API_KEY) {
    return c.json({ error: 'server missing ANAM_API_KEY' }, 500);
  }

  let body: { mode?: 'demo' | 'pat'; background?: string; platformId?: string } = {};
  try {
    body = await c.req.json();
  } catch {
    /* allow empty body — defaults below */
  }
  const mode: 'demo' | 'pat' = body.mode === 'pat' ? 'pat' : 'demo';
  // PAT: capture the browser's platformId so we can pre-warm the back-mind
  // container while Anam is still spinning up the avatar. Falls back to the
  // X-Pat-Platform-Id header in case an older client is in flight.
  const platformId =
    (typeof body.platformId === 'string' && body.platformId.length > 0 ? body.platformId : null) ??
    c.req.header('x-pat-platform-id') ??
    null;

  // Resolve the avatar: explicit client-side `background` slug wins.
  // Anything else falls back to the env-var (legacy + smoketests).
  // Default to "office" when neither is set.
  const requestedBackground =
    typeof body.background === 'string' && body.background in AVATAR_PRESETS
      ? body.background
      : null;
  const avatarId =
    (requestedBackground && AVATAR_PRESETS[requestedBackground]) ||
    ANAM_AVATAR_ID ||
    AVATAR_PRESETS.office;
  if (!avatarId) {
    return c.json({ error: 'server missing avatar configuration' }, 500);
  }

  const personaConfig: Record<string, unknown> = {
    name: 'pat',
    avatarId,
  };
  if (ANAM_VOICE_ID) personaConfig.voiceId = ANAM_VOICE_ID;

  if (mode === 'pat') {
    // Client-side custom LLM: the browser will run /api/chat/completions
    // on every fresh user turn and stream chunks back via the SDK's
    // createTalkMessageStream(). No system prompt needed here — we
    // generate text upstream.
    personaConfig.llmId = 'CUSTOMER_CLIENT_V1';
  } else {
    // Demo mode: Anam handles the whole conversation. SDK v4 requires
    // an llmId for every ephemeral persona, so we fall back to Anam's
    // quickstart-canonical id when ANAM_DEFAULT_LLM_ID isn't set.
    personaConfig.llmId = ANAM_DEFAULT_LLM_ID;
    personaConfig.systemPrompt = SYSTEM_PROMPT_DEMO;
  }

  try {
    const res = await fetch(ANAM_SESSION_TOKEN_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ANAM_API_KEY}`,
      },
      body: JSON.stringify({
        personaConfig,
        sessionOptions: {
          videoQuality: ANAM_VIDEO_QUALITY,
        },
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      return c.json(
        { error: `anam ${res.status}`, detail: text.slice(0, 400) },
        500,
      );
    }
    const data = JSON.parse(text);
    // Mint a fresh per-page sessionId. The browser uses this as the
    // X-Pat-Session-Id header on subsequent /api/chat/completions
    // POSTs AND as the ?session= for /api/anam/events. On the backend
    // it maps to thread_id = `anam-web-call-<sessionId>`.
    const sessionId = randomUUID();
    // PAT: removed session-token-mint back-mind prewarm 2026-05-26 —
    // the nanoclaw-side `/anam-web/prewarm` route is gone (was blocking
    // real chat rows for the full SDK cold-start; net latency worse
    // than not prewarming). See nanoclaw/src/channels/anam-web.ts.
    // PAT: mint a one-shot bearer the browser will present on the
    // `/api/realtime` WS upgrade via `Sec-WebSocket-Protocol`. The
    // bearer is bound to (sessionId, platformId) so a leaked Anam
    // session token can't be paired with a fresh sessionId.
    // Only meaningful in 'pat' mode — demo mode skips the realtime WS.
    let bearer: string | null = null;
    if (mode === 'pat' && platformId) {
      bearer = mintSessionBearer(sessionId, platformId);
    }
    return c.json({ sessionToken: data.sessionToken, mode, sessionId, bearer });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

// PAT: removed `/api/anam/prewarm-warmup` proxy 2026-05-26 —
// nanoclaw's `/anam-web/prewarm-warmup` route was deleted alongside
// the back-mind prewarm path. The browser-side useEffect that POSTed
// here on first pointerdown/keydown is also gone (pat-web/src/App.tsx).

// ── Browser-emitted structured-log ingress ─────────────────────────
//
// Browser POSTs structured events to /api/log-event; we forward them
// verbatim to nanoclaw `/admin/log-event` so they land in the same
// unified host JSONL as server-side events. Fire-and-forget on the
// browser side, no auth on this proxy (the upstream endpoint is
// token-skipped because peer ingress is internal-network-only — the
// pat-web → nanoclaw hop is the trust boundary).
//
// Payload shape mirrors `LogEvent` in `realtime/src/log-events.ts`:
//   { source: 'pat-web-browser', kind, level?, thread_id?, session_id?,
//     platform_id?, data: {...} }
//
// We don't validate the payload here — the upstream parser will reject
// malformed bodies and the drift test guards the schema at build time.
app.post('/api/log-event', async (c) => {
  const reqBody = await c.req.text();
  // Cap the body at 16KB to match nanoclaw's own limit (`handleLogEvent`).
  if (reqBody.length > 16 * 1024) {
    return c.json({ error: 'payload too large' }, 413);
  }
  void fetch(`${NANOCLAW_ADMIN_URL}/admin/log-event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: reqBody,
  }).catch(() => {
    // Instrumentation must never break the user-facing flow. Failures
    // are observable via the lack of inbound.sent / utterance.delta-
    // received rows in the dashboard.
  });
  // Respond immediately — the browser doesn't await the upstream hop.
  return c.json({ ok: true });
});

// ── Realtime WebSocket (replaces POST /api/chat/completions + GET /api/anam/banter) ──
//
// One long-lived browser↔pat-web WebSocket per call. The browser sends
// `{kind:"user-message",...}` JSON frames per user turn (formerly the
// per-turn POST), and we pipe the upstream nanoclaw banter SSE back as
// JSON frames (formerly the per-call EventSource). Per-turn TLS+HTTP
// setup cost drops to zero and the EventSource reconnect-storm path is
// retired. See server/realtime-ws.ts for the full bridge.
//
// Auth surface: same as the displaced POST — nanoclaw trusts whatever
// pat-web forwards, and pat-web's network position is the trust
// boundary. session + platform_id ride the upgrade query string because
// browsers can't set custom headers on WS upgrade.
// PAT: realtime WS — direct Bun upgrade (bypassing hono/bun's helper).
//
// Why direct: we need to echo `Sec-WebSocket-Protocol` on the upgrade
// response so the browser accepts the connection (per RFC-6455 §4.1,
// when the client offers subprotocols, the server MUST select one or
// the browser rejects). `hono/bun`'s `upgradeWebSocket` calls
// `server.upgrade(req, { data })` with no `headers` field; Bun's API
// does support a `headers` arg so we call it directly here.
//
// We still feed the same `events` shape (`onOpen` / `onMessage` /
// `onClose`) hono's `websocket` handler dispatches on, so the upgrade
// integrates with the rest of the server's WS plumbing untouched.
app.get(
  '/api/realtime',
  upgradeWebSocket((c) => {
    const url = new URL(c.req.url);
    const sessionId = url.searchParams.get('session') ?? '';
    const platformId = url.searchParams.get('platform_id') ?? '';
    const bearer = url.searchParams.get('bearer') ?? '';
    const auth = bearer ? consumeSessionBearer(bearer, sessionId, platformId) : null;
    let bridge: ReturnType<typeof openRealtimeBridge> | null = null;
    return {
      onOpen: (_ev, ws) => {
        if (!auth) {
          console.warn('[pat-web/realtime-ws] closing WS — missing/invalid bearer', {
            hasBearer: Boolean(bearer),
            sessionId,
            platformId,
          });
          // close before bridge is opened — never start the upstream
          // SSE proxy for a failed-auth socket.
          try {
            ws.close(1008, 'invalid bearer');
          } catch {
            /* noop */
          }
          return;
        }
        bridge = openRealtimeBridge(ws, {
          upstreamBase: NANOCLAW_ANAM_WEB_URL,
          sessionId: auth.sessionId,
          platformId: auth.platformId,
        });
      },
      onMessage: (event) => {
        if (!bridge) return;
        const raw = typeof event.data === 'string' ? event.data : '';
        if (!raw) return;
        bridge.handleClientFrame(raw);
      },
      onClose: () => {
        bridge?.close();
        bridge = null;
      },
      onError: () => {
        bridge?.close();
        bridge = null;
      },
    };
  }),
);

// ── Per-session events SSE proxy ───────────────────────────────────
//
// Browser → /api/anam/events?session=<sessionId> → nanoclaw
// `/anam-web/events?session=<sessionId>`. EventSource can't set
// custom headers in browsers, so platformId is passed via query
// param when present.
app.get('/api/anam/events', async (c) => {
  const sessionId = c.req.query('session');
  if (!sessionId) {
    return c.json({ error: 'missing ?session=' }, 400);
  }
  const platformId = c.req.query('platform_id');
  const since = c.req.query('since');
  const qs = new URLSearchParams();
  qs.set('session', sessionId);
  if (platformId) qs.set('platform_id', platformId);
  if (since) qs.set('since', since);
  const upstreamUrl = `${NANOCLAW_ANAM_WEB_URL}/anam-web/events?${qs.toString()}`;
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, { method: 'GET' });
  } catch (e) {
    return c.json({ error: `upstream unreachable: ${(e as Error).message}` }, 502);
  }
  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '');
    return c.json(
      { error: `upstream ${upstream.status}`, detail: detail.slice(0, 400) },
      upstream.status as 400 | 500,
    );
  }
  c.header('content-type', 'text/event-stream');
  c.header('cache-control', 'no-cache, no-transform');
  c.header('connection', 'keep-alive');
  c.header('x-accel-buffering', 'no');
  return stream(c, async (s) => {
    const reader = upstream.body!.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        await s.write(decoder.decode(value, { stream: true }));
      }
    } catch {
      /* upstream broke mid-stream; close gracefully */
    }
  });
});

// ── Events tail (legacy simulator endpoint) ────────────────────────
//
// Kept as a no-op stream so the simulator-mode events visualizer
// (use-events-stream with source='live') doesn't error out if it's
// ever pointed here. The real wiring is /api/anam/events above.
app.get('/api/events.tail', (c) => {
  c.header('content-type', 'text/event-stream');
  c.header('cache-control', 'no-cache, no-transform');
  return stream(c, async (s) => {
    await s.writeln(': pat-web events.tail — see /api/anam/events for the real channel');
    await s.writeln('');
  });
});

// Browser → /api/anam/session-ended → nanoclaw `/anam-web/session-ended`.
// Best-effort; close timing doesn't need to be fast.
app.post('/api/anam/session-ended', async (c) => {
  const body = await c.req.text();
  const r = await fetch(`${NANOCLAW_ANAM_WEB_URL}/anam-web/session-ended`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  return c.text(await r.text(), r.status as 200);
});

// Browser → /api/anam/barge-in → nanoclaw `/anam-web/barge-in`. Aborts
// in-flight streams + kills the back-mind container for this session.
app.post('/api/anam/barge-in', async (c) => {
  const body = await c.req.text();
  const r = await fetch(`${NANOCLAW_ANAM_WEB_URL}/anam-web/barge-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  return c.text(await r.text(), r.status as 200);
});

// Browser → /api/anam/turn-ended → nanoclaw `/anam-web/turn-ended`.
// Fired when Anam's MESSAGE_STREAM_EVENT_RECEIVED reports
// `endOfSpeech || interrupted` on the persona role — Anam's
// equivalent of Cartesia's AgentTurnEnded. The handler calls
// orchestrator.tts.markEnded so narrator cadence gates correctly.
app.post('/api/anam/turn-ended', async (c) => {
  const body = await c.req.text();
  const r = await fetch(`${NANOCLAW_ANAM_WEB_URL}/anam-web/turn-ended`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  return c.text(await r.text(), r.status as 200);
});

// PAT: WebRTC datachannel tap. The browser-side monkey-patch
// (src/lib/anam-rtc-tap.ts) forwards every observed RTC event here so
// it lands in our log stream alongside the other structured events.
// Goal: discover whether Anam's WebRTC layer sends a persona-audio-end
// signal that their SDK silently ignores. See the tap source for the
// list of event kinds.
app.post('/api/anam/rtc-tap', async (c) => {
  try {
    const payload = await c.req.json() as { kind?: string; ts?: string; data?: unknown };
    // Plain console.log — keeps it simple. Filter with `grep [rtc-tap]`
    // on /tmp/pat-prod-web.log or via the dashboard's raw view.
    console.log(`[rtc-tap] ${payload.kind ?? '?'}`, JSON.stringify(payload.data ?? {}));
  } catch {
    /* noop */
  }
  return c.text('ok', 200);
});

// ── Static SPA ─────────────────────────────────────────────────────
app.use('/assets/*', serveStatic({ root: './dist' }));
app.use('/favicon.svg', serveStatic({ path: './dist/favicon.svg' }));
// PWA + browser-fetched public files: manifest, apple-touch-icon, icon-512.
// These live in dist/ post-vite-build but need explicit routing since the
// SPA fallback below catches everything not matched.
app.use('/manifest.webmanifest', serveStatic({ path: './dist/manifest.webmanifest' }));
app.use('/apple-touch-icon.png', serveStatic({ path: './dist/apple-touch-icon.png' }));
app.use('/icon-512.png', serveStatic({ path: './dist/icon-512.png' }));

// SPA fallback. In dev (vite serves on a separate port and proxies
// /api here), this branch is never hit — vite owns the HTML. In prod
// we hand out the built index.html for everything not matched above.
app.get('*', (c) => {
  if (!existsSync(INDEX_HTML)) {
    return c.text(
      'pat-web SPA bundle missing. Run `bun run build` before starting the server.',
      500,
    );
  }
  const html = readFileSync(INDEX_HTML, 'utf8');
  c.header('content-type', 'text/html; charset=utf-8');
  return c.body(html);
});

// Load .env if present (Bun reads it automatically in newer versions
// but we don't depend on the behavior — give a clear hint at startup).
const envFile = join(__dirname, '..', '.env');
if (existsSync(envFile) && !ANAM_API_KEY) {
  console.warn(
    `[pat-web] .env exists but ANAM_API_KEY isn't in process.env yet.\n` +
      `         Start with: \`bun --env-file=.env run dev:server\` or export the vars manually.`,
  );
}

console.log(`[pat-web] listening on :${PORT}`);
console.log(`           ANAM_API_KEY: ${ANAM_API_KEY ? 'set' : 'MISSING'}`);
console.log(`           ANAM_AVATAR_ID: ${ANAM_AVATAR_ID || 'MISSING'}`);
console.log(`           NANOCLAW_ANAM_WEB_URL: ${NANOCLAW_ANAM_WEB_URL}`);
console.log(`           dist present: ${existsSync(DIST_DIR) ? readdirSync(DIST_DIR).length + ' entries' : 'no (dev mode)'}`);

export default {
  port: PORT,
  fetch: app.fetch,
  // Hono's createBunWebSocket pairs the upgradeWebSocket() helper with
  // this websocket handler set; Bun routes per-connection callbacks
  // through it. Without this, server.upgrade() succeeds but onOpen /
  // onMessage / onClose never fire.
  websocket,
};
