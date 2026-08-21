/**
 * PAT admin/observatory HTTP server — own listener on its own port.
 *
 * Phase 2 of the admin/observatory extraction (R10 in
 * plans/refactor-bundle-2026-05-14.md). Phase 1 (R7) moved the
 * handlers off `src/channels/phone-call.ts` into `src/admin/index.ts`
 * but kept dispatch on phone-call's port (8765). This server gives
 * them their own listener so pat-frontend (the dashboard Fly app
 * embedded in pat-web via iframe) can target it directly without
 * routing through the channel HTTP surface.
 *
 * Phone-call.ts retains a `POST /admin/log-event` dispatch on 8765
 * for voice-transport's structured-event ingress (voice-transport
 * doesn't know about the admin port). Read endpoints
 * (`/admin/logs.jsonl`, `/admin/logs.tail`, `/admin/monitor`,
 * `/admin/sessions/<id>/host-log.jsonl`) live exclusively here.
 *
 * Lifecycle: started by the realtime channel adapter's setup() and
 * stopped by its teardown() — same lifecycle window as the realtime
 * channel server. (Could be lifted to host main if/when nanoclaw
 * upstream absorbs the dashboard concept.)
 */

import http from 'http';

import { log } from '../log.js';
import { tryHandleAdminRequest } from './index.js';

const DEFAULT_ADMIN_PORT = 8767;

let server: http.Server | null = null;

export function adminPort(): number {
  const raw = process.env.PAT_ADMIN_PORT;
  if (!raw) return DEFAULT_ADMIN_PORT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_ADMIN_PORT;
}

export async function startAdminServer(): Promise<void> {
  if (server) return;
  const port = adminPort();
  // PAT (security): the admin server must NOT be reachable from the docker
  // bridge — agent containers on 172.17.x can otherwise hit unauthenticated
  // admin endpoints (e.g. POST /scenarios/provision, which stands up a public,
  // secret-bearing agent group). On Fly we bind the 6PN private address
  // (FLY_PRIVATE_IP) so only 6PN peers (pat-web / pat-frontend via *.internal)
  // reach it, not bridge-side containers. Explicit PAT_ADMIN_BIND_HOST still
  // wins (escape hatch — set it to :: to revert if 6PN reachability regresses);
  // local dev with none of these set falls back to loopback.
  const host =
    process.env.PAT_ADMIN_BIND_HOST || process.env.FLY_PRIVATE_IP || process.env.REALTIME_BIND_HOST || '127.0.0.1';
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (await tryHandleAdminRequest(req, res, url)) return;
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found', path: url.pathname }));
  });
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(port, host, () => {
      log.info('Admin server listening', { port, host });
      resolve();
    });
  });
}

export async function stopAdminServer(): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
}
