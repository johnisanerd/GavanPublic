/**
 * PAT: conversation recall (Phase 2) — host read-logic tests. Builds the DB
 * catalog (people spine + sessions) AND real SDK-transcript .jsonl fixtures on
 * disk under a temp DATA_DIR, then exercises list / fetch / search.
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-conversations' };
});
const TEST_DATA_DIR = '/tmp/nanoclaw-test-conversations';

import { initTestDb, closeDb, runMigrations, getDb, createAgentGroup } from '../db/index.js';
import { createSession } from '../db/sessions.js';
import { createMessagingGroup } from '../db/messaging-groups.js';
import { ensureSchema } from '../db/session-db.js';
import { sessionDir, outboundDbPath } from '../session-manager.js';
import { createPerson, addIdentifier, linkHandle } from '../people/index.js';
import { listConversations, fetchConversation, searchConversations } from './index.js';

const now = () => new Date().toISOString();
const enc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function seedUser(id: string, kind: string): void {
  getDb().prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?,?,NULL,?)`).run(id, kind, now());
}
function makeMg(id: string, channelType: string, platformId: string): void {
  createMessagingGroup({
    id,
    channel_type: channelType,
    platform_id: platformId,
    name: null,
    is_group: 0,
    unknown_sender_policy: 'request_approval',
    denied_at: null,
    created_at: now(),
  });
}
function makeSession(id: string, ag: string, mgId: string, threadId: string | null): void {
  createSession({
    id,
    agent_group_id: ag,
    messaging_group_id: mgId,
    thread_id: threadId,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  });
}

// Transcript entry builders (Claude Code .jsonl shape).
const userMsg = (from: string, text: string, ts: string) => ({
  type: 'user',
  timestamp: ts,
  message: { role: 'user', content: `<message id="1" from="${from}" sender="x" time="${ts}">${enc(text)}</message>` },
});
const asstText = (text: string, ts: string) => ({
  type: 'assistant',
  timestamp: ts,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const toolUse = (name: string, input: unknown, id: string, ts: string) => ({
  type: 'assistant',
  timestamp: ts,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const toolResult = (id: string, result: string, ts: string) => ({
  type: 'user',
  timestamp: ts,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result }] },
});

/** Write the continuation pointer (outbound.db) + the transcript .jsonl. */
function writeTranscript(ag: string, sessionId: string, sdkId: string, entries: unknown[]): void {
  fs.mkdirSync(sessionDir(ag, sessionId), { recursive: true });
  const outP = outboundDbPath(ag, sessionId);
  ensureSchema(outP, 'outbound');
  const odb = new Database(outP);
  odb
    .prepare("INSERT INTO session_state (key, value, updated_at) VALUES ('continuation:claude', ?, ?)")
    .run(sdkId, now());
  odb.close();
  const dir = path.join(TEST_DATA_DIR, 'v2-sessions', ag, '.claude-shared', 'projects', '-workspace-agent');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sdkId}.jsonl`), entries.map((e) => JSON.stringify(e)).join('\n'));
}

const AG = 'ag-1';

describe('conversation recall', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    runMigrations(initTestDb());
    createAgentGroup({ id: AG, name: 'ag1', folder: 'ag1', agent_provider: null, created_at: now() });
  });
  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  function seedAdaSignal(): { personId: string } {
    const p = createPerson({ first_name: 'Ada', last_name: 'L' });
    addIdentifier({ person_id: p.id, kind: 'phone', value: '+15550100001' });
    seedUser('signal:+15550100001', 'signal');
    linkHandle('signal:+15550100001', p.id);
    makeMg('mg-sig', 'signal', '+15550100001');
    makeSession('sess-sig', AG, 'mg-sig', null);
    writeTranscript(AG, 'sess-sig', 'sdk-sig', [
      userMsg('signal:+15550100001', 'hey can you check my flight to SF', '2026-06-20T10:00:00Z'),
      toolUse('Read', { file_path: '/flights' }, 't1', '2026-06-20T10:00:30Z'),
      toolResult('t1', 'UA 482 departs 3:10pm, on time', '2026-06-20T10:00:31Z'),
      asstText('Your flight UA 482 is on time, boards 3:10pm.', '2026-06-20T10:01:00Z'),
      userMsg('signal:+15550100001', 'thanks!', '2026-06-20T10:05:00Z'),
    ]);
    return { personId: p.id };
  }

  it('lists conversations with count + first…last preview (tools excluded from count)', () => {
    const { personId } = seedAdaSignal();
    const list = listConversations({ personId });
    expect(list).toHaveLength(1);
    expect(list[0].session_id).toBe('sess-sig');
    expect(list[0].channel_type).toBe('signal');
    expect(list[0].message_count).toBe(3); // 2 user + 1 agent; tool row excluded
    expect(list[0].preview).toContain('check my flight');
    expect(list[0].preview).toContain('thanks!');
  });

  it('fetch default includes a generously-truncated tool row; tools=none drops it', () => {
    const { personId: _ } = seedAdaSignal();
    void _;
    const full = fetchConversation({ sessionId: 'sess-sig' }); // default tools=truncated
    const roles = full.messages.map((m) => m.role);
    expect(roles).toEqual(['user', 'tool', 'agent', 'user']);
    const toolMsg = full.messages.find((m) => m.role === 'tool')!;
    expect(toolMsg.tool!.name).toBe('Read');
    expect(toolMsg.tool!.result).toContain('UA 482');

    const noTools = fetchConversation({ sessionId: 'sess-sig', tools: 'none' });
    expect(noTools.messages.map((m) => m.role)).toEqual(['user', 'agent', 'user']);
  });

  it('fetch role + first/last windowing', () => {
    seedAdaSignal();
    const usersOnly = fetchConversation({ sessionId: 'sess-sig', role: 'user', tools: 'none' });
    expect(usersOnly.messages.map((m) => m.text)).toEqual(['hey can you check my flight to SF', 'thanks!']);

    const firstOne = fetchConversation({ sessionId: 'sess-sig', tools: 'none', first: 1 });
    expect(firstOne.messages).toHaveLength(1);
    expect(firstOne.truncated).toBe(true);
    expect(firstOne.messages[0].text).toContain('check my flight');
  });

  it('keeps ALL messages when one user turn batches several <message> blocks', () => {
    const p = createPerson({ first_name: 'Ada', last_name: 'L' });
    seedUser('signal:+15550100001', 'signal');
    linkHandle('signal:+15550100001', p.id);
    makeMg('mg-sig', 'signal', '+15550100001');
    makeSession('sess-sig', AG, 'mg-sig', null);
    // A single user turn whose content concatenates TWO message blocks (user
    // fired two messages before the agent replied). Both must survive.
    const h = 'signal:+15550100001';
    const batched =
      `<message id="1" from="${h}" sender="x" time="t1">${enc('first message')}</message>` +
      `<message id="2" from="${h}" sender="x" time="t2">${enc('second message')}</message>`;
    writeTranscript(AG, 'sess-sig', 'sdk-sig', [
      { type: 'user', timestamp: '2026-06-20T10:00:00Z', message: { role: 'user', content: batched } },
    ]);
    const conv = fetchConversation({ sessionId: 'sess-sig', tools: 'none' });
    expect(conv.messages.map((m) => m.text)).toEqual(['first message', 'second message']);
  });

  it('search finds substring hits with snippets, scoped to the person', () => {
    const { personId } = seedAdaSignal();
    const hits = searchConversations({ personId, query: 'flight' });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].session_id).toBe('sess-sig');
    expect(hits[0].snippet.toLowerCase()).toContain('flight');
    expect(searchConversations({ personId, query: 'nonexistent-zzz' })).toHaveLength(0);
  });

  it('resolves a person from a single handle and spans their channels', () => {
    const p = createPerson({ first_name: 'Ada', last_name: 'L' });
    addIdentifier({ person_id: p.id, kind: 'phone', value: '+15550100001' });
    for (const [uid, kind, mg, ch] of [
      ['signal:+15550100001', 'signal', 'mg-sig', 'signal'],
      ['pstn:+15550100001', 'pstn', 'mg-pstn', 'pstn'],
    ] as const) {
      seedUser(uid, kind);
      linkHandle(uid, p.id);
      makeMg(mg, ch, '+15550100001');
    }
    makeSession('sess-sig', AG, 'mg-sig', null);
    makeSession('sess-pstn', AG, 'mg-pstn', 'call-1');
    writeTranscript(AG, 'sess-sig', 'sdk-sig', [
      userMsg('signal:+15550100001', 'hi on signal', '2026-06-20T10:00:00Z'),
    ]);
    writeTranscript(AG, 'sess-pstn', 'sdk-pstn', [userMsg('pstn:+15550100001', 'hi on phone', '2026-06-21T10:00:00Z')]);

    const list = listConversations({ userId: 'pstn:+15550100001' });
    expect(list.map((c) => c.channel_type).sort()).toEqual(['pstn', 'signal']);
  });

  it('scopes reads to agentGroupId (no cross-group leakage)', () => {
    const { personId } = seedAdaSignal();
    expect(listConversations({ personId, agentGroupId: AG })).toHaveLength(1);
    expect(listConversations({ personId, agentGroupId: 'ag-OTHER' })).toHaveLength(0);
    expect(() => fetchConversation({ sessionId: 'sess-sig', agentGroupId: 'ag-OTHER' })).toThrow(/not found/);
  });

  it('returns empty for an unknown person', () => {
    expect(listConversations({ personId: 'person-nope' })).toHaveLength(0);
  });
});
