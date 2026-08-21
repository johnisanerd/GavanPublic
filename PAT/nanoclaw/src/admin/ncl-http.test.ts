/**
 * PAT: integration test for the POST /admin/ncl bridge. Real I/O — boots the
 * admin HTTP server against an in-memory DB and drives it with fetch(),
 * asserting the ncl ResponseFrame round-trips and error frames map to the
 * right HTTP status (200 ok / 404 unknown-command / 400 handler+invalid).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// The admin server transitively imports the resources barrel → dispatch →
// approvals → container-runner. Mock the heavy runtime dep like groups.test.ts.
vi.mock('../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

import { initTestDb, closeDb, runMigrations } from '../db/index.js';
import { startAdminServer, stopAdminServer, adminPort } from './server.js';

let base: string;

async function ncl(command: string, args: Record<string, unknown> = {}) {
  const res = await fetch(`${base}/admin/ncl`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
    body: JSON.stringify({ command, args }),
  });
  return { status: res.status, body: (await res.json()) as { ok: boolean; data?: unknown; error?: { code: string } } };
}

describe('POST /admin/ncl bridge', () => {
  beforeAll(async () => {
    runMigrations(initTestDb());
    process.env.PAT_ADMIN_PORT = '8771';
    // The bridge is opt-in + fail-closed: enable it and configure the token.
    process.env.PAT_ENABLE_NCL_HTTP = '1';
    process.env.PAT_ADMIN_TOKEN = 'test-token';
    await startAdminServer();
    base = `http://127.0.0.1:${adminPort()}`;
  });
  afterAll(async () => {
    await stopAdminServer();
    closeDb();
    delete process.env.PAT_ENABLE_NCL_HTTP;
    delete process.env.PAT_ADMIN_TOKEN;
  });

  it('rejects a request with no/bad token (401) even when enabled', async () => {
    const res = await fetch(`${base}/admin/ncl`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'people-list' }),
    });
    expect(res.status).toBe(401);
  });

  it('round-trips a people-create and reflects it in people-list (200)', async () => {
    const created = await ncl('people-create', { 'first-name': 'Ada', 'last-name': 'Lovelace' });
    expect(created.status).toBe(200);
    expect(created.body.ok).toBe(true);
    expect((created.body.data as { id: string }).id).toMatch(/^person-/);

    const list = await ncl('people-list');
    expect(list.status).toBe(200);
    expect((list.body.data as unknown[]).length).toBe(1);
  });

  it('maps an unknown command to 404', async () => {
    const r = await ncl('people-frobnicate');
    expect(r.status).toBe(404);
    expect(r.body.error?.code).toBe('unknown-command');
  });

  it('maps a handler error (missing required arg) to 400', async () => {
    const r = await ncl('people-create', { 'first-name': 'NoLast' });
    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
  });

  it('maps a malformed body to 400', async () => {
    const res = await fetch(`${base}/admin/ncl`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });
});
