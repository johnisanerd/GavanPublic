/**
 * PAT: `ncl people` dispatch-layer test — verifies the resource registers,
 * custom ops route, host writes bypass approval, generic list/get work without
 * a `scopeField`, and the group-scope security boundary holds (people is NOT on
 * the whitelist, so a group-scoped agent can't reach it). The people module
 * logic itself is covered by src/people/people.test.ts.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

// dispatch.ts pulls in the approvals module → container-runner; mock it like
// groups.test.ts so the dispatch import doesn't drag in real runtime deps.
vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

import { initTestDb, closeDb, runMigrations, getDb } from '../../db/index.js';
import { dispatch } from '../dispatch.js';
// Side-effect import: registers the `people-*` commands.
import './people.js';
import type { CallerContext } from '../frame.js';

const HOST: CallerContext = { caller: 'host' };
const now = (): string => new Date().toISOString();

async function call(command: string, args: Record<string, unknown> = {}, ctx: CallerContext = HOST) {
  return dispatch({ id: `req-${command}`, command, args }, ctx);
}

function ok<T = unknown>(resp: Awaited<ReturnType<typeof dispatch>>): T {
  if (!resp.ok) throw new Error(`expected ok, got error: ${resp.error.code} ${resp.error.message}`);
  return resp.data as T;
}

describe('ncl people dispatch', () => {
  beforeEach(() => {
    runMigrations(initTestDb());
  });
  afterEach(() => closeDb());

  it('creates, lists, and gets a person (generic list/get work without scopeField for host)', async () => {
    const created = ok<{ id: string }>(await call('people-create', { first_name: 'Ada', last_name: 'Lovelace' }));
    expect(created.id).toMatch(/^person-/);

    const list = ok<Array<{ id: string }>>(await call('people-list'));
    expect(list.map((p) => p.id)).toContain(created.id);

    const got = ok<{ first_name: string }>(await call('people-get', { id: created.id }));
    expect(got.first_name).toBe('Ada');
  });

  it('adds an identifier and resolves the person by it (custom ops route)', async () => {
    const p = ok<{ id: string }>(await call('people-create', { first_name: 'Ada', last_name: 'L' }));
    ok(await call('people-add-identifier', { person_id: p.id, kind: 'phone', value: '+1 555 010 0001' }));
    const resolved = ok<{ id: string } | null>(await call('people-resolve', { kind: 'phone', value: '+15550100001' }));
    expect(resolved?.id).toBe(p.id);
  });

  it('links an existing handle and lists it', async () => {
    const p = ok<{ id: string }>(await call('people-create', { first_name: 'Ada', last_name: 'L' }));
    getDb()
      .prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'signal', NULL, ?)`)
      .run('signal:+15550100001', now());
    ok(await call('people-link', { user_id: 'signal:+15550100001', person_id: p.id }));
    const handles = ok<Array<{ user_id: string }>>(await call('people-handles', { person_id: p.id }));
    expect(handles.map((h) => h.user_id)).toEqual(['signal:+15550100001']);
  });

  it('surfaces handler errors as error frames (missing required arg)', async () => {
    const resp = await call('people-create', { first_name: 'Ada' }); // no last_name
    expect(resp.ok).toBe(false);
  });

  it('blocks a group-scoped agent (people is not on the CLI whitelist)', async () => {
    // A group-scoped agent caller: people is not in the dispatch whitelist
    // ['groups','sessions','destinations','members'], so this is forbidden
    // before the handler runs.
    const resp = await call(
      'people-list',
      {},
      { caller: 'agent', agentGroupId: 'ag-x', sessionId: 'sess-x', messagingGroupId: 'mg-x' },
    );
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.code).toBe('forbidden');
  });
});
