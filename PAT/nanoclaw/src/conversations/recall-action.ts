/**
 * PAT: host-side delivery action for conversation recall (Phase 2).
 *
 * The container's `list_conversations` / `fetch_conversation` MCP tools write a
 * `recall_request` system row to outbound.db; the delivery poll routes it here.
 * We run the host-side read logic and write the result back to inbound.db
 * (trigger=0, so it doesn't wake the agent — it's an inline tool reply the tool
 * polls for). Mirrors src/cli/delivery-action.ts (the `cli_request` bridge),
 * but as a dedicated action so it sidesteps the ncl group-scope whitelist (a
 * group-scoped agent can't reach the `conversations` ncl resource).
 *
 * Always scoped to the caller session's agent_group_id — an agent cannot read
 * another group's conversations.
 */
import { registerDeliveryAction } from '../delivery.js';
import { insertMessage } from '../db/session-db.js';
import { getMessagingGroup } from '../db/messaging-groups.js';
import { log } from '../log.js';
import { listConversations, fetchConversation, searchConversations } from './index.js';
import type { ToolDetail } from './transcript.js';
import type { ResponseFrame } from '../cli/frame.js';

/** Derive the current caller's handle from the session's DM messaging group,
 *  so `list_conversations` with no args means "this person's conversations". */
function currentHandle(messagingGroupId: string | null): string | undefined {
  if (!messagingGroupId) return undefined;
  const mg = getMessagingGroup(messagingGroupId);
  if (!mg || mg.is_group) return undefined; // group chat → no single person
  return `${mg.channel_type}:${mg.platform_id}`;
}

registerDeliveryAction('recall_request', async (content, session, inDb) => {
  const requestId = content.requestId as string;
  const op = content.op as string;
  const args = (content.args as Record<string, unknown>) ?? {};
  if (!requestId || !op) {
    log.warn('recall_request missing requestId or op', { sessionId: session.id });
    return;
  }

  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const numOf = (v: unknown): number | undefined => (v === undefined ? undefined : Number(v));
  // Default the recall target to the current person (resolved from this chat).
  const defaultUser = (): string | undefined =>
    str(args.person_id) || str(args.user_id) ? undefined : currentHandle(session.messaging_group_id);

  let frame: ResponseFrame;
  try {
    let data: unknown;
    if (op === 'list') {
      data = listConversations({
        personId: str(args.person_id),
        userId: str(args.user_id) ?? defaultUser(),
        agentGroupId: session.agent_group_id,
        channelType: str(args.channel_type),
        since: str(args.since),
        limit: numOf(args.limit),
      });
    } else if (op === 'fetch') {
      const sessionId = str(args.session_id);
      if (!sessionId) throw new Error('session_id is required');
      const role = str(args.role);
      if (role && role !== 'user' && role !== 'agent') throw new Error("role must be 'user' or 'agent'");
      const tools = str(args.tools);
      if (tools && tools !== 'none' && tools !== 'truncated' && tools !== 'full')
        throw new Error("tools must be 'none', 'truncated', or 'full'");
      data = fetchConversation({
        sessionId,
        agentGroupId: session.agent_group_id,
        tools: tools as ToolDetail | undefined,
        role: role as 'user' | 'agent' | undefined,
        first: numOf(args.first),
        last: numOf(args.last),
      });
    } else if (op === 'search') {
      const query = str(args.query);
      if (!query) throw new Error('query is required');
      data = searchConversations({
        query,
        personId: str(args.person_id),
        userId: str(args.user_id) ?? defaultUser(),
        agentGroupId: session.agent_group_id,
        channelType: str(args.channel_type),
        since: str(args.since),
        until: str(args.until),
        limit: numOf(args.limit),
      });
    } else {
      throw new Error(`unknown recall op: ${op}`);
    }
    frame = { id: requestId, ok: true, data };
  } catch (e) {
    frame = {
      id: requestId,
      ok: false,
      error: { code: 'handler-error', message: e instanceof Error ? e.message : String(e) },
    };
  }

  insertMessage(inDb, {
    id: `recall-resp-${requestId}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    platformId: null,
    channelType: null,
    threadId: null,
    content: JSON.stringify({ type: 'recall_response', requestId, frame }),
    processAfter: null,
    recurrence: null,
    trigger: 0,
  });

  log.info('recall response written', { requestId, op, ok: frame.ok, sessionId: session.id });
});
