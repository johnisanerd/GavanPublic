/**
 * Tests for realtime owner-phone auto-elevation.
 *
 * Two layers:
 *  - Unit: `matchOwnerPhone` reads PAT_OWNER_PHONES, accepts pstn: ids
 *    on the allowlist, rejects others.
 *  - Integration: routeInbound on a realtime/PSTN event auto-grants
 *    `owner` on first sight and the access gate then allows the message
 *    through. Non-matching phones don't get elevated.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../../db/messaging-groups.js';
import { getOwnerPhones, matchOwnerPhone, resetOwnerPhonesCache } from './realtime-owners.js';
import { getUserRoles, isOwner } from './db/user-roles.js';

// Mock container runner — avoid actual docker spawn when routeInbound
// would otherwise try to wake a container.
vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

// Mock delivery — record but don't actually emit.
const deliverMock = vi.fn().mockResolvedValue('plat-msg-id');
vi.mock('../../delivery.js', () => ({
  getDeliveryAdapter: () => ({
    deliver: deliverMock,
  }),
}));

// Mock ensureUserDm — sender-approval flow may invoke it; return null
// so the flow doesn't take a side trip into adapter.openDM.
vi.mock('./user-dm.js', () => ({
  ensureUserDm: vi.fn(async () => null),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-realtime-owners' };
});

const TEST_DIR = '/tmp/nanoclaw-test-realtime-owners';

function now() {
  return new Date().toISOString();
}

function realtimeInbound(senderId: string, text: string) {
  return {
    channelType: 'phone-call',
    platformId: '+13415551234',
    threadId: 'call-test-1',
    message: {
      id: `realtime-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat' as const,
      content: JSON.stringify({
        senderId,
        text,
        sender: 'realtime-user',
      }),
      timestamp: now(),
    },
  };
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);

  // Side-effect import: registers senderResolver + accessGate hooks.
  await import('./index.js');

  // Realtime fixture wiring so routeInbound has somewhere to land.
  createAgentGroup({ id: 'ag-rt', name: 'PAT', folder: 'pat', agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: 'mg-rt',
    channel_type: 'phone-call',
    platform_id: '+13415551234',
    name: 'phone-call:+13415551234',
    is_group: 0,
    unknown_sender_policy: 'request_approval',
    created_at: now(),
  });
  createMessagingGroupAgent({
    id: 'mga-rt',
    messaging_group_id: 'mg-rt',
    agent_group_id: 'ag-rt',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'per-thread',
    priority: 0,
    created_at: now(),
  });

  deliverMock.mockClear();
  resetOwnerPhonesCache();
});

afterEach(() => {
  delete process.env.PAT_OWNER_PHONES;
  resetOwnerPhonesCache();
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('matchOwnerPhone (unit)', () => {
  it('returns the phone when it matches the allowlist', () => {
    process.env.PAT_OWNER_PHONES = '+13415551234,+15555550100';
    resetOwnerPhonesCache();
    expect(matchOwnerPhone('pstn:+13415551234')).toBe('+13415551234');
    expect(matchOwnerPhone('pstn:+15555550100')).toBe('+15555550100');
  });

  it('returns null for non-matching phones', () => {
    process.env.PAT_OWNER_PHONES = '+13415551234';
    resetOwnerPhonesCache();
    expect(matchOwnerPhone('pstn:+19999999999')).toBeNull();
  });

  it('returns null for non-pstn user ids', () => {
    process.env.PAT_OWNER_PHONES = '+13415551234';
    resetOwnerPhonesCache();
    expect(matchOwnerPhone('slack:U123')).toBeNull();
    expect(matchOwnerPhone('telegram:<telegram-id>')).toBeNull();
    expect(matchOwnerPhone('realtime:+13415551234')).toBeNull();
  });

  it('handles whitespace and empty entries in the env var', () => {
    process.env.PAT_OWNER_PHONES = ' +13415551234 ,, +15555550100 ';
    resetOwnerPhonesCache();
    expect(getOwnerPhones().has('+13415551234')).toBe(true);
    expect(getOwnerPhones().has('+15555550100')).toBe(true);
    expect(getOwnerPhones().has('')).toBe(false);
  });

  it('treats unset env var as empty allowlist (no auto-elevation)', () => {
    delete process.env.PAT_OWNER_PHONES;
    resetOwnerPhonesCache();
    expect(matchOwnerPhone('pstn:+13415551234')).toBeNull();
  });
});

describe('routeInbound: realtime owner auto-elevation', () => {
  it('grants global owner on first sight when the phone is on the allowlist', async () => {
    process.env.PAT_OWNER_PHONES = '+13415551234';
    resetOwnerPhonesCache();

    const { routeInbound } = await import('../../router.js');
    await routeInbound(realtimeInbound('pstn:+13415551234', 'hi pat'));

    expect(isOwner('pstn:+13415551234')).toBe(true);
    const roles = getUserRoles('pstn:+13415551234');
    expect(roles).toHaveLength(1);
    expect(roles[0]?.role).toBe('owner');
    expect(roles[0]?.agent_group_id).toBeNull();
  });

  it('does NOT grant owner to a phone NOT on the allowlist', async () => {
    process.env.PAT_OWNER_PHONES = '+13415551234';
    resetOwnerPhonesCache();

    const { routeInbound } = await import('../../router.js');
    await routeInbound(realtimeInbound('pstn:+19999999999', 'hi pat'));

    expect(isOwner('pstn:+19999999999')).toBe(false);
    expect(getUserRoles('pstn:+19999999999')).toHaveLength(0);
  });

  it('is idempotent — second call from the same owner phone does not duplicate the role row', async () => {
    process.env.PAT_OWNER_PHONES = '+13415551234';
    resetOwnerPhonesCache();

    const { routeInbound } = await import('../../router.js');
    await routeInbound(realtimeInbound('pstn:+13415551234', 'first'));
    await routeInbound(realtimeInbound('pstn:+13415551234', 'second'));

    const roles = getUserRoles('pstn:+13415551234');
    expect(roles).toHaveLength(1);
  });

  it('an owner phone caller passes the access gate (no unknown-sender card)', async () => {
    process.env.PAT_OWNER_PHONES = '+13415551234';
    resetOwnerPhonesCache();

    const { routeInbound } = await import('../../router.js');
    await routeInbound(realtimeInbound('pstn:+13415551234', 'hello'));
    await new Promise((r) => setTimeout(r, 10));

    // No approval card delivered — the gate let the owner straight through.
    const cardDeliveries = deliverMock.mock.calls.filter((c) => c[3] === 'chat-sdk');
    expect(cardDeliveries).toHaveLength(0);
  });
});
