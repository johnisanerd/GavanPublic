/**
 * Database tab routes — PROXY to nanoclaw's admin DB browser over the network.
 *
 * pat-frontend is a SEPARATE Fly app from nanoclaw and has no local v2.db, so
 * we forward to nanoclaw's `/admin/db` (same pattern as the /api/logs.* proxy),
 * swapping the operator/viewer auth on our side for the upstream admin token.
 * Read-only by construction (nanoclaw's handler issues SELECT/PRAGMA only).
 *
 * Routes:
 *   GET /api/db          → { available, tables: [{name, exists, count}] }
 *   GET /api/db/:table   → { table, exists, columns, foreignKeys, total, rows }
 *
 * Auth: requireOperatorOrToken — Clerk session (operators) or the legacy
 * viewer token (machine/embed). 502 if nanoclaw is unreachable.
 */
import type { Hono } from 'hono';

import { requireOperator, requireOperatorOrToken } from './auth';

// PAT (security): identity-sensitive tables the low-trust viewer token (iframe
// embeds + Claude's log tools) must NOT read. A leaked token could otherwise
// poll live plaintext pairing_codes during an operator's 5-minute window and
// hijack the link, or scrape person_identifiers (emails/phones). Operators
// (Clerk session) still read every table.
const TOKEN_BLOCKED_TABLES = new Set(['pairing_codes', 'person_identifiers']);

const NANOCLAW_HOST = process.env.NANOCLAW_INTERNAL_HOST ?? 'pat-nanoclaw.internal:8767';
const NANOCLAW_SCHEME = process.env.NANOCLAW_INTERNAL_SCHEME ?? 'http';
const NANOCLAW_TOKEN = process.env.PAT_ADMIN_TOKEN ?? '';

async function proxyAdminDb(path: string, signal: AbortSignal): Promise<Response> {
  const sep = path.includes('?') ? '&' : '?';
  const url =
    `${NANOCLAW_SCHEME}://${NANOCLAW_HOST}${path}` +
    (NANOCLAW_TOKEN ? `${sep}token=${encodeURIComponent(NANOCLAW_TOKEN)}` : '');
  const upstream = await fetch(url, { signal });
  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  });
}

export function registerDbRoutes(app: Hono, viewerToken: string): void {
  app.get('/api/db', async (c) => {
    if (!(await requireOperatorOrToken(c, viewerToken))) return c.text('unauthorized', 401);
    try {
      return await proxyAdminDb('/admin/db', c.req.raw.signal);
    } catch (e) {
      return c.json({ error: `nanoclaw unreachable: ${(e as Error).message}`, available: false }, 502);
    }
  });

  app.get('/api/db/:table', async (c) => {
    const table = c.req.param('table');
    // Operators (Clerk) read everything; the viewer-token path is blocked from
    // identity-sensitive tables (see TOKEN_BLOCKED_TABLES).
    const operator = await requireOperator(c);
    if (!operator) {
      const t = c.req.query('token') ?? '';
      if (!(viewerToken && t === viewerToken)) return c.text('unauthorized', 401);
      if (TOKEN_BLOCKED_TABLES.has(table)) {
        return c.text('forbidden: the viewer token cannot read this table', 403);
      }
    }
    const qs = new URLSearchParams();
    const limit = c.req.query('limit');
    const offset = c.req.query('offset');
    if (limit) qs.set('limit', limit);
    if (offset) qs.set('offset', offset);
    const path = `/admin/db/${encodeURIComponent(table)}${qs.toString() ? `?${qs.toString()}` : ''}`;
    try {
      return await proxyAdminDb(path, c.req.raw.signal);
    } catch (e) {
      return c.json({ error: `nanoclaw unreachable: ${(e as Error).message}` }, 502);
    }
  });
}
