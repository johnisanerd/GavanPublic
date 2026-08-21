/**
 * Permissions module — sender resolution + access gate.
 *
 * Registers two hooks into the core router:
 *   1. setSenderResolver — runs before agent resolution. Parses the payload,
 *      derives a namespaced user id, and upserts the `users` row on first
 *      sight. Returns null when the payload doesn't carry enough to identify
 *      a sender.
 *   2. setAccessGate — runs after agent resolution. Enforces the
 *      unknown_sender_policy (strict/request_approval/public) and the
 *      owner/global-admin/scoped-admin/member access hierarchy. Records its
 *      own `dropped_messages` row on refusal (structural drops are recorded
 *      by core).
 *
 * Without this module: sender resolution is a no-op (userId=null); the
 * access gate is not registered and core defaults to allow-all.
 */
import { recordDroppedMessage } from '../../db/dropped-messages.js';
import { getAgentGroup, getAllAgentGroups } from '../../db/agent-groups.js';
import { createMessagingGroupAgent, setMessagingGroupDeniedAt } from '../../db/messaging-groups.js';
import {
  routeInbound,
  setAccessGate,
  setChannelRequestGate,
  setMessageInterceptor,
  setSenderResolver,
  setSenderScopeGate,
  type AccessGateResult,
} from '../../router.js';
import type { InboundEvent } from '../../channels/adapter.js';
import { registerResponseHandler, type ResponsePayload } from '../../response-registry.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import type { MessagingGroup, MessagingGroupAgent } from '../../types.js';
import { canAccessAgentGroup } from './access.js';
import {
  buildAgentSelectionOptions,
  CHOOSE_EXISTING_VALUE,
  CONNECT_PREFIX,
  createNewAgentGroup,
  NEW_AGENT_VALUE,
  REJECT_VALUE,
  requestChannelApproval,
} from './channel-approval.js';
import { addMember } from './db/agent-group-members.js';
import {
  deletePendingChannelApproval,
  getPendingChannelApproval,
  updatePendingChannelApprovalCard,
} from './db/pending-channel-approvals.js';
import { deletePendingSenderApproval, getPendingSenderApproval } from './db/pending-sender-approvals.js';
import { grantRole, hasAdminPrivilege, isOwner } from './db/user-roles.js';
import { getUser, upsertUser } from './db/users.js';
import { matchOwnerPhone } from './realtime-owners.js';
import { autoApproveKnownPerson, autoEnroll, getPersonByUser } from '../../people/index.js'; // PAT: people spine
import { matchPairingCodeInText } from '../../people/pairing.js'; // PAT: pairing-code linking
import { tryPairHandle } from './pairing.js'; // PAT: pairing-code linking
import { requestSenderApproval } from './sender-approval.js';
import { ensureUserDm } from './user-dm.js';

// ── Free-text name input state ──
// Tracks approvers waiting for a text reply with the agent name. Keyed by
// namespaced userId (e.g. "slack:U0ABC"). Cleared on receipt or restart.
interface PendingNameInput {
  channelMgId: string;
  dmChannelType: string;
  dmPlatformId: string;
}
const awaitingNameInput = new Map<string, PendingNameInput>();

function extractAndUpsertUser(event: InboundEvent): string | null {
  let content: Record<string, unknown>;
  try {
    content = JSON.parse(event.message.content) as Record<string, unknown>;
  } catch {
    return null;
  }

  // chat-sdk-bridge serializes author info as a nested `author.userId` and
  // does NOT populate top-level `senderId`. Older adapters (v1, native) put
  // `senderId` or `sender` directly at the top level. Check all three.
  const senderIdField = typeof content.senderId === 'string' ? content.senderId : undefined;
  const senderField = typeof content.sender === 'string' ? content.sender : undefined;
  const author =
    typeof content.author === 'object' && content.author !== null
      ? (content.author as Record<string, unknown>)
      : undefined;
  const authorUserId = typeof author?.userId === 'string' ? (author.userId as string) : undefined;
  const senderName =
    (typeof content.senderName === 'string' ? content.senderName : undefined) ??
    (typeof author?.fullName === 'string' ? (author.fullName as string) : undefined) ??
    (typeof author?.userName === 'string' ? (author.userName as string) : undefined);

  const rawHandle = senderIdField ?? senderField ?? authorUserId;
  if (!rawHandle) return null;

  const userId = rawHandle.includes(':') ? rawHandle : `${event.channelType}:${rawHandle}`;
  if (!getUser(userId)) {
    upsertUser({
      id: userId,
      kind: event.channelType,
      display_name: senderName ?? null,
      created_at: new Date().toISOString(),
    });
  }

  // Realtime owner auto-elevation: if this is a phone caller (pstn:<E.164>)
  // and the number is on the PAT_OWNER_PHONES allowlist, grant the global
  // owner role on first sight. Idempotent — the role row persists, so the
  // env var only matters for the first inbound. Every downstream gate
  // (canAccessAgentGroup, command-gate, pickApprover, OneCLI approvals)
  // reads user_roles and now sees a real owner.
  const matchedPhone = matchOwnerPhone(userId);
  if (matchedPhone) {
    if (!isOwner(userId)) {
      grantRole({
        user_id: userId,
        role: 'owner',
        agent_group_id: null,
        granted_by: null,
        granted_at: new Date().toISOString(),
      });
      log.event({
        kind: 'permissions.realtime-owner-resolved',
        data: {
          matched_phone: matchedPhone,
          user_id: userId,
          role: 'owner',
          decision: 'granted',
          reason: 'env_PAT_OWNER_PHONES',
        },
      });
    } else {
      log.event({
        kind: 'permissions.realtime-owner-resolved',
        level: 'debug',
        data: {
          matched_phone: matchedPhone,
          user_id: userId,
          role: 'owner',
          decision: 'already_owner',
          reason: 'env_PAT_OWNER_PHONES',
        },
      });
    }
  }

  // PAT: people-spine auto-enroll. If this handle carries a recognizable
  // identifier (phone/email) that a seeded person owns, link it under that
  // person. Links, never creates; idempotent; never throws on the hot path.
  // See plans/admin-dashboard-and-people.md (Phase 1).
  autoEnroll(userId);

  return userId;
}

function safeParseContent(raw: string): { text?: string; sender?: string; senderId?: string } {
  try {
    return JSON.parse(raw);
  } catch {
    return { text: raw };
  }
}

// PAT: the unknown-SENDER approval card is disabled by default (pairing replaced
// it). Code stays present (requestSenderApproval / handleSenderApprovalResponse /
// pending_sender_approvals) but is not invoked. Set PAT_SENDER_APPROVAL_CARDS=1 to
// re-enable the dormant card path. Read at call time so it's flippable without a
// redeploy.
function senderApprovalCardsEnabled(): boolean {
  return process.env.PAT_SENDER_APPROVAL_CARDS === '1';
}

function handleUnknownSender(
  mg: MessagingGroup,
  userId: string | null,
  agentGroupId: string,
  accessReason: string,
  event: InboundEvent,
): void {
  const parsed = safeParseContent(event.message.content);

  // PAT: pairing-code linking (the live self-serve path). If this unknown
  // sender's handle is UNLINKED and their message carries an active pairing code,
  // pair it — link the handle, wire+grant so Pat engages, consume the code,
  // confirm, and replay. Fire-and-forget (the replay re-routes the message); the
  // current attempt still records as dropped. Only fires for unlinked handles
  // with a live code match, so it never short-circuits a normal stranger.
  if (userId && !getPersonByUser(userId) && matchPairingCodeInText(parsed.text ?? '')) {
    void tryPairHandle(event, userId, mg, routeInbound).then((paired) => {
      // If it didn't actually pair (race / no agent group), fall through to the
      // normal drop path (the sender card is disabled by default). Call it
      // directly (NOT handleUnknownSender) to avoid re-matching the code + looping.
      if (!paired) raiseUnknownSenderCard(mg, userId, agentGroupId, accessReason, event);
    });
    return;
  }

  raiseUnknownSenderCard(mg, userId, agentGroupId, accessReason, event);
}

/** The unknown-sender drop path (strict → silent drop; request_approval → drop,
 *  and ONLY raise the approval card when PAT_SENDER_APPROVAL_CARDS=1 — disabled by
 *  default, pairing replaced it). Factored out so the pairing fallback can call it
 *  without re-checking for a pairing code. */
function raiseUnknownSenderCard(
  mg: MessagingGroup,
  userId: string | null,
  agentGroupId: string,
  accessReason: string,
  event: InboundEvent,
): void {
  const parsed = safeParseContent(event.message.content);
  const senderName = parsed.sender ?? null;
  const dropRecord = {
    channel_type: event.channelType,
    platform_id: event.platformId,
    user_id: userId,
    sender_name: senderName,
    reason: `unknown_sender_${mg.unknown_sender_policy}`,
    messaging_group_id: mg.id,
    agent_group_id: agentGroupId,
  };

  if (mg.unknown_sender_policy === 'strict') {
    log.info('MESSAGE DROPPED — unknown sender (strict policy)', {
      messagingGroupId: mg.id,
      agentGroupId,
      userId,
      accessReason,
    });
    recordDroppedMessage(dropRecord);
    return;
  }

  if (mg.unknown_sender_policy === 'request_approval') {
    log.info('MESSAGE DROPPED — unknown sender (approval requested)', {
      messagingGroupId: mg.id,
      agentGroupId,
      userId,
      accessReason,
    });
    recordDroppedMessage(dropRecord);
    // PAT: the unknown-SENDER approval card is DISABLED by default (pairing
    // replaced it — an unlinked sender pairs by sending a code; see the pairing
    // pre-check in the access gate). The card code stays present (requestSenderApproval
    // + handleSenderApprovalResponse + pending_sender_approvals), just not invoked,
    // so our fork diff stays minimal for /update-nanoclaw syncs. Re-enable with
    // env PAT_SENDER_APPROVAL_CARDS=1.
    //
    // Fire-and-forget when enabled; pick-approver + delivery + row-insert are all
    // async. Requires a resolved userId (senderResolver populates users row before
    // the gate fires); without one there's nothing to identify for approval and we
    // just stay in the "silent drop" branch.
    if (senderApprovalCardsEnabled() && userId) {
      requestSenderApproval({
        messagingGroupId: mg.id,
        agentGroupId,
        senderIdentity: userId,
        senderName,
        event,
      }).catch((err) => log.error('Sender-approval flow threw', { err }));
    }
    return;
  }

  // 'public' should have been handled before the gate; fall through silently.
}

setSenderResolver(extractAndUpsertUser);

setAccessGate((event, userId, mg, agentGroupId): AccessGateResult => {
  // Public channels skip the access check entirely.
  if (mg.unknown_sender_policy === 'public') {
    return { allowed: true };
  }

  if (!userId) {
    handleUnknownSender(mg, null, agentGroupId, 'unknown_user', event);
    return { allowed: false, reason: 'unknown_user' };
  }

  const decision = canAccessAgentGroup(userId, agentGroupId);
  if (decision.allowed) {
    return { allowed: true };
  }

  // PAT: cross-channel auto-approve. If this sender resolves to a KNOWN PERSON
  // (an operator vouched for them — dashboard OAuth login or operator seed),
  // grant agent-group-scoped membership and let them through. Applies under
  // EVERY non-public policy (strict included — that's the point: a vouched-for
  // human is allowed even in a strict channel). Only ever fires when the handle
  // is linked to a person; otherwise we fall through to the normal card/drop.
  if (autoApproveKnownPerson(userId, agentGroupId)) {
    log.info('Sender auto-approved — resolves to a known person', { userId, agentGroupId });
    return { allowed: true };
  }

  handleUnknownSender(mg, userId, agentGroupId, decision.reason, event);
  return { allowed: false, reason: decision.reason };
});

/**
 * Per-wiring sender-scope enforcement. Stricter than the messaging-group
 * `unknown_sender_policy` — a wiring can require `sender_scope='known'`
 * (explicit owner / admin / member) even on a 'public' messaging group.
 *
 * 'all' is a no-op; any sender passes. 'known' requires a userId that
 * canAccessAgentGroup accepts (owner, admin, or group member).
 */
setSenderScopeGate(
  (_event: InboundEvent, userId: string | null, _mg: MessagingGroup, agent: MessagingGroupAgent): AccessGateResult => {
    if (agent.sender_scope === 'all') return { allowed: true };
    if (!userId) return { allowed: false, reason: 'unknown_user_scope' };
    const decision = canAccessAgentGroup(userId, agent.agent_group_id);
    if (decision.allowed) return { allowed: true };
    // PAT: a known person passes sender_scope='known' too — grant + allow.
    if (autoApproveKnownPerson(userId, agent.agent_group_id)) return { allowed: true };
    return { allowed: false, reason: `sender_scope_${decision.reason}` };
  },
);

/**
 * Response handler for the unknown-sender approval card.
 *
 * Claim rule: questionId matches a row in pending_sender_approvals. If no
 * such row, return false so the next handler (approvals module, OneCLI,
 * interactive) gets a shot.
 *
 * Approve: add the sender to agent_group_members + re-invoke routeInbound
 * with the stored event. The second routing attempt clears the gate because
 * the user is now a member.
 *
 * Deny: delete the row (no "deny list" — a future message re-triggers a
 * fresh card per ACTION-ITEMS item 5 "no denial persistence").
 */
async function handleSenderApprovalResponse(payload: ResponsePayload): Promise<boolean> {
  const row = getPendingSenderApproval(payload.questionId);
  if (!row) return false;

  // payload.userId is the raw platform userId (e.g. "<telegram-id>"); namespace it
  // with the channel type so it matches users(id) format. Some platforms
  // (e.g. Teams "29:xxx") already include a colon — mirror resolveOrCreateUser
  // logic and only prefix when the raw id has no colon.
  const clickerId = payload.userId
    ? payload.userId.includes(':')
      ? payload.userId
      : `${payload.channelType}:${payload.userId}`
    : null;
  const isAuthorized =
    clickerId !== null && (clickerId === row.approver_user_id || hasAdminPrivilege(clickerId, row.agent_group_id));
  if (!isAuthorized) {
    log.warn('Unknown-sender approval click rejected — unauthorized clicker', {
      approvalId: row.id,
      clickerId,
      expectedApprover: row.approver_user_id,
    });
    return true; // claim the response so it's not unclaimed-logged, but do nothing
  }
  const approverId = clickerId;
  const approved = payload.value === 'approve';

  if (approved) {
    addMember({
      user_id: row.sender_identity,
      agent_group_id: row.agent_group_id,
      added_by: approverId,
      added_at: new Date().toISOString(),
    });
    log.info('Unknown sender approved — member added', {
      approvalId: row.id,
      senderIdentity: row.sender_identity,
      agentGroupId: row.agent_group_id,
      approverId,
    });

    // Clear the pending row BEFORE re-routing so the gate check on the
    // second attempt doesn't see the in-flight row and short-circuit.
    deletePendingSenderApproval(row.id);

    try {
      const event = JSON.parse(row.original_message) as InboundEvent;
      await routeInbound(event);
    } catch (err) {
      log.error('Failed to replay message after sender approval', { approvalId: row.id, err });
    }
    return true;
  }

  log.info('Unknown sender denied', {
    approvalId: row.id,
    senderIdentity: row.sender_identity,
    agentGroupId: row.agent_group_id,
    approverId,
  });
  deletePendingSenderApproval(row.id);
  return true;
}

registerResponseHandler(handleSenderApprovalResponse);

// ── Unwired-channel handling: PAIRING (live), channel-registration card (gated off) ──
//
// PAT: the channel-registration approval-card flow below (requestChannelApproval
// + handleChannelApprovalResponse + the free-text name interceptor + the
// `ncl channel-registrations` resource) is left INTACT but is NO LONGER INVOKED
// from the ingress path — pairing replaced it. We keep the code present (not
// deleted) so our fork's diff against upstream stays minimal and `/update-nanoclaw`
// syncs stay clean. The single disable point is right here: the unwired-channel
// gate routes to pairing-or-drop and never calls requestChannelApproval.
//
// To RE-ENABLE the card flow, set PAT_CHANNEL_REGISTRATION_CARDS=1 (env, read at
// each gate invocation so it's flippable without a code change). Default OFF.
function channelRegistrationCardsEnabled(): boolean {
  return process.env.PAT_CHANNEL_REGISTRATION_CARDS === '1';
}

// One-time-hint dedup: namespaced userId → last-hinted epoch ms. In-process
// (resets on restart); a restart re-hinting once is acceptable and not spammy.
const lastPairingHintAt = new Map<string, number>();
const PAIRING_HINT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // at most one hint per sender per day

async function maybeSendPairingHint(event: InboundEvent, userId: string): Promise<void> {
  const last = lastPairingHintAt.get(userId);
  if (last && Date.now() - last < PAIRING_HINT_COOLDOWN_MS) return;
  lastPairingHintAt.set(userId, Date.now());
  const adapter = getDeliveryAdapter();
  if (!adapter) return;
  try {
    await adapter.deliver(
      event.channelType,
      event.platformId,
      event.threadId,
      'chat',
      JSON.stringify({
        text: "I don't recognize this handle yet. To connect, open the PAT dashboard, generate a pairing code under “My Handles → Link new handle”, and send it here.",
      }),
      undefined,
      event.instance,
    );
  } catch (err) {
    log.warn('Pairing hint delivery failed', { err });
  }
}

setChannelRequestGate(async (mg, event) => {
  // PAT: pairing-code linking on an UNWIRED channel (a fresh DM from a new
  // handle). If the sender's handle is unlinked and the message carries an
  // active pairing code, pair it (link + wire + member + consume + confirm +
  // replay). tryPairHandle wires the messaging group to the primary agent group
  // itself, so the replay engages Pat. Only intercepts on a live code match for
  // an unlinked handle.
  const userId = extractAndUpsertUser(event);
  if (userId && !getPersonByUser(userId)) {
    const parsed = safeParseContent(event.message.content);
    if (matchPairingCodeInText(parsed.text ?? '')) {
      const paired = await tryPairHandle(event, userId, mg, routeInbound);
      if (paired) return;
    }
  }

  // No pairing — default is DROP (the router already recorded the drop) with a
  // one-time hint. The channel-registration card is disabled by default; the
  // env flag re-enables the dormant card path.
  if (channelRegistrationCardsEnabled()) {
    await requestChannelApproval({ messagingGroupId: mg.id, event });
    return;
  }
  if (userId) await maybeSendPairingHint(event, userId);
});

/**
 * Response handler for the unknown-channel registration card.
 *
 * Claim rule: questionId matches a pending_channel_approvals row (keyed
 * by messaging_group_id). If no such row, return false so downstream
 * handlers get a shot.
 *
 * Value dispatch:
 *   connect:<id>    — wire to an existing agent group, replay the message
 *   choose_existing — send a follow-up card listing all agents
 *   new_agent       — prompt for a free-text agent name (interceptor
 *                     captures the reply and creates immediately)
 *   reject          — set denied_at, delete pending row
 */
// PAT: exported so `ncl channel-registrations approve/reject` can resolve a
// pending registration programmatically (manual/agentic), mirroring a card click.
export async function handleChannelApprovalResponse(payload: ResponsePayload): Promise<boolean> {
  const row = getPendingChannelApproval(payload.questionId);
  if (!row) return false;

  const clickerId = payload.userId
    ? payload.userId.includes(':')
      ? payload.userId
      : `${payload.channelType}:${payload.userId}`
    : null;
  const isAuthorized =
    clickerId !== null && (clickerId === row.approver_user_id || hasAdminPrivilege(clickerId, row.agent_group_id));
  if (!isAuthorized) {
    log.warn('Channel registration click rejected — unauthorized clicker', {
      messagingGroupId: row.messaging_group_id,
      clickerId,
      expectedApprover: row.approver_user_id,
    });
    return true;
  }
  const approverId = clickerId;

  // ── Reject / Cancel ──
  if (payload.value === REJECT_VALUE) {
    setMessagingGroupDeniedAt(row.messaging_group_id, new Date().toISOString());
    deletePendingChannelApproval(row.messaging_group_id);
    log.info('Channel registration denied', {
      messagingGroupId: row.messaging_group_id,
      approverId,
    });
    return true;
  }

  // ── Choose existing agent — send agent-selection follow-up card ──
  if (payload.value === CHOOSE_EXISTING_VALUE) {
    const approverDm = await ensureUserDm(row.approver_user_id);
    if (!approverDm) {
      log.error('Channel registration: no DM channel for approver', {
        messagingGroupId: row.messaging_group_id,
        approverUserId: row.approver_user_id,
      });
      return true;
    }

    const adapter = getDeliveryAdapter();
    if (!adapter) return true;

    const agentGroups = getAllAgentGroups();
    const options = buildAgentSelectionOptions(agentGroups, approverId);
    const title = '📋 Choose an agent';
    updatePendingChannelApprovalCard(row.messaging_group_id, title, JSON.stringify(options));

    try {
      await adapter.deliver(
        approverDm.channel_type,
        approverDm.platform_id,
        null,
        'chat-sdk',
        JSON.stringify({
          type: 'ask_question',
          questionId: row.messaging_group_id,
          title,
          question: 'Which agent should handle this channel?',
          options,
        }),
      );
    } catch (err) {
      log.error('Channel registration: agent-selection card delivery failed', {
        messagingGroupId: row.messaging_group_id,
        err,
      });
    }
    return true;
  }

  // ── Create new agent — prompt for free-text name ──
  if (payload.value === NEW_AGENT_VALUE) {
    const approverDm = await ensureUserDm(row.approver_user_id);
    if (!approverDm) {
      log.error('Channel registration: no DM channel for approver', {
        messagingGroupId: row.messaging_group_id,
        approverUserId: row.approver_user_id,
      });
      return true;
    }

    const adapter = getDeliveryAdapter();
    if (!adapter) {
      log.error('Channel registration: no delivery adapter for name prompt', {
        messagingGroupId: row.messaging_group_id,
      });
      return true;
    }

    awaitingNameInput.set(row.approver_user_id, {
      channelMgId: row.messaging_group_id,
      dmChannelType: approverDm.channel_type,
      dmPlatformId: approverDm.platform_id,
    });

    try {
      await adapter.deliver(
        approverDm.channel_type,
        approverDm.platform_id,
        null,
        'chat-sdk',
        JSON.stringify({ text: 'Reply with the name for your new agent:' }),
      );
    } catch (err) {
      log.error('Channel registration: name prompt delivery failed', {
        messagingGroupId: row.messaging_group_id,
        err,
      });
      awaitingNameInput.delete(row.approver_user_id);
    }
    return true;
  }

  // ── Resolve target agent group (connect to existing or create new) ──
  let targetAgentGroupId: string;

  if (payload.value.startsWith(CONNECT_PREFIX)) {
    targetAgentGroupId = payload.value.slice(CONNECT_PREFIX.length);
    const ag = getAgentGroup(targetAgentGroupId);
    if (!ag) {
      log.error('Channel registration: target agent group no longer exists', {
        messagingGroupId: row.messaging_group_id,
        targetAgentGroupId,
      });
      deletePendingChannelApproval(row.messaging_group_id);
      return true;
    }
    if (!hasAdminPrivilege(approverId, targetAgentGroupId)) {
      log.warn('Channel registration: target agent group rejected for unauthorized approver', {
        messagingGroupId: row.messaging_group_id,
        targetAgentGroupId,
        approverId,
      });
      return true;
    }
  } else {
    log.warn('Channel registration: unknown response value', {
      messagingGroupId: row.messaging_group_id,
      value: payload.value,
    });
    return true;
  }

  // ── Wire + replay (shared path for connect and create) ──
  let event: InboundEvent;
  try {
    event = JSON.parse(row.original_message) as InboundEvent;
  } catch (err) {
    log.error('Channel registration: failed to parse stored event', {
      messagingGroupId: row.messaging_group_id,
      err,
    });
    deletePendingChannelApproval(row.messaging_group_id);
    return true;
  }

  const isGroup = event.threadId !== null;
  const engageMode: MessagingGroupAgent['engage_mode'] = isGroup ? 'mention-sticky' : 'pattern';
  const engagePattern = isGroup ? null : '.';

  const mgaId = `mga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  createMessagingGroupAgent({
    id: mgaId,
    messaging_group_id: row.messaging_group_id,
    agent_group_id: targetAgentGroupId,
    engage_mode: engageMode,
    engage_pattern: engagePattern,
    sender_scope: 'known',
    ignored_message_policy: 'accumulate',
    session_mode: 'shared',
    priority: 0,
    created_at: new Date().toISOString(),
  });
  log.info('Channel registration approved — wiring created', {
    messagingGroupId: row.messaging_group_id,
    agentGroupId: targetAgentGroupId,
    mgaId,
    engageMode,
    approverId,
  });

  const senderUserId = extractAndUpsertUser(event);
  if (senderUserId) {
    addMember({
      user_id: senderUserId,
      agent_group_id: targetAgentGroupId,
      added_by: approverId,
      added_at: new Date().toISOString(),
    });
  }

  deletePendingChannelApproval(row.messaging_group_id);

  try {
    await routeInbound(event);
  } catch (err) {
    log.error('Failed to replay message after channel approval', {
      messagingGroupId: row.messaging_group_id,
      err,
    });
  }
  return true;
}

registerResponseHandler(handleChannelApprovalResponse);

// ── Free-text name interceptor ──
// Captures the next DM from an approver who clicked "Create new agent",
// creates the agent immediately, wires the channel, and replays.

setMessageInterceptor(async (event: InboundEvent): Promise<boolean> => {
  const userId = extractAndUpsertUser(event);
  if (!userId) return false;

  const pending = awaitingNameInput.get(userId);
  if (!pending) return false;
  if (event.channelType !== pending.dmChannelType || event.platformId !== pending.dmPlatformId) return false;

  awaitingNameInput.delete(userId);

  let text: string | undefined;
  try {
    const parsed = JSON.parse(event.message.content) as Record<string, unknown>;
    text = (typeof parsed.text === 'string' ? parsed.text : undefined)?.trim();
  } catch {
    /* fall through */
  }

  if (!text) {
    log.warn('Channel registration: empty name reply, ignoring', { userId });
    return true;
  }

  const row = getPendingChannelApproval(pending.channelMgId);
  if (!row) return true;

  const ag = createNewAgentGroup(text);
  log.info('Channel registration: new agent group created', {
    messagingGroupId: row.messaging_group_id,
    agentGroupId: ag.id,
    agentName: ag.name,
    folder: ag.folder,
  });

  let originalEvent: InboundEvent;
  try {
    originalEvent = JSON.parse(row.original_message) as InboundEvent;
  } catch (err) {
    log.error('Channel registration: failed to parse stored event', {
      messagingGroupId: row.messaging_group_id,
      err,
    });
    deletePendingChannelApproval(row.messaging_group_id);
    return true;
  }

  const isGroup = originalEvent.threadId !== null;
  const engageMode: MessagingGroupAgent['engage_mode'] = isGroup ? 'mention-sticky' : 'pattern';
  const engagePattern = isGroup ? null : '.';

  const mgaId = `mga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  createMessagingGroupAgent({
    id: mgaId,
    messaging_group_id: row.messaging_group_id,
    agent_group_id: ag.id,
    engage_mode: engageMode,
    engage_pattern: engagePattern,
    sender_scope: 'known',
    ignored_message_policy: 'accumulate',
    session_mode: 'shared',
    priority: 0,
    created_at: new Date().toISOString(),
  });
  log.info('Channel registration approved — wiring created', {
    messagingGroupId: row.messaging_group_id,
    agentGroupId: ag.id,
    mgaId,
    engageMode,
    approverId: userId,
  });

  const senderUserId = extractAndUpsertUser(originalEvent);
  if (senderUserId) {
    addMember({
      user_id: senderUserId,
      agent_group_id: ag.id,
      added_by: userId,
      added_at: new Date().toISOString(),
    });
  }

  deletePendingChannelApproval(row.messaging_group_id);

  try {
    await routeInbound(originalEvent);
  } catch (err) {
    log.error('Failed to replay message after channel approval', {
      messagingGroupId: row.messaging_group_id,
      err,
    });
  }

  const adapter = getDeliveryAdapter();
  if (adapter) {
    const dm = await ensureUserDm(row.approver_user_id);
    if (dm) {
      adapter
        .deliver(
          dm.channel_type,
          dm.platform_id,
          null,
          'chat-sdk',
          JSON.stringify({ text: `✅ Agent "${ag.name}" created and connected.` }),
        )
        .catch(() => {});
    }
  }
  return true;
});
