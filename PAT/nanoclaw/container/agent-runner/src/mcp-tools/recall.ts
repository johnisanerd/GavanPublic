/**
 * PAT: conversation-recall MCP tools (Phase 2) — `list_conversations` and
 * `fetch_conversation`.
 *
 * These are READ tools that must return data to the agent, so unlike the
 * fire-and-forget `send_voice_memo` they BLOCK: write a `recall_request` system
 * row to outbound.db, then poll inbound.db for the host's `recall_response`
 * (same mechanism as the container `ncl` client). The host handler lives in
 * nanoclaw/src/conversations/recall-action.ts and is scoped to this session's
 * agent group, so the agent can only read its own group's conversations.
 *
 * Why MCP tools (not `ncl conversations`): palisade-internal runs at
 * cli_scope:'group', which whitelist-blocks non-core ncl resources. MCP tools
 * are globally available, so this is the right agent surface.
 */
import { Database } from 'bun:sqlite';

import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const INBOUND_DB = '/workspace/inbound.db';
const OUTBOUND_DB = '/workspace/outbound.db';
const TIMEOUT_MS = 30_000;

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `recall-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}
function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

type ResponseFrame =
  | { id: string; ok: true; data: unknown }
  | { id: string; ok: false; error: { code: string; message: string } };

/** Poll inbound.db for the recall_response matching requestId. Fresh connection
 *  per poll (mmap_size=0) for cross-mount visibility, like the ncl client. */
function pollResponse(requestId: string): ResponseFrame | null {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const inDb = new Database(INBOUND_DB, { readonly: true });
    inDb.exec('PRAGMA busy_timeout = 5000');
    inDb.exec('PRAGMA mmap_size = 0');
    try {
      const row = inDb
        .prepare("SELECT id, content FROM messages_in WHERE status = 'pending' AND content LIKE ?")
        .get(`%"requestId":"${requestId}"%`) as { id: string; content: string } | null;
      if (row) {
        // Mark completed via processing_ack so the agent-runner poll skips it.
        const outDb = new Database(OUTBOUND_DB);
        outDb.exec('PRAGMA journal_mode = DELETE');
        outDb.exec('PRAGMA busy_timeout = 5000');
        outDb
          .prepare(
            "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'completed', datetime('now'))",
          )
          .run(row.id);
        outDb.close();
        return JSON.parse(row.content).frame as ResponseFrame;
      }
    } finally {
      inDb.close();
    }
    Bun.sleepSync(400);
  }
  return null;
}

/** Round-trip a recall request to the host and return the result JSON string. */
function recall(op: 'list' | 'fetch' | 'search', args: Record<string, unknown>) {
  const requestId = generateId();
  writeMessageOut({
    id: requestId,
    kind: 'system',
    content: JSON.stringify({ action: 'recall_request', requestId, op, args }),
  });
  log(`recall ${op}: ${requestId} ${JSON.stringify(args)}`);
  const resp = pollResponse(requestId);
  if (!resp) return err('recall timed out after 30s');
  if (!resp.ok) return err(resp.error.message);
  return ok(JSON.stringify(resp.data, null, 2));
}

export const listConversations: McpToolDefinition = {
  tool: {
    name: 'list_conversations',
    description:
      "List a person's prior conversations across channels (phone, Signal, Telegram, …), newest first. " +
      'Use this to recall earlier context with the person you are talking to — e.g. "what did we discuss last time", ' +
      'or before answering something that references the past. ' +
      "With no arguments it lists the CURRENT person's conversations (resolved from this chat). " +
      'Each entry has a session_id (pass it to fetch_conversation), channel, thread, message_count, last_active, and a preview. ' +
      'This returns metadata only — call fetch_conversation to read the actual messages.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        person_id: {
          type: 'string',
          description: 'Optional. A specific person id (from the people spine). Defaults to the current person.',
        },
        user_id: {
          type: 'string',
          description:
            'Optional. A handle like `signal:+1555…` — resolves to its person and lists all their conversations.',
        },
        channel: { type: 'string', description: 'Optional channel filter (e.g. `signal`, `pstn`, `telegram`).' },
        since: { type: 'string', description: 'Optional ISO-8601 lower bound on activity.' },
        limit: { type: 'number', description: 'Optional max conversations to return (default 50).' },
      },
    },
  },
  async handler(args) {
    return recall('list', {
      person_id: args.person_id,
      user_id: args.user_id,
      channel_type: args.channel,
      since: args.since,
      limit: args.limit,
    });
  },
};

export const fetchConversation: McpToolDefinition = {
  tool: {
    name: 'fetch_conversation',
    description:
      'Fetch ONE prior conversation (from list_conversations), user + agent turns in time order. ' +
      'PREFER fetching the whole conversation — do not paginate. To manage size, lean on `tools` and `role` rather than cutting it short. ' +
      'By default returns the full conversation with tool calls included but generously truncated. ' +
      'Use `first`/`last` only when you genuinely just want the opening or the ending.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        session_id: { type: 'string', description: 'The conversation id (session_id) from list_conversations.' },
        tools: {
          type: 'string',
          enum: ['none', 'truncated', 'full'],
          description:
            "How to include tool activity. 'none' = chat only; 'truncated' (default) = tool calls + results, both trimmed only when very large; 'full' = untruncated params + results.",
        },
        role: { type: 'string', enum: ['user', 'agent'], description: "Optional: only one side ('user' or 'agent')." },
        first: { type: 'number', description: 'Optional: only the first N messages.' },
        last: { type: 'number', description: 'Optional: only the last N messages.' },
      },
      required: ['session_id'],
    },
  },
  async handler(args) {
    if (!args.session_id) return err('session_id is required');
    return recall('fetch', {
      session_id: args.session_id,
      tools: args.tools,
      role: args.role,
      first: args.first,
      last: args.last,
    });
  },
};

export const searchConversations: McpToolDefinition = {
  tool: {
    name: 'search_conversations',
    description:
      "Substring-search a person's past conversations for a phrase (case-insensitive), across all their channels. " +
      'Returns matching messages with a session_id + snippet — use list_conversations/fetch_conversation to read more around a hit. ' +
      'Use this to find where something specific was discussed instead of fetching whole conversations to scan them.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'The phrase to search for (substring, case-insensitive).' },
        channel: { type: 'string', description: 'Optional channel filter (e.g. `signal`, `pstn`).' },
        since: { type: 'string', description: 'Optional ISO-8601 lower bound.' },
        until: { type: 'string', description: 'Optional ISO-8601 upper bound.' },
        limit: { type: 'number', description: 'Optional max hits (default 30).' },
      },
      required: ['query'],
    },
  },
  async handler(args) {
    if (!args.query) return err('query is required');
    return recall('search', {
      query: args.query,
      channel_type: args.channel,
      since: args.since,
      until: args.until,
      limit: args.limit,
    });
  },
};

registerTools([listConversations, fetchConversation, searchConversations]);
