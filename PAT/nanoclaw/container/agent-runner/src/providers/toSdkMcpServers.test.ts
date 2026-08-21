// PAT: contract test for the McpServerConfig → SDK-shape translation.
// Catches typos / field-rename regressions in toSdkMcpServers — the
// production path used by Apify (Wave 2.D) and any other http MCP
// integration. Pure translation; no network, no SDK round-trip.
import { describe, it, expect } from 'bun:test';

import { toSdkMcpServers } from './claude.js';
import type { McpServerConfig } from './types.js';

describe('toSdkMcpServers', () => {
  it('maps a stdio config to type:stdio', () => {
    const input: Record<string, McpServerConfig> = {
      local: { command: 'node', args: ['server.js'], env: { FOO: 'bar' } },
    };
    expect(toSdkMcpServers(input)).toEqual({
      local: { type: 'stdio', command: 'node', args: ['server.js'], env: { FOO: 'bar' } },
    });
  });

  it('maps an http config (e.g. Apify) to type:http', () => {
    const input: Record<string, McpServerConfig> = {
      apify: {
        transport: 'http',
        url: 'https://mcp.apify.com',
        headers: { 'x-test': '1' },
      },
    };
    expect(toSdkMcpServers(input)).toEqual({
      apify: { type: 'http', url: 'https://mcp.apify.com', headers: { 'x-test': '1' } },
    });
  });

  it('preserves an http config without headers (OneCLI-injected case)', () => {
    const input: Record<string, McpServerConfig> = {
      apify: { transport: 'http', url: 'https://mcp.apify.com' },
    };
    expect(toSdkMcpServers(input)).toEqual({
      apify: { type: 'http', url: 'https://mcp.apify.com', headers: undefined },
    });
  });

  it('handles mixed stdio + http in one map', () => {
    const input: Record<string, McpServerConfig> = {
      local: { command: 'node', args: [], env: {} },
      apify: { transport: 'http', url: 'https://mcp.apify.com' },
    };
    const out = toSdkMcpServers(input);
    expect(out.local).toMatchObject({ type: 'stdio', command: 'node' });
    expect(out.apify).toMatchObject({ type: 'http', url: 'https://mcp.apify.com' });
  });

  it('returns an empty object for an empty input', () => {
    expect(toSdkMcpServers({})).toEqual({});
  });
});
