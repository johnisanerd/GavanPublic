/**
 * PAT realtime channel — entry point for fast conversational layers.
 *
 * Exposes a small local HTTP surface that voice / avatar / other realtime
 * transports talk to. The transports are language-agnostic (the first one
 * lives in agentic_toolkit/transports/, written in Python with the
 * Cartesia Line SDK), so the contract here is JSON over localhost HTTP.
 *
 * The actual front-mind/back-mind logic lives in agentic_toolkit/realtime/
 * (TypeScript). This file is the channel-adapter shim; it imports the
 * realtime library and wires it into NanoClaw's normal channel flow.
 *
 * Routing model
 * -------------
 * - POST /inbound — voice transport pushes a user utterance. Adapter dispatches
 *   to the realtime library, which classifies (banter vs chat per the
 *   front-mind/back-mind design doc) and writes to NanoClaw's inbound.db with
 *   the right kind via nanoclaw-client. The naming mirrors NanoClaw's two-DB
 *   model: inbound.db is host→container, /inbound is voice-transport→host.
 * - SSE GET /outbound — voice transport keeps a long-lived stream open.
 *   Anything the realtime layer wants spoken (narration, banter reply, final
 *   chat answer) is pushed here. deliver() also pushes through here when the
 *   container produces a chat row. kind='detail' rows are tail-read by the
 *   realtime library on its own loop (delivery.ts short-circuits them so the
 *   adapter never has to deliver them itself).
 *
 * Chat SDK question translation
 * -----------------------------
 * The chat-sdk bridge's ask-question card-rendering logic is reused: when
 * the back-mind invokes ask_user_question, that becomes a question payload
 * the realtime library hands to the front-mind to elicit (e.g. as a spoken
 * yes/no), and the binary answer gets fed back through POST /inbound as a
 * normal user reply.
 *
 * Session resolution
 * ------------------
 * platform_id = the caller's phone number (or explicit platform_id from a
 * non-PSTN transport, e.g. smoketest). One messaging_group per caller,
 * created lazily on first inbound (see ensureRealtimeMessagingGroup).
 * Per-call isolation comes from session_mode='per-thread' on the auto-
 * created mga — each call's thread_id (e.g. `call-c5a3561d5c51`) routes
 * to its own session.
 */
import fs from 'fs';
import http from 'http';
import path from 'path';

import {
  streamBanterAck,
  streamBanterRender,
  requestLayerOnUserMessage,
  state as realtimeState,
  streamBanterToSse,
  ChannelOrchestrator,
  NarrationManager,
  conversationKey,
} from '@agentic-toolkit/realtime';
import type {
  ChannelTransport,
  StreamCancelReason,
  DeliverChatRenderInfo,
  NarrationSession,
} from '@agentic-toolkit/realtime';
import type {
  BanterStreamCallbacks,
  BanterHistoryEntry,
  LlmCallHook,
  BanterUtteranceSource,
} from '@agentic-toolkit/realtime';

// PAT (TaskList #8): per-inbound caller-context resolver. Install-side
// capability surface is seeded at boot via `setInstallCapabilities`
// (see `src/index.ts`); this resolver covers only the per-inbound
// caller block (identity + known handles + permissions).
// See `src/capability-resolver.ts` for surface scope.
import { createCallerContextResolver, resolveAgentGroupForPlatform } from '../capability-resolver.js';
import { DATA_DIR } from '../config.js';
// PAT: killContainer is the cancel-propagation primitive for Path C
// barge-in. When the user interrupts, voice-transport posts /barge-in
// here and we kill the in-flight back-mind container so it stops
// generating against a directive the caller already pivoted away from.
import { killContainer } from '../container-runner.js';
import { findSession, getActiveSessions, getSession, updateSession } from '../db/sessions.js';
import {
  getMessagingGroupByPlatform,
  getMessagingGroupsByChannel,
  provisionMessagingGroup,
  resolveSeedAgentForChannel,
} from '../db/messaging-groups.js';
// PAT: inbound caller authorization gate (see authorizeCaller below). These are
// the SAME helpers the Signal/Telegram permission flow uses — the realtime/phone
// path used to bypass all of them. We reuse them rather than reinventing access
// logic so phone gating stays in lockstep with the other channels.
import { canAccessAgentGroup } from '../modules/permissions/access.js';
import { getUser, upsertUser } from '../modules/permissions/db/users.js';
import { grantRole, isOwner } from '../modules/permissions/db/user-roles.js';
import { matchOwnerPhone } from '../modules/permissions/realtime-owners.js';
import { autoApproveKnownPerson, autoEnroll, resolvePersonIdentity } from '../people/index.js';
import { openOutboundDb } from '../db/session-db.js';
import { log } from '../log.js';
import { outboundDbPath } from '../session-manager.js';
import { sliceHostLogForCall, handleLogEvent } from '../admin/index.js';
import { startAdminServer, stopAdminServer } from '../admin/server.js';
import { registerChannelAdapter } from './channel-registry.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';

// PAT: rendered-chat persistence in the realtime shim. Upstream
// outbound.db only stores raw back-mind text — the banter rendition
// (what TTS actually says) lives only in RAM and the host log line.
// Append every successful rendition here so post-mortem can reconstruct
// what was spoken. JSONL keyed by thread_id (= call_id post per-thread
// flip) and timestamp; tail-friendly. Migration path is to put this in
// outbound.db proper as a sidecar column / kind — backlog.
const RENDERINGS_LOG_PATH = path.join(DATA_DIR, 'realtime-renderings.jsonl');
function persistRendition(entry: {
  threadId: string | null;
  platformId: string;
  rawText: string;
  renderedText: string;
  renderMs: number;
}): void {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    fs.appendFileSync(RENDERINGS_LOG_PATH, line);
  } catch (err) {
    log.warn('persistRendition failed', { err });
  }
}

// PAT: platform_id was hard-coded to 'local' for all realtime traffic, which
// meant ALL phone calls collapsed into one messaging group + (with the
// shared session_mode the bootstrap used) ONE session ever — thread_id stayed
// empty so per-call isolation never worked. Now: each caller gets their
// own messaging_group keyed by their phone number; per-thread session_mode
// is enforced at lazy-creation time so isolation works out of the box.
//
// Fallback when caller_number isn't supplied (smoketest, direct WebRTC,
// pre-flight probes): a synthetic 'unknown' group so we still route, but
// behavior is best-effort. Real phone calls always carry caller_number.
const FALLBACK_PLATFORM_ID = 'unknown';

// PAT: spoken to an UNKNOWN caller when the messaging group is on a gated
// `unknown_sender_policy` (`request_approval` / `strict`). Edit here to change
// the refusal wording. The caller hears this one line and the call engages no
// further (no inbound written, no agent wake, no banter).
const UNKNOWN_CALLER_REFUSAL = "Sorry, I don't recognize this number.";

const DEFAULT_PORT = 8765;
const NARRATION_POLL_INTERVAL_MS = 1000;

/**
 * PAT: derive the realtime platform_id from an inbound payload. Prefers
 * `caller_number` (the caller's E.164), falls back to an explicit
 * `platform_id` (legacy / smoketest), then a process-wide `unknown`.
 *
 * This value is the caller's number used as the messaging_group key under the
 * `phone-call` ROUTING channel (one mg per caller). It is intentionally NOT the
 * person identity, and we deliberately do NOT prefix it with `pstn:` here: the
 * caller's PERSON id is `pstn:<number>`, set separately as the message senderId,
 * so role grants (owner/admin) bind to the person — and follow them across
 * routing channels — rather than to the routing mg.
 */
function derivePlatformIdFromInbound(payload: { caller_number?: unknown; platform_id?: unknown }): string {
  if (typeof payload.caller_number === 'string' && payload.caller_number.length > 0) {
    return payload.caller_number;
  }
  if (typeof payload.platform_id === 'string' && payload.platform_id.length > 0) {
    return payload.platform_id;
  }
  return FALLBACK_PLATFORM_ID;
}

/**
 * Ensure a realtime messaging_group exists for `platformId`. Creates it
 * lazily on first contact and wires it to whichever agent group(s) the
 * existing realtime mgas already point at — so a new caller inherits
 * the same agent and policy as existing callers, just with their own
 * isolated mg + per-thread session lineage.
 *
 * Idempotent: returns the existing mg if found.
 *
 * Returns null if no realtime agent is wired anywhere yet — caller is
 * expected to log + reject the inbound.
 */
function ensureRealtimeMessagingGroup(platformId: string): { id: string; platform_id: string } | null {
  const existing = getMessagingGroupByPlatform('phone-call', platformId);
  if (existing) return existing;
  const seed = resolveSeedAgentForChannel('phone-call');
  if (!seed) {
    log.warn('ensureRealtimeMessagingGroup: no seed mg + wired agent to copy wiring from', { platformId });
    return null;
  }
  const result = provisionMessagingGroup({
    channelType: 'phone-call',
    platformId,
    mgName: `phone-call:${platformId}`,
    unknownSenderPolicy: seed.seedMg.unknown_sender_policy ?? 'allow',
    mga: {
      agent_group_id: seed.seedMga.agent_group_id,
      engage_mode: seed.seedMga.engage_mode,
      engage_pattern: seed.seedMga.engage_pattern,
      sender_scope: seed.seedMga.sender_scope,
      ignored_message_policy: seed.seedMga.ignored_message_policy,
      // PAT: per-thread is the only mode that gives proper per-call
      // isolation. Hard-coded so a new caller never inherits a 'shared'
      // default the way the legacy bootstrap did.
      session_mode: 'per-thread',
      priority: seed.seedMga.priority,
    },
  });
  log.event({
    kind: 'session.created',
    platform_id: platformId,
    data: {
      agent_group_id: result.agent_group_id,
      messaging_group_id: result.id,
      session_mode: 'per-thread',
    },
  });
  return { id: result.id, platform_id: result.platform_id };
}

// PAT: inbound caller authorization gate for the realtime/phone channel.
//
// PROBLEM this solves: the phone-call channel used to answer EVERY caller
// unconditionally — it never consulted the messaging group's
// `unknown_sender_policy` nor any access role, so Signal/Telegram gating (the
// permissions module) was completely bypassed on voice. Deleting a person did
// NOT stop them calling.
//
// BEHAVIOR (mirrors the Signal path's access gate in
// `src/modules/permissions/index.ts`):
//   - policy 'public' / 'allow'  → NO gate. Returns authorized=true without any
//     DB writes. (2026-07-04: BOTH prod and staging now run 'request_approval'
//     on every phone-call mg — the gate is armed everywhere; known people are
//     admitted via people-spine auto-enroll on first call.)
//   - policy 'request_approval' / 'strict' → enforce. Upsert the caller's users
//     row (helpers need it), run owner-phone elevation + people auto-enroll
//     (same as `extractAndUpsertUser`), then check access. Authorized =
//     owner OR admin OR member OR resolves-to-known-person (after auto-approve).
//
// FAIL-CLOSED: this is an access gate, so any unexpected throw inside it is
// treated as NOT authorized (refuse). If a gate bug or transient error means we
// can't positively verify the caller, they don't get in. The tradeoff is the
// reverse of fail-open: a gate bug that throws on every call refuses everyone
// (including the owner) — but that's a LOUD, immediately-obvious outage we'd
// catch and fix at once, whereas fail-open would silently admit unknown callers
// (exactly the gap this gate exists to close). Note the catch only fires for
// GATED policies — public/allow returns authorized above without entering it,
// so non-gated lines can never be refused by a gate exception.
function authorizeCaller(senderId: string, callerNumber: string | null, policy: string, agentGroupId: string): boolean {
  // Only gated policies enforce. public/allow (and any unexpected value) are
  // pass-through — never change behavior for the non-gated default.
  if (policy !== 'request_approval' && policy !== 'strict') return true;

  try {
    // 1) Ensure a users row exists — every helper below (canAccessAgentGroup,
    //    autoEnroll, autoApproveKnownPerson) keys off it. Mirrors the minimum
    //    `extractAndUpsertUser` does on the Signal inbound path. The senderId is
    //    already namespaced (`pstn:<E164>` or `realtime:<platform>`).
    if (!getUser(senderId)) {
      upsertUser({
        id: senderId,
        kind: callerNumber ? 'phone' : 'phone-call',
        display_name: null,
        created_at: new Date().toISOString(),
      });
    }

    // 2) Realtime owner-phone auto-elevation — identical to the hook in
    //    `extractAndUpsertUser`. A number on PAT_OWNER_PHONES becomes a global
    //    owner on first sight so the operator's own phone is always authorized.
    const matchedPhone = matchOwnerPhone(senderId);
    if (matchedPhone && !isOwner(senderId)) {
      grantRole({
        user_id: senderId,
        role: 'owner',
        agent_group_id: null,
        granted_by: null,
        granted_at: new Date().toISOString(),
      });
      log.event({
        kind: 'permissions.realtime-owner-resolved',
        data: {
          matched_phone: matchedPhone,
          user_id: senderId,
          role: 'owner',
          decision: 'granted',
          reason: 'env_PAT_OWNER_PHONES',
        },
      });
    }

    // 3) People-spine auto-enroll — link this handle to a seeded person if its
    //    phone/email matches a `person_identifiers` row. Links, never creates.
    autoEnroll(senderId);

    // 4) Access decision (owner / global-admin / scoped-admin / member).
    const decision = canAccessAgentGroup(senderId, agentGroupId);
    if (decision.allowed) return true;

    // 5) Cross-channel auto-approve: a caller who resolves to a KNOWN PERSON
    //    (operator-vouched) gets agent-group-scoped membership and passes — the
    //    same fallthrough the Signal access gate uses. Only fires when the
    //    handle is linked to a person; otherwise the caller is unauthorized.
    if (autoApproveKnownPerson(senderId, agentGroupId)) return true;

    return false;
    // Catch-all: a gate failure must not crash the call handler, but for an
    // access gate we FAIL CLOSED — refuse rather than silently admit. Only
    // reached for gated policies (public/allow returned above). See header.
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (err) {
    log.warn('authorizeCaller threw — failing closed (refused)', {
      senderId,
      policy,
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// Channel orchestrator — owns all per-thread state carriers
// (TtsBusyTracker, StreamingControllers, ConversationHistory,
// BanterBroadcast), the back-mind processing flag, the buffered-banter
// ring, the chat-row dedup queue (deliverChat / clearIntent), and the
// full inbound loop (handleUserMessage). Aliases below give shorter
// names to the pieces this adapter touches outside the inbound loop.
// The banter broadcast is unused on PSTN (no SSE-to-browser surface);
// instantiated for symmetry with anam-web.
const orchestrator = new ChannelOrchestrator({
  host: { log },
  // PAT (TaskList #8): per-inbound caller-context resolver. Install-
  // side capability surface is seeded at boot via
  // `setInstallCapabilities` and lives in SYSTEM; this resolver only
  // covers the per-inbound caller block (identity, known handles,
  // permissions). Pure DB reads; no model calls.
  callerContextResolver: createCallerContextResolver({ channelType: 'phone-call' }),
});
const ttsBusyTracker = orchestrator.tts;
const streamingControllers = orchestrator.streams;
const conversationHistory = orchestrator.history;
/**
 * PAT: module-level broadcaster for LLM call traces (system prompt + user
 * message + response + timing). Smoke harness captures these so the test
 * viewer can show "what context did the LLM have" per call. Set in
 * createAdapter() once SSE clients exist; called by handleInbound and
 * deliver() through the realtime library's `onCall` hook on each model call /
 * Sonnet call. Behind NANOCLAW_TRACE_LLM_CALLS to avoid bandwidth churn
 * on normal phone calls.
 */
let broadcastTrace: (trace: import('@agentic-toolkit/realtime').LlmCallTrace) => void = () => {};

interface SseClient {
  res: http.ServerResponse;
}

function realtimePort(): number {
  const raw = process.env.REALTIME_PORT;
  if (!raw) return DEFAULT_PORT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PORT;
}

export function createPhoneCallAdapter(): ChannelAdapter {
  return createAdapter();
}

// PAT: SSE broadcast primitive — write `data: {kind, content}\n\n` to
// every connected client, log on drop / write failure. Module-level so
// both createAdapter() (which closes over its own sseClients) and the
// top-level handleInbound (which receives sseClients as a parameter)
// can share one implementation. Callers typically wrap with a closure
// that binds the destination set.
function broadcastSseEventTo(sseClients: Set<SseClient>, kind: string, content: unknown): void {
  const payload = JSON.stringify({ kind, content });
  if (sseClients.size === 0) {
    log.warn('SSE drop: no clients for broadcast', { kind });
  }
  for (const c of sseClients) {
    try {
      c.res.write(`data: ${payload}\n\n`);
    } catch (err) {
      log.warn('Realtime SSE write failed', { kind, err });
    }
  }
}

function phoneCallTransport(
  sseClients: Set<SseClient>,
  threadId: string | null,
  source: BanterUtteranceSource,
): ChannelTransport {
  return {
    onDelta: (text_delta: string, seq: number) => {
      broadcastSseEventTo(sseClients, 'utterance-delta', {
        thread_id: threadId,
        source,
        text_delta,
        seq,
      });
    },
    onEnd: (fullText: string, _deltaCount: number, _streamMs: number, _firstDeltaMs: number) => {
      broadcastSseEventTo(sseClients, 'utterance-end', {
        thread_id: threadId,
        source,
        full_text: fullText,
      });
    },
    onCancelled: (reason: StreamCancelReason, _partialText: string, _deltaCount: number) => {
      broadcastSseEventTo(sseClients, 'utterance-cancel', {
        thread_id: threadId,
        source,
        reason,
      });
    },
  };
}

function createAdapter(): ChannelAdapter {
  let server: http.Server | null = null;
  const sseClients = new Set<SseClient>();

  // Wire the module-level broadcastTrace once we have sseClients in scope.
  // Default ON; set NANOCLAW_TRACE_LLM_CALLS=0 to suppress (e.g. if SSE
  // bandwidth becomes a concern in production). Off-spec consumers like
  // voice-transport ignore unknown kinds, so always-on is safe.
  broadcastTrace = (trace) => {
    // PAT: surface any layer failure on the host log so silent fallbacks
    // ("hmm, my front-mind isn't quite there...") have a paper trail.
    // Otherwise the failure reason lives only in SSE trace events, which
    // we may not be capturing post-hoc. Catches banter / request-layer /
    // narration / rendition uniformly — every layer goes through onCall.
    if (!trace.ok) {
      log.warn('LLM layer failure', {
        layer: trace.layer,
        model: trace.model,
        latencyMs: trace.latencyMs,
        error: trace.error,
      });
    }
    if (process.env.NANOCLAW_TRACE_LLM_CALLS === '0') return;
    const payload = JSON.stringify({ kind: 'trace', content: trace });
    if (sseClients.size === 0) {
      log.warn('SSE drop: no clients for trace broadcast', { layer: trace.layer });
    }
    for (const c of sseClients) {
      try {
        c.res.write(`data: ${payload}\n\n`);
      } catch (err) {
        log.warn('Realtime SSE write failed (trace)', { err });
      }
    }
  };

  // Pure SSE broadcast; the NarrationManager's onUtterance closure
  // (in the realtime library) stamps `orchestrator.tts.markStarted`
  // with the correct thread key before invoking this — DO NOT mix
  // markStarted in here.
  const broadcastNarration = (text: string, threadId: string | null): void => {
    const payload = JSON.stringify({
      kind: 'realtime-utterance',
      // PAT: stamp thread_id so the transport's cross-call filter routes this
      // narration line only to the caller it belongs to.
      content: { text, sender: 'realtime-agent', thread_id: threadId },
    });
    if (sseClients.size === 0) {
      log.warn('SSE drop: no clients for narration broadcast', { textPreview: text.slice(0, 60) });
    }
    for (const c of sseClients) {
      try {
        c.res.write(`data: ${payload}\n\n`);
      } catch (err) {
        log.warn('Realtime SSE write failed (narration)', { err });
      }
    }
  };

  const narrationManager = new NarrationManager(orchestrator, {
    channelType: 'phone-call',
    listSessions: () => {
      const mgs = getMessagingGroupsByChannel('phone-call');
      if (mgs.length === 0) return [];
      const mgById = new Map(mgs.map((mg) => [mg.id, mg]));
      const phoneCallMgIds = new Set(mgs.map((mg) => mg.id));
      return getActiveSessions()
        .filter((s) => s.messaging_group_id !== null && phoneCallMgIds.has(s.messaging_group_id))
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
    makeTransport: (threadId: string | null) => phoneCallTransport(sseClients, threadId, 'banter-narration'),
    broadcast: broadcastNarration,
    markSessionClosed: (s: NarrationSession) => updateSession(s.sessionId, { status: 'closed' }),
  });

  const adapter: ChannelAdapter = {
    name: 'phone-call',
    channelType: 'phone-call',
    // PAT: realtime channel — emits its own inbound.received via the
    // orchestrator; router skips its chat-forward to avoid double-emit.
    isRealtime: true,
    // PAT: declare thread support so the router doesn't strip thread_id
    // from /inbound payloads (router.ts collapses threads-to-channel for
    // non-thread-capable adapters). This is what lets the smoketest
    // wiring's session_mode='per-thread' actually take effect — without
    // it, router.ts forces threadId=null and we always reuse one session.
    // For phone callers (no thread_id sent), the wiring's session_mode is
    // still 'shared' so they collapse to one session as before.
    supportsThreads: true,

    async setup(config: ChannelSetup): Promise<void> {
      const port = realtimePort();
      // PAT: bind host is overridable via REALTIME_BIND_HOST so cloud
      // deploys (Fly) can expose to the private 6PN/.flycast network
      // by setting it to '0.0.0.0'. Default stays 127.0.0.1 so a
      // local dev box doesn't accidentally listen on every interface.
      const host = process.env.REALTIME_BIND_HOST || '127.0.0.1';
      server = http.createServer((req, res) => handleRequest(req, res, config, sseClients));
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(port, host, () => {
          log.info('Realtime channel listening', { port, host });
          resolve();
        });
      });
      narrationManager.start();
      // PAT: admin server lives on its own port (8767 by default).
      // Started here for now; a future nanoclaw-upstream lift would
      // move this to host main. R10 in
      // plans/refactor-bundle-2026-05-14.md.
      await startAdminServer();
    },

    async teardown(): Promise<void> {
      narrationManager.stop();
      await stopAdminServer();
      for (const c of sseClients) {
        try {
          c.res.end();
        } catch {
          // best-effort
        }
      }
      sseClients.clear();
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
     * Outbound delivery to the realtime transport.
     *
     * Streams to every connected SSE client. The transport (voice-line,
     * avatar provider, etc.) decides how to render — speak via TTS, mouth-
     * shape, etc.
     *
     * PAT: kind='chat' rows from the back-mind are re-rendered through the
     * banter layer before broadcast. The architecture is "banter is
     * the only voice" — so the user hears Pat's voice on acks (banter on
     * user turns) AND results (banter rendition of back-mind output). The
     * raw back-mind text remains in outbound.db as the audit/diagnostic
     * record; the SSE clients (and therefore TTS / judge) get the rendition.
     *
     * If banter rendering fails (model error, no API key), fall back to the
     * raw back-mind text — better to deliver the answer in a clunkier voice
     * than to drop it entirely.
     */
    async deliver(platformId, threadId, message: OutboundMessage): Promise<string | undefined> {
      if (sseClients.size === 0) {
        log.warn('SSE drop: no clients for deliver', { kind: message.kind });
        return undefined;
      }
      const platformIdForMessage = platformId ?? FALLBACK_PLATFORM_ID;
      const threadIdForMessage = threadId ?? null;
      // PAT: non-chat kinds (e.g. detail) bypass the accumulator entirely —
      // they're forensic / detail rows, not speakable, and the realtime
      // library short-circuits them via delivery.ts anyway. We still
      // broadcast on SSE in case a consumer (test viewer) wants to see them.
      if (message.kind !== 'chat') {
        const payload = JSON.stringify({ kind: message.kind, content: message.content });
        for (const c of sseClients) {
          try {
            c.res.write(`data: ${payload}\n\n`);
          } catch (err) {
            log.warn('Realtime SSE write failed', { err });
          }
        }
        return undefined;
      }
      // chat path — orchestrator owns the queue + rendition + history
      // stamp + TTS busy marking + log emits. The post-rendition
      // `persistRendition` hook is phone-call-only (on-disk audit JSONL).
      const rawText =
        typeof (message.content as { text?: unknown }).text === 'string'
          ? (message.content as { text: string }).text
          : '';
      if (!rawText) {
        log.warn('chat row with no text; dropping', { kind: message.kind });
        return undefined;
      }
      // PAT (TaskList #8): resolve agentGroupId for the install-side
      // capability block lookup inside banter-render's render().
      const agentGroupForMessage = resolveAgentGroupForPlatform('phone-call', platformIdForMessage);
      const agentGroupIdForMessage = agentGroupForMessage?.agentGroupId ?? '';
      await orchestrator.deliverChat({
        threadId: threadIdForMessage,
        threadKey: conversationKey(threadIdForMessage, platformIdForMessage),
        platformId: platformIdForMessage,
        agentGroupId: agentGroupIdForMessage,
        rawText,
        renditionTransport: phoneCallTransport(sseClients, threadIdForMessage, 'banter-rendition'),
        onLlmCall: broadcastTrace,
        onRendered: ({ spoken, contexts, renderMs }: DeliverChatRenderInfo) => {
          persistRendition({
            threadId: threadIdForMessage,
            platformId: platformIdForMessage,
            rawText: contexts.length === 1 ? contexts[0]! : contexts.join('\n\n---\n\n'),
            renderedText: spoken,
            renderMs,
          });
        },
      });
      return undefined;
    },
  };

  return adapter;
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: ChannelSetup,
  sseClients: Set<SseClient>,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, channel: 'phone-call' }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/outbound') {
    handleSse(req, res, sseClients);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/inbound') {
    await handleInbound(req, res, config, sseClients);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/agent-turn-ended') {
    await handleAgentTurnEnded(req, res);
    return;
  }

  // PAT: Path C barge-in path. voice-transport posts here whenever
  // Cartesia's cancel_filter aborts the SDK's process() task. We kill
  // the in-flight back-mind container and clear the per-thread intent
  // accumulator so any chat row that's already through the inbound.db
  // pipeline doesn't speak about the cancelled directive.
  if (req.method === 'POST' && url.pathname === '/barge-in') {
    await handleBargeIn(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/call-ended') {
    await handleCallEnded(req, res, config);
    return;
  }

  // PAT: voice-transport posts structured events to /admin/log-event
  // via its REALTIME_BASE_URL (8765) — the voice transport doesn't know
  // about the dedicated admin port (8767). Keep this one dispatch
  // here so peer ingress isn't broken by R10's port split. All other
  // /admin/* routes live exclusively on the admin server.
  if (req.method === 'POST' && url.pathname === '/admin/log-event') {
    await handleLogEvent(req, res);
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
}

/**
 * PAT: voice-transport posts here when Cartesia signals the call has
 * ended (caller hung up). With session_mode='per-thread', every call
 * creates a new session row; without an explicit close on hangup they
 * pile up `status='active'` forever and narration polls every one each
 * tick. Mark the matching session closed so the polling loop drops it.
 *
 * Container stop is intentionally NOT done here — heartbeat-based
 * idle exit handles that. We just want narration to stop polling.
 */
async function handleCallEnded(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: ChannelSetup,
): Promise<void> {
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
  let payload: { thread_id?: string; platform_id?: string };
  try {
    payload = JSON.parse(body) as { thread_id?: string; platform_id?: string };
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid json' }));
    return;
  }
  const threadId = typeof payload.thread_id === 'string' && payload.thread_id ? payload.thread_id : null;
  const platformId = derivePlatformIdFromInbound(payload);
  if (!threadId) {
    log.warn('call-ended without thread_id; nothing to close');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, closed: 0 }));
    return;
  }
  // Channel type is fixed for this adapter (registered as 'phone-call'
  // at bottom of file). ChannelSetup doesn't carry channelType, so we
  // use the literal directly.
  const mg = getMessagingGroupByPlatform('phone-call', platformId);
  if (!mg) {
    log.warn('call-ended: no messaging group', { platformId });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, closed: 0 }));
    return;
  }
  const sess = findSession(mg.id, threadId);
  if (!sess) {
    log.info('call-ended: no active session for thread', { threadId, platformId });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, closed: 0 }));
    return;
  }
  updateSession(sess.id, { status: 'closed' });
  // PAT: clear the per-thread Path C accumulator. Belt-and-suspenders —
  // a stale entry wouldn't matter for the next call (different thread)
  // but keeps the map bounded across long-lived host processes.
  orchestrator.clearIntent(conversationKey(threadId, platformId), { threadId, platformId });
  // PAT: Path A — abort any still-running streaming model calls on
  // this thread. Stream-end usually clears these on its own; this
  // catches the rare case where a stream is mid-flight when the
  // caller hangs up.
  streamingControllers.abortAll(conversationKey(threadId, platformId));
  log.event({
    kind: 'session.closed',
    session_id: sess.id,
    thread_id: threadId,
    platform_id: platformId,
    data: { reason: 'call-ended' },
  });
  // PAT: snapshot every host log line that mentions this call's thread
  // into the session folder. Survives forever next to the inbound.db /
  // outbound.db. fly-call-log.py / verify-timeline-vs-wav / future
  // viewers can render from this without depending on Fly's rolling
  // log buffer or the full host-YYYY-MM-DD.jsonl.
  // Done synchronously after the session close; a few-MB grep takes
  // <100ms on the volume so blocking the HTTP response is fine.
  try {
    sliceHostLogForCall(sess.agent_group_id, sess.id, threadId);
  } catch (err) {
    // Snapshot is best-effort — never block the call-end ack on it.
    log.warn('call-ended: host-log slice failed', { sessionId: sess.id, err });
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, closed: 1, sessionId: sess.id }));
}

/**
 * PAT: voice-transport posts here when Cartesia signals the agent has
 * finished speaking a turn. Narrator uses this to gate follow-up
 * narrations off real end-of-speech instead of the
 * `len(text) / TTS_CHARS_PER_SEC` heuristic.
 */
/**
 * PAT: Path C cancel-propagation. voice-transport POSTs here whenever
 * the Cartesia Line SDK cancels its in-flight process() task (today
 * the only trigger is UserTurnStarted matching the cancel_filter —
 * i.e. the user barged in).
 *
 * What we do:
 *   1. Emit `bargein.received` with the cartesia-supplied reason.
 *   2. Find the active per-thread session and kill its container.
 *      The container holds the back-mind query (Opus); without the
 *      kill, the model keeps generating against a directive the user
 *      already abandoned, eating tokens and producing a chat row
 *      that lands on the SSE stream seconds later.
 *   3. Clear the per-thread intent accumulator. Anything that ALREADY
 *      slipped through `deliver()` (rendition in flight, or pending
 *      contexts waiting to render) is forfeited — the user has moved
 *      on, hearing those answers now would be wrong.
 *   4. Flip the host-side `processingByThread` gate off so the
 *      narration brain stops filling silence for the cancelled run.
 *
 * The kill primitive (`killContainer`) is heavy but available today;
 * the back-mind container respawns lazily on the next inbound. A
 * future light-weight cancel (sdk continuation-id abort) is in the
 * backlog — see plans/voice-transport-cartesia-rethink.md.
 */
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
  let payload: { thread_id?: string; reason?: string; platform_id?: string };
  try {
    payload = JSON.parse(body) as { thread_id?: string; reason?: string; platform_id?: string };
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid json' }));
    return;
  }
  const threadId = typeof payload.thread_id === 'string' && payload.thread_id.length > 0 ? payload.thread_id : null;
  const reason = typeof payload.reason === 'string' && payload.reason.length > 0 ? payload.reason : 'unknown';
  const platformId = derivePlatformIdFromInbound(payload);

  log.event({
    kind: 'bargein.received',
    thread_id: threadId,
    platform_id: platformId,
    data: { reason },
  });

  // Find the live session for this call and kill its container.
  // Wrap the DB lookup in try/catch so a transient DB hiccup (or a
  // test environment without initDb()) doesn't 500 a barge-in — the
  // user is barging in NOW; we'd rather drop the kill than block.
  let killedSessionId: string | null = null;
  let killedContainer = false;
  if (threadId) {
    try {
      const mg = getMessagingGroupByPlatform('phone-call', platformId);
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
            log.warn('bargein: killContainer threw', { sessionId: sess.id, err });
          }
        }
      }
    } catch (err) {
      log.warn('bargein: session lookup failed', { threadId, platformId, err });
    }
  }

  // Drop any in-flight rendition + queued contexts for this thread.
  const dropped = orchestrator.clearIntent(conversationKey(threadId, platformId), { threadId, platformId });

  // PAT: Path A — abort any in-flight streaming model calls (banter
  // ack / rendition / narration). The streamBanterToSse helper observes
  // the AbortSignal, stops emitting deltas, and fires onCancelled
  // which broadcasts the SSE utterance-cancel for voice-transport to
  // close its TTS context. Without this the streams keep generating
  // until they complete naturally — wasted tokens + audio bleed past
  // the user's barge-in.
  const abortedStreams = streamingControllers.abortAll(conversationKey(threadId, platformId));

  // The cancelled work isn't going to produce a query-end any more —
  // flip processing off explicitly so the narrator stops generating
  // filler. Mirrors the existing query-end handler in the poll loop.
  orchestrator.setProcessing({
    threadKey: conversationKey(threadId, platformId),
    threadId,
    platformId,
    value: false,
  });

  log.event({
    kind: 'bargein.propagated',
    thread_id: threadId,
    platform_id: platformId,
    data: {
      killed_container: killedContainer,
      killed_session_id: killedSessionId ?? undefined,
      dropped_pending_contexts: dropped,
    },
  });
  if (abortedStreams > 0) {
    log.info('bargein: aborted streaming model calls', {
      threadId,
      platformId,
      aborted_count: abortedStreams,
    });
  }

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      ok: true,
      killed_container: killedContainer,
      killed_session_id: killedSessionId,
      dropped_pending_contexts: dropped,
      aborted_streams: abortedStreams,
    }),
  );
}

async function handleAgentTurnEnded(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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
  let payload: { text?: string; thread_id?: string };
  try {
    payload = JSON.parse(body) as { text?: string; thread_id?: string };
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid json' }));
    return;
  }
  const text = typeof payload.text === 'string' ? payload.text : '';
  const threadId = typeof payload.thread_id === 'string' && payload.thread_id.length > 0 ? payload.thread_id : null;
  log.event({
    kind: 'tts.turn-ended',
    thread_id: threadId,
    data: {
      text_preview: text.slice(0, 200),
      est_dur_ms: Math.round((text.length / 11) * 1000 + 1000),
    },
  });
  ttsBusyTracker.markEnded(threadId, text);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

function handleSse(req: http.IncomingMessage, res: http.ServerResponse, sseClients: Set<SseClient>): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(`event: open\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  const client: SseClient = { res };
  sseClients.add(client);
  const remote = req.socket.remoteAddress ?? 'unknown';
  log.event({
    kind: 'sse.client-changed',
    data: {
      action: 'connected',
      total_clients: sseClients.size,
      remote,
    },
  });
  const cleanup = (reason: string) => {
    if (sseClients.delete(client)) {
      log.event({
        kind: 'sse.client-changed',
        level: 'warn',
        data: {
          action: 'disconnected',
          total_clients: sseClients.size,
          remote,
          reason,
        },
      });
    }
  };
  req.on('close', () => cleanup('close'));
  req.on('error', (err) => cleanup(`error: ${(err as Error).message}`));
}

interface InboundPayload {
  text?: string;
  sender?: string;
  /**
   * Hint from the transport about whether this turn should wake the agent.
   * If omitted the realtime library decides (banter vs chat classification).
   * For the spike the field is honored verbatim: `chat` => trigger=1,
   * `banter` => trigger=0. Replace with library classification once that
   * lands.
   */
  classification?: 'chat' | 'banter';
  /**
   * PAT: Routes this turn to a specific session keyed by (mg, ag, thread_id).
   * Honored only when the wired messaging_group_agent has
   * session_mode='per-thread'. Used by the smoketest harness to give each
   * scenario its own container so memory doesn't leak across runs.
   */
  thread_id?: string;
  /**
   * PAT: Routes to a non-default messaging group on this channel. Default
   * is `'local'` (the phone wiring). The smoketest harness sends
   * `'smoketest'` so its traffic goes to the dedicated test wiring (which
   * has session_mode='per-thread') without affecting phone behaviour.
   */
  platform_id?: string;
  /**
   * PAT: Caller's E.164 phone number, set by voice-transport from
   * `CallRequest.from_` when a Cartesia PSTN call lands. When present we
   * key the inbound under `pstn:<number>` so role grants (admin, owner)
   * can target a specific phone instead of the synthetic `realtime:local`
   * shared by all callers. Absent for non-PSTN paths (smoketest harness,
   * direct WebRTC, etc.) — those still get `realtime:<platform_id>`.
   */
  caller_number?: string;
}

async function handleInbound(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: ChannelSetup,
  sseClients: Set<SseClient>,
): Promise<void> {
  let body = '';
  req.setEncoding('utf8');
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64 * 1024) {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'payload too large' }));
      return;
    }
  }

  let payload: InboundPayload;
  try {
    payload = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid json' }));
    return;
  }

  if (typeof payload.text !== 'string' || payload.text.length === 0) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing text' }));
    return;
  }

  const threadId = typeof payload.thread_id === 'string' && payload.thread_id.length > 0 ? payload.thread_id : null;
  const platformId = derivePlatformIdFromInbound(payload);
  // PAT: lazily provision an mg for first-time callers. Without this
  // every caller would land on the same 'local' mg → same shared
  // session → no isolation. ensureRealtimeMessagingGroup is idempotent.
  const ensured = ensureRealtimeMessagingGroup(platformId);
  if (!ensured) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'no realtime agent wired' }));
    return;
  }
  // PAT: caller-number → pstn:<number> user id ONLY when it is a real
  // E.164 (leading '+', 7-15 digits). Cartesia's WS/playground calls put
  // "websocket" in `from`, which used to mint the junk identity
  // `pstn:websocket` — unmatchable to any owner or person (people-spine
  // parseHandle requires '+'), so gated lines refused even known callers
  // (2026-07-03/-04, KNOWN_ISSUES). Non-E.164 callers fall back to the
  // synthetic `realtime:<platform_id>`. Lets role grants target one phone.
  const callerNumber =
    typeof payload.caller_number === 'string' && payload.caller_number.length > 0 ? payload.caller_number : null;
  const callerE164 = callerNumber && /^\+[1-9]\d{6,14}$/.test(callerNumber) ? callerNumber : null;
  const senderId = callerE164 ? `pstn:${callerE164}` : `realtime:${platformId}`;
  const senderLabel = payload.sender ?? 'realtime-user';

  // PSTN-specific synthetic broadcast helper, used when we need to
  // speak a host-side error message that didn't come from a streamed
  // banter call (e.g. routing failure). Marks TTS busy with the
  // length-projected duration so the narrator gates correctly.
  const broadcastUtterance = (text: string): void => {
    const ssePayload = JSON.stringify({
      kind: 'realtime-utterance',
      // PAT: stamp thread_id so the transport's cross-call filter delivers this
      // host-side spoken line only to THIS caller, not every concurrent call.
      content: { text, sender: 'realtime-agent', thread_id: threadId },
    });
    const estDurMs = (text.length / 11) * 1000 + 400;
    ttsBusyTracker.markStarted(threadId, estDurMs);
    log.event({
      kind: 'tts.busy-marked',
      thread_id: threadId,
      data: { est_dur_ms: estDurMs, text_preview: text.slice(0, 200) },
    });
    for (const c of sseClients) {
      try {
        c.res.write(`data: ${ssePayload}\n\n`);
      } catch (err) {
        log.warn('Realtime SSE write failed', { err });
      }
    }
  };

  const userText = payload.text;
  const threadKey = conversationKey(threadId, platformId);
  // PAT (TaskList #8): resolve agentGroupId for the install-side
  // capability block lookup inside each front-mind prompt's render().
  const agentGroupForInbound = resolveAgentGroupForPlatform('phone-call', platformId);
  const agentGroupIdForInbound = agentGroupForInbound?.agentGroupId ?? '';

  // PAT: inbound caller authorization gate. The realtime/phone channel used to
  // answer everyone unconditionally — this is the toggle that lets the operator
  // gate it by flipping the messaging group's `unknown_sender_policy`.
  //
  // ensureRealtimeMessagingGroup() returns {id, platform_id} but NOT the policy,
  // so re-fetch the mg row here. On 'public'/'allow' the gate is a no-op
  // (2026-07-04: both prod and staging run 'request_approval' everywhere).
  // On 'request_approval'/'strict' an unauthorized caller hears a spoken
  // refusal and we return early WITHOUT writing the inbound, waking the agent,
  // or running banter. FAIL-CLOSED: the mg was just ensured above (we 503 if it
  // can't be provisioned), so a lookup miss here is anomalous — treat an
  // unreadable policy as GATED ('request_approval') rather than permissive, so a
  // known caller still passes (owner/member/known-person) but an unknown is
  // refused rather than silently admitted.
  const gatingMg = getMessagingGroupByPlatform('phone-call', platformId);
  const senderPolicy = gatingMg?.unknown_sender_policy ?? 'request_approval';
  if (!authorizeCaller(senderId, callerE164, senderPolicy, agentGroupIdForInbound)) {
    log.event({
      kind: 'permissions.caller-refused',
      level: 'warn',
      thread_id: threadId,
      platform_id: platformId,
      data: { sender_id: senderId, policy: senderPolicy, platform_id: platformId },
    });
    broadcastUtterance(UNKNOWN_CALLER_REFUSAL);
    // 200 so the transport doesn't retry; the call simply engages no further.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ accepted: false, refused: true, reason: 'unauthorized_caller' }));
    return;
  }
  // PAT: resolve the caller's opaque person_id (people-spine) for the
  // inbound.received log enrichment. The realtime library can't import the
  // people-spine, so we resolve here and pass it into the orchestrator.
  // Defensive: never throws, returns null when unlinked / on error. No name —
  // names live in pat_enrichment, never beside message bodies.
  const { personId } = resolvePersonIdentity(senderId);
  const result = await orchestrator.handleUserMessage({
    threadId,
    threadKey,
    platformId,
    agentGroupId: agentGroupIdForInbound,
    sessionId: null, // phone-call doesn't use banter SSE broadcast
    userText,
    senderId,
    channelType: 'phone-call', // PAT: stamped onto inbound.received
    personId, // PAT: opaque id only — name lives in pat_enrichment
    onLlmCall: broadcastTrace,
    transport: phoneCallTransport(sseClients, threadId, 'banter-ack'),
    forwardToBackMind: async ({ invokeText }: { invokeText: string }) => {
      await config.onInbound(platformId, threadId, {
        id: `realtime-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        content: {
          text: invokeText,
          sender: senderLabel,
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
        id: `realtime-banter-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'banter',
        timestamp: new Date().toISOString(),
        content: { text, sender: from },
      });
    },
  });

  if (result.forwardError) {
    // PSTN-specific: speak an audible error so the caller doesn't dial
    // into silence after a routing failure. The orchestrator already
    // logged `error.surfaced` with the verbatim error; we add the
    // engineering-log `kind:'error'` row + spoken broadcast.
    log.error('Realtime: onInbound threw', { err: result.forwardError });
    const errorMsg =
      "Hmm, I couldn't route your message internally. Something's broken on the host side — check the logs.";
    log.event({
      kind: 'error',
      level: 'error',
      thread_id: threadId,
      data: {
        msg: 'inbound dispatch failed; speaking error fallback',
        err: result.forwardError.message,
        spoken_text: errorMsg,
      },
    });
    broadcastUtterance(errorMsg);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'inbound dispatch failed' }));
    return;
  }

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      accepted: true,
      decision: result.decision.decision,
      spoke: result.banterText !== null,
    }),
  );
}

// PAT: channel_type is 'phone-call' as of R11 / migration 014. Older
// installs had channel_type='realtime' (matching the legacy file name);
// migration 014 rewrites all such rows to 'phone-call' on first boot.
// See plans/refactor-bundle-2026-05-14.md.
registerChannelAdapter('phone-call', { factory: createAdapter });
