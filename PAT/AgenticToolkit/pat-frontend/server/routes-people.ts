/**
 * People tab + handle-linking API.
 *
 * Reads (/api/people, /api/handles) accept an operator session OR the legacy
 * viewer token (machine/embed). Writes (link/unlink) require a real operator
 * (Clerk) — the viewer token can't mutate identity. The login→person mint lives
 * on /api/me (server/index.ts), not here.
 */
import type { Hono } from 'hono';

import { requireOperator, requireOperatorOrToken } from './auth';
import { pairingTargets } from './pairing-targets';
import {
  addIdentifier,
  createPairingCode,
  deletePerson,
  ensurePersonForOperator,
  getPairingCode,
  linkHandle,
  listHandles,
  listPeople,
  removeIdentifier,
  unlinkHandle,
} from './people';

export function registerPeopleRoutes(app: Hono, viewerToken: string): void {
  app.get('/api/people', async (c) => {
    if (!(await requireOperatorOrToken(c, viewerToken))) return c.text('unauthorized', 401);
    try {
      return c.json({ people: await listPeople(c.req.raw.signal) });
    } catch (e) {
      return c.json({ error: `nanoclaw unreachable: ${(e as Error).message}` }, 502);
    }
  });

  // Per-channel pairing targets (contacts + deep-link templates) for the
  // "Link a new handle" modal's tabs. Operator-gated — same surface as the rest
  // of the dashboard; not sensitive, but no reason to expose to the viewer token.
  app.get('/api/pairing-targets', async (c) => {
    if (!(await requireOperator(c))) return c.text('unauthorized', 401);
    return c.json({ targets: pairingTargets() });
  });

  app.get('/api/handles', async (c) => {
    if (!(await requireOperatorOrToken(c, viewerToken))) return c.text('unauthorized', 401);
    const kind = c.req.query('kind') || undefined;
    const q = c.req.query('q') || undefined;
    const limit = Number(c.req.query('limit') ?? '50') || 50;
    try {
      return c.json(await listHandles(kind, q, limit, c.req.raw.signal));
    } catch (e) {
      return c.json({ error: `nanoclaw unreachable: ${(e as Error).message}` }, 502);
    }
  });

  app.post('/api/people/:id/identifier', async (c) => {
    if (!(await requireOperator(c))) return c.text('unauthorized', 401);
    const personId = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as {
      kind?: string;
      value?: string;
      verified?: boolean;
    };
    if (!body.kind || !body.value) return c.json({ error: 'kind and value required' }, 400);
    const r = await addIdentifier(personId, body.kind, body.value, body.verified ?? true);
    return r.ok ? c.json({ ok: true, data: r.data }) : c.json({ error: r.error?.message ?? 'add failed' }, 400);
  });

  app.post('/api/people/:id/identifier/remove', async (c) => {
    if (!(await requireOperator(c))) return c.text('unauthorized', 401);
    const body = (await c.req.json().catch(() => ({}))) as { kind?: string; value?: string };
    if (!body.kind || !body.value) return c.json({ error: 'kind and value required' }, 400);
    const r = await removeIdentifier(body.kind, body.value);
    return r.ok ? c.json({ ok: true }) : c.json({ error: r.error?.message ?? 'remove failed' }, 400);
  });

  app.post('/api/people/:id/link', async (c) => {
    if (!(await requireOperator(c))) return c.text('unauthorized', 401);
    const personId = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as { user_id?: string };
    if (!body.user_id) return c.json({ error: 'user_id required' }, 400);
    const r = await linkHandle(personId, body.user_id);
    return r.ok ? c.json({ ok: true }) : c.json({ error: r.error?.message ?? 'link failed' }, 400);
  });

  app.post('/api/people/:id/unlink', async (c) => {
    if (!(await requireOperator(c))) return c.text('unauthorized', 401);
    const body = (await c.req.json().catch(() => ({}))) as { user_id?: string };
    if (!body.user_id) return c.json({ error: 'user_id required' }, 400);
    const r = await unlinkHandle(body.user_id);
    return r.ok ? c.json({ ok: true }) : c.json({ error: r.error?.message ?? 'unlink failed' }, 400);
  });

  // Destructive: delete a person + cascade-deregister every linked handle.
  // Operator-only (the viewer token can't reach this). The browser enforces a
  // type-the-full-name confirmation before calling; the real gate is here +
  // the nanoclaw transaction. Returns the cascade report (incl. kept shared
  // groups) so the UI can surface what survived.
  app.post('/api/people/:id/delete', async (c) => {
    if (!(await requireOperator(c))) return c.text('unauthorized', 401);
    const personId = c.req.param('id');
    const r = await deletePerson(personId);
    return r.ok ? c.json({ ok: true, data: r.data }) : c.json({ error: r.error?.message ?? 'delete failed' }, 400);
  });

  // ── Pairing-code self-service handle linking ──
  // The operator can only ever mint a code for THEIR OWN person (resolved
  // server-side from the Clerk session) — the browser never names a person_id.
  // Minting requires a real operator; the poll is operator-scoped to their own
  // codes so one operator can't watch another's pairing.

  app.post('/api/pairing-codes', async (c) => {
    const op = await requireOperator(c);
    if (!op) return c.text('unauthorized', 401);
    const person = await ensurePersonForOperator(op);
    if (!person) return c.json({ error: 'no person for operator (people spine unreachable)' }, 502);
    const r = await createPairingCode(person.id);
    if (!r.ok || !r.data) return c.json({ error: r.error?.message ?? 'create failed' }, 400);
    // Return only what the modal needs — the code + expiry. (Never leak other
    // people's codes; this is the operator's own freshly-minted one.)
    return c.json({
      id: r.data.id,
      code: r.data.code,
      expires_at: r.data.expires_at,
    });
  });

  app.get('/api/pairing-codes/:id', async (c) => {
    const op = await requireOperator(c);
    if (!op) return c.text('unauthorized', 401);
    const person = await ensurePersonForOperator(op);
    if (!person) return c.json({ error: 'no person for operator' }, 502);
    try {
      const row = await getPairingCode(c.req.param('id'), c.req.raw.signal);
      // Scope: an operator may only poll their OWN person's codes.
      if (!row || row.person_id !== person.id) return c.json({ error: 'not found' }, 404);
      return c.json({
        id: row.id,
        code: row.code,
        expires_at: row.expires_at,
        consumed_at: row.consumed_at,
        linked_user_id: row.linked_user_id,
      });
    } catch (e) {
      return c.json({ error: `nanoclaw unreachable: ${(e as Error).message}` }, 502);
    }
  });
}
