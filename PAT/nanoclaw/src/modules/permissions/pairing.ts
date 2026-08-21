/**
 * PAT: pairing-code ingress — the self-service handle-linking seam.
 *
 * When a message arrives from an UNLINKED handle whose text contains an active
 * pairing code, we instantly link that handle to the code's person, wire it so
 * Pat engages + replies, consume the code (single-use), and confirm. This is the
 * primary (and, by default, only) self-serve linking path: it is the live
 * mechanism that replaced the channel-registration approval card — that card
 * code is left in the tree but is DISABLED at the ingress (see index.ts
 * `channelRegistrationCardsEnabled`). Pairing is checked as a pre-check at both
 * ingress seams ahead of any card.
 *
 * The actual matching/consumption lives in src/people/pairing.ts; the
 * link/wire/member machinery is the existing people-spine + permissions code
 * (linkHandle, createMessagingGroupAgent, addMember) — this module just
 * sequences them. See plans/pairing-handle-linking.md.
 *
 * Hot-path safe: every entry point is wrapped so a DB hiccup can never drop a
 * message — on any failure we return false and the caller falls through to its
 * normal drop path.
 */
import { getAllAgentGroups } from '../../db/agent-groups.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { createMessagingGroupAgent, getMessagingGroupAgents } from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import { consumePairingCode, matchPairingCodeInText } from '../../people/pairing.js';
import { getPerson, linkHandle } from '../../people/index.js';
import type { InboundEvent } from '../../channels/adapter.js';
import type { MessagingGroup } from '../../types.js';
import { addMember, hasMembershipRow } from './db/agent-group-members.js';

function safeText(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text : content;
  } catch {
    return content;
  }
}

/**
 * Ensure the messaging group is wired to an agent group AND the handle is a
 * member, so the replayed message wakes Pat. Returns the agent group id Pat will
 * engage on, or null if no agent group exists to wire to.
 *
 * - Already-wired channel: grant membership on the (first) wired agent group.
 * - Unwired channel (fresh DM): create a pattern='.' wiring to the primary
 *   agent group (mirrors the channel-registration "connect" defaults), then
 *   grant membership.
 */
function ensureWiredAndMember(mg: MessagingGroup, userId: string): string | null {
  const wired = getMessagingGroupAgents(mg.id);
  let agentGroupId: string;

  if (wired.length > 0) {
    agentGroupId = wired[0].agent_group_id;
  } else {
    // No wiring yet — connect to the primary agent group. PAT is a single-
    // agent install (palisade-internal); getAllAgentGroups()[0] is it.
    const groups = getAllAgentGroups();
    if (groups.length === 0) {
      log.warn('Pairing: no agent group to wire to — cannot complete pairing', { messagingGroupId: mg.id });
      return null;
    }
    agentGroupId = groups[0].id;
    const isGroup = mg.is_group !== 0;
    createMessagingGroupAgent({
      id: `mga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      messaging_group_id: mg.id,
      agent_group_id: agentGroupId,
      // Mirror channel-registration "connect" defaults: groups use mention-
      // sticky, DMs use pattern='.' so every message engages.
      engage_mode: isGroup ? 'mention-sticky' : 'pattern',
      engage_pattern: isGroup ? null : '.',
      sender_scope: 'known',
      ignored_message_policy: 'accumulate',
      session_mode: 'shared',
      priority: 0,
      created_at: new Date().toISOString(),
    });
    log.info('Pairing: wired messaging group to agent group', { messagingGroupId: mg.id, agentGroupId });
  }

  if (!hasMembershipRow(userId, agentGroupId)) {
    addMember({
      user_id: userId,
      agent_group_id: agentGroupId,
      added_by: null, // system grant — vouched-for via the pairing code
      added_at: new Date().toISOString(),
    });
  }
  return agentGroupId;
}

async function sendConfirmation(event: InboundEvent, person: { first_name: string }): Promise<void> {
  const adapter = getDeliveryAdapter();
  if (!adapter) return;
  try {
    await adapter.deliver(
      event.channelType,
      event.platformId,
      event.threadId,
      'chat',
      JSON.stringify({
        text: `✓ Paired — this handle is now linked to ${person.first_name}. You can talk to Pat here.`,
      }),
      undefined,
      event.instance,
    );
  } catch (err) {
    log.warn('Pairing: confirmation delivery failed', { err });
  }
}

/**
 * Attempt to pair an inbound message from an unlinked handle. The caller MUST
 * have already confirmed the handle is unlinked (getPersonByUser(userId) is
 * falsy) — we don't re-check here so a known handle's message is never
 * intercepted.
 *
 * On a hit: link → wire+member → consume → confirm → replay (so Pat engages).
 * Returns true when the message was consumed by pairing (caller stops its
 * normal card/drop handling); false otherwise.
 *
 * `replay` is injected (the router's routeInbound) to avoid an import cycle.
 */
export async function tryPairHandle(
  event: InboundEvent,
  userId: string,
  mg: MessagingGroup,
  replay: (event: InboundEvent) => Promise<void>,
): Promise<boolean> {
  try {
    const text = safeText(event.message.content);
    const match = matchPairingCodeInText(text);
    if (!match) return false;

    const person = getPerson(match.person_id);
    if (!person) {
      log.warn('Pairing: code matched but person missing — ignoring', { codeId: match.id });
      return false;
    }

    // Link the handle to the person FIRST (manual-equivalent, but method tags
    // the provenance). linkHandle upserts on user_id.
    linkHandle(userId, person.id, 'pairing');

    // Wire + grant membership so the replay actually engages Pat.
    const agentGroupId = ensureWiredAndMember(mg, userId);
    if (!agentGroupId) {
      // Couldn't wire (no agent group). The handle is still linked, but we
      // can't make Pat respond — fall through so the operator sees the normal
      // path. Don't consume the code (let them retry once an agent exists).
      return false;
    }

    // Consume (single-use). If we lost a race (already consumed), the link +
    // wiring already happened, so still treat it as paired.
    const consumed = consumePairingCode(match.id, userId);
    if (!consumed) {
      log.info('Pairing: code already consumed by a concurrent message — handle still linked', { codeId: match.id });
    }

    log.event({
      kind: 'people.paired',
      data: { user_id: userId, person_id: person.id, code_id: match.id, agent_group_id: agentGroupId },
    });
    log.info('Pairing: handle paired to person', { userId, personId: person.id, agentGroupId });

    // Confirm to the new handle, then replay so Pat processes the message that
    // carried the code (now that the handle is a member, the gate passes).
    await sendConfirmation(event, person);
    await replay(event);
    return true;
    // Intentional catch-all: pairing runs on the inbound hot path and must
    // never throw — any failure falls through to the normal card/drop path.
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (err) {
    log.warn('tryPairHandle failed', { userId, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}
