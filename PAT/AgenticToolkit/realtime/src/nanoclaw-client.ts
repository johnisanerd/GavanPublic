/**
 * NanoClaw integration surface — the only file in `realtime/` that knows
 * about NanoClaw's storage layout, schemas, or row conventions.
 *
 * The rest of the realtime library imports only from here. When NanoClaw
 * upstream changes a schema or moves a path, this module changes; the rest
 * of the library doesn't notice. Per the design doc §"Localization without
 * heavy abstraction" — concrete client first, factor the interface into a
 * clean abstraction post-hoc once usage patterns are real.
 */
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import Database, { type Database as DB } from 'better-sqlite3';

/**
 * Resolves to NanoClaw's data root. Default matches the upstream layout
 * (sessions live under `<root>/data/v2-sessions/<agent_group_id>/<session_id>/`).
 *
 * Override with NANOCLAW_DATA_ROOT for non-default installs (e.g. the spike
 * deployment where realtime/ runs alongside a sibling NanoClaw clone).
 */
function nanoclawDataRoot(): string {
  return process.env.NANOCLAW_DATA_ROOT ?? path.resolve(process.cwd(), '../nanoclaw/data');
}

export interface SessionLocator {
  agentGroupId: string;
  sessionId: string;
}

function inboundDbPath(loc: SessionLocator): string {
  return path.join(nanoclawDataRoot(), 'v2-sessions', loc.agentGroupId, loc.sessionId, 'inbound.db');
}

function outboundDbPath(loc: SessionLocator): string {
  return path.join(nanoclawDataRoot(), 'v2-sessions', loc.agentGroupId, loc.sessionId, 'outbound.db');
}

/**
 * Open `inbound.db` for writing. Caller closes.
 *
 * NanoClaw enforces `journal_mode=DELETE` on session DBs — load-bearing for
 * cross-mount visibility (host writes here, container reads). The pragma is
 * sticky on the file, so we don't need to set it.
 */
export function openInbound(loc: SessionLocator): DB {
  return new Database(inboundDbPath(loc));
}

/** Open `outbound.db` for reading only. Caller closes. */
export function openOutboundReadOnly(loc: SessionLocator): DB {
  return new Database(outboundDbPath(loc), { readonly: true, fileMustExist: true });
}

// ───────────────────────── Inbound writes ─────────────────────────

export type RealtimeSender = 'realtime-agent' | 'realtime-user';

interface WriteInboundParams {
  /** 'banter' (no wake) or 'chat' (wakes container if idle). Per design doc invariant. */
  kind: 'banter' | 'chat';
  text: string;
  sender: RealtimeSender;
  /** Channel routing — 'realtime' channel type, 'local' platform id for spike. */
  channelType?: string;
  platformId?: string;
  threadId?: string | null;
}

/**
 * Write a row into `messages_in`.
 *
 * `trigger` is set 1 for chat (wake), 0 for banter (don't wake) — matches
 * the design doc invariant (banter ⟺ trigger=0, chat ⟺ trigger=1).
 *
 * `seq` is left null on insert and auto-assigned by the row's INSERT trigger
 * (host-side seq is even; agent-runner reads from messages_in by id, not seq).
 */
export function writeInbound(loc: SessionLocator, params: WriteInboundParams): string {
  const id = `realtime-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const content = JSON.stringify({ text: params.text, sender: params.sender });
  const trigger = params.kind === 'chat' ? 1 : 0;
  const db = openInbound(loc);
  try {
    db.prepare(
      `INSERT INTO messages_in (id, kind, content, channel_type, platform_id, thread_id, timestamp, trigger)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)`,
    ).run(
      id,
      params.kind,
      content,
      params.channelType ?? 'realtime',
      params.platformId ?? 'local',
      params.threadId ?? null,
      trigger,
    );
  } finally {
    db.close();
  }
  return id;
}

// ───────────────────────── Outbound reads (detail tail) ─────────────────────────

export type DetailContent =
  | { type: 'tool-pre'; tool: string; input: Record<string, unknown>; toolUseId?: string }
  | { type: 'tool-post'; tool: string; result: unknown; toolUseId?: string }
  | { type: 'tool-failed'; tool: string; error: string; toolUseId?: string }
  | { type: 'token-delta'; text: string }
  | { type: 'compact'; sessionId: string };

export interface DetailRow {
  seq: number;
  timestamp: string;
  content: DetailContent;
}

/**
 * Tail-read detail rows from a session's outbound.db, returning rows with
 * `seq > afterSeq` ordered by seq ascending.
 *
 * The realtime library tracks its own watermark per session — independent of
 * NanoClaw's host delivery polling, which marks delivered rows in inbound.db
 * but never mutates the rows themselves.
 */
export function readDetailRowsAfter(loc: SessionLocator, afterSeq: number): DetailRow[] {
  const db = openOutboundReadOnly(loc);
  try {
    const rows = db
      .prepare(
        `SELECT seq, timestamp, content
         FROM messages_out
         WHERE kind = 'detail' AND seq > ?
         ORDER BY seq ASC`,
      )
      .all(afterSeq) as Array<{ seq: number; timestamp: string; content: string }>;
    return rows.map((r) => ({
      seq: r.seq,
      timestamp: r.timestamp,
      content: JSON.parse(r.content) as DetailContent,
    }));
  } finally {
    db.close();
  }
}

/** Discover the highest seq across all rows in outbound.db (for watermark init). */
export function maxOutboundSeq(loc: SessionLocator): number {
  const db = openOutboundReadOnly(loc);
  try {
    const row = db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_out').get() as
      | { m: number }
      | undefined;
    return row?.m ?? 0;
  } finally {
    db.close();
  }
}
