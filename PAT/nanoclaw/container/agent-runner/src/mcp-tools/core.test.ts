// Merged on upgrade to v2.1.19: this file unions two independent suites that
// both exercise sendMessage —
//   1) PAT: cold-contact fall-through (namespaced platform-ids dispatch as a
//      regular chat row straight to messages_out). Guards the PAT cold-contact
//      feature in core.ts (tryColdContactParse).
//   2) upstream: per-batch in_reply_to plumbing for a2a return-path routing
//      (setCurrentInReplyTo → outbound rows stamped with in_reply_to). Guards
//      current-batch.js wiring.
// Each suite keeps its own setup (PAT seeds session_routing; upstream seeds a
// peer agent destination) so they don't interfere.
import { describe, it, test, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { setCurrentInReplyTo, clearCurrentInReplyTo } from '../current-batch.js';
import { sendMessage } from './core.js';

interface MessagesOutRow {
  id: string;
  kind: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
}

function readMessagesOut(): MessagesOutRow[] {
  return getOutboundDb()
    .prepare('SELECT id, kind, platform_id, channel_type, thread_id, content FROM messages_out ORDER BY seq')
    .all() as MessagesOutRow[];
}

function seedDestination(name: string, channelType: string, platformId: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (?, ?, 'channel', ?, ?, NULL)`,
    )
    .run(name, name, channelType, platformId);
}

// PAT: send_message's cold-contact fall-through. send_message is the single
// MCP surface for mid-turn outbound; cold targets (recipients not in the
// destination map) dispatch as a regular chat row with the namespaced
// channel/platform straight to messages_out. Direct-addressable channels
// (signal, pstn, telegram, whatsapp, imessage) get this fall-through;
// resolution-required ones (slack, discord, teams, …) need a per-adapter
// openDM resolution we don't implement today and fall through to "Unknown
// destination".
describe('send_message — cold-contact dispatch (PAT)', () => {
  beforeEach(() => {
    initTestSessionDb();
    // Seed session_routing — sendMessage's resolveRouting reads it.
    getInboundDb().exec(`
      CREATE TABLE IF NOT EXISTS session_routing (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        channel_type TEXT,
        platform_id TEXT,
        thread_id TEXT
      );
      INSERT OR REPLACE INTO session_routing (id, channel_type, platform_id, thread_id)
        VALUES (1, 'cli', 'local', NULL);
    `);
  });

  describe('known destination (unchanged behavior)', () => {
    test('writes a chat row when `to` matches a destination map entry', async () => {
      seedDestination('family', 'discord', 'discord:@me:123');
      const result = await sendMessage.handler({ to: 'family', text: 'hi' });

      expect(result.isError).toBeUndefined();
      const rows = readMessagesOut();
      expect(rows).toHaveLength(1);
      expect(rows[0].kind).toBe('chat');
      expect(rows[0].channel_type).toBe('discord');
      expect(rows[0].platform_id).toBe('discord:@me:123');
      expect(JSON.parse(rows[0].content)).toEqual({ text: 'hi' });
    });
  });

  describe('cold platform-id direct dispatch', () => {
    test('signal:+E164 writes a chat row direct to messages_out', async () => {
      const result = await sendMessage.handler({ to: 'signal:+15550100000', text: 'cold ping' });

      expect(result.isError).toBeUndefined();
      const rows = readMessagesOut();
      expect(rows).toHaveLength(1);
      expect(rows[0].kind).toBe('chat');
      expect(rows[0].channel_type).toBe('signal');
      expect(rows[0].platform_id).toBe('+15550100000');
      expect(JSON.parse(rows[0].content)).toEqual({ text: 'cold ping' });
    });

    test('signal-+E164 (dash separator) works equivalently', async () => {
      const result = await sendMessage.handler({ to: 'signal-+15550100000', text: 'dash form' });

      expect(result.isError).toBeUndefined();
      const rows = readMessagesOut();
      expect(rows[0].kind).toBe('chat');
      expect(rows[0].channel_type).toBe('signal');
      expect(rows[0].platform_id).toBe('+15550100000');
    });

    test('signal bare 10 digits → rejection error pointing at E.164', async () => {
      const result = await sendMessage.handler({ to: 'signal-5550100000', text: 'no plus' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/E\.164/);
      expect(result.content[0].text).toMatch(/country/);
      expect(readMessagesOut()).toHaveLength(0);
    });

    test('signal bare 11 digits → rejection error pointing at E.164', async () => {
      const result = await sendMessage.handler({ to: 'signal-15550100000', text: '11 digits' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/E\.164/);
      expect(readMessagesOut()).toHaveLength(0);
    });

    test('pstn bare digits → same rejection (phone-based channel)', async () => {
      const result = await sendMessage.handler({ to: 'pstn-5550100000', text: 'no plus' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/E\.164/);
      expect(readMessagesOut()).toHaveLength(0);
    });

    test('UK number with + prefix passes through (regression test for prior bug)', async () => {
      const result = await sendMessage.handler({ to: 'signal:+447700900123', text: 'UK ping' });

      expect(result.isError).toBeUndefined();
      const rows = readMessagesOut();
      expect(rows[0].platform_id).toBe('+447700900123');
      expect(rows[0].channel_type).toBe('signal');
    });

    test('pstn:+E164 dispatches directly', async () => {
      const result = await sendMessage.handler({ to: 'pstn:+15550100000', text: 'voice cold' });

      expect(result.isError).toBeUndefined();
      const rows = readMessagesOut();
      expect(rows[0].kind).toBe('chat');
      expect(rows[0].channel_type).toBe('pstn');
      expect(rows[0].platform_id).toBe('+15550100000');
    });
  });

  describe('non-direct-addressable channels fall through', () => {
    test('slack:U… falls through to Unknown destination (no cold-contact support today)', async () => {
      const result = await sendMessage.handler({ to: 'slack:U02ABC123', text: 'slack ping' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/Unknown destination/);
      expect(readMessagesOut()).toHaveLength(0);
    });
  });

  describe('pattern does NOT match → original error', () => {
    test('unknown channel prefix returns Unknown destination error', async () => {
      const result = await sendMessage.handler({ to: 'carrier-pigeon:abc', text: 'nope' });

      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      expect(text).toMatch(/Unknown destination/);
      expect(readMessagesOut()).toHaveLength(0);
    });

    test('arbitrary string with no channel prefix returns Unknown destination error', async () => {
      const result = await sendMessage.handler({ to: 'definitely-not-a-channel', text: 'nope' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/Unknown destination/);
      expect(readMessagesOut()).toHaveLength(0);
    });
  });
});

// upstream: the agent-runner sets a current `inReplyTo` at the top of each
// batch in poll-loop, and outbound writes from MCP tools (send_message,
// send_file) must pick it up so a2a return-path routing on the host can
// correlate replies back to the originating session.
describe('send_message MCP tool — in_reply_to plumbing (upstream a2a)', () => {
  beforeEach(() => {
    initTestSessionDb();
    // Seed a peer agent destination
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('peer', 'Peer', 'agent', NULL, NULL, 'ag-peer')`,
      )
      .run();
  });

  afterEach(() => {
    clearCurrentInReplyTo();
    closeSessionDb();
  });

  it('stamps current batch in_reply_to on outbound rows', async () => {
    setCurrentInReplyTo('inbound-msg-1');

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('inbound-msg-1');
  });

  it('writes null when no batch is active', async () => {
    // No setCurrentInReplyTo before this call — simulates ad-hoc / out-of-batch invocation.
    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });
});
