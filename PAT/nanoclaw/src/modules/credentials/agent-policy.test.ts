// PAT: tests for the selective-by-default policy on newly-created OneCLI agents.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./onecli-vault.js', () => ({
  listAgents: vi.fn(),
  listSecrets: vi.fn(),
  setAgentSecretMode: vi.fn().mockResolvedValue(undefined),
  setAgentSecrets: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../log.js', () => ({
  log: { event: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { log } from '../../log.js';
import { listAgents, listSecrets, setAgentSecretMode, setAgentSecrets } from './onecli-vault.js';
import { applyNewAgentSecretPolicy } from './agent-policy.js';

const AGENT = { id: 'agent-uuid-1', name: 'New Group', identifier: 'ag-new-123', secretMode: 'all' as const };
const SECRETS = [
  { id: 'sec-anthropic', name: 'anthropic-prod', type: 'anthropic', hostPattern: 'api.anthropic.com' },
  { id: 'sec-exa', name: 'exa', type: 'generic', hostPattern: 'mcp.exa.ai' },
];

describe('applyNewAgentSecretPolicy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listAgents).mockResolvedValue([AGENT]);
    vi.mocked(listSecrets).mockResolvedValue(SECRETS);
  });

  it('flips a new agent to selective with ONLY the baseline (anthropic) assigned', async () => {
    await applyNewAgentSecretPolicy('ag-new-123');
    expect(setAgentSecretMode).toHaveBeenCalledWith('agent-uuid-1', 'selective');
    expect(setAgentSecrets).toHaveBeenCalledWith('agent-uuid-1', ['sec-anthropic']);
  });

  it('throws when the agent is not found (spawn aborts; sweep retries)', async () => {
    vi.mocked(listAgents).mockResolvedValue([]);
    await expect(applyNewAgentSecretPolicy('ag-new-123')).rejects.toThrow(/not found/);
    expect(setAgentSecretMode).not.toHaveBeenCalled();
  });

  it('still scopes selective (empty assignment) + warns when the baseline secret is missing', async () => {
    vi.mocked(listSecrets).mockResolvedValue([SECRETS[1]]); // no anthropic
    await applyNewAgentSecretPolicy('ag-new-123');
    expect(setAgentSecretMode).toHaveBeenCalledWith('agent-uuid-1', 'selective');
    expect(setAgentSecrets).toHaveBeenCalledWith('agent-uuid-1', []);
    expect(log.warn).toHaveBeenCalled();
  });

  it('propagates gateway write failures (fail closed, never half-applied silently)', async () => {
    vi.mocked(setAgentSecretMode).mockRejectedValueOnce(new Error('HTTP 500'));
    await expect(applyNewAgentSecretPolicy('ag-new-123')).rejects.toThrow('HTTP 500');
  });
});
