/**
 * PAT: `ncl conversations` — operator/test surface for conversation recall
 * (Phase 2). Reads only, all `open`. This is the HOST/operator surface (reach
 * it via the socket or POST /admin/ncl); the AGENT reaches recall through the
 * `list_conversations` / `fetch_conversation` MCP tools instead, because
 * group-scoped agents are blocked from non-whitelisted ncl resources.
 *
 * Virtual resource — there's no `conversations` table; all logic lives in
 * src/conversations/ and reads the per-session message-bus DBs.
 */
import { listConversations, fetchConversation, searchConversations } from '../../conversations/index.js';
import type { ToolDetail } from '../../conversations/transcript.js';
import { registerResource } from '../crud.js';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const num = (v: unknown): number | undefined => (v === undefined ? undefined : Number(v));

registerResource({
  name: 'conversation',
  plural: 'conversations',
  table: 'sessions', // unused — no generic ops registered
  description:
    'Conversation recall — a person’s prior conversations (one per session) across channels, read from the per-session message DBs. Reads only.',
  idColumn: 'session_id',
  columns: [
    { name: 'session_id', type: 'string', description: 'Session id (the conversation id).' },
    { name: 'channel_type', type: 'string', description: 'Channel.' },
    { name: 'thread_id', type: 'string', description: 'Thread within the channel.' },
    { name: 'message_count', type: 'number', description: 'User turns attributed to the person.' },
    { name: 'last_active', type: 'string', description: 'Last activity timestamp.' },
    { name: 'preview', type: 'string', description: 'First user line.' },
  ],
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      description:
        'List a person’s conversations (newest first). ncl conversations list (--person-id P | --user-id signal:+1555) [--channel-type signal] [--since ISO] [--limit N]',
      handler: async (args) => {
        const personId = str(args.person_id);
        const userId = str(args.user_id);
        if (!personId && !userId) throw new Error('provide --person-id or --user-id');
        return listConversations({
          personId,
          userId,
          channelType: str(args.channel_type),
          since: str(args.since),
          limit: num(args.limit),
        });
      },
    },
    get: {
      access: 'open',
      description:
        'Fetch one conversation from its transcript. ncl conversations get --id <session_id> [--tools none|truncated|full] [--role user|agent] [--first N] [--last N]',
      handler: async (args) => {
        const sessionId = str(args.id) ?? str(args.session_id);
        if (!sessionId) throw new Error('--id (session id) is required');
        const role = str(args.role);
        if (role && role !== 'user' && role !== 'agent') throw new Error("--role must be 'user' or 'agent'");
        const tools = str(args.tools);
        if (tools && tools !== 'none' && tools !== 'truncated' && tools !== 'full')
          throw new Error("--tools must be 'none', 'truncated', or 'full'");
        return fetchConversation({
          sessionId,
          tools: tools as ToolDetail | undefined,
          role: role as 'user' | 'agent' | undefined,
          first: num(args.first),
          last: num(args.last),
        });
      },
    },
    search: {
      access: 'open',
      description:
        'Grep-style substring search across a person’s conversations. ncl conversations search --query "flight" (--person-id P | --user-id signal:+1555) [--channel-type signal] [--since ISO] [--until ISO] [--limit N]',
      handler: async (args) => {
        const query = str(args.query);
        if (!query) throw new Error('--query is required');
        const personId = str(args.person_id);
        const userId = str(args.user_id);
        if (!personId && !userId) throw new Error('provide --person-id or --user-id');
        return searchConversations({
          query,
          personId,
          userId,
          channelType: str(args.channel_type),
          since: str(args.since),
          until: str(args.until),
          limit: num(args.limit),
        });
      },
    },
  },
});
