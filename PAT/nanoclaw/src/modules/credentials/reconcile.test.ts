// PAT: tests for the credential reconcile (routing table → OneCLI vault).
// The vault client is mocked; the routing table is a real in-memory DB.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./onecli-vault.js', () => ({
  vaultConfigured: vi.fn().mockReturnValue(true),
  listSecrets: vi.fn().mockResolvedValue([]),
  createSecret: vi.fn().mockResolvedValue(undefined),
  deleteSecret: vi.fn().mockResolvedValue(undefined),
  replaceSecret: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../log.js', () => ({
  log: { event: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { upsertCredentialRoute, tombstoneCredentialRoute } from '../../db/credential-routing.js';
import { createSecret, deleteSecret, listSecrets, replaceSecret, vaultConfigured } from './onecli-vault.js';
import { reconcileCredentials } from './reconcile.js';

const ROUTE = {
  name: 'exa',
  host_pattern: 'mcp.exa.ai',
  header_name: 'x-api-key',
  value_format: '{value}',
  type: 'generic',
  secret_name: 'RECON_TEST_KEY',
};

describe('reconcileCredentials', () => {
  beforeEach(() => {
    runMigrations(initTestDb());
    vi.clearAllMocks();
    vi.mocked(vaultConfigured).mockReturnValue(true);
    vi.mocked(listSecrets).mockResolvedValue([]);
  });

  afterEach(() => {
    closeDb();
    delete process.env.AGENT_RECON_TEST_KEY;
  });

  it('creates a vault entry when the AGENT_ value exists and none is present', async () => {
    process.env.AGENT_RECON_TEST_KEY = 'sk-123';
    upsertCredentialRoute(ROUTE);
    const summary = await reconcileCredentials();
    expect(summary.created).toEqual(['exa']);
    expect(summary.errors).toEqual([]);
    expect(createSecret).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'exa', value: 'sk-123', hostPattern: 'mcp.exa.ai' }),
    );
  });

  it('refreshes (replaces) an existing entry when the value is env-backed — rotation propagation', async () => {
    process.env.AGENT_RECON_TEST_KEY = 'sk-rotated';
    upsertCredentialRoute(ROUTE);
    vi.mocked(listSecrets).mockResolvedValue([{ id: 'v1', name: 'exa', type: 'generic', hostPattern: 'mcp.exa.ai' }]);
    const summary = await reconcileCredentials();
    expect(summary.refreshed).toEqual(['exa']);
    expect(replaceSecret).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'v1' }),
      expect.objectContaining({ value: 'sk-rotated' }),
    );
    expect(createSecret).not.toHaveBeenCalled();
  });

  it('never touches a hand-managed entry when no AGENT_ value exists', async () => {
    upsertCredentialRoute(ROUTE); // no env value set
    vi.mocked(listSecrets).mockResolvedValue([{ id: 'v1', name: 'exa', type: 'generic', hostPattern: 'mcp.exa.ai' }]);
    const summary = await reconcileCredentials();
    expect(summary.untouched).toEqual(['exa']);
    expect(replaceSecret).not.toHaveBeenCalled();
    expect(deleteSecret).not.toHaveBeenCalled();
  });

  it('reports awaiting when the value is absent and no entry exists', async () => {
    upsertCredentialRoute(ROUTE);
    const summary = await reconcileCredentials();
    expect(summary.awaiting).toEqual(['exa']);
    expect(createSecret).not.toHaveBeenCalled();
  });

  it('deletes the vault entry for a tombstoned route', async () => {
    upsertCredentialRoute(ROUTE);
    tombstoneCredentialRoute('exa');
    vi.mocked(listSecrets).mockResolvedValue([{ id: 'v1', name: 'exa', type: 'generic', hostPattern: 'mcp.exa.ai' }]);
    const summary = await reconcileCredentials();
    expect(summary.deleted).toEqual(['exa']);
    expect(deleteSecret).toHaveBeenCalledWith('v1');
  });

  it('dry-run reports intent without any vault writes', async () => {
    process.env.AGENT_RECON_TEST_KEY = 'sk-123';
    upsertCredentialRoute(ROUTE);
    const summary = await reconcileCredentials({ dryRun: true });
    expect(summary.created).toEqual(['exa']);
    expect(summary.dry_run).toBe(true);
    expect(createSecret).not.toHaveBeenCalled();
  });

  it('skips entirely (with an error note) when the vault is unconfigured', async () => {
    vi.mocked(vaultConfigured).mockReturnValue(false);
    upsertCredentialRoute(ROUTE);
    const summary = await reconcileCredentials();
    expect(summary.errors[0]).toMatch(/not configured/);
    expect(listSecrets).not.toHaveBeenCalled();
  });

  it('collects a per-route error without aborting the rest', async () => {
    process.env.AGENT_RECON_TEST_KEY = 'sk-123';
    upsertCredentialRoute(ROUTE);
    upsertCredentialRoute({ ...ROUTE, name: 'second', host_pattern: 'api.second.dev' });
    vi.mocked(createSecret).mockRejectedValueOnce(new Error('HTTP 500')).mockResolvedValueOnce(undefined);
    const summary = await reconcileCredentials();
    expect(summary.errors).toHaveLength(1);
    expect(summary.created).toHaveLength(1);
  });
});
