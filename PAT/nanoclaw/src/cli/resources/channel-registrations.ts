// PAT: ncl channel-registrations — list + approve/reject pending channel-
// registration cards programmatically. Normally an unknown chat that addresses
// the bot raises a card that only resolves when an approver CLICKS it in their
// channel. This resource exposes the same resolution over the ncl socket + the
// /admin/ncl bridge, so an operator (or an agent) can fetch open registrations
// and approve them without the card click. Wraps handleChannelApprovalResponse
// (the exact code path a click runs), authorizing as the card's own approver.
import {
  getPendingChannelApproval,
  type PendingChannelApproval,
} from '../../modules/permissions/db/pending-channel-approvals.js';
import { handleChannelApprovalResponse } from '../../modules/permissions/index.js';
import { registerResource } from '../crud.js';

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`--${name} is required`);
  return v;
};

// Mirror an approver clicking a card button. We authorize AS the card's intended
// approver (its stored user_id), so the handler's auth check passes with no
// special bypass — host callers (operators / the bridge) resolve on their behalf.
function buildPayload(row: PendingChannelApproval, value: string) {
  const approver = row.approver_user_id; // e.g. "slack:<slack-user>"
  const ci = approver.indexOf(':');
  return {
    questionId: row.messaging_group_id,
    value,
    userId: approver,
    channelType: ci >= 0 ? approver.slice(0, ci) : 'cli',
    platformId: ci >= 0 ? approver.slice(ci + 1) : approver,
    threadId: null,
  };
}

registerResource({
  name: 'channel-registration',
  plural: 'channel-registrations',
  table: 'pending_channel_approvals',
  description:
    'Pending channel-registration cards — an unknown chat addressed the bot and is waiting to be wired to an agent. Normally resolved by an approver clicking the card; this lets you list open registrations and approve/reject them directly (manual or agentic). approve wires the chat to the agent + replays the original message.',
  idColumn: 'messaging_group_id',
  columns: [
    { name: 'messaging_group_id', type: 'string', description: 'The chat (messaging group) awaiting registration.' },
    { name: 'agent_group_id', type: 'string', description: 'The agent the card suggests connecting to.' },
    { name: 'approver_user_id', type: 'string', description: 'Who the card was routed to.' },
    { name: 'title', type: 'string', description: 'Card title.' },
    { name: 'options_json', type: 'json', description: 'Card button options.' },
    { name: 'original_message', type: 'json', description: 'The original inbound, replayed on approve.' },
    { name: 'created_at', type: 'string', description: 'Auto-set.' },
  ],
  operations: { list: 'open', get: 'open' },
  customOperations: {
    approve: {
      access: 'approval',
      description:
        'Approve a pending registration: wire the chat to an agent + replay the message. ncl channel-registrations approve --messaging-group-id mg-... [--agent-group-id ag-...]',
      handler: async (args) => {
        const mgId = str(args.messaging_group_id, 'messaging-group-id');
        const row = getPendingChannelApproval(mgId);
        if (!row) throw new Error(`no pending registration for messaging group ${mgId}`);
        const agId = (args.agent_group_id as string | undefined) || row.agent_group_id;
        const ok = await handleChannelApprovalResponse(buildPayload(row, `connect:${agId}`));
        return { approved: ok, messaging_group_id: mgId, agent_group_id: agId };
      },
    },
    reject: {
      access: 'approval',
      description: 'Reject a pending registration. ncl channel-registrations reject --messaging-group-id mg-...',
      handler: async (args) => {
        const mgId = str(args.messaging_group_id, 'messaging-group-id');
        const row = getPendingChannelApproval(mgId);
        if (!row) throw new Error(`no pending registration for messaging group ${mgId}`);
        const ok = await handleChannelApprovalResponse(buildPayload(row, 'reject'));
        return { rejected: ok, messaging_group_id: mgId };
      },
    },
  },
});
