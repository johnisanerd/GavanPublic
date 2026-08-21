/**
 * PAT: SDK-transcript reader for conversation recall (Phase 2).
 *
 * The Claude Code session transcript (<sdk_session_id>.jsonl) is the single
 * content source for recall — uniform across all channels, with native
 * tool_use/tool_result (full params + untruncated results). The central DB is
 * only the catalog (which sessions a person has); this module turns one session
 * into its actual messages.
 *
 * Mapping (verified against real data): a nanoclaw session's outbound.db has
 * session_state.continuation = 'claude|<sdk_session_id>', and the transcript
 * lives under <DATA_DIR>/v2-sessions/<agent_group>/.claude-shared/projects/<dir>/ as
 * <sdk_session_id>.jsonl.
 *
 * Caveat: continuation points at the LIVE transcript; compaction rotates
 * older ones out, so a very long session can span multiple files. We read the
 * live one; archive-stitching is a follow-on.
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR } from '../config.js';
import { outboundDbPath } from '../session-manager.js';

export type ToolDetail = 'none' | 'truncated' | 'full';

export interface TranscriptMessage {
  role: 'user' | 'agent' | 'tool';
  sender: string | null; // user turns: the from/sender attribute
  timestamp: string | null;
  text: string;
  /** Present on role==='tool' rows. */
  tool?: { name: string; input?: unknown; result?: string; truncated?: boolean };
}

// "Generous" per-item truncation: only trim a single tool input/result when
// it's genuinely large, so most tool I/O comes through whole.
const TRUNCATE_AT = 2000;

function truncateText(s: string): { text: string; truncated: boolean } {
  if (s.length <= TRUNCATE_AT) return { text: s, truncated: false };
  return { text: s.slice(0, TRUNCATE_AT) + `\n...[+${s.length - TRUNCATE_AT} chars]`, truncated: true };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Read the session's continuation pointer -> sdk_session_id, or null. */
export function continuationSdkId(agentGroupId: string, sessionId: string): string | null {
  const p = outboundDbPath(agentGroupId, sessionId);
  if (!fs.existsSync(p)) return null;
  const db = new Database(p, { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 3000');
  try {
    // The container stores the resume id under a provider-suffixed key, e.g.
    // `continuation:claude`, with the bare sdk_session_id as the value.
    const row = db
      .prepare("SELECT value FROM session_state WHERE key LIKE 'continuation:%' ORDER BY updated_at DESC LIMIT 1")
      .get() as { value: string } | undefined;
    return row?.value || null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** Resolve the transcript .jsonl path for a session, or null if not found. */
export function transcriptPath(agentGroupId: string, sessionId: string): string | null {
  const sdkId = continuationSdkId(agentGroupId, sessionId);
  if (!sdkId) return null;
  const projects = path.join(DATA_DIR, 'v2-sessions', agentGroupId, '.claude-shared', 'projects');
  if (!fs.existsSync(projects)) return null;
  for (const dir of fs.readdirSync(projects)) {
    const candidate = path.join(projects, dir, `${sdkId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

interface RawEntry {
  type?: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
}

// Extract the human-facing messages from a user-turn string. Inbound user turns
// are wrapped in message elements carrying from/sender/time attributes
// (entity-encoded body). A SINGLE turn can batch SEVERAL <message> blocks (the
// formatter concatenates them when a user fires multiple messages before the
// agent replies), so we return ALL of them — not just the first. Pure system
// injections (a self-closing context tag) are dropped.
function parseUserMessages(raw: string): Array<{ text: string; sender: string | null }> {
  const out: Array<{ text: string; sender: string | null }> = [];
  const re = /<message\b([^>]*)>([\s\S]*?)<\/message>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const attrs = m[1] ?? '';
    const from = attrs.match(/\bfrom="([^"]*)"/)?.[1] ?? null;
    const sender = attrs.match(/\bsender="([^"]*)"/)?.[1] ?? null;
    const text = decodeEntities(m[2] ?? '').trim();
    if (text) out.push({ text, sender: from ?? sender });
  }
  if (out.length > 0) return out;
  // No <message> wrapper: drop pure system framing, else treat as raw text.
  const stripped = raw.replace(/<context\b[^>]*\/>/g, '').trim();
  if (!stripped || stripped.startsWith('<')) return [];
  return [{ text: decodeEntities(stripped), sender: null }];
}

/**
 * Parse a transcript file into ordered messages. tools controls whether (and
 * how verbosely) tool calls/results are included; thinking blocks are always
 * dropped (internal). Tool results are paired to their call by tool_use_id.
 */
export function parseTranscript(filePath: string, tools: ToolDetail): TranscriptMessage[] {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const out: TranscriptMessage[] = [];
  // tool_use id -> index in out, so a later tool_result can fill the result.
  const toolIndexById = new Map<string, number>();

  for (const line of lines) {
    if (!line.trim()) continue;
    let e: RawEntry;
    try {
      e = JSON.parse(line) as RawEntry;
    } catch {
      continue;
    }
    const ts = e.timestamp ?? null;
    const content = e.message?.content;

    if (e.type === 'user') {
      if (typeof content === 'string') {
        for (const msg of parseUserMessages(content)) {
          out.push({ role: 'user', sender: msg.sender, timestamp: ts, text: msg.text });
        }
      } else if (Array.isArray(content)) {
        for (const item of content as Array<Record<string, unknown>>) {
          if (item.type === 'tool_result' && tools !== 'none') {
            const id = item.tool_use_id as string | undefined;
            if (!id) continue;
            const idx = toolIndexById.get(id);
            if (idx === undefined) continue;
            const resultStr = typeof item.content === 'string' ? item.content : JSON.stringify(item.content);
            const t = tools === 'full' ? { text: resultStr, truncated: false } : truncateText(resultStr);
            out[idx]!.tool!.result = t.text;
            out[idx]!.tool!.truncated = t.truncated;
          }
          // type==='text' in a user array is a skill/system injection — skip.
        }
      }
    } else if (e.type === 'assistant' && Array.isArray(content)) {
      for (const item of content as Array<Record<string, unknown>>) {
        if (item.type === 'text' && typeof item.text === 'string') {
          const text = item.text.trim();
          if (text) out.push({ role: 'agent', sender: null, timestamp: ts, text });
        } else if (item.type === 'tool_use' && tools !== 'none') {
          const id = item.id as string | undefined;
          const name = (item.name as string) ?? 'tool';
          let inputStr: string | undefined;
          if (item.input !== undefined) {
            const raw = typeof item.input === 'string' ? item.input : JSON.stringify(item.input);
            inputStr = tools === 'full' ? raw : truncateText(raw).text;
          }
          out.push({ role: 'tool', sender: null, timestamp: ts, text: `-> ${name}`, tool: { name, input: inputStr } });
          if (id) toolIndexById.set(id, out.length - 1);
        }
        // type==='thinking' -> internal, skip.
      }
    }
    // attachment / queue-operation / ai-title -> skip.
  }
  return out;
}
