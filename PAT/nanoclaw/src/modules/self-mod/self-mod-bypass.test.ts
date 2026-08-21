/**
 * PAT: tests for PAT_ADMINS_BYPASS_APPROVAL extension to self-mod actions.
 *
 * Covers: handleInstallPackages + handleAddMcpServer auto-apply when the
 * flag is set AND the REQUESTER (session.user_id) is themselves an admin/owner.
 *
 * Flag off → existing requestApproval path runs (no apply call).
 * Flag on  + requester not an admin → requestApproval path runs (no apply),
 *            even if some other admin exists in the deployment.
 * Flag on  + requester is an admin/owner → apply runs directly, no approval row.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { createSession } from '../../db/sessions.js';
import type { Session } from '../../types.js';
import { upsertUser } from '../permissions/db/users.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { resetAdminBypassCache } from '../permissions/command-gate.js';
import { handleAddMcpServer, handleInstallPackages } from './request.js';

// vi.mock factories are hoisted; declare mocks via vi.hoisted so the
// factories can capture them.
const {
  buildAgentGroupImageMock,
  killContainerMock,
  wakeContainerMock,
  updateContainerConfigMock,
  writeSessionMessageMock,
  requestApprovalMock,
  notifyAgentMock,
} = vi.hoisted(() => ({
  buildAgentGroupImageMock: vi.fn().mockResolvedValue(undefined),
  killContainerMock: vi.fn(),
  wakeContainerMock: vi.fn().mockResolvedValue(undefined),
  updateContainerConfigMock: vi.fn(),
  writeSessionMessageMock: vi.fn(),
  requestApprovalMock: vi.fn().mockResolvedValue(undefined),
  notifyAgentMock: vi.fn(),
}));

// Prevent docker / image / kill side effects.
vi.mock('../../container-runner.js', () => ({
  wakeContainer: wakeContainerMock,
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: killContainerMock,
  buildAgentGroupImage: buildAgentGroupImageMock,
}));

// apply.ts now reads/writes container config via the DB (upstream's
// container-config-to-db). Mock getContainerConfig to return an empty config
// row and capture the updateContainerConfigJson writes so tests can assert.
vi.mock('../../db/container-configs.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/container-configs.js')>('../../db/container-configs.js');
  return {
    ...actual,
    getContainerConfig: vi.fn(() => ({
      agent_group_id: 'ag-1',
      packages_apt: '[]',
      packages_npm: '[]',
      mcp_servers: '{}',
    })),
    updateContainerConfigJson: updateContainerConfigMock,
  };
});

// Avoid opening per-session inbound.db files on disk.
vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: writeSessionMessageMock,
}));

// Record requestApproval invocations without exercising the real approval
// delivery / DB pipeline. notifyAgent must remain real(ish) so tests can
// distinguish "approval card requested" from "agent notified directly".
vi.mock('../approvals/index.js', async () => {
  const actual = await vi.importActual<typeof import('../approvals/index.js')>('../approvals/index.js');
  return {
    ...actual,
    requestApproval: requestApprovalMock,
    notifyAgent: notifyAgentMock,
  };
});

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-self-mod-bypass' };
});

const TEST_DIR = '/tmp/nanoclaw-test-self-mod-bypass';

function now(): string {
  return new Date().toISOString();
}

function seedSession(userId: string | null = 'telegram:owner'): Session {
  const session: Session = {
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: 'mg-1',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'idle',
    last_active: null,
    created_at: now(),
    // PAT: the requester bound at session creation — the bypass now checks that
    // THIS user is an admin, not merely that some admin exists.
    user_id: userId,
  };
  createSession(session);
  return session;
}

function seedOwner(): void {
  upsertUser({ id: 'telegram:owner', kind: 'telegram', display_name: 'Owner', created_at: now() });
  grantRole({
    user_id: 'telegram:owner',
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: now(),
  });
}

beforeEach(() => {
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
    unknown_sender_policy: 'public',
    created_at: now(),
  });

  buildAgentGroupImageMock.mockClear();
  killContainerMock.mockClear();
  updateContainerConfigMock.mockClear();
  writeSessionMessageMock.mockClear();
  requestApprovalMock.mockClear();
  notifyAgentMock.mockClear();
  resetAdminBypassCache();
});

afterEach(() => {
  delete process.env.PAT_ADMINS_BYPASS_APPROVAL;
  resetAdminBypassCache();
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

// ── install_packages ────────────────────────────────────────────────────────

describe('handleInstallPackages — admin bypass', () => {
  it('flag unset: requests approval (no auto-apply)', async () => {
    delete process.env.PAT_ADMINS_BYPASS_APPROVAL;
    resetAdminBypassCache();
    seedOwner();
    const session = seedSession();

    await handleInstallPackages({ apt: ['curl'], npm: [], reason: 'demo' }, session);

    expect(requestApprovalMock).toHaveBeenCalledTimes(1);
    expect(updateContainerConfigMock).not.toHaveBeenCalled();
    expect(buildAgentGroupImageMock).not.toHaveBeenCalled();
    expect(killContainerMock).not.toHaveBeenCalled();
  });

  it('flag set + admin present: auto-applies (config update + rebuild + kill, no approval)', async () => {
    process.env.PAT_ADMINS_BYPASS_APPROVAL = '1';
    resetAdminBypassCache();
    seedOwner();
    const session = seedSession();

    await handleInstallPackages({ apt: ['curl'], npm: ['lodash'], reason: 'demo' }, session);

    expect(requestApprovalMock).not.toHaveBeenCalled();
    // Two writes now: one per field (packages_apt, packages_npm) — upstream's
    // DB-backed updateContainerConfigJson is called per-field, not once.
    expect(updateContainerConfigMock).toHaveBeenCalledTimes(2);
    expect(buildAgentGroupImageMock).toHaveBeenCalledWith('ag-1');
    // upstream added an onExit callback param to killContainer.
    expect(killContainerMock).toHaveBeenCalledWith('sess-1', 'rebuild applied', expect.any(Function));
    // Follow-up "verify" prompt written to session inbound.
    expect(writeSessionMessageMock).toHaveBeenCalledTimes(1);
  });

  it('flag set but no admin/owner configured: falls back to requestApproval (no free pass)', async () => {
    process.env.PAT_ADMINS_BYPASS_APPROVAL = '1';
    resetAdminBypassCache();
    // No seedOwner — fresh install scenario.
    const session = seedSession();

    await handleInstallPackages({ apt: ['curl'], npm: [], reason: '' }, session);

    expect(requestApprovalMock).toHaveBeenCalledTimes(1);
    expect(buildAgentGroupImageMock).not.toHaveBeenCalled();
    expect(killContainerMock).not.toHaveBeenCalled();
  });

  it('flag set + admin exists but REQUESTER is not admin: falls back to approval (no member free pass)', async () => {
    process.env.PAT_ADMINS_BYPASS_APPROVAL = '1';
    resetAdminBypassCache();
    seedOwner(); // an admin exists in the deployment...
    const session = seedSession('telegram:rando'); // ...but the requester is not them
    await handleInstallPackages({ apt: ['curl'], npm: [], reason: '' }, session);
    expect(requestApprovalMock).toHaveBeenCalledTimes(1);
    expect(buildAgentGroupImageMock).not.toHaveBeenCalled();
    expect(killContainerMock).not.toHaveBeenCalled();
  });

  it('flag set + invalid apt package: rejects before bypass — validation preserved', async () => {
    process.env.PAT_ADMINS_BYPASS_APPROVAL = '1';
    resetAdminBypassCache();
    seedOwner();
    const session = seedSession();

    await handleInstallPackages({ apt: ['BAD;rm -rf /'], npm: [], reason: '' }, session);

    expect(requestApprovalMock).not.toHaveBeenCalled();
    expect(buildAgentGroupImageMock).not.toHaveBeenCalled();
    expect(updateContainerConfigMock).not.toHaveBeenCalled();
    expect(notifyAgentMock).toHaveBeenCalled();
    expect(notifyAgentMock.mock.calls[0][1]).toContain('invalid apt');
  });
});

// ── add_mcp_server ──────────────────────────────────────────────────────────

describe('handleAddMcpServer — admin bypass', () => {
  it('flag unset: requests approval (no auto-apply)', async () => {
    delete process.env.PAT_ADMINS_BYPASS_APPROVAL;
    resetAdminBypassCache();
    seedOwner();
    const session = seedSession();

    await handleAddMcpServer({ name: 'pizza', command: 'node', args: ['server.js'], env: {} }, session);

    expect(requestApprovalMock).toHaveBeenCalledTimes(1);
    expect(updateContainerConfigMock).not.toHaveBeenCalled();
    expect(killContainerMock).not.toHaveBeenCalled();
  });

  it('flag set + admin present: auto-applies (config update + kill, no rebuild, no approval)', async () => {
    process.env.PAT_ADMINS_BYPASS_APPROVAL = '1';
    resetAdminBypassCache();
    seedOwner();
    const session = seedSession();

    await handleAddMcpServer({ name: 'pizza', command: 'node', args: ['server.js'], env: { TOKEN: 'x' } }, session);

    expect(requestApprovalMock).not.toHaveBeenCalled();
    expect(updateContainerConfigMock).toHaveBeenCalledTimes(1);
    expect(killContainerMock).toHaveBeenCalledWith('sess-1', 'mcp server added', expect.any(Function));
    // add_mcp_server doesn't rebuild — bun runs TS directly.
    expect(buildAgentGroupImageMock).not.toHaveBeenCalled();
    // upstream moved the success notice from notifyAgent → an on_wake
    // writeSessionMessage so the rebuilt container picks it up.
    expect(writeSessionMessageMock).toHaveBeenCalled();
    const mcpNote = JSON.parse(writeSessionMessageMock.mock.calls[0][2].content) as { text: string };
    expect(mcpNote.text).toMatch(/MCP server "pizza" added/);
  });

  it('flag set but no admin/owner configured: falls back to requestApproval', async () => {
    process.env.PAT_ADMINS_BYPASS_APPROVAL = '1';
    resetAdminBypassCache();
    const session = seedSession();

    await handleAddMcpServer({ name: 'pizza', command: 'node' }, session);

    expect(requestApprovalMock).toHaveBeenCalledTimes(1);
    expect(updateContainerConfigMock).not.toHaveBeenCalled();
    expect(killContainerMock).not.toHaveBeenCalled();
  });

  it('flag set + missing name/command: rejects before bypass — validation preserved', async () => {
    process.env.PAT_ADMINS_BYPASS_APPROVAL = '1';
    resetAdminBypassCache();
    seedOwner();
    const session = seedSession();

    await handleAddMcpServer({ name: '', command: 'node' }, session);

    expect(requestApprovalMock).not.toHaveBeenCalled();
    expect(updateContainerConfigMock).not.toHaveBeenCalled();
    expect(notifyAgentMock).toHaveBeenCalled();
    expect(notifyAgentMock.mock.calls[0][1]).toContain(
      'name and either url (remote/http) or command (stdio) are required',
    );
  });
});
