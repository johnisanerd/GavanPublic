/**
 * Outbound message delivery.
 * Polls session outbound DBs for undelivered messages, delivers through channel adapters.
 *
 * Two-DB architecture:
 *   - Reads messages_out from outbound.db (container-owned, opened read-only)
 *   - Tracks delivery in inbound.db's `delivered` table (host-owned)
 *   - Never writes to outbound.db — preserves single-writer-per-file invariant
 */
import type Database from 'better-sqlite3';

import { getRunningSessions, getActiveSessions, createPendingQuestion } from './db/sessions.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getDb, hasTable } from './db/connection.js';
import { createMessagingGroup, getMessagingGroup, getMessagingGroupByPlatform } from './db/messaging-groups.js';
import { upsertUser } from './modules/permissions/db/users.js';
import { upsertUserDm } from './modules/permissions/db/user-dms.js';
import {
  getDueOutboundMessages,
  getDeliveredIds,
  markDelivered,
  markDeliveryFailed,
  migrateDeliveredTable,
} from './db/session-db.js';
import { log } from './log.js';
import { normalizeOptions } from './channels/ask-question.js';
import { clearOutbox, openInboundDb, openOutboundDb, readOutboxFiles } from './session-manager.js';
import { pauseTypingRefreshAfterDelivery, setTypingAdapter } from './modules/typing/index.js';
import { registerApprovalHandler, requestApproval } from './modules/approvals/index.js';
import type { OutboundFile } from './channels/adapter.js';
import type { Session } from './types.js';

// PAT: dropped active poll from 1000ms to 100ms — SQLite reads are
// microseconds, so this is a CPU-cheap latency improvement. ~1s of
// per-turn round-trip latency disappears (the host was waiting up to
// a full second to notice the container's outbound row, then up to
// another second on the container side reading inbound).
// Sweep poll (60s) untouched: it iterates ALL active sessions with
// heartbeat reads + container_state — dropping that would pin a core.
// PAT: dropped from 100 → 25 in lockstep with container-side poll-loop
// (POLL_INTERVAL_MS, ACTIVE_POLL_INTERVAL_MS). better-sqlite3 reads
// stay microsecond-cheap; this is the host half of the same tune.
const ACTIVE_POLL_MS = 25;
const SWEEP_POLL_MS = 60_000;
// PAT: the retry budget must NOT inherit ACTIVE_POLL_MS. Retry spacing used to
// be the poll interval, so once that dropped 1000→25ms all attempts burned in
// ~75ms and any transient adapter error (Telegram 502, Slack 429, a Signal
// daemon mid-reconnect) permanently dropped the reply. Space attempts with
// exponential backoff decoupled from the poll cadence — a blip now has ~10s to
// clear before the message is marked failed.
const MAX_DELIVERY_ATTEMPTS = 5;
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 5_000;

/** Exponential backoff for failure #N (1-based): 500, 1000, 2000, 4000, capped 5000ms. */
function retryBackoffMs(attempts: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);
}

/** Track delivery attempt counts. Resets on process restart (gives failed messages a fresh chance). */
const deliveryAttempts = new Map<string, number>();

/** Earliest wall-clock time (ms) a failed message may be retried. Paired with
 *  deliveryAttempts; both reset on process restart. */
const nextAttemptAt = new Map<string, number>();

/**
 * Sessions whose outbound queue is currently being drained.
 *
 * The active poll (1s, running sessions) and the sweep poll (60s, all
 * active sessions) both call deliverSessionMessages, and a running session
 * is in *both* result sets. Without this guard, the two timer chains can
 * race on the same outbound row: both read it as undelivered, both call
 * the channel adapter, both markDelivered (idempotent in the DB via
 * INSERT OR IGNORE — but the user has already seen the message twice).
 *
 * Skipping (vs. queueing) is correct: any message left over when the
 * second caller skips will be picked up on the next poll tick (~1s).
 */
const inflightDeliveries = new Set<string>();

// PAT: provenance for the `outbound.sent` log event, threaded into the
// delivery seam so the channel-agnostic choke point
// (createChannelDeliveryAdapter) can stamp WHO produced the send without
// guessing. The outbound delivery poll (deliverMessage, below) passes
// origin='agent' plus the sending session + agent group; host-module
// system sends (permissions / approvals / pairing / signal-health) omit
// it entirely and default to origin='system'. Optional + additive — no
// existing caller has to change.
export interface OutboundDeliveryContext {
  /** Component that authored the send. Defaults to 'system' when absent. */
  origin?: 'agent' | 'system' | 'realtime';
  /** Sending agent group (`ag-…`) for origin='agent'. */
  senderAgentGroupId?: string | null;
  /** Sending session id for origin='agent' (promoted to top-level session_id). */
  sessionId?: string | null;
}

export interface ChannelDeliveryAdapter {
  deliver(
    channelType: string,
    platformId: string,
    threadId: string | null,
    kind: string,
    content: string,
    files?: OutboundFile[],
    /** Delivering adapter instance (defaults to channelType downstream).
     *  Host-internal only — containers never see instance. */
    instance?: string,
    /** PAT: optional provenance for the outbound.sent log event. */
    ctx?: OutboundDeliveryContext,
  ): Promise<string | undefined>;
  setTyping?(channelType: string, platformId: string, threadId: string | null, instance?: string): Promise<void>;
}

let deliveryAdapter: ChannelDeliveryAdapter | null = null;
let activePolling = false;
let sweepPolling = false;

/**
 * Callbacks fired when the delivery adapter is first set (and again if it's
 * replaced). Lets modules that need the adapter at boot (e.g. approvals →
 * OneCLI handler) hook in without core calling into the module directly.
 *
 * Not a general-purpose registry — narrow lifecycle hook only.
 */
type AdapterReadyCallback = (adapter: ChannelDeliveryAdapter) => void | Promise<void>;
const adapterReadyCallbacks: AdapterReadyCallback[] = [];

/** Current delivery adapter or null if not yet set. Modules use this in live
 *  message-flow handlers where the adapter is guaranteed to be set. For
 *  boot-time setup (before the adapter is ready), use onDeliveryAdapterReady. */
export function getDeliveryAdapter(): ChannelDeliveryAdapter | null {
  return deliveryAdapter;
}

export function onDeliveryAdapterReady(cb: AdapterReadyCallback): void {
  adapterReadyCallbacks.push(cb);
  if (deliveryAdapter) {
    // Already set — fire immediately so late registrations still run.
    void Promise.resolve()
      .then(() => cb(deliveryAdapter as ChannelDeliveryAdapter))
      .catch((err) => log.error('onDeliveryAdapterReady callback threw', { err }));
  }
}

export function setDeliveryAdapter(adapter: ChannelDeliveryAdapter): void {
  deliveryAdapter = adapter;
  // Forward to the typing module so it can fire setTyping on its own
  // interval. Direct call, not a registry — typing is a default module.
  setTypingAdapter(adapter);
  for (const cb of adapterReadyCallbacks) {
    void Promise.resolve()
      .then(() => cb(adapter))
      .catch((err) => log.error('onDeliveryAdapterReady callback threw', { err }));
  }
}

/** Start the active container poll loop (~1s). */
export function startActiveDeliveryPoll(): void {
  if (activePolling) return;
  activePolling = true;
  pollActive();
}

/** Start the sweep poll loop (~60s). */
export function startSweepDeliveryPoll(): void {
  if (sweepPolling) return;
  sweepPolling = true;
  pollSweep();
}

async function pollActive(): Promise<void> {
  if (!activePolling) return;

  try {
    const sessions = getRunningSessions();
    for (const session of sessions) {
      await deliverSessionMessages(session);
    }
  } catch (err) {
    log.error('Active delivery poll error', { err });
  }

  setTimeout(pollActive, ACTIVE_POLL_MS);
}

async function pollSweep(): Promise<void> {
  if (!sweepPolling) return;

  try {
    const sessions = getActiveSessions();
    for (const session of sessions) {
      await deliverSessionMessages(session);
    }
  } catch (err) {
    log.error('Sweep delivery poll error', { err });
  }

  setTimeout(pollSweep, SWEEP_POLL_MS);
}

export async function deliverSessionMessages(session: Session): Promise<void> {
  // Reject re-entry from a concurrent poll on the same session — see the
  // comment on inflightDeliveries above.
  if (inflightDeliveries.has(session.id)) return;
  inflightDeliveries.add(session.id);

  try {
    await drainSession(session);
  } finally {
    inflightDeliveries.delete(session.id);
  }
}

async function drainSession(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  let outDb: Database.Database;
  let inDb: Database.Database;
  try {
    outDb = openOutboundDb(agentGroup.id, session.id);
    inDb = openInboundDb(agentGroup.id, session.id);
  } catch {
    return; // DBs might not exist yet
  }

  try {
    // Read all due messages from outbound.db (read-only)
    const allDue = getDueOutboundMessages(outDb);
    if (allDue.length === 0) return;

    // Filter out already-delivered messages using inbound.db's delivered table
    const delivered = getDeliveredIds(inDb);
    const undelivered = allDue.filter((m) => !delivered.has(m.id));
    if (undelivered.length === 0) return;

    // Ensure platform_message_id column exists (migration for existing sessions)
    migrateDeliveredTable(inDb);

    for (const msg of undelivered) {
      // PAT: honor the retry backoff window. The 25ms active poll re-enters
      // this loop constantly; without this gate every retry burned within
      // ~75ms of the first failure and any transient adapter error (Telegram
      // 502, Slack 429, signal daemon mid-reconnect) permanently dropped the
      // reply. Skipped messages stay undelivered and are re-examined next poll.
      const notBefore = nextAttemptAt.get(msg.id);
      if (notBefore !== undefined && Date.now() < notBefore) continue;
      try {
        const platformMsgId = await deliverMessage(msg, session, inDb);
        markDelivered(inDb, msg.id, platformMsgId ?? null);
        deliveryAttempts.delete(msg.id);
        nextAttemptAt.delete(msg.id);

        // Pause the typing indicator after a real user-facing message
        // lands on the user's screen, so the client has time to visually
        // clear the indicator before the next heartbeat tick brings it
        // back. Skip the pause for internal traffic (system actions,
        // agent-to-agent routing) — the user doesn't see those and
        // shouldn't get a gap in their typing indicator for them.
        if (msg.kind !== 'system' && msg.channel_type !== 'agent') {
          pauseTypingRefreshAfterDelivery(session.id);
        }
      } catch (err) {
        const attempts = (deliveryAttempts.get(msg.id) ?? 0) + 1;
        deliveryAttempts.set(msg.id, attempts);
        if (attempts >= MAX_DELIVERY_ATTEMPTS) {
          log.error('Message delivery failed permanently, giving up', {
            messageId: msg.id,
            sessionId: session.id,
            attempts,
            err,
          });
          markDeliveryFailed(inDb, msg.id);
          deliveryAttempts.delete(msg.id);
          nextAttemptAt.delete(msg.id);
        } else {
          const backoffMs = retryBackoffMs(attempts);
          nextAttemptAt.set(msg.id, Date.now() + backoffMs);
          log.warn('Message delivery failed, will retry', {
            messageId: msg.id,
            sessionId: session.id,
            attempt: attempts,
            maxAttempts: MAX_DELIVERY_ATTEMPTS,
            backoffMs,
            err,
          });
        }
      }
    }
  } finally {
    outDb.close();
    inDb.close();
  }
}

// PAT: channels where the user-facing handle IS the delivery target
// (no separate openDM resolution required). Mirrors the cold-contact
// allowlist in agent-runner's tryColdContactParse + the parser path in
// poll-loop.ts:dispatchResultText. Slack/Discord/Teams need a per-
// adapter openDM round-trip we don't perform during delivery; for
// those, leave the "unknown messaging group" error in place so the
// agent gets explicit feedback.
const PAT_DIRECT_ADDRESSABLE_CHANNELS = new Set(['signal', 'pstn', 'telegram', 'whatsapp', 'imessage']);

/**
 * Auto-create the `users` + `messaging_groups` + `user_dms` scaffolding for
 * a cold-contact send target. Idempotent — safe to call repeatedly. Returns
 * the newly-created messaging_group, or null if the channel isn't direct-
 * addressable.
 *
 * Also auto-grants the source agent permission to send to this destination
 * by inserting an `agent_destinations` row. Without that grant, the
 * permission check immediately below would throw `unauthorized channel
 * destination` for any non-origin cold target.
 */
function maybeMaterializeColdContact(
  channelType: string,
  platformId: string,
  session: Session,
): import('./types.js').MessagingGroup | undefined {
  if (!PAT_DIRECT_ADDRESSABLE_CHANNELS.has(channelType)) {
    return undefined;
  }
  const userId = `${channelType}:${platformId}`;
  const now = new Date().toISOString();
  upsertUser({
    id: userId,
    kind: channelType,
    display_name: platformId,
    created_at: now,
  });
  const mgId = `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const mg: import('./types.js').MessagingGroup = {
    id: mgId,
    channel_type: channelType,
    platform_id: platformId,
    name: null,
    is_group: 0,
    unknown_sender_policy: 'request_approval',
    denied_at: null,
    created_at: now,
  };
  createMessagingGroup(mg);
  upsertUserDm({
    user_id: userId,
    channel_type: channelType,
    messaging_group_id: mgId,
    resolved_at: now,
  });
  // PAT (security): do NOT auto-grant. Cold-contact to a never-seen address
  // was an exfil channel — a (prompt-injected) agent could message CRM/any data
  // to an attacker number and permanently self-widen its own destination ACL.
  // Instead request an admin approval card ONCE (this fn runs only on first
  // contact, while no messaging_groups row exists yet) and leave the grant OUT,
  // so the permission check below fails closed until an admin approves. The
  // 'cold_contact' handler (registered below) inserts the grant on approval;
  // later sends to this address skip this fn (the mg now exists) → no re-ask,
  // and a denied address simply keeps failing closed with no new card.
  void requestColdContactApproval(session, mg).catch((err) =>
    log.error('cold-contact approval request failed', { err, agentGroupId: session.agent_group_id }),
  );
  log.info('Cold-contact destination materialized — pending approval, no grant', {
    channelType,
    platformId,
    messagingGroupId: mgId,
    agentGroupId: session.agent_group_id,
  });
  return mg;
}

/** PAT : request a one-time admin approval to let this agent group cold-
 *  contact a brand-new destination. Fire-and-forget from the caller. */
async function requestColdContactApproval(session: Session, mg: import('./types.js').MessagingGroup): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  const name = agentGroup?.name ?? session.agent_group_id;
  await requestApproval({
    session,
    agentName: name,
    action: 'cold_contact',
    payload: {
      agentGroupId: session.agent_group_id,
      messagingGroupId: mg.id,
      channelType: mg.channel_type,
      platformId: mg.platform_id,
    },
    title: 'Cold-contact approval',
    question:
      `Agent "${name}" wants to start a NEW conversation with ${mg.channel_type}:${mg.platform_id} ` +
      `(never contacted before). Approve only if the agent should be able to message this address.`,
  });
}

// PAT : on approval, grant the agent permission to deliver to the cold
// destination. Called ONCE at boot (from src/index.ts) rather than at module
// load — a load-time registration is a side effect that breaks unit tests whose
// approvals mock is incomplete, and calling it post-boot also sidesteps the
// delivery↔approvals import cycle (the real approvals module is fully loaded).
export function registerColdContactApprovalHandler(): void {
  registerApprovalHandler('cold_contact', async ({ payload, notify }) => {
    const agentGroupId = payload.agentGroupId as string;
    const mgId = payload.messagingGroupId as string;
    if (hasTable(getDb(), 'agent_destinations')) {
      getDb()
        .prepare('INSERT OR IGNORE INTO agent_destinations (agent_group_id, target_type, target_id) VALUES (?, ?, ?)')
        .run(agentGroupId, 'channel', mgId);
    }
    notify(`Cold-contact to ${payload.channelType}:${payload.platformId} approved — you can message them now.`);
  });
}

async function deliverMessage(
  msg: {
    id: string;
    kind: string;
    platform_id: string | null;
    channel_type: string | null;
    thread_id: string | null;
    content: string;
    in_reply_to: string | null;
  },
  session: Session,
  inDb: Database.Database,
): Promise<string | undefined> {
  if (!deliveryAdapter) {
    log.warn('No delivery adapter configured, dropping message', { id: msg.id });
    return;
  }

  // PAT: detail rows are consumed by the realtime library directly
  // (it tail-reads outbound.db). They never go through user-facing
  // channel adapters. Short-circuit here so drainSession marks them
  // delivered and they don't accumulate as undelivered backlog.
  if (msg.kind === 'detail') {
    return;
  }

  const content = JSON.parse(msg.content);

  // System actions — handle internally (schedule_task, cancel_task, etc.)
  if (msg.kind === 'system') {
    await handleSystemAction(content, session, inDb);
    return;
  }

  // Agent-to-agent — route to target session via the agent-to-agent module.
  // Guarded by the channel_type check. If the module isn't installed the
  // `agent_destinations` table won't exist and `routeAgentMessage`'s permission
  // check will throw, which falls into the normal retry → mark-failed path.
  if (msg.channel_type === 'agent') {
    if (!hasTable(getDb(), 'agent_destinations')) {
      throw new Error(`agent-to-agent module not installed — cannot route message ${msg.id}`);
    }
    const { routeAgentMessage } = await import('./modules/agent-to-agent/agent-route.js');
    await routeAgentMessage(msg, session);
    return;
  }

  // Permission check: the source agent must be allowed to deliver to this
  // channel destination. Two ways it passes:
  //
  //   1. The target is the session's own origin chat (session.messaging_group_id
  //      matches). An agent can always reply to the chat it was spawned from;
  //      requiring a destinations row for the obvious case is a footgun.
  //
  //   2. Otherwise, the agent must have an explicit agent_destinations row
  //      targeting that messaging group. createMessagingGroupAgent() inserts
  //      these automatically when wiring, so an operator wiring additional
  //      chats to the agent doesn't need a separate ACL step.
  //
  // Failures throw — unlike a silent `return`, an Error falls into the retry
  // path in deliverSessionMessages and eventually marks the message as failed
  // (instead of marking it delivered when nothing was actually delivered,
  // which was the pre-refactor bug).
  let deliverInstance: string | undefined;
  if (msg.channel_type && msg.platform_id) {
    // Resolve the messaging group ORIGIN-SESSION-FIRST: when the message
    // targets the session's own chat address, the origin row wins even if
    // sibling instances share the same (channel_type, platform_id) — so the
    // reply goes out through the instance the message came in on. Otherwise
    // fall back to the by-platform lookup (default-instance-first).
    // PAT: `let` (not `const`) — the cold-contact block below reassigns mg
    // via maybeMaterializeColdContact when no row exists yet.
    const originMg = session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined;
    let mg =
      originMg && originMg.channel_type === msg.channel_type && originMg.platform_id === msg.platform_id
        ? originMg
        : getMessagingGroupByPlatform(msg.channel_type, msg.platform_id);
    if (!mg) {
      // PAT: cold-contact materialization. When the container dispatches a
      // chat row to a direct-addressable platform-id we've never talked to
      // (e.g. `<message to="signal:+E164">` for a new recipient), no
      // messaging_groups row exists yet — there's no inbound history to
      // have created one. Auto-create it now with the same defaults the
      // router uses on inbound auto-create (`request_approval` policy), so
      // the recipient's reply (if any) lands as an approval card to an
      // owner rather than being silently dropped.
      //
      // Limited to direct-addressable channels — handles where the user-
      // facing ID IS the delivery target. Slack/Discord/Teams need a
      // separate `openDM` round-trip we don't perform here; for those,
      // continue to fail closed.
      mg = maybeMaterializeColdContact(msg.channel_type, msg.platform_id, session);
      if (!mg) {
        throw new Error(`unknown messaging group for ${msg.channel_type}/${msg.platform_id} (message ${msg.id})`);
      }
    }
    const isOriginChat = session.messaging_group_id === mg.id;
    // Guarded: without the agent-to-agent module, `agent_destinations`
    // doesn't exist and we permit all non-origin channel sends (the
    // origin-chat case is always allowed regardless). Inlined SQL instead
    // of importing `hasDestination` so core doesn't depend on the module.
    if (!isOriginChat && hasTable(getDb(), 'agent_destinations')) {
      const row = getDb()
        .prepare(
          'SELECT 1 FROM agent_destinations WHERE agent_group_id = ? AND target_type = ? AND target_id = ? LIMIT 1',
        )
        .get(session.agent_group_id, 'channel', mg.id);
      if (!row) {
        throw new Error(
          `unauthorized channel destination: ${session.agent_group_id} cannot send to ${mg.channel_type}/${mg.platform_id}`,
        );
      }
    }
    deliverInstance = mg.instance;
  }

  // Track pending questions for ask_user_question flow.
  // Guarded: without the interactive module, `pending_questions` doesn't
  // exist and we skip persistence — the card still delivers to the user,
  // but the response path has nowhere to land and will log unclaimed.
  if (content.type === 'ask_question' && content.questionId && hasTable(getDb(), 'pending_questions')) {
    const title = content.title as string | undefined;
    const rawOptions = content.options as unknown;
    if (!title || !Array.isArray(rawOptions)) {
      log.error('ask_question missing required title/options — not persisting', {
        questionId: content.questionId,
      });
    } else {
      const inserted = createPendingQuestion({
        question_id: content.questionId,
        session_id: session.id,
        message_out_id: msg.id,
        platform_id: msg.platform_id,
        channel_type: msg.channel_type,
        thread_id: msg.thread_id,
        title,
        options: normalizeOptions(rawOptions as never),
        created_at: new Date().toISOString(),
      });
      if (inserted) {
        log.info('Pending question created', { questionId: content.questionId, sessionId: session.id });
      }
    }
  }

  // Channel delivery
  if (!msg.channel_type || !msg.platform_id) {
    log.warn('Message missing routing fields', { id: msg.id });
    return;
  }

  // Read file attachments from outbox if the content declares files.
  // File I/O lives in session-manager.ts (symmetric with inbound
  // extractAttachmentFiles) — delivery just hands buffers to the adapter.
  const files =
    Array.isArray(content.files) && content.files.length > 0
      ? readOutboxFiles(session.agent_group_id, session.id, msg.id, content.files as string[])
      : undefined;

  const platformMsgId = await deliveryAdapter.deliver(
    msg.channel_type,
    msg.platform_id,
    msg.thread_id,
    msg.kind,
    msg.content,
    files,
    deliverInstance,
    // PAT: this is the back-mind/container reply path — the agent produced
    // this row in outbound.db (detail/system/agent-to-agent kinds already
    // short-circuited above). Stamp origin='agent' so outbound.sent records
    // it as an authored reply, and carry the sending session + agent group.
    { origin: 'agent', senderAgentGroupId: session.agent_group_id, sessionId: session.id },
  );
  log.event({
    kind: 'routing.message-delivered',
    session_id: session.id,
    data: {
      msg_id: String(msg.id),
      msg_kind: msg.kind,
      channel_type: msg.channel_type,
      file_count: files?.length,
      platform_msg_id: platformMsgId,
      platform_id: msg.platform_id,
    },
  });

  clearOutbox(session.agent_group_id, session.id, msg.id);

  return platformMsgId;
}

/**
 * Delivery action registry.
 *
 * Modules register handlers for system-kind outbound message actions via
 * `registerDeliveryAction`. Core checks the registry first in
 * `handleSystemAction` and falls through to the inline switch when no
 * handler is registered. The switch will shrink as modules are extracted
 * (scheduling, approvals, agent-to-agent) and eventually only its default
 * branch remains.
 *
 * Default when no handler registered and the switch doesn't match: log
 * "Unknown system action" and return.
 */
export type DeliveryActionHandler = (
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
) => Promise<void>;

const actionHandlers = new Map<string, DeliveryActionHandler>();

export function registerDeliveryAction(action: string, handler: DeliveryActionHandler): void {
  if (actionHandlers.has(action)) {
    log.warn('Delivery action handler overwritten', { action });
  }
  actionHandlers.set(action, handler);
}

/** Look up a registered delivery-action handler. Lets module registrations be behavior-tested. */
export function getDeliveryAction(action: string): DeliveryActionHandler | undefined {
  return actionHandlers.get(action);
}

/**
 * Handle system actions from the container agent.
 * These are written to messages_out because the container can't write to inbound.db.
 * The host applies them to inbound.db here.
 */
async function handleSystemAction(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const action = content.action as string;
  log.info('System action from agent', { sessionId: session.id, action });

  const registered = actionHandlers.get(action);
  if (registered) {
    await registered(content, session, inDb);
    return;
  }

  log.warn('Unknown system action', { action });
}

export function stopDeliveryPolls(): void {
  activePolling = false;
  sweepPolling = false;
}
