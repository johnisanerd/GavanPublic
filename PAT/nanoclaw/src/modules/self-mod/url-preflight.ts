/**
 * PAT: MCP endpoint preflight — one unauthenticated `initialize` POST that
 * distinguishes "wrong path" from everything else BEFORE an approval card is
 * spent on it. Motivating incident: the agent wired apify at the conventional
 * /mcp path; Apify serves MCP at the root, so the handshake 404'd invisibly
 * and the agent spun theories at the operator ("maybe restart?").
 *
 * Verdicts:
 *   'wrong-path'  — 404/405: the path definitively isn't an MCP endpoint.
 *   'ok'          — anything else that answered (200, 401 needs-auth — the
 *                   vault injects at egress, so 401 here is EXPECTED, 403,
 *                   5xx vendor-down, …). Never block on maybe-transient.
 *   'skipped'     — we refused to probe (see the SSRF guard) or the network
 *                   errored. Behave exactly as before this feature existed.
 *
 * SSRF guard: this runs on the HOST with open egress, against an
 * AGENT-supplied URL. Unguarded, the agent could aim the host's own HTTP
 * client at internal control planes (e.g. the OneCLI vault admin API on
 * localhost:10254). So: https only, resolve the hostname and refuse
 * loopback / private / link-local ranges, never follow redirects, 3s cap.
 * (Resolve-then-fetch has a theoretical DNS-rebinding gap — acceptable for a
 * trusted-internal, single-admin install; the wiring itself is admin-approved.)
 * A skipped probe never blocks wiring — private/http MCP entries stay possible.
 */
import dns from 'dns/promises';
import net from 'net';

export interface PreflightResult {
  verdict: 'ok' | 'wrong-path' | 'skipped';
  status?: number;
}

function isForbiddenAddress(addr: string): boolean {
  if (net.isIPv4(addr)) {
    const [a, b] = addr.split('.').map(Number);
    return (
      a === 127 || // loopback
      a === 10 || // private
      (a === 172 && b >= 16 && b <= 31) || // private
      (a === 192 && b === 168) || // private
      (a === 169 && b === 254) || // link-local / cloud metadata
      a === 0
    );
  }
  const lower = addr.toLowerCase();
  return (
    lower === '::1' ||
    lower === '::' ||
    lower.startsWith('fc') || // ULA fc00::/7
    lower.startsWith('fd') ||
    lower.startsWith('fe80') || // link-local
    lower.startsWith('::ffff:') // v4-mapped — re-check would be needed; refuse
  );
}

export async function preflightMcpUrl(url: string): Promise<PreflightResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { verdict: 'skipped' };
  }
  if (parsed.protocol !== 'https:') return { verdict: 'skipped' };

  let addrs;
  try {
    addrs = await dns.lookup(parsed.hostname, { all: true });
  } catch {
    return { verdict: 'skipped' };
  }
  if (addrs.length === 0 || addrs.some((a) => isForbiddenAddress(a.address))) {
    return { verdict: 'skipped' };
  }

  try {
    const res = await fetch(parsed.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'nanoclaw-preflight', version: '1' },
        },
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(3_000),
    });
    if (res.status === 404 || res.status === 405) return { verdict: 'wrong-path', status: res.status };
    return { verdict: 'ok', status: res.status };
  } catch {
    return { verdict: 'skipped' };
  }
}
