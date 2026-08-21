// PAT: tests for credential-gated MCP activation — enqueue, groupsUsingHost,
// and the activate sequence (config write + row delete + respawn wiring).
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Required by the import chain (activation → container-runner → OneCLI/docker).
vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../log.js', () => ({
  log: { event: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// writeSessionMessage creates real session-DB files — point DATA_DIR at a
// temp dir (same idiom as cli/resources/groups.test.ts). The literal is
// repeated inside the factory because vi.mock is hoisted above the const.
const TEST_DIR = '/tmp/nanoclaw-test-credentials-activation';
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-credentials-activation' };
});

import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { ensureSchema } from '../../db/session-db.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import { listPendingMcpActivations, upsertPendingMcpActivation } from '../../db/pending-mcp-activations.js';
import { createSession } from '../../db/sessions.js';
import { isContainerRunning, killContainer, wakeContainer } from '../../container-runner.js';
import type { Session } from '../../types.js';
import {
  activatePendingMcp,
  buildMcpServerEntry,
  enqueuePendingActivation,
  groupsUsingHost,
  VAULT_PLACEHOLDER,
} from './activation.js';

const GID = 'ag-cred-test';
const SID = 'sess-cred-1';
const now = () => new Date().toISOString();

const HTTP_PAYLOAD = {
  name: 'exa',
  transport: 'http',
  url: 'https://mcp.exa.ai/mcp',
  secret_name: 'EXA_API_KEY',
  auth_header: 'x-api-key',
  auth_format: '{value}',
};

function session(): Session {
  return {
    id: SID,
    agent_group_id: GID,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  };
}

describe('credential-gated activation', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    // Session dirs + inbound schema are scaffolded at session resolution in
    // prod; writeSessionMessage expects both to exist.
    fs.mkdirSync(`${TEST_DIR}/v2-sessions/${GID}/${SID}`, { recursive: true });
    ensureSchema(`${TEST_DIR}/v2-sessions/${GID}/${SID}/inbound.db`, 'inbound');
    runMigrations(initTestDb());
    vi.clearAllMocks();
    createAgentGroup({ id: GID, name: 'cred-test', folder: 'cred-test', agent_provider: null, created_at: now() });
    ensureContainerConfig(GID);
    createSession(session());
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('buildMcpServerEntry: http + secret_name → placeholder auth header', () => {
    expect(buildMcpServerEntry(HTTP_PAYLOAD)).toEqual({
      transport: 'http',
      url: 'https://mcp.exa.ai/mcp',
      headers: { 'x-api-key': VAULT_PLACEHOLDER },
    });
  });

  it('buildMcpServerEntry: http without secret_name passes caller headers verbatim', () => {
    const entry = buildMcpServerEntry({ name: 'open', url: 'https://mcp.open.dev/mcp', headers: { a: 'b' } });
    expect(entry).toEqual({ transport: 'http', url: 'https://mcp.open.dev/mcp', headers: { a: 'b' } });
  });

  it('buildMcpServerEntry: stdio shape preserved', () => {
    expect(buildMcpServerEntry({ name: 's', command: 'npx', args: ['x'] })).toEqual({
      command: 'npx',
      args: ['x'],
      env: {},
    });
  });

  it('enqueue parks the request and records the pending row', () => {
    enqueuePendingActivation({
      session: session(),
      name: 'exa',
      payload: HTTP_PAYLOAD,
      hostPattern: 'mcp.exa.ai',
      secretName: 'EXA_API_KEY',
    });
    const rows = listPendingMcpActivations();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agent_group_id: GID, name: 'exa', host_pattern: 'mcp.exa.ai' });
    // The MCP must NOT be wired yet.
    expect(JSON.parse(getContainerConfig(GID)!.mcp_servers)).toEqual({});
    // Re-request upserts, not duplicates.
    enqueuePendingActivation({
      session: session(),
      name: 'exa',
      payload: HTTP_PAYLOAD,
      hostPattern: 'mcp.exa.ai',
      secretName: 'EXA_API_KEY',
    });
    expect(listPendingMcpActivations()).toHaveLength(1);
  });

  it('groupsUsingHost finds live http entries by URL host, skipping tombstones', () => {
    updateContainerConfigJson(GID, 'mcp_servers', {
      exa: { transport: 'http', url: 'https://mcp.exa.ai/mcp', headers: {} },
      dead: { transport: 'http', url: 'https://mcp.dead.dev/mcp', headers: {}, deleted: true },
      local: { command: 'npx', args: [] },
    });
    expect(groupsUsingHost('mcp.exa.ai')).toEqual([GID]);
    expect(groupsUsingHost('mcp.dead.dev')).toEqual([]);
    expect(groupsUsingHost('elsewhere.dev')).toEqual([]);
  });

  it('activate wires the config, deletes the row, and wakes a stopped session', async () => {
    enqueuePendingActivation({
      session: session(),
      name: 'exa',
      payload: HTTP_PAYLOAD,
      hostPattern: 'mcp.exa.ai',
      secretName: 'EXA_API_KEY',
    });
    const [row] = listPendingMcpActivations();
    await activatePendingMcp(row);

    const servers = JSON.parse(getContainerConfig(GID)!.mcp_servers);
    expect(servers.exa).toEqual({
      transport: 'http',
      url: 'https://mcp.exa.ai/mcp',
      headers: { 'x-api-key': VAULT_PLACEHOLDER },
    });
    expect(listPendingMcpActivations()).toHaveLength(0);
    // Stopped container → plain wake (killContainer would never invoke onExit).
    expect(killContainer).not.toHaveBeenCalled();
    expect(wakeContainer).toHaveBeenCalled();
    // The on-wake verify prompt reached the session inbound DB.
    const inbound = fs.existsSync(`${TEST_DIR}/v2-sessions/${GID}/${SID}/inbound.db`);
    expect(inbound).toBe(true);
  });

  it('activate kills + respawns when the container is running', async () => {
    vi.mocked(isContainerRunning).mockReturnValue(true);
    enqueuePendingActivation({
      session: session(),
      name: 'exa',
      payload: HTTP_PAYLOAD,
      hostPattern: 'mcp.exa.ai',
      secretName: 'EXA_API_KEY',
    });
    const [row] = listPendingMcpActivations();
    await activatePendingMcp(row);
    expect(killContainer).toHaveBeenCalledWith(SID, 'mcp credential arrived', expect.any(Function));
  });

  it('activate with a vanished session still writes the config and clears the row', async () => {
    enqueuePendingActivation({
      session: session(),
      name: 'exa',
      payload: HTTP_PAYLOAD,
      hostPattern: 'mcp.exa.ai',
      secretName: 'EXA_API_KEY',
    });
    getDb().prepare('DELETE FROM sessions WHERE id = ?').run(SID);
    const [row] = listPendingMcpActivations();
    await activatePendingMcp(row);
    expect(JSON.parse(getContainerConfig(GID)!.mcp_servers).exa).toBeDefined();
    expect(listPendingMcpActivations()).toHaveLength(0);
    expect(wakeContainer).not.toHaveBeenCalled();
  });
});
