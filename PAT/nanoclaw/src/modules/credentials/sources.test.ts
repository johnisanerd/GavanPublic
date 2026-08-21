// PAT: tests for the two credential-source seams (inline/AGENT_ impls).
import { afterEach, describe, expect, it } from 'vitest';

import type { CredentialRoute } from '../../db/credential-routing.js';
import type { VaultSecret } from './onecli-vault.js';
import { hostHasCredential, resolveVaultSecretSpec } from './sources.js';

function route(overrides: Partial<CredentialRoute> = {}): CredentialRoute {
  return {
    name: 'exa',
    host_pattern: 'mcp.exa.ai',
    header_name: 'x-api-key',
    value_format: '{value}',
    type: 'generic',
    secret_name: 'TEST_SEAM_KEY',
    deleted: 0,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('resolveVaultSecretSpec (seam 1 — inline/AGENT_ impl)', () => {
  afterEach(() => {
    delete process.env.AGENT_TEST_SEAM_KEY;
  });

  it('materializes a generic spec from AGENT_<secret_name> env', () => {
    process.env.AGENT_TEST_SEAM_KEY = 'sk-value-123';
    const spec = resolveVaultSecretSpec(route());
    expect(spec).toEqual({
      name: 'exa',
      type: 'generic',
      value: 'sk-value-123',
      hostPattern: 'mcp.exa.ai',
      injectionConfig: { headerName: 'x-api-key', valueFormat: '{value}' },
    });
  });

  it('returns null when the AGENT_ env value is absent (awaiting value)', () => {
    expect(resolveVaultSecretSpec(route())).toBeNull();
  });

  it('returns null without a secret_name or host_pattern (nothing to materialize)', () => {
    process.env.AGENT_TEST_SEAM_KEY = 'sk-value-123';
    expect(resolveVaultSecretSpec(route({ secret_name: null }))).toBeNull();
    expect(resolveVaultSecretSpec(route({ host_pattern: '' }))).toBeNull();
  });

  it('omits injectionConfig for gateway-auto-configured types (anthropic)', () => {
    process.env.AGENT_TEST_SEAM_KEY = 'sk-ant-123';
    const spec = resolveVaultSecretSpec(route({ name: 'anthropic-prod', type: 'anthropic', header_name: null }));
    expect(spec).toEqual({
      name: 'anthropic-prod',
      type: 'anthropic',
      value: 'sk-ant-123',
      hostPattern: 'mcp.exa.ai',
    });
  });

  it('defaults generic header/format when the route leaves them empty', () => {
    process.env.AGENT_TEST_SEAM_KEY = 'v';
    const spec = resolveVaultSecretSpec(route({ header_name: null, value_format: '' }));
    expect(spec?.injectionConfig).toEqual({ headerName: 'Authorization', valueFormat: 'Bearer {value}' });
  });
});

describe('hostHasCredential (seam 2 matcher)', () => {
  const secrets: VaultSecret[] = [
    { id: '1', name: 'exa', type: 'generic', hostPattern: 'mcp.exa.ai' },
    { id: '2', name: 'nohost', type: 'generic', hostPattern: null },
  ];

  it('matches an entry by exact hostPattern', () => {
    expect(hostHasCredential('mcp.exa.ai', secrets)).toBe(true);
  });

  it('misses absent hosts, empty patterns, and null-host entries', () => {
    expect(hostHasCredential('api.other.dev', secrets)).toBe(false);
    expect(hostHasCredential('', secrets)).toBe(false);
  });
});
