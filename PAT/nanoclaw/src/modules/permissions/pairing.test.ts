/**
 * Integration tests for the pairing-code ingress flow.
 *
 * Drives routeInbound with a message from an unlinked handle carrying an active
 * pairing code and asserts the end-to-end effect: handle linked to the code's
 * person, code consumed, a confirmation delivered, and the message replayed so
 * the agent engages (container woken). Covers BOTH seams:
 *   - wired channel, unknown sender (access gate → handleUnknownSender)
 *   - unwired DM (channel-request gate)
 * Plus the negative: no card is short-circuited for a stranger without a code.
 */
import fs from 'fs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent, getMessagingGroupAgents } from '../../db/messaging-groups.js';
import { createPerson, getPersonByUser } from '../../people/index.js';
import { createPairingCode, getPairingCode } from '../../people/pairing.js';

const wakeMock = vi.fn().mockResolvedValue(true);
vi.mock('../../container-runner.js', () => ({
  wakeContainer: (...args: unknown[]) => wakeMock(...args),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

const deliverMock = vi.fn().mockResolvedValue('plat-msg-id');
vi.mock('../../delivery.js', () => ({
  getDeliveryAdapter: () => ({ deliver: deliverMock, setTyping: vi.fn() }),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-pairing' };
});

const TEST_DIR = '/tmp/nanoclaw-test-pairing';
const now = () => new Date().toISOString();

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  await import('./index.js'); // register hooks after mocks

  createAgentGroup({ id: 'ag-1', name: 'Pat', folder: 'pat', agent_provider: null, created_at: now() });

  deliverMock.mockClear();
  wakeMock.mockClear();
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

function inbound(opts: { platformId: string; isGroup: boolean; senderId: string; text: string }) {
  return {
    channelType: 'telegram',
    platformId: opts.platformId,
    threadId: null,
    message: {
      id: `m-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat' as const,
      isMention: true,
      isGroup: opts.isGroup,
      content: JSON.stringify({ senderId: opts.senderId, senderName: 'New Handle', text: opts.text }),
      timestamp: now(),
    },
  };
}

describe('pairing-code ingress', () => {
  it('pairs an unknown sender on a WIRED channel (access-gate seam)', async () => {
    const person = createPerson({ first_name: 'Ada', last_name: 'Lovelace' });
    const code = createPairingCode(person.id);

    // Wired, strict channel — an unknown sender would normally be dropped.
    createMessagingGroup({
      id: 'mg-chat',
      channel_type: 'telegram',
      platform_id: 'chat-123',
      name: 'Chat',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-1',
      messaging_group_id: 'mg-chat',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });

    const { routeInbound } = await import('../../router.js');
    // senderId has no colon, so it's namespaced to telegram:newbie.
    await routeInbound(
      inbound({ platformId: 'chat-123', isGroup: true, senderId: 'newbie', text: `code ${code.code}` }),
    );
    await new Promise((r) => setTimeout(r, 20)); // let the fire-and-forget pairing + replay resolve

    // Linked, consumed, confirmed, and the replay woke the container.
    expect(getPersonByUser('telegram:newbie')?.id).toBe(person.id);
    expect(getPairingCode(code.id)?.linked_user_id).toBe('telegram:newbie');
    expect(deliverMock).toHaveBeenCalled();
    expect(JSON.parse(deliverMock.mock.calls[0][4] as string).text).toMatch(/Paired/);
    expect(wakeMock).toHaveBeenCalled();
  });

  it('pairs + wires an UNWIRED DM (channel-request-gate seam)', async () => {
    const person = createPerson({ first_name: 'Grace', last_name: 'Hopper' });
    const code = createPairingCode(person.id);

    // No messaging group, no wiring — a fresh DM from a brand-new handle.
    const { routeInbound } = await import('../../router.js');
    await routeInbound(
      inbound({ platformId: 'dm-new', isGroup: false, senderId: 'fresh', text: `my code: ${code.code}` }),
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(getPersonByUser('telegram:fresh')?.id).toBe(person.id);
    expect(getPairingCode(code.id)?.linked_user_id).toBe('telegram:fresh');
    // The DM's messaging group was auto-created + wired to the primary agent.
    const { getMessagingGroupWithAgentCount } = await import('../../db/messaging-groups.js');
    const found = getMessagingGroupWithAgentCount('telegram', 'dm-new', 'telegram');
    expect(found).toBeTruthy();
    expect(getMessagingGroupAgents(found!.mg.id).length).toBeGreaterThan(0);
    expect(wakeMock).toHaveBeenCalled();
  });

  it('does NOT pair a stranger without a code; drops + hints, raises NO card', async () => {
    const person = createPerson({ first_name: 'Ada', last_name: 'Lovelace' });
    const code = createPairingCode(person.id);

    const { routeInbound } = await import('../../router.js');
    await routeInbound(
      inbound({ platformId: 'dm-x', isGroup: false, senderId: 'tg:stranger', text: 'just saying hi' }),
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(getPersonByUser('telegram:tg:stranger')).toBeUndefined();
    expect(getPairingCode(code.id)?.consumed_at).toBeNull(); // still active

    // The channel-registration card flow is DISABLED — no card row should exist.
    const { getDb } = await import('../../db/connection.js');
    const cards = getDb().prepare('SELECT COUNT(*) AS c FROM pending_channel_approvals').get() as { c: number };
    expect(cards.c).toBe(0);

    // Instead, a one-time pairing hint was delivered.
    const hinted = deliverMock.mock.calls.some((call) =>
      String((JSON.parse(call[4] as string) as { text?: string }).text ?? '').includes('pairing code'),
    );
    expect(hinted).toBe(true);
  });
});
