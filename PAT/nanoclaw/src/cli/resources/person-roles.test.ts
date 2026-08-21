/**
 * PAT: person-roles resource — dashboard data-visibility authority (person-keyed).
 * Verifies grant/list/revoke + one-role-per-person upsert + validation guards,
 * driven through the real `dispatch` (caller:'host') path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, runMigrations, getDb } from '../../db/index.js';
import { dispatch } from '../dispatch.js';
import './index.js'; // register all resources (side-effect)

const now = () => new Date().toISOString();

function seedPerson(id: string): void {
  getDb()
    .prepare(`INSERT INTO people (id, first_name, last_name, created_at) VALUES (?, 'Ada', 'L', ?)`)
    .run(id, now());
}
// dispatch returns a discriminated ResponseFrame; tests assert on ok/data, so
// view it through a loose shape (the `.ok` check is the real assertion).
type Frame = { ok: boolean; data?: unknown; error?: { message: string } };
const grant = (args: Record<string, unknown>) =>
  dispatch({ id: 't', command: 'person-roles-grant', args }, { caller: 'host' }) as Promise<Frame>;
const revoke = (args: Record<string, unknown>) =>
  dispatch({ id: 't', command: 'person-roles-revoke', args }, { caller: 'host' }) as Promise<Frame>;
const list = () => dispatch({ id: 't', command: 'person-roles-list', args: {} }, { caller: 'host' }) as Promise<Frame>;

describe('person-roles resource', () => {
  beforeEach(() => {
    runMigrations(initTestDb());
    seedPerson('person-x');
  });
  afterEach(() => closeDb());

  it('grants a role and lists it', async () => {
    const g = await grant({ person: 'person-x', role: 'admin' });
    expect(g.ok).toBe(true);
    const l = await list();
    expect(l.ok).toBe(true);
    expect(l.data).toEqual([expect.objectContaining({ person_id: 'person-x', role: 'admin' })]);
  });

  it('keeps one role per person — re-grant replaces, not appends', async () => {
    await grant({ person: 'person-x', role: 'admin' });
    await grant({ person: 'person-x', role: 'employee' });
    const l = await list();
    expect((l.data as unknown[]).length).toBe(1);
    expect(l.data).toEqual([expect.objectContaining({ person_id: 'person-x', role: 'employee' })]);
  });

  it('rejects an unknown role', async () => {
    const r = await grant({ person: 'person-x', role: 'wizard' });
    expect(r.ok).toBe(false);
  });

  it('rejects a person that does not exist', async () => {
    const r = await grant({ person: 'ghost', role: 'admin' });
    expect(r.ok).toBe(false);
  });

  it('revokes a role, and revoking a non-existent role errors', async () => {
    await grant({ person: 'person-x', role: 'admin' });
    const rev = await revoke({ person: 'person-x' });
    expect(rev.ok).toBe(true);
    expect((await list()).data).toEqual([]);
    const again = await revoke({ person: 'person-x' });
    expect(again.ok).toBe(false);
  });
});
