/**
 * PAT: conversation recall (Phase 2) — host-side read logic.
 *
 * Lets the agent (and operators) read a PERSON's prior conversations across
 * sessions and channels. The people spine (Phase 1) resolves a person to their
 * handles; this module turns those handles into conversations.
 *
 * Architecture (settled 2026-06-22, verified against real data):
 *   - The central DB is the CATALOG: person → handles → DM messaging_groups →
 *     sessions. It's the only place that knows who/what-channel/when. Group
 *     chats key their messaging_group on a chat id (not a user handle), so this
 *     naturally returns the person's 1:1 conversations.
 *   - The SDK transcript JSON (see transcript.ts) is the single CONTENT source —
 *     uniform across every channel, with full tool calls/params/results.
 *
 * Reads are always constrained to a caller-supplied agent_group_id when present
 * (an agent must not read another group's conversations).
 */
import { getDb } from '../db/connection.js';
import { getMessagingGroup } from '../db/messaging-groups.js';
import { getSession } from '../db/sessions.js';
import { getHandlesForPerson, getPersonByUser } from '../people/index.js';
import type { Session } from '../types.js';
import { parseTranscript, transcriptPath, type ToolDetail, type TranscriptMessage } from './transcript.js';

export interface ConversationSummary {
  session_id: string;
  agent_group_id: string;
  messaging_group_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  message_count: number;
  last_active: string | null;
  created_at: string;
  preview: string | null; // first line … last line (role-tagged)
}

export type ConversationMessage = TranscriptMessage;

const PREVIEW_LINE_MAX = 100;
const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_SEARCH_LIMIT = 30;
const SNIPPET_PAD = 80;
// Hard ceiling on a single fetch_conversation payload so a long thread can't
// blow the agent's context. ~40k tokens at ~4 chars/token. When exceeded we
// keep the most recent messages and flag truncated (the agent can narrow with
// first/last/role/tools).
const FETCH_MAX_CHARS = 160_000;

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n - 1) + '…' : flat;
}

/** Resolve the recall target to a set of handles (user_ids). */
function resolveHandles(opts: { personId?: string; userId?: string }): string[] {
  if (opts.personId) return getHandlesForPerson(opts.personId).map((h) => h.user_id);
  if (opts.userId) {
    const person = getPersonByUser(opts.userId);
    if (person) {
      const handles = getHandlesForPerson(person.id).map((h) => h.user_id);
      return handles.includes(opts.userId) ? handles : [...handles, opts.userId];
    }
    return [opts.userId];
  }
  return [];
}

/** Handles → candidate DM messaging_group ids (user_dms cache + (channel,platform) shape). */
function messagingGroupIdsForHandles(handles: string[]): string[] {
  if (handles.length === 0) return [];
  const db = getDb();
  const ids = new Set<string>();
  const ph = handles.map(() => '?').join(',');
  for (const r of db.prepare(`SELECT messaging_group_id FROM user_dms WHERE user_id IN (${ph})`).all(...handles) as {
    messaging_group_id: string;
  }[]) {
    ids.add(r.messaging_group_id);
  }
  for (const h of handles) {
    const idx = h.indexOf(':');
    if (idx < 0) continue;
    for (const r of db
      .prepare('SELECT id FROM messaging_groups WHERE channel_type = ? AND platform_id = ?')
      .all(h.slice(0, idx), h.slice(idx + 1)) as { id: string }[]) {
      ids.add(r.id);
    }
  }
  return [...ids];
}

/** Candidate sessions for a person, newest first, scoped + channel-filtered. */
function candidateSessions(opts: {
  personId?: string;
  userId?: string;
  agentGroupId?: string;
  channelType?: string;
  since?: string;
}): Session[] {
  const handles = resolveHandles(opts);
  if (handles.length === 0) return [];
  const mgIds = messagingGroupIdsForHandles(handles);
  if (mgIds.length === 0) return [];

  const params: unknown[] = [...mgIds];
  let sql = `SELECT * FROM sessions WHERE messaging_group_id IN (${mgIds.map(() => '?').join(',')})`;
  if (opts.agentGroupId) {
    sql += ' AND agent_group_id = ?';
    params.push(opts.agentGroupId);
  }
  sql += ' ORDER BY COALESCE(last_active, created_at) DESC';
  let sessions = getDb()
    .prepare(sql)
    .all(...params) as Session[];

  if (opts.channelType) {
    sessions = sessions.filter((s) => {
      const mg = s.messaging_group_id ? getMessagingGroup(s.messaging_group_id) : undefined;
      return mg?.channel_type === opts.channelType;
    });
  }
  if (opts.since) {
    sessions = sessions.filter((s) => (s.last_active ?? s.created_at) >= opts.since!);
  }
  return sessions;
}

/** List a person's conversations (one per session), newest first. Content
 *  (count + preview) comes from each session's transcript. */
export function listConversations(opts: {
  personId?: string;
  userId?: string;
  agentGroupId?: string;
  channelType?: string;
  since?: string;
  limit?: number;
}): ConversationSummary[] {
  const limit = Math.max(1, opts.limit ?? DEFAULT_LIST_LIMIT);
  const out: ConversationSummary[] = [];
  for (const s of candidateSessions(opts)) {
    if (out.length >= limit) break;
    const mg = s.messaging_group_id ? getMessagingGroup(s.messaging_group_id) : undefined;
    const tpath = transcriptPath(s.agent_group_id, s.id);
    const msgs = tpath ? parseTranscript(tpath, 'none') : [];
    if (msgs.length === 0) continue; // no real conversation on disk
    const first = msgs[0]!;
    const last = msgs[msgs.length - 1]!;
    const preview =
      msgs.length === 1
        ? `${first.role}: ${truncate(first.text, PREVIEW_LINE_MAX)}`
        : `${first.role}: ${truncate(first.text, PREVIEW_LINE_MAX)} … ${last.role}: ${truncate(last.text, PREVIEW_LINE_MAX)}`;
    out.push({
      session_id: s.id,
      agent_group_id: s.agent_group_id,
      messaging_group_id: s.messaging_group_id ?? null,
      channel_type: mg?.channel_type ?? null,
      thread_id: s.thread_id ?? null,
      message_count: msgs.length,
      last_active: last.timestamp ?? s.last_active ?? null,
      created_at: s.created_at,
      preview,
    });
  }
  return out;
}

/** Cap total payload size: keep the most recent messages, drop oldest when over
 *  FETCH_MAX_CHARS. Measures the serialized message (text + tool input/result). */
function capByChars(msgs: ConversationMessage[]): { messages: ConversationMessage[]; capped: boolean } {
  let total = 0;
  const kept: ConversationMessage[] = [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const size = JSON.stringify(msgs[i]).length;
    if (kept.length > 0 && total + size > FETCH_MAX_CHARS) break;
    total += size;
    kept.push(msgs[i]!);
  }
  kept.reverse();
  return { messages: kept, capped: kept.length < msgs.length };
}

/** Apply a head/tail window: first N and/or last M (deduped); neither → all. */
function windowMessages(
  msgs: ConversationMessage[],
  first?: number,
  last?: number,
): { messages: ConversationMessage[]; truncated: boolean } {
  if (first === undefined && last === undefined) return { messages: msgs, truncated: false };
  const head = first ? msgs.slice(0, first) : [];
  const tail = last ? msgs.slice(Math.max(first ?? 0, msgs.length - last)) : [];
  const merged = [...head, ...tail];
  return { messages: merged, truncated: merged.length < msgs.length };
}

/**
 * Fetch one conversation's messages from its transcript. `tools` controls
 * tool-call inclusion/verbosity ('none' | 'truncated' (default) | 'full');
 * `role` filters a side; `first`/`last` take a head/tail window (default: whole
 * conversation). Scoped to `agentGroupId` when provided.
 */
export function fetchConversation(opts: {
  sessionId: string;
  agentGroupId?: string;
  tools?: ToolDetail;
  role?: 'user' | 'agent';
  first?: number;
  last?: number;
}): {
  session: { id: string; channel_type: string | null; thread_id: string | null };
  messages: ConversationMessage[];
  truncated: boolean;
} {
  const session = getSession(opts.sessionId);
  if (!session) throw new Error(`session not found: ${opts.sessionId}`);
  if (opts.agentGroupId && session.agent_group_id !== opts.agentGroupId) {
    throw new Error(`session not found: ${opts.sessionId}`); // don't leak cross-group existence
  }
  const mg = session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined;
  const tpath = transcriptPath(session.agent_group_id, session.id);
  let msgs = tpath ? parseTranscript(tpath, opts.tools ?? 'truncated') : [];

  if (opts.role === 'user') msgs = msgs.filter((m) => m.role === 'user');
  else if (opts.role === 'agent') msgs = msgs.filter((m) => m.role !== 'user');

  const windowed = windowMessages(msgs, opts.first, opts.last);
  const capped = capByChars(windowed.messages);
  return {
    session: { id: session.id, channel_type: mg?.channel_type ?? null, thread_id: session.thread_id ?? null },
    messages: capped.messages,
    truncated: windowed.truncated || capped.capped,
  };
}

export interface SearchHit {
  session_id: string;
  channel_type: string | null;
  role: string;
  timestamp: string | null;
  snippet: string;
}

/**
 * Grep-style substring search across a person's conversation transcripts.
 * Case-insensitive. Returns matching chat messages with a snippet around the
 * hit. (Fuzzy ranking is backlogged — this is exact substring for now.)
 */
export function searchConversations(opts: {
  query: string;
  personId?: string;
  userId?: string;
  agentGroupId?: string;
  channelType?: string;
  since?: string;
  until?: string;
  limit?: number;
}): SearchHit[] {
  const q = opts.query?.trim().toLowerCase();
  if (!q) throw new Error('query is required');
  const limit = Math.max(1, opts.limit ?? DEFAULT_SEARCH_LIMIT);
  const hits: SearchHit[] = [];

  for (const s of candidateSessions(opts)) {
    if (hits.length >= limit) break;
    const tpath = transcriptPath(s.agent_group_id, s.id);
    if (!tpath) continue;
    const mg = s.messaging_group_id ? getMessagingGroup(s.messaging_group_id) : undefined;
    for (const m of parseTranscript(tpath, 'none')) {
      if (opts.until && m.timestamp && m.timestamp > opts.until) continue;
      const lc = m.text.toLowerCase();
      const at = lc.indexOf(q);
      if (at < 0) continue;
      const start = Math.max(0, at - SNIPPET_PAD);
      const end = Math.min(m.text.length, at + q.length + SNIPPET_PAD);
      const snippet =
        (start > 0 ? '…' : '') +
        m.text.slice(start, end).replace(/\s+/g, ' ').trim() +
        (end < m.text.length ? '…' : '');
      hits.push({
        session_id: s.id,
        channel_type: mg?.channel_type ?? null,
        role: m.role,
        timestamp: m.timestamp,
        snippet,
      });
      if (hits.length >= limit) break;
    }
  }
  return hits;
}
