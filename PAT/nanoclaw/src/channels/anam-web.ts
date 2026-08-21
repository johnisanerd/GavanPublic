/**
 * PAT: anam-web channel — HTTP backend for the Anam.ai avatar frontend
 * at agentic_toolkit/pat-web/.
 *
 * Conceptually mirrors `realtime.ts` (PSTN voice) but the transport is
 * the browser instead of voice-transport.py. Key differences:
 *
 *   - Inbound `POST /anam-web/message` is request-scoped: the browser opens
 *     it for each user turn and consumes an OpenAI-style SSE chat-completions
 *     response. The banter ack deltas land on THAT response (not a
 *     long-lived SSE set). Voice-transport opens one SSE for the whole
 *     call; the browser opens one chat-completions per turn.
 *   - Out-of-band utterances (rendition deltas, narration deltas, tool
 *     cards) ride a separate per-session SSE channel at
 *     `GET /anam-web/events?session=<id>`, which the browser subscribes
 *     to ONCE for the lifetime of the Anam session. Server-side we tail
 *     the host log file and filter by thread_id / platform_id; consumers
 *     dispatch on `.kind` per `docs/log-schema.md`.
 *
 * Identity / threading model:
 *
 *   - `platformId = "anam-web:<localStorage UUID>"` — the browser mints
 *     the UUID once on first visit and persists across visits. Same UUID
 *     = same user → conversation ring (per-thread) accumulates history.
 *   - `threadId  = "anam-web-call-<sessionId>"` — fresh per Anam session
 *     (per page load). Each session = its own thread + its own back-mind
 *     container session. No continuity across reloads (matches voice).
 *   - Browser sends `X-Pat-Platform-Id` + `X-Pat-Session-Id` on every
 *     `/anam-web/message` POST and on the `/anam-web/events` EventSource.
 *
 * Realtime cognition layer:
 *   The full inbound loop, narration brain, chat-row dedup, and
 *   per-thread state carriers are owned by `ChannelOrchestrator` +
 *   `NarrationManager` from `@agentic-toolkit/realtime`. This file is
 *   the channel-specific transport shim — HTTP routes, mg auto-
 *   provisioning, OpenAI-style chat-completions response shaping, and
 *   the banter-broadcast SSE feed for browser-side delta consumption.
 *   See `realtime/src/channel-orchestrator.ts` and
 *   `realtime/src/narration-manager.ts` for the shared logic.
 */
import fs from 'fs';
import http from 'http';
import path from 'path';

// PAT: ws-server library for the new `/anam-web/ws` endpoint. The host
// process runs on Node (tsx) — unlike pat-web (Bun) — so we can't use
// `hono/bun`'s createBunWebSocket helper here. The `ws` package is the
// canonical Node WS implementation; we use it in `noServer` mode and
// hook into the http.Server's `upgrade` event for protocol negotiation.
import { WebSocketServer } from 'ws';
import type { WebSocket as WsSocket } from 'ws';

import {
  streamBanterAck,
  streamBanterRender,
  requestLayerOnUserMessage,
  state as realtimeState,
  ChannelOrchestrator,
  NarrationManager,
  conversationKey,
  makeProvider,
  parseFastModelSlug,
  FastLlmKeepalivePinger,
} from '@agentic-toolkit/realtime';
import type {
  BanterEvent,
  BanterStreamCallbacks,
  BanterHistoryEntry,
  ChannelTransport,
  LlmCallHook,
  LlmCallTrace,
  BanterUtteranceSource,
  NarrationSession,
  StreamCancelReason,
} from '@agentic-toolkit/realtime';

// PAT (TaskList #8): per-inbound caller-context resolver. Install-side
// capability surface is seeded at boot via `setInstallCapabilities`
// (see `src/index.ts`); this resolver covers only the per-inbound
// caller block (identity + known handles + permissions).
// See `src/capability-resolver.ts` for surface scope.
import { createCallerContextResolver, resolveAgentGroupForPlatform } from '../capability-resolver.js';
import { loadScenarioContext } from '../presentation/load-scenario-context.js';
import { postSlideBus } from '../presentation/slide-bus-client.js';
import { getScenarioCursor, setScenarioCursor, clearScenarioCursor } from '../presentation/scenario-cursor.js';
import type { ScenarioAction } from '@agentic-toolkit/realtime';
// PAT: Phase 5 (plans/timeline-runtime-and-scenarios.md) — side-effect
// import. Loading the scenarios presentation barrel runs
// `registerActionDomain(scenariosPresentationExtension)` at module load,
// so the timeline action registry recognizes scenario tags
// (`next_slide`, `frag_next`, `goto_slide`, ...) when the orchestrator's
// tag-stream interpreter consults the registry. Without this import the
// extension would never register and scenario tags would fall through
// to the unknown-tag observability path.
import '@agentic-toolkit/scenarios/presentation';
// PAT: removed isContainerRunning + wakeContainer 2026-05-26 — only used
// by the deleted handlePrewarm / handlePrewarmWarmup back-mind prewarm path.
import { killContainer } from '../container-runner.js';
import { findSession, getActiveSessions, getSessionsByAgentGroup, updateSession } from '../db/sessions.js';
import {
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
  getMessagingGroupsByChannel,
  provisionMessagingGroup,
} from '../db/messaging-groups.js';
// PAT: removed resolveSession + writeSessionMessage 2026-05-26 — only used
// by the deleted back-mind prewarm path. Re-add if the file needs them again.
import { openOutboundDb } from '../db/session-db.js';
import { log } from '../log.js';
import { outboundDbPath } from '../session-manager.js';
// PAT: user_dms cache for anam-web inbound. Mirrors the cold-DM path
// `ensureUserDm` uses on outbound — populating on inbound makes future
// outbound.initiate against this user a single DB read rather than a
// re-resolution. The module-side import is intentional; signal.ts hasn't
// adopted it yet because it relies on the router's sender resolver, but
// anam-web's `anam-web:<uuid>` ids aren't a registered adapter prefix so
// the resolver short-circuits — we upsert explicitly here.
import { upsertUserDm } from '../modules/permissions/db/user-dms.js';
import { upsertUser } from '../modules/permissions/db/users.js';
import { resolvePersonIdentity } from '../people/index.js'; // PAT: inbound.received person enrichment
import { registerChannelAdapter } from './channel-registry.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';

// ────────────────────────── Constants ────────────────────────────────

const CHANNEL_TYPE = 'anam-web';
const CHANNEL_NAME = 'anam-web';
const DEFAULT_PORT = 8766;
const NARRATION_POLL_INTERVAL_MS = 1000;

const PLATFORM_HEADER = 'x-pat-platform-id';
const SESSION_HEADER = 'x-pat-session-id';

const FALLBACK_PLATFORM_ID = 'anam-web:unknown';

function channelPort(): number {
  const raw = process.env.ANAM_WEB_CHANNEL_PORT;
  if (!raw) return DEFAULT_PORT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PORT;
}

/** `sessionId` (the per-page uuid the browser sent) → thread_id. */
function threadIdFromSession(sessionId: string): string {
  return `anam-web-call-${sessionId}`;
}

/** Extract sessionId back out of a threadId — `anam-web-call-<uuid>` → `<uuid>`. */
function sessionIdFromThread(threadId: string | null): string | null {
  if (!threadId) return null;
  const m = /^anam-web-call-(.+)$/.exec(threadId);
  return m?.[1] ?? null;
}

// ─────────────────── Per-thread state (scoped to adapter) ─────────────

/** Channel orchestrator — owns all per-thread state carriers
 *  (TtsBusyTracker, StreamingControllers, ConversationHistory,
 *  BanterBroadcast), the back-mind processing flag, the
 *  buffered-banter ring, and the full inbound loop
 *  (`handleUserMessage`). Aliases below give shorter names to the
 *  pieces this adapter touches directly outside the inbound loop. */
const orchestrator = new ChannelOrchestrator({
  host: { log },
  // Per-inbound packet load. When platformId is `anam-web:scenario-<slug>`,
  // resolver returns a ScenarioContext that threads into all four
  // front-mind prompts (banter-ack / banter-render / banter-narration /
  // request-layer). Default Pat behavior otherwise.
  scenarioResolver: (platformId, threadId) => loadScenarioContext(platformId, threadId),
  // PAT (TaskList #8): per-inbound caller-context resolver. Install-
  // side capability surface is seeded at boot via
  // `setInstallCapabilities` and lives in SYSTEM; this resolver only
  // covers the per-inbound caller block (identity, known handles,
  // permissions). Pure DB reads; no model calls.
  callerContextResolver: createCallerContextResolver({ channelType: CHANNEL_TYPE }),
  // PAT: tag-stream non-prose action dispatcher. Fires per nav /
  // fragment / ask-questions / tool action emitted by the action
  // interpreter. Translates to pat-web slide-bus POSTs so the deck
  // iframe animates in lockstep with prose.
  scenarioActionDispatcher: dispatchScenarioAction,
});
const conversationHistory = orchestrator.history;
const streamingControllers = orchestrator.streams;
const banter = orchestrator.banter;
const ttsBusyTracker = orchestrator.tts;

// ────────────────── Tag-stream action dispatcher ────────────────────
//
// PAT: handles non-prose ScenarioActions emitted by the front-mind
// action interpreter. Prose actions ride the renditionTransport
// (banter SSE → browser → Anam talkStream) inside the library;
// nav/fragment/tool actions surface here so we can drive the deck
// iframe via the slide-bus and surface tool requests for follow-up.
//
// Best-effort: a slide-bus POST failure is logged and dropped. The
// host-side parser/interpreter has already emitted the
// `scenario.action` structured-log event, so the dashboard records
// the intent even when the deck iframe is offline.

async function dispatchScenarioAction(
  action: ScenarioAction,
  ctx: { scenario: { slug: string }; threadId: string | null; platformId: string },
): Promise<void> {
  const slug = ctx.scenario.slug;
  const threadKey = conversationKey(ctx.threadId, ctx.platformId);
  switch (action.type) {
    case 'slide-nav': {
      // Update in-memory cursor BEFORE the bus POST so the next
      // inbound's ScenarioContext loader (which reads cursor from
      // memory for tag-stream packets) sees the new slide. Cursor is
      // 1-indexed; slide-bus payload is relative ('next'/'prev').
      if (action.direction === 'next' || action.direction === 'prev') {
        const cur = getScenarioCursor(threadKey);
        const next = action.direction === 'next' ? cur + 1 : Math.max(1, cur - 1);
        setScenarioCursor(threadKey, next);
        await postSlideBus(slug, { cmd: action.direction }, ctx.threadId);
      } else {
        // up/down/left/right map to the deck's vertical/horizontal
        // axes — not yet implemented in the bus, log and skip.
        log.info('anam-web: slide-nav direction not yet wired to bus', {
          direction: action.direction,
          slug,
        });
      }
      return;
    }
    case 'slide-goto': {
      // n is 1-indexed in the tag; slide-bus 'advance' expects 0-indexed.
      setScenarioCursor(threadKey, action.target_slide);
      await postSlideBus(slug, { cmd: 'advance', n: Math.max(0, action.target_slide - 1) }, ctx.threadId);
      return;
    }
    case 'fragment': {
      await postSlideBus(slug, { cmd: `frag-${action.direction}` }, ctx.threadId);
      return;
    }
    case 'ask-questions': {
      // No deck-side animation; the request-layer / Q&A path picks up
      // the next inbound. Logged via scenario.action already.
      return;
    }
    case 'tool': {
      // Phase A: log only — Phase D / future work will round-trip
      // tool requests back into the back-mind's inbox so the agent
      // can act on them.
      log.info('anam-web: tag-stream tool directive (logged only for Phase A)', {
        slug,
        tool: action.tool_name,
        args: action.tool_args,
      });
      return;
    }
    case 'prose':
    case 'cartesia-passthrough':
    case 'unknown-tag':
      // PAT: prose + Cartesia passthroughs already rode the rendition
      // transport via the orchestrator's tag-stream branch.
      // unknown-tag is observability only.
      return;
  }
}

// ────────────── Lazy mg provisioning ─────────────
//
// First-time anam-web visitor flow:
//   1. Look up an existing messaging_group by (channel_type='anam-web',
//      platform_id='anam-web:<uuid>'). Idempotent short-circuit.
//   2. Resolve the configured default agent_group from
//      ANAM_WEB_DEFAULT_AGENT_GROUP_ID (required — throw clearly when
//      unset so a misconfigured install fails fast at first contact).
//      Anam-web doesn't seed from existing mgs; the env var is the
//      source of truth so a fresh install can serve its first visitor
//      without operator hand-wiring.
//   3. provisionMessagingGroup (`src/db/messaging-groups.ts`) inserts
//      the mg + mga + agent_destinations rows in one go. mg.name is
//      set to the destination's canonical local_name
//      (`anam-web-<8-char uuid>`) so normalizeName(mg.name) produces
//      the same value.
//   4. Upsert users + user_dms so future cold-DM outbound to this visitor
//      doesn't re-resolve from scratch.
//   5. Project destinations into any active session of the wired agent
//      group so already-running containers learn the new destination
//      without waiting for next wake.

/** Extract the per-visitor UUID from an `anam-web:<uuid>` platform id, or
 *  return the whole thing when the prefix is missing (defensive: the
 *  fallback `FALLBACK_PLATFORM_ID = 'anam-web:unknown'` already carries
 *  the prefix, so this branch should never fire in practice). */
function uuidFromPlatformId(platformId: string): string {
  const idx = platformId.indexOf(':');
  return idx < 0 ? platformId : platformId.slice(idx + 1);
}

/** `anam-web-<first 8 chars of uuid>`. Matches the destination-list
 *  pattern an operator already sees (`signal-15550100000`,
 *  `realtime-15550100000`). createMessagingGroupAgent's auto-create
 *  normalizes mg.name through `[^a-z0-9]+ → -`, which leaves this
 *  alphanumeric-plus-dash form unchanged — so the agent_destinations
 *  row lands with this exact local_name. */
function destinationNameForAnamWeb(platformId: string): string {
  const short = uuidFromPlatformId(platformId).slice(0, 8) || 'unknown';
  return `anam-web-${short}`;
}

/** Resolve the configured anam-web default agent group, throwing a clear
 *  error when unset so misconfigured installs fail fast at first contact
 *  rather than silently dropping the visitor. Centralized so tests and
 *  the lazy-provisioning path read the same env var. */
function requireAnamWebDefaultAgentGroupId(): string {
  const id = (process.env.ANAM_WEB_DEFAULT_AGENT_GROUP_ID || '').trim();
  if (!id) {
    throw new Error(
      'anam-web: ANAM_WEB_DEFAULT_AGENT_GROUP_ID is unset. Set it to the agent_group_id that should answer anam-web inbound (no seed mg required).',
    );
  }
  return id;
}

/** Ensure an anam-web messaging_group + wiring + destination exists for
 *  this platformId. Idempotent. Returns null when the install is
 *  misconfigured (no ANAM_WEB_DEFAULT_AGENT_GROUP_ID) — caller logs and
 *  rejects the request rather than silently dropping. */
function ensureAnamWebMessagingGroup(
  platformId: string,
  visitorDisplayName: string | null = null,
): { id: string; platform_id: string; agent_group_id: string } | null {
  const existing = getMessagingGroupByPlatform(CHANNEL_TYPE, platformId);
  if (existing) {
    // Idempotent re-entry. We don't re-upsert users/user_dms here — they
    // were upserted at first contact and the display name doesn't change.
    // PAT: also don't require ANAM_WEB_DEFAULT_AGENT_GROUP_ID — the mg
    // already exists and its messaging_group_agents row carries the real
    // agent_group_id. The env var is only needed for the auto-provision
    // path when no mg exists yet (operator-default inbound). Presenter
    // scenarios explicitly pre-provision their mg via
    // provisionPresentation() and shouldn't depend on the env var.
    return {
      id: existing.id,
      platform_id: existing.platform_id,
      // Return empty here; downstream lookups (router, orchestrator)
      // resolve the real agent_group_id from messaging_group_agents.
      agent_group_id: '',
    };
  }

  let agentGroupId: string;
  try {
    agentGroupId = requireAnamWebDefaultAgentGroupId();
  } catch (err) {
    log.error('anam-web: cannot auto-provision', { err, platformId });
    return null;
  }

  const destName = destinationNameForAnamWeb(platformId);
  const result = provisionMessagingGroup({
    channelType: CHANNEL_TYPE,
    platformId,
    // Canonical local_name — leans on createMessagingGroupAgent's
    // auto-destination side effect (no separate createDestination call).
    mgName: destName,
    // 'public' matches the test seed; anam-web has no platform-side
    // member concept — every visitor identifies via a localStorage uuid.
    unknownSenderPolicy: 'public',
    mga: {
      agent_group_id: agentGroupId,
      // anam-web turns are stateless from the routing POV: one tab = one
      // thread, banter ack runs locally and only the request-layer
      // forwards land in the agent's session DB.
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'accumulate',
      session_mode: 'per-thread',
      priority: 0,
    },
  });

  // user_dms cache. The user id namespace is `anam-web:<uuid>` (same as
  // the platform id) — anam-web has no separate "handle" concept. Outbound
  // cold-DM via ensureUserDm finds this row and resolves directly to the
  // mg without re-resolution.
  const userId = platformId; // already `anam-web:<uuid>`
  const now = new Date().toISOString();
  upsertUser({
    id: userId,
    kind: 'anam-web',
    display_name: visitorDisplayName,
    created_at: now,
  });
  upsertUserDm({
    user_id: userId,
    channel_type: CHANNEL_TYPE,
    messaging_group_id: result.id,
    resolved_at: now,
  });

  log.event({
    kind: 'misc',
    data: {
      msg: 'anam-web: auto-provisioned messaging_group + destination + user_dm for new visitor',
      channel_type: CHANNEL_TYPE,
      platform_id: platformId,
      agent_group_id: agentGroupId,
      mg_id: result.id,
      destination_name: result.destination_name,
    },
  });

  // Project destinations into any session already running for this agent
  // group. session_mode='per-thread' means this visitor's first turn will
  // spawn a fresh container that calls writeDestinations on wake — BUT
  // other visitors of the same agent group may have running containers
  // that need the new destination row too (e.g. the back-mind tries to
  // message anam-web-aaaaaaaa from a different visitor's session via
  // cross-channel send).
  void refreshDestinationsForAgentGroup(agentGroupId);

  return { id: result.id, platform_id: platformId, agent_group_id: agentGroupId };
}

/** Fire-and-forget destination projection into every active session of
 *  the wired agent group. See signal.ts's mirror function for the
 *  rationale (already-running container has stale inbound.db
 *  destinations until next wake). */
async function refreshDestinationsForAgentGroup(agentGroupId: string): Promise<void> {
  try {
    const sessions = getSessionsByAgentGroup(agentGroupId).filter((s) => s.status === 'active');
    if (sessions.length === 0) return;
    const { writeDestinations } = await import('../modules/agent-to-agent/write-destinations.js');
    for (const session of sessions) {
      try {
        writeDestinations(agentGroupId, session.id);
      } catch (err) {
        log.warn('anam-web: writeDestinations failed for session', { sessionId: session.id, err });
      }
    }
  } catch (err) {
    log.debug('anam-web: refreshDestinationsForAgentGroup skipped', { err });
  }
}

// ─────────────────── Streaming transport factory ────────────────────

function anamWebTransport(
  sessionForBroadcast: string | null,
  threadId: string | null,
  platformId: string,
  source: BanterUtteranceSource,
  model: string,
  writeOpenAiDelta: (text_delta: string) => void,
): ChannelTransport {
  return {
    onStreamStarted: () => {
      banter.broadcast(sessionForBroadcast, 'utterance.stream-started', threadId, platformId, { source, model });
      // PAT: mark TTS busy with the tracker's fallback (we don't know
      // the final text length yet — it's a stream). pat-web POSTs
      // `/anam-web/turn-ended` on Anam's `endOfSpeech || interrupted`
      // signal, which calls markEnded and clears this. Without the
      // POST the fallback timeout (30s) clears it anyway so a wedged
      // browser can't permanently block the narrator.
      ttsBusyTracker.markStarted(threadId, 30_000);
    },
    onDelta: (text_delta: string, seq: number) => {
      writeOpenAiDelta(text_delta);
      banter.broadcast(sessionForBroadcast, 'utterance.stream-delta', threadId, platformId, {
        source,
        text_delta,
        seq,
      });
    },
    onEnd: (fullText: string, deltaCount: number, streamMs: number, firstDeltaMs: number) => {
      banter.broadcast(sessionForBroadcast, 'utterance.stream-ended', threadId, platformId, {
        source,
        full_text: fullText,
        delta_count: deltaCount,
        stream_ms: streamMs,
        first_delta_ms: firstDeltaMs,
      });
    },
    onCancelled: (reason: StreamCancelReason, partialText: string, deltaCount: number) => {
      banter.broadcast(sessionForBroadcast, 'utterance.stream-cancelled', threadId, platformId, {
        source,
        reason,
        partial_text: partialText,
        delta_count: deltaCount,
      });
      // Stream aborted — TTS won't actually fire (or fires very
      // briefly). Clear busy so narration doesn't wait for an end
      // signal that won't come.
      ttsBusyTracker.markEnded(threadId, partialText);
    },
  };
}

// ─────────────────────── Adapter factory ─────────────────────────────

export function createAnamWebAdapter(): ChannelAdapter {
  let server: http.Server | null = null;
  // PAT: server-side WebSocket endpoint backing the pat-web realtime
  // bridge (`/anam-web/ws`). Hangs off the same http.Server in
  // `noServer` mode so we share the port with the legacy HTTP routes
  // (`/anam-web/message`, `/anam-web/banter`, etc.). Created lazily in
  // `setup()` once `config` is available — the connection handler
  // needs to forward inbound user messages into `config.onInbound`.
  let wss: WebSocketServer | null = null;
  // PAT: NarrationManager class lives in `realtime/src/narration-manager.ts`
  // — same poll loop and brain-spawn logic phone-call uses. Anam-web
  // omits `broadcast` because narration deltas already reach the
  // browser via the structured-log SSE feed (`/anam-web/events`); a
  // full-utterance fan-out would be redundant.
  const narrationManager = new NarrationManager(orchestrator, {
    channelType: CHANNEL_TYPE,
    listSessions: () => {
      const mgs = getMessagingGroupsByChannel(CHANNEL_TYPE);
      if (mgs.length === 0) return [];
      const mgById = new Map(mgs.map((mg) => [mg.id, mg]));
      const anamMgIds = new Set(mgs.map((mg) => mg.id));
      return getActiveSessions()
        .filter((s) => s.messaging_group_id !== null && anamMgIds.has(s.messaging_group_id))
        .map((s) => {
          const mg = mgById.get(s.messaging_group_id!)!;
          return {
            sessionId: s.id,
            threadId: s.thread_id ?? null,
            platformId: mg.platform_id,
            agentGroupId: s.agent_group_id,
            messagingGroupId: s.messaging_group_id!,
          };
        });
    },
    readOutbound: (session: NarrationSession, lastSeq: number) => {
      const db = openOutboundDb(outboundDbPath(session.agentGroupId, session.sessionId));
      try {
        return db
          .prepare('SELECT id, seq, kind, content FROM messages_out WHERE seq > ? ORDER BY seq ASC LIMIT 100')
          .all(lastSeq) as Array<{ id: string; seq: number; kind: string; content: string }>;
      } finally {
        try {
          db.close();
        } catch {
          /* best-effort */
        }
      }
    },
    makeTransport: (threadId: string | null, platformId: string) =>
      anamWebTransport(
        sessionIdFromThread(threadId),
        threadId,
        platformId,
        'banter-narration',
        process.env.FAST_MODEL ?? 'claude-haiku-4-5-20251001',
        () => {
          /* no per-request response to write into for narration */
        },
      ),
    markSessionClosed: (s: NarrationSession) => updateSession(s.sessionId, { status: 'closed' }),
  });

  const adapter: ChannelAdapter = {
    name: CHANNEL_NAME,
    channelType: CHANNEL_TYPE,
    // PAT: realtime channel — emits its own inbound.received via the
    // orchestrator; router skips its chat-forward to avoid double-emit.
    isRealtime: true,
    supportsThreads: true,

    async setup(config: ChannelSetup): Promise<void> {
      const port = channelPort();
      const host = process.env.ANAM_WEB_BIND_HOST || '127.0.0.1';
      server = http.createServer((req, res) => handleRequest(req, res, config));

      // PAT: attach the `/anam-web/ws` WebSocket endpoint to the same
      // listener. `noServer:true` skips the library's own http server
      // and lets us decide which upgrade requests it handles — i.e.
      // route only the WS path here while leaving everything else
      // (SSE banter, prewarm, etc.) on the HTTP handler. Auth surface
      // mirrors `/anam-web/message`: server-to-server inside Fly
      // internal — the bar is channel-trust, not browser-grade.
      wss = new WebSocketServer({ noServer: true });
      server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        if (url.pathname !== '/anam-web/ws') {
          // Foreign upgrade target — drop the socket so the http
          // server doesn't hang waiting for one.
          socket.destroy();
          return;
        }
        wss!.handleUpgrade(req, socket, head, (ws) => {
          wss!.emit('connection', ws, req);
        });
      });
      wss.on('connection', (ws, req) => {
        handleWsConnection(ws, req, config);
      });

      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(port, host, () => {
          log.info('anam-web channel listening', { port, host });
          resolve();
        });
      });
      narrationManager.start();
    },

    async teardown(): Promise<void> {
      narrationManager.stop();
      if (wss) {
        // Drop all live sockets; per-WS `onClose` handlers fire the
        // banter.subscribe cleanup. Closing the WSS first means the
        // http.Server's close() doesn't wait on idle WS sockets.
        for (const client of wss.clients) {
          try {
            client.close(1001, 'shutdown');
          } catch {
            /* noop */
          }
        }
        wss.close();
        wss = null;
      }
      if (server) {
        await new Promise<void>((resolve) => {
          server!.close(() => resolve());
        });
        server = null;
      }
    },

    isConnected(): boolean {
      return server !== null;
    },

    /**
     * Outbound chat row from the back-mind. We re-render through the banter
     * rendition layer, then let the log emits carry the deltas to
     * the browser via the `/anam-web/events` SSE channel. The browser
     * dispatches utterance.stream-delta source='banter-rendition' to
     * `anamClient.talk(text_delta)` so the avatar speaks it out-of-band.
     *
     * (No per-request response to write into — that lifetime is the
     * single user turn, which is already complete by the time the back-
     * mind produces this chat row.)
     */
    async deliver(platformId, threadId, message: OutboundMessage): Promise<string | undefined> {
      if (message.kind !== 'chat') {
        // detail / other kinds — delivery.ts short-circuits detail and
        // doesn't call us. If something else lands, log and drop.
        log.info('anam-web: deliver non-chat (ignored)', {
          kind: message.kind,
          platformId,
          threadId,
        });
        return undefined;
      }
      const rawText =
        typeof (message.content as { text?: unknown }).text === 'string'
          ? (message.content as { text: string }).text
          : '';
      if (!rawText) {
        log.warn('anam-web: chat row with no text; dropping', {});
        return undefined;
      }
      const platformIdForMessage = platformId ?? FALLBACK_PLATFORM_ID;
      const threadIdForMessage = threadId ?? null;
      // PAT (TaskList #8): resolve agentGroupId for the install-side
      // capability block lookup inside banter-render's render().
      const agentGroupForMessage = resolveAgentGroupForPlatform(CHANNEL_TYPE, platformIdForMessage);
      const agentGroupIdForMessage = agentGroupForMessage?.agentGroupId ?? '';
      // Orchestrator owns the chat-row dedup queue + rendition + history
      // stamp + log emits + TTS busy marking. Rendition deltas reach the
      // browser via the banter-broadcast transport (utterance.stream-*
      // events the /anam-web/events SSE feed surfaces).
      const sessionForBroadcast = sessionIdFromThread(threadIdForMessage);
      const model = process.env.FAST_MODEL ?? 'claude-haiku-4-5-20251001';
      await orchestrator.deliverChat({
        threadId: threadIdForMessage,
        threadKey: conversationKey(threadIdForMessage, platformIdForMessage),
        platformId: platformIdForMessage,
        agentGroupId: agentGroupIdForMessage,
        rawText,
        renditionTransport: anamWebTransport(
          sessionForBroadcast,
          threadIdForMessage,
          platformIdForMessage,
          'banter-rendition',
          model,
          () => {
            /* no per-request response to write into for rendition */
          },
        ),
      });
      return undefined;
    },
  };

  return adapter;
}

// ──────────────────────── HTTP handler dispatch ──────────────────────

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse, config: ChannelSetup): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, channel: CHANNEL_TYPE }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/anam-web/message') {
    await handleUserMessage(req, res, config);
    return;
  }

  // PAT: removed back-mind prewarm routes 2026-05-26 — `/anam-web/prewarm`
  // (session-token-mint, d3f3dab) + `/anam-web/prewarm-warmup`
  // (first-gesture, 5eec056). Both fired a Sonnet no-op query that
  // blocked the per-session container's poll loop while real user
  // chat rows waited (78s observed on anam-web-call-c6ba0098). See
  // container/agent-runner/src/poll-loop.ts for the matching removal.

  if (req.method === 'GET' && url.pathname === '/anam-web/events') {
    handleEventsSse(req, res, url);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/anam-web/banter') {
    handleBanterSse(req, res, url);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/anam-web/barge-in') {
    await handleBargeIn(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/anam-web/session-ended') {
    await handleSessionEnded(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/anam-web/turn-ended') {
    await handleTurnEnded(req, res);
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
}

// PAT: removed back-mind prewarm 2026-05-26 — handlePrewarm,
// handlePrewarmWarmup, prewarmBackMind, prewarmInFlightSessionIds,
// WARMUP_PLATFORM_ID, WARMUP_THREAD_ID all lived here. The prewarm
// blocked the per-session container's poll loop for the full SDK
// cold-start while real user chat rows waited (78s on
// anam-web-call-c6ba0098). `prewarmFastLlm` (Cerebras TLS socket warmup,
// unrelated to back-mind) is kept below for future re-wiring.

async function prewarmFastLlm(ctx: { threadId: string; platformId: string }): Promise<void> {
  // Build the PRIMARY provider directly via makeProvider — do NOT go
  // through getFastProvider, which wraps with FallbackProvider. The
  // prewarm's whole point is to warm the primary's TLS socket; if the
  // primary fails, falling back to a different vendor warms the WRONG
  // socket. Verified 2026-05-24: a 1-token prewarm against Cerebras
  // gpt-oss-120b returned `delta.role` + `delta.reasoning` but no
  // `delta.content`, the primary returned `ok:false, error:'no content'`,
  // and FallbackProvider routed to Anthropic Haiku — warming the
  // Anthropic socket while the real banter-ack call would use Cerebras.
  //
  // We resolve the same model the real banter-ack call will use, but
  // treat ANY non-thrown completion (even ok:false) as a successful
  // warm-up. What matters is that the TLS handshake + headers landed
  // — `result.ttfbMs` is the real signal. Content emission is irrelevant
  // for warm-up purposes.
  const slug = process.env.BANTER_ACK_MODEL || process.env.FAST_MODEL || 'anthropic/claude-haiku-4-5-20251001';
  const routing = parseFastModelSlug(slug);
  const t0 = Date.now();
  try {
    const provider = makeProvider(routing.provider, routing.model);
    const result = await provider.stream({
      system: 'You are a server health check.',
      user: 'Say "ok".',
      maxTokens: 16,
      onDelta: () => {
        /* discard */
      },
    });
    log.event({
      kind: 'anam-web.llm-prewarmed',
      thread_id: ctx.threadId,
      platform_id: ctx.platformId,
      data: {
        ok: result.ttfbMs !== undefined, // socket warmed iff headers landed
        latency_ms: Date.now() - t0,
        ttfb_ms: result.ttfbMs,
        provider: result.provider,
        model: result.model,
        // PAT: surface socket-state so dashboards can verify the prewarm
        // actually performed a handshake (the WHOLE POINT of prewarm) —
        // first prewarm after boot should be `connection_reused: false`
        // with a concrete `connect_ms`, subsequent prewarms within the
        // keep-alive window should be `connection_reused: true`.
        ...(result.connectionReused !== undefined ? { connection_reused: result.connectionReused } : {}),
        ...(result.connectMs !== undefined ? { connect_ms: result.connectMs } : {}),
        error: result.ok ? undefined : result.error,
      },
    });
  } catch (err) {
    log.warn('anam-web llm-prewarm threw', { err, threadId: ctx.threadId });
    log.event({
      kind: 'anam-web.llm-prewarmed',
      thread_id: ctx.threadId,
      platform_id: ctx.platformId,
      data: { ok: false, latency_ms: Date.now() - t0, error: (err as Error).message },
    });
  }
}

// ───────────────────────── /anam-web/message ────────────────────────────

interface TurnPayload {
  model?: string;
  stream?: boolean;
  messages?: Array<{ role: string; content?: string }>;
}

/**
 * PAT: shared inbound-loop helper. Drives `orchestrator.handleUserMessage`
 * for a parsed (platformId, sessionId, userText) triple. Called by both:
 *   - The legacy HTTP handler `/anam-web/message` (passes a writer that
 *     emits OpenAI-shape SSE chat-completions deltas on the response).
 *   - The new WS handler `/anam-web/ws` (passes a no-op writer; banter
 *     deltas reach the browser via the WS-piped banter-broadcast stream).
 *
 * Returns the orchestrator result; callers stamp their own response
 * shape. Caller is responsible for lazy mg provisioning, payload
 * parsing, and any per-transport status emission.
 */
async function runUserMessageLoop(args: {
  platformId: string;
  sessionIdRaw: string;
  userText: string;
  config: ChannelSetup;
  ensured: { agent_group_id: string };
  writeDelta: (text_delta: string) => void;
}): Promise<void> {
  const { platformId, sessionIdRaw, userText, config, ensured, writeDelta } = args;
  const threadId = threadIdFromSession(sessionIdRaw);
  const threadKey = conversationKey(threadId, platformId);
  const sessionForBroadcast = sessionIdFromThread(threadId);
  const model = process.env.FAST_MODEL ?? 'claude-haiku-4-5-20251001';
  const senderId = platformId; // platformId already encodes anam-web:<uuid>

  // PAT: resolve the visitor's opaque person_id (people-spine) for the
  // inbound.received log enrichment. The realtime library can't import the
  // people-spine, so we resolve here and pass it into the orchestrator.
  // Defensive: never throws, returns null when unlinked / on error. No name —
  // names live in pat_enrichment, never beside message bodies.
  const { personId } = resolvePersonIdentity(senderId);

  await orchestrator.handleUserMessage({
    threadId,
    threadKey,
    platformId,
    // PAT (TaskList #8): agent_group_id drives the install-side
    // capability block lookup inside each front-mind prompt's render().
    agentGroupId: ensured.agent_group_id,
    sessionId: sessionForBroadcast,
    userText,
    senderId,
    channelType: CHANNEL_TYPE, // PAT: stamped onto inbound.received
    personId, // PAT: opaque id only — name lives in pat_enrichment
    transport: anamWebTransport(sessionForBroadcast, threadId, platformId, 'banter-ack', model, writeDelta),
    forwardToBackMind: async ({ invokeText }: { invokeText: string }) => {
      await config.onInbound(platformId, threadId, {
        id: `anam-web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        content: {
          text: invokeText,
          sender: 'realtime-user',
          senderId,
        },
      });
    },
    // PAT: persist banter asides (front-mind acks + noop'd user turns)
    // as kind:'banter' rows. Router forces trigger=0 so they accumulate
    // without waking; the formatter renders them in `<banter>` on the
    // next chat-row wake.
    recordBanter: async ({ from, text }) => {
      await config.onInbound(platformId, threadId, {
        id: `anam-web-banter-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'banter',
        timestamp: new Date().toISOString(),
        content: { text, sender: from },
      });
    },
  });
}

async function handleUserMessage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: ChannelSetup,
): Promise<void> {
  const platformId = headerStr(req, PLATFORM_HEADER) ?? FALLBACK_PLATFORM_ID;
  const sessionIdRaw = headerStr(req, SESSION_HEADER);
  if (!sessionIdRaw) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `missing ${SESSION_HEADER} header` }));
    return;
  }

  let body = '';
  req.setEncoding('utf8');
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 256 * 1024) {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'payload too large' }));
      return;
    }
  }
  let payload: TurnPayload;
  try {
    payload = JSON.parse(body) as TurnPayload;
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid json' }));
    return;
  }

  // Last user message — use-banter-driver sends the whole history per turn.
  const lastUser = [...(payload.messages ?? [])].reverse().find((m) => m.role === 'user');
  const userText = typeof lastUser?.content === 'string' ? lastUser.content.trim() : '';
  if (!userText) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'no user message' }));
    return;
  }

  // Lazy mg provisioning per (platformId). Returns null only when the
  // install is misconfigured (ANAM_WEB_DEFAULT_AGENT_GROUP_ID unset);
  // operator needs to set the env var and restart.
  const ensured = ensureAnamWebMessagingGroup(platformId);
  if (!ensured) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'anam-web not configured: set ANAM_WEB_DEFAULT_AGENT_GROUP_ID' }));
    return;
  }

  // Open the OpenAI-shape SSE response.
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const writeOpenAiDelta = (text_delta: string): void => {
    const chunk = JSON.stringify({ choices: [{ delta: { content: text_delta } }] });
    try {
      res.write(`data: ${chunk}\n\n`);
    } catch (err) {
      log.warn('anam-web: chat-completions write failed', { err });
    }
  };

  await runUserMessageLoop({
    platformId,
    sessionIdRaw,
    userText,
    config,
    ensured,
    writeDelta: writeOpenAiDelta,
  });

  // Close out the OpenAI-shape SSE response.
  try {
    res.write('data: [DONE]\n\n');
    res.end();
  } catch {
    /* already closed */
  }
}

// ───────────────────── /anam-web/events (per-session SSE) ────────────

/**
 * Tail the host log file and emit one SSE event per line that matches
 * the session's thread_id OR platform_id. Browser dispatches on `.kind`.
 *
 * Filters OUT `utterance.stream-delta/ended/cancelled` with
 * `source === 'banter-ack'` — those already streamed through
 * `/anam-web/message`'s chat-completions response, re-emitting would cause
 * double-speak.
 */
function handleEventsSse(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
  const sessionId = url.searchParams.get('session');
  if (!sessionId) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing ?session=' }));
    return;
  }
  const threadId = threadIdFromSession(sessionId);
  // Optional platform_id filter — when supplied, lines without thread_id
  // but matching the platform also pass (so global state.transitioned
  // events with platform_id but no thread_id surface).
  const platformIdFilter = url.searchParams.get('platform_id');

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(`: anam-web events session=${sessionId}\n\n`);

  // Since-filter so reconnects don't replay forever.
  let sinceMs = 0;
  const sinceRaw = url.searchParams.get('since');
  if (sinceRaw) {
    const n = Number(sinceRaw);
    if (Number.isFinite(n) && n > 0) sinceMs = n;
  }

  let closed = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let kaTimer: ReturnType<typeof setInterval> | null = null;
  let currentPath: string | null = null;
  let offset = 0;
  let buf = '';
  let lastWriteAt = Date.now();

  const safeWrite = (chunk: string): boolean => {
    try {
      res.write(chunk);
      lastWriteAt = Date.now();
      return true;
    } catch {
      return false;
    }
  };

  const cleanup = () => {
    closed = true;
    if (timer) clearInterval(timer);
    timer = null;
    if (kaTimer) clearInterval(kaTimer);
    kaTimer = null;
  };
  req.on('close', cleanup);
  req.on('error', cleanup);

  const lineMatches = (line: string): boolean => {
    // Cheap-parse for thread_id / platform_id and source filter.
    // Skip banter-ack utterance.stream-* (already through chat-completions).
    if (line.includes('"source":"banter-ack"')) {
      // Only the stream-* utterance events carry this — drop them. Other
      // log lines that legitimately include the string don't exist in
      // the schema today.
      if (
        line.includes('"kind":"utterance.stream-delta"') ||
        line.includes('"kind":"utterance.stream-ended"') ||
        line.includes('"kind":"utterance.stream-started"') ||
        line.includes('"kind":"utterance.stream-cancelled"')
      ) {
        return false;
      }
    }
    // PAT: filter semantics:
    //   - If the line carries thread_id, require it to match X (event
    //     scoped to a session — must be this session's thread).
    //   - If the line has no thread_id, fall through to platform_id
    //     check (global events like state.transitioned, container.*,
    //     session.* without thread surface only when platform_id
    //     matches the caller's scenario).
    // Old behavior was thread_id OR platform_id (either passed), which
    // leaked events from sibling threads sharing the same platform_id.
    const hasThreadId = line.includes('"thread_id":"');
    if (hasThreadId) {
      // Must match THIS thread, no fallthrough to platform.
      return line.includes(`"thread_id":"${threadId}"`);
    }
    // No thread_id on the line — check the optional platform filter.
    if (platformIdFilter && line.includes(`"platform_id":"${platformIdFilter}"`)) return true;
    return false;
  };

  const tick = () => {
    if (closed) return;
    const day = new Date().toISOString().slice(0, 10);
    const logDir = process.env.PAT_HOST_LOG_DIR ?? path.resolve(process.cwd(), 'data', 'logs');
    const filePath = path.join(logDir, `host-${day}.jsonl`);
    if (filePath !== currentPath) {
      currentPath = filePath;
      offset = 0;
      buf = '';
    }
    if (!fs.existsSync(filePath)) return;
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return;
    }
    if (stat.size < offset) {
      offset = 0;
      buf = '';
    }
    if (stat.size === offset) return;
    let chunk: string;
    try {
      const fd = fs.openSync(filePath, 'r');
      const len = stat.size - offset;
      const data = Buffer.alloc(len);
      fs.readSync(fd, data, 0, len, offset);
      fs.closeSync(fd);
      chunk = data.toString('utf8');
      offset = stat.size;
    } catch {
      return;
    }
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line) continue;
      if (sinceMs > 0) {
        const m = /"ts"\s*:\s*"([^"]+)"/.exec(line);
        if (m) {
          const lineMs = Date.parse(m[1] ?? '');
          if (Number.isFinite(lineMs) && lineMs < sinceMs) continue;
        }
      }
      if (!lineMatches(line)) continue;
      if (!safeWrite(`data: ${line}\n\n`)) {
        cleanup();
        return;
      }
    }
  };

  timer = setInterval(tick, 250);
  kaTimer = setInterval(() => {
    if (closed) return;
    if (Date.now() - lastWriteAt < 15_000) return;
    if (!safeWrite(`: ka\n\n`)) cleanup();
  }, 5_000);
  tick();
}

// ───────────────────── /anam-web/banter (per-session SSE) ────────────
//
// Dedicated voice-transport channel: serves every utterance.stream-*
// event broadcast by runRequestScopedFrontMind, regardless of source
// (banter-ack + banter-rendition + banter-narration). Independent of
// the structured log file — events come from an in-memory broadcast
// (banter.broadcast / banter.subscribe) so reconnects don't replay
// other observability noise and HTTP/2 flakes can recover via
// Last-Event-Id.
//
// Wire format: one SSE event per BanterEvent, with `id: <event.id>` so
// EventSource auto-sends Last-Event-Id on reconnect.
function handleBanterSse(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
  const sessionId = url.searchParams.get('session');
  if (!sessionId) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing ?session=' }));
    return;
  }
  // Last-Event-Id (replay cursor) — EventSource sends this header on
  // automatic reconnect. Also accept ?since= as an explicit query param.
  const lastEventIdHeader =
    (req.headers['last-event-id'] as string | undefined) ?? url.searchParams.get('since') ?? null;

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(`: anam-web banter session=${sessionId}\n\n`);

  let closed = false;
  let kaTimer: ReturnType<typeof setInterval> | null = null;
  let lastWriteAt = Date.now();

  const safeWrite = (chunk: string): boolean => {
    try {
      res.write(chunk);
      lastWriteAt = Date.now();
      return true;
    } catch {
      return false;
    }
  };

  const emit = (e: BanterEvent): void => {
    if (closed) return;
    // EventSource tracks the most recent `id:` line and replays it as
    // Last-Event-Id on automatic reconnect — the replay loop in
    // banter.subscribe picks up from there.
    const payload = JSON.stringify(e);
    if (!safeWrite(`id: ${e.id}\ndata: ${payload}\n\n`)) cleanup();
  };

  const cleanup = (): void => {
    closed = true;
    if (kaTimer) clearInterval(kaTimer);
    kaTimer = null;
    try {
      unsub();
    } catch {
      /* noop */
    }
  };

  const unsub = banter.subscribe(sessionId, emit, lastEventIdHeader);
  req.on('close', cleanup);
  req.on('error', cleanup);

  // Aggressive keepalive (3s) so HTTP/2 edges don't idle-close the
  // stream mid-utterance gap.
  kaTimer = setInterval(() => {
    if (closed) return;
    if (Date.now() - lastWriteAt < 3_000) return;
    if (!safeWrite(`: ka\n\n`)) cleanup();
  }, 3_000);
}

// ─────────────────────── /anam-web/ws (PAT realtime bridge) ─────────
//
// PAT: server-to-server WebSocket between pat-web and nanoclaw. One WS
// per browser-side anam-web call; pat-web opens it at session-start and
// closes at session-end. Replaces three round-trips per call lifecycle
// (HTTP POST /anam-web/message per user turn + GET /anam-web/banter SSE
// + POST /anam-web/turn-ended) with a single duplex socket.
//
// Wire shape:
//
//   Inbound frames (pat-web bridge → nanoclaw):
//     { kind: "user-message", text, threadId, platformId, correlationId? }
//     { kind: "turn-ended", text?, threadId?, interrupted? }
//     { kind: "barge-in", sessionId, reason? }
//     { kind: "session-ended", sessionId }
//
//   Outbound frames (nanoclaw → pat-web bridge):
//     Verbatim `BanterEvent` rows from `banter.subscribe()` —
//     `utterance.stream-{started,delta,ended,cancelled}` with the same
//     shape `/anam-web/banter` SSE emits today. Browser dispatches the
//     same way.
//
// Auth: per the spec, "matches the existing channel auth" — i.e. none
// beyond network position. `/anam-web/message` trusts the upstream
// pat-web caller because it lives on the same Fly internal-net. The
// browser-grade auth boundary is pat-web's `/api/realtime` WS upgrade
// (Sec-WebSocket-Protocol bearer). See pat-web/server/realtime-ws.ts.
//
// The legacy SSE handler `handleBanterSse` is intentionally left intact;
// both can co-exist on the same banter.subscribe() backlog. pat-web no
// longer uses the SSE path after this change, but other potential
// consumers might (and it's the safe rollback path).

interface WsInboundFrame {
  kind?: string;
  text?: string;
  threadId?: string;
  platformId?: string;
  correlationId?: string;
  sessionId?: string;
  reason?: string;
  interrupted?: boolean;
}

function handleWsConnection(ws: WsSocket, req: http.IncomingMessage, config: ChannelSetup): void {
  // The pat-web bridge MAY pass session/platform context via query string
  // for early logging; the source of truth on each frame is the frame body
  // (so a single pat-web ↔ nanoclaw WS can technically multiplex
  // sessions if we ever need it).
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const initialSessionId = url.searchParams.get('session');
  const initialPlatformId = url.searchParams.get('platform_id');

  // Per-connection banter subscription. We DON'T subscribe immediately
  // on open — we wait until the first frame tells us which session to
  // pipe (or we use the query string if present). The empty case is
  // a 1-RTT race but the pat-web bridge always opens the WS after it
  // has the sessionId in hand, so query-string-based subscription is
  // the common path.
  let banterUnsub: (() => void) | null = null;
  let subscribedSessionId: string | null = null;

  const emit = (e: BanterEvent): void => {
    // No `id:` framing needed on WS — frames are full JSON payloads.
    try {
      ws.send(JSON.stringify(e));
    } catch (err) {
      log.warn('anam-web/ws: emit failed', { err });
    }
  };

  const subscribeBanter = (sessionId: string): void => {
    if (subscribedSessionId === sessionId) return;
    if (banterUnsub) {
      try {
        banterUnsub();
      } catch {
        /* noop */
      }
      banterUnsub = null;
    }
    subscribedSessionId = sessionId;
    banterUnsub = banter.subscribe(sessionId, emit, null);
  };

  if (initialSessionId) subscribeBanter(initialSessionId);

  log.event({
    kind: 'anam-web.ws-opened',
    thread_id: initialSessionId ? threadIdFromSession(initialSessionId) : null,
    platform_id: initialPlatformId ?? null,
    data: {
      remote: (req.socket.remoteAddress ?? '') + ':' + (req.socket.remotePort ?? ''),
      session_id_present: Boolean(initialSessionId),
    },
  });

  // PAT: per-session TLS keepalive. Fires a 1-token ping every 3s through
  // the same provider+model the next banter-ack will use, so Node's
  // undici keep-alive socket stays warm across the 8-15s inter-turn gaps
  // typical of voice traffic. Bench evidence (2026-05-24): without this,
  // only 3/24 real banter-ack calls saw `connection_reused: true` — i.e.
  // 87.5% paid a fresh TCP+TLS handshake (200-1000ms cost). Started on
  // WS open; stop()'d in onClose. We ping banter-ack + request-layer to
  // cover both critical paths (typically same host, so deduped to one
  // ping per tick — but if FAST_MODEL and REQUEST_LAYER_MODEL diverge,
  // each socket pool stays warm independently).
  // PAT: keepalive pinger disabled for Cerebras provider 2026-05-26.
  // The Cerebras SDK ships with agentkeepalive (keepAlive: true, 5min
  // timeout) built into its default HTTPS agent — the TLS socket stays
  // warm between calls without us burning API tokens every 3s. Only
  // re-enable if FAST_MODEL switches back to a provider without
  // built-in keepalive (e.g. OpenRouter / raw Anthropic).
  const fastModel = process.env.FAST_MODEL ?? '';
  const isCerebras = fastModel.startsWith('cerebras/');
  const keepalive = new FastLlmKeepalivePinger({
    log,
    layers: ['banter-ack', 'request-layer'],
    threadId: initialSessionId ? threadIdFromSession(initialSessionId) : null,
    platformId: initialPlatformId ?? null,
  });
  if (!isCerebras) {
    keepalive.start();
  }

  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      log.warn('anam-web/ws: dropping binary frame');
      return;
    }
    const text = raw.toString('utf8');
    let frame: WsInboundFrame;
    try {
      frame = JSON.parse(text) as WsInboundFrame;
    } catch {
      log.warn('anam-web/ws: dropping non-JSON frame');
      return;
    }

    switch (frame.kind) {
      case 'user-message': {
        const platformId =
          typeof frame.platformId === 'string' && frame.platformId.length > 0
            ? frame.platformId
            : (initialPlatformId ?? FALLBACK_PLATFORM_ID);
        const userText = typeof frame.text === 'string' ? frame.text.trim() : '';
        // threadId on the wire is `anam-web-call-<sessionId>`; derive
        // sessionId for banter subscription either from that or fall
        // back to `initialSessionId` (query-string default).
        const wireThreadId = typeof frame.threadId === 'string' && frame.threadId.length > 0 ? frame.threadId : null;
        const sessionIdRaw = sessionIdFromThread(wireThreadId) ?? initialSessionId ?? '';
        if (!sessionIdRaw || !userText) {
          log.warn('anam-web/ws: user-message missing sessionId or text', {
            hasSession: Boolean(sessionIdRaw),
            hasText: Boolean(userText),
          });
          return;
        }
        // Make sure we're subscribed for THIS session's banter so the
        // browser receives utterance.stream-* frames for the upcoming
        // banter-ack stream.
        subscribeBanter(sessionIdRaw);

        const ensured = ensureAnamWebMessagingGroup(platformId);
        if (!ensured) {
          log.warn('anam-web/ws: user-message dropped — install not configured', {
            platformId,
          });
          return;
        }
        // Fire-and-forget: orchestrator drives streaming + history +
        // request-layer + back-mind forward. Errors are surfaced
        // through `error.surfaced` events on the same banter stream.
        void runUserMessageLoop({
          platformId,
          sessionIdRaw,
          userText,
          config,
          ensured,
          // WS path has no per-request response body; banter deltas
          // reach the browser via the banter.subscribe() pipe above.
          writeDelta: () => {
            /* no-op — voice rides the banter broadcast */
          },
        }).catch((err) => {
          log.warn('anam-web/ws: runUserMessageLoop threw', { err });
        });
        return;
      }
      case 'turn-ended': {
        const threadId =
          typeof frame.threadId === 'string' && frame.threadId.length > 0
            ? frame.threadId
            : initialSessionId
              ? threadIdFromSession(initialSessionId)
              : null;
        runTurnEndedCore({
          text: typeof frame.text === 'string' ? frame.text : '',
          threadId,
          interrupted: frame.interrupted === true,
        });
        return;
      }
      case 'barge-in': {
        const sessionId =
          typeof frame.sessionId === 'string' && frame.sessionId.length > 0 ? frame.sessionId : initialSessionId;
        if (!sessionId) {
          log.warn('anam-web/ws: barge-in frame missing sessionId');
          return;
        }
        runBargeInCore({
          sessionId,
          reason: typeof frame.reason === 'string' && frame.reason.length > 0 ? frame.reason : 'unknown',
        });
        return;
      }
      case 'session-ended': {
        const sessionId =
          typeof frame.sessionId === 'string' && frame.sessionId.length > 0 ? frame.sessionId : initialSessionId;
        if (!sessionId) {
          log.warn('anam-web/ws: session-ended frame missing sessionId');
          return;
        }
        runSessionEndedCore(sessionId);
        return;
      }
      default:
        log.warn('anam-web/ws: ignoring unknown frame kind', { kind: frame.kind });
        return;
    }
  });

  const onClose = (code: number, reason: Buffer): void => {
    if (banterUnsub) {
      try {
        banterUnsub();
      } catch {
        /* noop */
      }
      banterUnsub = null;
    }
    // PAT: stop the TLS keepalive pinger. Idempotent — if the WS dies
    // mid-tick, the in-flight ping is aborted via the pinger's internal
    // AbortController, the next tick is prevented by clearInterval.
    try {
      keepalive.stop();
    } catch (err) {
      log.warn('anam-web/ws: keepalive.stop threw', { err });
    }
    log.event({
      kind: 'anam-web.ws-closed',
      thread_id: subscribedSessionId ? threadIdFromSession(subscribedSessionId) : null,
      platform_id: initialPlatformId ?? null,
      data: {
        code,
        reason: reason.toString('utf8').slice(0, 200),
      },
    });
  };
  ws.on('close', onClose);
  ws.on('error', (err) => {
    log.warn('anam-web/ws: socket error', { err });
  });
}

// ───────────────────────── /anam-web/barge-in ────────────────────────

/**
 * PAT: shared barge-in core. Extracted from `handleBargeIn` so the
 * new `/anam-web/ws` handler can fire the same propagation path on
 * `{kind:"barge-in"}` frames without a fresh HTTP roundtrip. Logs
 * `bargein.received` + `bargein.propagated`, kills any active
 * back-mind container for the session, aborts streaming controllers,
 * clears the timeline sequencer + banter buffer, and resets the
 * processing flag.
 *
 * Returns the same shape the HTTP handler used to JSON-encode so a
 * future caller (or test) can read it directly.
 */
function runBargeInCore(args: { sessionId: string | null; reason: string }): {
  killed_container: boolean;
  killed_session_id: string | null;
  aborted_streams: number;
} {
  const { sessionId, reason } = args;
  const threadId = sessionId ? threadIdFromSession(sessionId) : null;
  // Derive platformId from the live session — barge-in doesn't carry it.
  // Best effort: search anam-web mgs for one whose session has this
  // threadId.
  let platformId: string | null = null;
  if (threadId) {
    const mgs = getMessagingGroupsByChannel(CHANNEL_TYPE);
    for (const mg of mgs) {
      const s = findSession(mg.id, threadId);
      if (s) {
        platformId = mg.platform_id;
        break;
      }
    }
  }

  log.event({
    kind: 'bargein.received',
    thread_id: threadId,
    platform_id: platformId,
    data: { reason },
  });

  let killedSessionId: string | null = null;
  let killedContainer = false;
  if (threadId && platformId) {
    try {
      const mg = getMessagingGroupByPlatform(CHANNEL_TYPE, platformId);
      if (mg) {
        const sess = findSession(mg.id, threadId);
        if (sess && sess.status === 'active') {
          killedSessionId = sess.id;
          try {
            killContainer(sess.id, 'bargein');
            killedContainer = true;
            log.event({
              kind: 'back-mind.cancelled',
              session_id: sess.id,
              thread_id: threadId,
              platform_id: platformId,
              data: { reason: 'bargein' },
            });
          } catch (err) {
            log.warn('anam-web bargein: killContainer threw', { sessionId: sess.id, err });
          }
        }
      }
    } catch (err) {
      log.warn('anam-web bargein: session lookup failed', { threadId, platformId, err });
    }
  }

  // PAT: drain the timeline Sequencer + close any open timeline ids so
  // `isDelivering()` flips false and no further queued actions reach TTS
  // or the slide-bus. Without this, killContainer + abortAll only stop
  // the back-mind and the in-flight TTS — the front-mind timeline keeps
  // draining until it organically reaches `timeline.finished`.
  const droppedTimelineActions = orchestrator.clearIntent(
    conversationKey(threadId, platformId ?? FALLBACK_PLATFORM_ID),
    { threadId, platformId: platformId ?? FALLBACK_PLATFORM_ID },
  );
  const abortedStreams = streamingControllers.abortAll(conversationKey(threadId, platformId ?? FALLBACK_PLATFORM_ID));
  orchestrator.setProcessing({
    threadKey: conversationKey(threadId, platformId ?? FALLBACK_PLATFORM_ID),
    threadId,
    platformId: platformId ?? FALLBACK_PLATFORM_ID,
    value: false,
  });
  banter.clear(sessionIdFromThread(threadId));

  log.event({
    kind: 'bargein.propagated',
    thread_id: threadId,
    platform_id: platformId,
    data: {
      killed_container: killedContainer,
      killed_session_id: killedSessionId ?? undefined,
      dropped_pending_contexts: droppedTimelineActions,
    },
  });

  return { killed_container: killedContainer, killed_session_id: killedSessionId, aborted_streams: abortedStreams };
}

async function handleBargeIn(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let body = '';
  req.setEncoding('utf8');
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 16 * 1024) {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'payload too large' }));
      return;
    }
  }
  let payload: { sessionId?: string; reason?: string };
  try {
    payload = JSON.parse(body) as { sessionId?: string; reason?: string };
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid json' }));
    return;
  }
  const sessionId = typeof payload.sessionId === 'string' && payload.sessionId.length > 0 ? payload.sessionId : null;
  const reason = typeof payload.reason === 'string' && payload.reason.length > 0 ? payload.reason : 'unknown';

  const result = runBargeInCore({ sessionId, reason });

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, ...result }));
}

// ───────────────────── /anam-web/session-ended ───────────────────────

/**
 * PAT: shared session-ended core. Extracted so the new `/anam-web/ws`
 * handler can fire the same teardown on `{kind:"session-ended"}`
 * frames + on its own onClose without a fresh HTTP roundtrip.
 */
function runSessionEndedCore(sessionIdRaw: string): { closed: number; closedSessionId: string | null } {
  const threadId = threadIdFromSession(sessionIdRaw);

  // Find the matching session across all anam-web mgs (we don't carry
  // platformId here).
  let closed = 0;
  let closedSessionId: string | null = null;
  let platformId: string | null = null;
  const mgs = getMessagingGroupsByChannel(CHANNEL_TYPE);
  for (const mg of mgs) {
    const sess = findSession(mg.id, threadId);
    if (!sess) continue;
    platformId = mg.platform_id;
    updateSession(sess.id, { status: 'closed' });
    closed += 1;
    closedSessionId = sess.id;
    log.event({
      kind: 'session.closed',
      session_id: sess.id,
      thread_id: threadId,
      platform_id: mg.platform_id,
      data: { reason: 'session-ended' },
    });
    break;
  }
  if (platformId) {
    const tk = conversationKey(threadId, platformId);
    streamingControllers.abortAll(tk);
    // PAT: drop the tag-stream scenario cursor so a fresh anam-web
    // session for the same scenario slug starts at slide 1. Without
    // this, accumulated cursors per-threadKey would leak forever
    // (small leak; cleanup is still worth it).
    clearScenarioCursor(tk);
  }
  banter.clear(sessionIdRaw);
  return { closed, closedSessionId };
}

async function handleSessionEnded(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let body = '';
  req.setEncoding('utf8');
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 4 * 1024) {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'payload too large' }));
      return;
    }
  }
  let payload: { sessionId?: string };
  try {
    payload = JSON.parse(body) as { sessionId?: string };
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid json' }));
    return;
  }
  const sessionIdRaw = typeof payload.sessionId === 'string' && payload.sessionId.length > 0 ? payload.sessionId : null;
  if (!sessionIdRaw) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing sessionId' }));
    return;
  }
  const result = runSessionEndedCore(sessionIdRaw);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, ...result }));
}

/**
 * PAT: shared turn-ended core. Extracted so the new `/anam-web/ws`
 * handler can fire on `{kind:"turn-ended"}` frames without a fresh
 * HTTP roundtrip. Drives `tts.turn-ended` log + `ttsBusyTracker.markEnded`
 * — the cadence gate for the narrator. */
function runTurnEndedCore(args: { text: string; threadId: string | null; interrupted: boolean }): void {
  const { text, threadId, interrupted } = args;
  log.event({
    kind: 'tts.turn-ended',
    thread_id: threadId,
    data: {
      source: 'anam-web',
      text_preview: text.slice(0, 200),
      interrupted,
    },
  });
  ttsBusyTracker.markEnded(threadId, text);
}

/** POST /anam-web/turn-ended — pat-web calls this when Anam's
 *  MESSAGE_STREAM_EVENT_RECEIVED fires with `endOfSpeech: true` or
 *  `interrupted: true` for the persona role. That's the closest
 *  equivalent to Cartesia's AgentTurnEnded on PSTN — real "Anam
 *  finished rendering this turn's audio" signal, not just our
 *  last-delta emit. Mirrors the PSTN /agent-turn-ended handler so
 *  narration cadence gates uniformly. */
async function handleTurnEnded(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let body = '';
  req.setEncoding('utf8');
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 16 * 1024) {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'payload too large' }));
      return;
    }
  }
  let payload: { text?: string; thread_id?: string; interrupted?: boolean };
  try {
    payload = JSON.parse(body) as { text?: string; thread_id?: string; interrupted?: boolean };
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid json' }));
    return;
  }
  const text = typeof payload.text === 'string' ? payload.text : '';
  const threadId = typeof payload.thread_id === 'string' && payload.thread_id.length > 0 ? payload.thread_id : null;
  const interrupted = payload.interrupted === true;
  runTurnEndedCore({ text, threadId, interrupted });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

// ───────────────────────── Helpers ───────────────────────────────────

function headerStr(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string') return v[0];
  return undefined;
}

registerChannelAdapter(CHANNEL_NAME, { factory: createAnamWebAdapter });
