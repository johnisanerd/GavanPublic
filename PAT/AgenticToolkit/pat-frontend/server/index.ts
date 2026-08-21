/**
 * pat-frontend — Hono server.
 *
 * Two responsibilities:
 *   1. Serve the built React SPA (dist/) and its static assets.
 *   2. Proxy `/api/logs.tail` to the upstream nanoclaw `/admin/logs.tail`
 *      SSE feed, swapping the viewer token for the admin token.
 *
 * Deliberately tiny — every other admin route on nanoclaw is *not*
 * proxied. A leaked viewer token grants read-only monitor access only.
 */
import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { serveStatic } from 'hono/bun';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerDbRoutes } from './routes-db';
import { registerCapabilityRoutes } from './routes-capabilities';
import { registerPeopleRoutes } from './routes-people';
import { ensurePersonForOperator, getRole, getIdentifiers, getHandlesForPerson } from './people';
// PAT: runtime PUBLIC_ env injection — replaces the VITE_ Clerk build-arg.
import { injectPublicEnv } from './public-env';
// PAT (Phase 0): operator auth — Google OAuth via Clerk, @palisaderesearch.org gate.
// requireOperatorOrToken: Clerk session (normal) OR the legacy viewer token.
import { requireOperator, requireOperatorOrToken } from './auth';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(__dirname, '..', 'dist');
const INDEX_HTML = join(DIST_DIR, 'index.html');

const PORT = Number(process.env.PORT ?? 8787);
const VIEWER_TOKEN = process.env.PAT_VIEWER_TOKEN ?? '';
const NANOCLAW_TOKEN = process.env.PAT_ADMIN_TOKEN ?? '';
const NANOCLAW_HOST =
  process.env.NANOCLAW_INTERNAL_HOST ?? 'pat-nanoclaw.internal:8767';
const NANOCLAW_SCHEME = process.env.NANOCLAW_INTERNAL_SCHEME ?? 'http';
const RECONNECT_MS = 1500;
const KEEPALIVE_MS = 15_000;

const app = new Hono();

// ──────────────────────── Security headers ─────────────────────────
// PAT (webapp W3/W4, security): clickjacking + referrer hardening on the
// operator dashboard. Only the pat-web avatar app legitimately frames this page
// (it embeds pat-frontend in an iframe); deny every other origin so an attacker
// page can't frame the authenticated dashboard and trick an operator into
// state-changing clicks. `frame-ancestors` (CSP) is the modern control —
// X-Frame-Options can't express an allowlist. `Referrer-Policy: no-referrer`
// stops the viewer token (carried in the iframe URL) leaking via Referer.
const FRAME_ANCESTORS =
  process.env.PAT_FRAME_ANCESTORS ?? "'self' https://pat-web.fly.dev https://pat-web-staging.fly.dev";
app.use('*', async (c, next) => {
  await next();
  // NB: no X-Frame-Options — it can't express "self + pat-web" (only DENY /
  // SAMEORIGIN / deprecated ALLOW-FROM), and SAMEORIGIN would break the legit
  // cross-origin pat-web embed. CSP frame-ancestors is the correct, well-supported
  // control here.
  c.header('Content-Security-Policy', `frame-ancestors ${FRAME_ANCESTORS}`);
  c.header('Referrer-Policy', 'no-referrer');
});

// ──────────────────────── Health check ─────────────────────────────
// Always 200, no auth — used by the platform's TCP/HTTP probes.
app.get('/healthz', (c) => c.text('ok'));

// ──────────────────────── Operator auth (Clerk) ────────────────────
// No middleware: requireOperator() verifies the Clerk session per-request via
// @clerk/backend authenticateRequest (reads the same-origin __session cookie or
// a Bearer header), which is safe on streaming routes too. See server/auth.ts.

// Who am I — the OAuth round-trip proof + the dashboard's "current operator"
// endpoint. 403 unless a signed-in @palisaderesearch.org user (or the local
// dev bypass).
app.get('/api/me', async (c) => {
  const operator = await requireOperator(c);
  if (!operator) return c.json({ error: 'unauthorized' }, 403);
  // Login→person mint: ensure this operator has a person row (created on first
  // login with a verified `email` identifier). Idempotent + fails soft, so a
  // people-spine hiccup never blocks login.
  const person = await ensurePersonForOperator(operator);
  // identifiers let the client detect a missing phone (first-login capture
  // modal); handles power the "My Handles" view. [] when there's no person;
  // both fail soft on read error.
  const [role, identifiers, handles] = person
    ? await Promise.all([getRole(person.id), getIdentifiers(person.id), getHandlesForPerson(person.id)])
    : [null, [], []];
  return c.json({ ...operator, person, role, identifiers, handles });
});

// ──────────────────────── New tab routes ───────────────────────────
// Database tab (readonly central v2.db browser) + Capability tab
// (front-mind capability list). Both share the viewer-token auth
// pattern of the log proxy routes. See server/routes-db.ts and
// server/routes-capabilities.ts.
registerDbRoutes(app, VIEWER_TOKEN);
registerCapabilityRoutes(app, VIEWER_TOKEN);
// People tab + handle-linking (reads: operator|viewer; writes: operator only).
registerPeopleRoutes(app, VIEWER_TOKEN);
// (removed registerUserMutationRoutes — it gated POST/PUT/DELETE /api/db/users on
//  the VIEWER token, not OAuth (an auth inversion), and wrote the central DB
//  directly from this app (single-writer violation). The People view's writes
//  will go through nanoclaw's ncl, operator-identity-gated. See the security
//  hardening notes in plans/dashboard-permissions.md.)

// ──────────────────────── Historical JSONL proxy ───────────────────
//
// Forwards every query param through to the upstream nanoclaw
// `/admin/logs.jsonl` (which supports since/until/date/thread_id/
// session_id/kind/source/levels/include_debug — see admin/index.ts).
// Streams `application/x-ndjson` back to the caller; no SSE framing.
//
// Usage from a shell (the canonical forensics pull):
//   curl -sS "https://pat-frontend.fly.dev/api/logs.jsonl?token=<viewer>&thread_id=<id>&since=<ms>" | jq
//
// To pull the FULL LLM-call traces (default-excluded), append
// `&include_debug=1` or `&levels=debug,info,warn,error`.
app.get('/api/logs.jsonl', async (c) => {
  if (!(await requireOperatorOrToken(c, VIEWER_TOKEN))) {
    return c.text('unauthorized', 401);
  }
  // Forward every param except the viewer token. The upstream's own
  // admin-token auth (PAT_ADMIN_TOKEN) goes in via the proxy here.
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(c.req.queries())) {
    if (k === 'token') continue;
    for (const val of v) qs.append(k, val);
  }
  if (NANOCLAW_TOKEN) qs.set('token', NANOCLAW_TOKEN);
  const upstreamUrl = `${NANOCLAW_SCHEME}://${NANOCLAW_HOST}/admin/logs.jsonl?${qs.toString()}`;
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, { signal: c.req.raw.signal });
  } catch (e) {
    return c.json({ error: `upstream unreachable: ${(e as Error).message}` }, 502);
  }
  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '');
    return c.json(
      { error: `upstream ${upstream.status}`, detail: detail.slice(0, 400) },
      upstream.status as 400 | 500,
    );
  }
  c.header('content-type', 'application/x-ndjson');
  c.header('x-accel-buffering', 'no'); // hint for any reverse-proxy buffering
  return stream(c, async (s) => {
    // PAT: flush response headers immediately so Fly's edge doesn't 502
    // when the upstream takes a few seconds to produce its first matching
    // line. Empty lines are ignored by every NDJSON parser, so this is
    // safe on the wire. nanoclaw also emits its own keepalive '\n' lines.
    await s.write('\n');
    const reader = upstream.body!.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        await s.write(decoder.decode(value, { stream: true }));
      }
    } catch {
      /* upstream broke mid-stream; close gracefully */
    }
  });
});

// ──────────────────────── Published files (PUBLIC) ─────────────────
// PAT (publish_file): pass-through for nanoclaw's signed expiring file
// URLs. Deliberately UNAUTHENTICATED here — each URL carries its own
// HMAC + expiry, validated by nanoclaw (src/modules/file-publish/);
// this app just owns the public plsd.app cert. Only exact
// /files/pub/<one-segment> GETs are forwarded — everything else on the
// admin surface stays unreachable from the internet.
app.get('/files/pub/:name', async (c) => {
  const name = c.req.param('name');
  if (!name || name.includes('/') || name.includes('..')) return c.text('not found', 404);
  const qs = new URLSearchParams();
  const exp = c.req.query('exp');
  const sig = c.req.query('sig');
  if (exp) qs.set('exp', exp);
  if (sig) qs.set('sig', sig);
  const upstreamUrl = `${NANOCLAW_SCHEME}://${NANOCLAW_HOST}/files/pub/${encodeURIComponent(name)}?${qs.toString()}`;
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, { signal: c.req.raw.signal });
  } catch (e) {
    return c.json({ error: `upstream unreachable: ${(e as Error).message}` }, 502);
  }
  // Mirror status + the content headers nanoclaw sets (type, disposition,
  // nosniff, CSP sandbox); stream the body through untouched.
  const headers = new Headers();
  for (const h of [
    'content-type',
    'content-length',
    'content-disposition',
    'x-content-type-options',
    'content-security-policy',
    'cache-control',
  ]) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
});

// ──────────────────────── SSE proxy ────────────────────────────────
app.get('/api/logs.tail', async (c) => {
  if (!(await requireOperatorOrToken(c, VIEWER_TOKEN))) {
    return c.text('unauthorized', 401);
  }

  c.header('content-type', 'text/event-stream');
  c.header('cache-control', 'no-cache, no-transform');
  c.header('connection', 'keep-alive');
  c.header('x-accel-buffering', 'no'); // hint for any reverse-proxy buffering

  // Forward `?since=<ms>` from the viewer through to nanoclaw — used
  // by the dashboard to skip historical backlog on a fresh load.
  const sinceParam = c.req.query('since');

  return stream(c, async (s) => {
    let cancelled = false;
    s.onAbort(() => {
      cancelled = true;
    });

    const qs = new URLSearchParams();
    if (NANOCLAW_TOKEN) qs.set('token', NANOCLAW_TOKEN);
    if (sinceParam) qs.set('since', sinceParam);
    const upstreamUrl =
      `${NANOCLAW_SCHEME}://${NANOCLAW_HOST}/admin/logs.tail` +
      (qs.toString() ? `?${qs.toString()}` : '');

    await s.writeln(': pat-frontend proxy connected');

    // Independent keepalive so the downstream connection (browser ←→ proxy)
    // stays warm even when the upstream nanoclaw log is idle for long
    // stretches. Without this, intermediate proxies (Fly edge, vite dev,
    // any reverse-proxy) silently drop idle SSE connections after ~30s.
    let lastWriteAt = Date.now();
    const safeWrite = async (chunk: string) => {
      lastWriteAt = Date.now();
      await s.write(chunk);
    };
    const keepaliveTimer = setInterval(() => {
      if (cancelled) return;
      if (Date.now() - lastWriteAt < KEEPALIVE_MS) return;
      // ":\n\n" is a valid SSE comment line — browsers ignore it but the
      // bytes flow through every intermediate proxy.
      void s.write(`: ka\n\n`).then(() => {
        lastWriteAt = Date.now();
      });
    }, 5_000);
    s.onAbort(() => clearInterval(keepaliveTimer));

    try {
      while (!cancelled) {
        try {
          const upstream = await fetch(upstreamUrl, {
            headers: { accept: 'text/event-stream' },
            signal: c.req.raw.signal,
          });

          if (!upstream.ok || !upstream.body) {
            await safeWrite(`: upstream returned ${upstream.status}\n\n`);
            await s.sleep(RECONNECT_MS);
            continue;
          }

          const reader = upstream.body.getReader();
          const decoder = new TextDecoder();
          await safeWrite(': upstream connected\n\n');

          // eslint-disable-next-line no-constant-condition
          while (true) {
            if (cancelled) {
              try {
                await reader.cancel();
              } catch {
                /* noop */
              }
              return;
            }
            const { value, done } = await reader.read();
            if (done) break;
            await safeWrite(decoder.decode(value, { stream: true }));
          }
        } catch (err) {
          if (cancelled) return;
          await safeWrite(`: upstream error ${(err as Error).message}\n\n`);
        }

        if (cancelled) return;
        await safeWrite(`: reconnecting in ${RECONNECT_MS}ms\n\n`);
        await s.sleep(RECONNECT_MS);
      }
    } finally {
      clearInterval(keepaliveTimer);
    }
  });
});

// ──────────────────────── Static SPA ───────────────────────────────
// Serve assets from dist/ — everything that isn't /api/* or /healthz.
app.use('/assets/*', serveStatic({ root: './dist' }));
app.use('/favicon.svg', serveStatic({ path: './dist/favicon.svg' }));

// SPA fallback: serve index.html for any unmatched GET (so that future
// client-side routing keeps working without 404s).
app.get('*', (c) => {
  if (!existsSync(INDEX_HTML)) {
    return c.text(
      'pat-frontend SPA bundle missing. Run `vite build` before starting the server.',
      500,
    );
  }
  // Inject PUBLIC_* env (prefix stripped) as window.__PUBLIC_ENV__ so the client
  // reads runtime config (e.g. CLERK_PUBLISHABLE_KEY) instead of a baked build-arg.
  const html = injectPublicEnv(readFileSync(INDEX_HTML, 'utf8'), process.env);
  c.header('content-type', 'text/html; charset=utf-8');
  return c.body(html);
});

console.log(`[pat-frontend] listening on :${PORT}  (upstream=${NANOCLAW_SCHEME}://${NANOCLAW_HOST})`);

export default {
  port: PORT,
  fetch: app.fetch,
};
