/**
 * Tests for PAT_ADMINS_BYPASS_APPROVAL flag.
 *
 * Covers:
 *  - isAdminBypassEnabled() reads and caches the env var
 *  - requestSenderApproval: bypasses for owner, admin; fires card for other
 *  - requestChannelApproval: bypasses for owner, admin; fires card for other
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../../db/messaging-groups.js';
import { upsertUser } from './db/users.js';
import { grantRole } from './db/user-roles.js';
import { isAdminBypassEnabled, resetAdminBypassCache } from './command-gate.js';
import { requestSenderApproval } from './sender-approval.js';
import { requestChannelApproval } from './channel-approval.js';

// Prevent docker spawn.
vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

// Record card deliveries.
const deliverMock = vi.fn().mockResolvedValue('plat-msg-id');
vi.mock('../../delivery.js', () => ({
  getDeliveryAdapter: () => ({ deliver: deliverMock }),
}));

// Return the owner's DM row so pickApprovalDelivery can resolve.
vi.mock('./user-dm.js', () => ({
  ensureUserDm: vi.fn(async (userId: string) => {
    const { getDb } = await import('../../db/connection.js');
    return getDb()
      .prepare(
        `SELECT mg.* FROM messaging_groups mg
           JOIN user_dms ud ON ud.messaging_group_id = mg.id
          WHERE ud.user_id = ?`,
      )
      .get(userId);
  }),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-admin-bypass' };
});

const TEST_DIR = '/tmp/nanoclaw-test-admin-bypass';

function now() {
  return new Date().toISOString();
}

function makeEvent(senderId: string, channelType = 'telegram', platformId = 'chat-123') {
  return {
    channelType,
    platformId,
    threadId: null,
    message: {
      id: `msg-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat' as const,
      content: JSON.stringify({ senderId, senderName: 'Tester', text: 'hello' }),
      timestamp: now(),
      isMention: true,
    },
  };
}

// requestChannelApproval inserts into pending_channel_approvals which has a
// FK on messaging_groups(id). Tests that expect the card to actually fire
// need the messaging group row to exist; bypass-path tests skip the insert
// so they don't need it.
function seedMessagingGroup(messagingGroupId: string, platformId: string): void {
  createMessagingGroup({
    id: messagingGroupId,
    channel_type: 'telegram',
    platform_id: platformId,
    name: messagingGroupId,
    is_group: 0,
    unknown_sender_policy: 'request_approval',
    created_at: now(),
  });
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);

  createAgentGroup({ id: 'ag-1', name: 'PAT', folder: 'pat', agent_provider: null, created_at: now() });

  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'telegram',
    platform_id: 'chat-123',
    name: 'Test Chat',
    is_group: 0,
    unknown_sender_policy: 'request_approval',
    created_at: now(),
  });
  createMessagingGroupAgent({
    id: 'mga-1',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });

  // Owner with a DM group so pickApprovalDelivery can succeed.
  upsertUser({ id: 'telegram:owner', kind: 'telegram', display_name: 'Owner', created_at: now() });
  grantRole({ user_id: 'telegram:owner', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
  createMessagingGroup({
    id: 'mg-dm-owner',
    channel_type: 'telegram',
    platform_id: 'dm-owner',
    name: 'Owner DM',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  const { getDb } = await import('../../db/connection.js');
  getDb()
    .prepare(`INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at) VALUES (?, ?, ?, ?)`)
    .run('telegram:owner', 'telegram', 'mg-dm-owner', now());

  // Admin user.
  upsertUser({ id: 'telegram:admin', kind: 'telegram', display_name: 'Admin', created_at: now() });
  grantRole({
    user_id: 'telegram:admin',
    role: 'admin',
    agent_group_id: null,
    granted_by: 'telegram:owner',
    granted_at: now(),
  });

  // Regular user (no role).
  upsertUser({ id: 'telegram:stranger', kind: 'telegram', display_name: 'Stranger', created_at: now() });

  // Pre-seed messaging groups for channel-approval tests (pending_channel_approvals FK).
  for (let i = 1; i <= 4; i++) {
    seedMessagingGroup(`mg-new-chan-${i}`, `new-chan-${i}`);
  }

  deliverMock.mockClear();
  resetAdminBypassCache();
});

afterEach(() => {
  delete process.env.PAT_ADMINS_BYPASS_APPROVAL;
  resetAdminBypassCache();
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

// ── Unit: isAdminBypassEnabled ──────────────────────────────────────────────

describe('isAdminBypassEnabled (unit)', () => {
  it('returns false when env var is unset', () => {
    delete process.env.PAT_ADMINS_BYPASS_APPROVAL;
    resetAdminBypassCache();
    expect(isAdminBypassEnabled()).toBe(false);
  });

  it('returns true when env var is "1"', () => {
    process.env.PAT_ADMINS_BYPASS_APPROVAL = '1';
    resetAdminBypassCache();
    expect(isAdminBypassEnabled()).toBe(true);
  });

  it('returns true when env var is "true"', () => {
    process.env.PAT_ADMINS_BYPASS_APPROVAL = 'true';
    resetAdminBypassCache();
    expect(isAdminBypassEnabled()).toBe(true);
  });

  it('returns false for any other value', () => {
    process.env.PAT_ADMINS_BYPASS_APPROVAL = 'yes';
    resetAdminBypassCache();
    expect(isAdminBypassEnabled()).toBe(false);
  });

  it('caches the value — env change after first call has no effect', () => {
    delete process.env.PAT_ADMINS_BYPASS_APPROVAL;
    resetAdminBypassCache();
    expect(isAdminBypassEnabled()).toBe(false);
    process.env.PAT_ADMINS_BYPASS_APPROVAL = '1';
    // No resetAdminBypassCache — cache must return the original false.
    expect(isAdminBypassEnabled()).toBe(false);
  });
});

// ── requestSenderApproval bypass ────────────────────────────────────────────

describe('requestSenderApproval — admin bypass', () => {
  it('flag unset: sends card regardless of caller role', async () => {
    delete process.env.PAT_ADMINS_BYPASS_APPROVAL;
    resetAdminBypassCache();

    await requestSenderApproval({
      messagingGroupId: 'mg-1',
      agentGroupId: 'ag-1',
      senderIdentity: 'telegram:owner',
      senderName: 'Owner',
      event: makeEvent('telegram:owner'),
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(deliverMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(deliverMock.mock.calls[0][4] as string);
    expect(payload.type).toBe('ask_question');
  });

  it('flag set: owner skips the card (no delivery, no pending row)', async () => {
    process.env.PAT_ADMINS_BYPASS_APPROVAL = '1';
    resetAdminBypassCache();

    await requestSenderApproval({
      messagingGroupId: 'mg-1',
      agentGroupId: 'ag-1',
      senderIdentity: 'telegram:owner',
      senderName: 'Owner',
      event: makeEvent('telegram:owner'),
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(deliverMock).not.toHaveBeenCalled();
    const { getDb } = await import('../../db/connection.js');
    const count = (getDb().prepare('SELECT COUNT(*) AS c FROM pending_sender_approvals').get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it('flag set: global admin skips the card', async () => {
    process.env.PAT_ADMINS_BYPASS_APPROVAL = '1';
    resetAdminBypassCache();

    await requestSenderApproval({
      messagingGroupId: 'mg-1',
      agentGroupId: 'ag-1',
      senderIdentity: 'telegram:admin',
      senderName: 'Admin',
      event: makeEvent('telegram:admin'),
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(deliverMock).not.toHaveBeenCalled();
    const { getDb } = await import('../../db/connection.js');
    const count = (getDb().prepare('SELECT COUNT(*) AS c FROM pending_sender_approvals').get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it('flag set: regular user still gets a card', async () => {
    process.env.PAT_ADMINS_BYPASS_APPROVAL = '1';
    resetAdminBypassCache();

    await requestSenderApproval({
      messagingGroupId: 'mg-1',
      agentGroupId: 'ag-1',
      senderIdentity: 'telegram:stranger',
      senderName: 'Stranger',
      event: makeEvent('telegram:stranger'),
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(deliverMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(deliverMock.mock.calls[0][4] as string);
    expect(payload.type).toBe('ask_question');
  });
});

// ── requestChannelApproval bypass ───────────────────────────────────────────

describe('requestChannelApproval — admin bypass', () => {
  it('flag unset: sends card for an owner-triggered new channel', async () => {
    delete process.env.PAT_ADMINS_BYPASS_APPROVAL;
    resetAdminBypassCache();

    await requestChannelApproval({
      messagingGroupId: 'mg-new-chan-1',
      event: makeEvent('telegram:owner', 'telegram', 'new-chan-1'),
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(deliverMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(deliverMock.mock.calls[0][4] as string);
    expect(payload.type).toBe('ask_question');
  });

  it('flag set: owner triggering new channel skips the card', async () => {
    process.env.PAT_ADMINS_BYPASS_APPROVAL = '1';
    resetAdminBypassCache();

    await requestChannelApproval({
      messagingGroupId: 'mg-new-chan-2',
      event: makeEvent('telegram:owner', 'telegram', 'new-chan-2'),
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(deliverMock).not.toHaveBeenCalled();
    const { getDb } = await import('../../db/connection.js');
    const count = (getDb().prepare('SELECT COUNT(*) AS c FROM pending_channel_approvals').get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it('flag set: global admin triggering new channel skips the card', async () => {
    process.env.PAT_ADMINS_BYPASS_APPROVAL = '1';
    resetAdminBypassCache();

    await requestChannelApproval({
      messagingGroupId: 'mg-new-chan-3',
      event: makeEvent('telegram:admin', 'telegram', 'new-chan-3'),
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(deliverMock).not.toHaveBeenCalled();
    const { getDb } = await import('../../db/connection.js');
    const count = (getDb().prepare('SELECT COUNT(*) AS c FROM pending_channel_approvals').get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it('flag set: stranger triggering new channel still gets a card', async () => {
    process.env.PAT_ADMINS_BYPASS_APPROVAL = '1';
    resetAdminBypassCache();

    await requestChannelApproval({
      messagingGroupId: 'mg-new-chan-4',
      event: makeEvent('stranger', 'telegram', 'new-chan-4'),
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(deliverMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(deliverMock.mock.calls[0][4] as string);
    expect(payload.type).toBe('ask_question');
  });
});
