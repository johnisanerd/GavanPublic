// PAT: tests for the MCP endpoint preflight (SSRF guard + verdict mapping).
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('dns/promises', () => ({
  default: { lookup: vi.fn() },
}));

import dns from 'dns/promises';
import { preflightMcpUrl } from './url-preflight.js';

const lookup = vi.mocked(dns.lookup);

function mockFetchStatus(status: number): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status } as Response));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('preflightMcpUrl', () => {
  it('404/405 → wrong-path (the apify incident)', async () => {
    lookup.mockResolvedValue([{ address: '34.1.2.3', family: 4 }] as never);
    mockFetchStatus(404);
    expect(await preflightMcpUrl('https://mcp.apify.com/mcp')).toEqual({ verdict: 'wrong-path', status: 404 });
  });

  it('401 → ok (auth is injected at egress later — expected on a bare probe)', async () => {
    lookup.mockResolvedValue([{ address: '34.1.2.3', family: 4 }] as never);
    mockFetchStatus(401);
    expect(await preflightMcpUrl('https://mcp.apify.com/')).toEqual({ verdict: 'ok', status: 401 });
  });

  it('5xx → ok (vendor may be transiently down; never block on that)', async () => {
    lookup.mockResolvedValue([{ address: '34.1.2.3', family: 4 }] as never);
    mockFetchStatus(503);
    expect((await preflightMcpUrl('https://mcp.x.dev/mcp')).verdict).toBe('ok');
  });

  it('refuses to probe non-https and unparseable URLs (skipped, never fetches)', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect((await preflightMcpUrl('http://internal.dev/mcp')).verdict).toBe('skipped');
    expect((await preflightMcpUrl('not a url')).verdict).toBe('skipped');
    expect(f).not.toHaveBeenCalled();
  });

  it('SSRF guard: refuses loopback/private/link-local resolutions, never fetches', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    for (const address of ['127.0.0.1', '10.0.0.5', '172.18.0.2', '192.168.1.1', '169.254.169.254']) {
      lookup.mockResolvedValue([{ address, family: 4 }] as never);
      expect((await preflightMcpUrl('https://evil.example.com/mcp')).verdict).toBe('skipped');
    }
    lookup.mockResolvedValue([{ address: '::1', family: 6 }] as never);
    expect((await preflightMcpUrl('https://evil6.example.com/mcp')).verdict).toBe('skipped');
    expect(f).not.toHaveBeenCalled();
  });

  it('network error / DNS failure → skipped (behave as before the feature)', async () => {
    lookup.mockRejectedValue(new Error('ENOTFOUND'));
    expect((await preflightMcpUrl('https://gone.example.com/mcp')).verdict).toBe('skipped');
    lookup.mockResolvedValue([{ address: '34.1.2.3', family: 4 }] as never);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    expect((await preflightMcpUrl('https://slow.example.com/mcp')).verdict).toBe('skipped');
  });
});
