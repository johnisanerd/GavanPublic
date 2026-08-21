/**
 * PAT: per-person memory mounts (Phase 3). Verifies /shared is always mounted,
 * /personal only for sessions bound to a resolved person (session.user_id →
 * person via the spine), and — the point of the whole phase — that two people
 * get DISTINCT /personal dirs (no leak). Person resolution is trivial: the
 * session records its sender at creation, so it works uniformly across channels
 * incl. phone-call (where the routing mg ≠ the person handle).
 */
import fs from 'fs';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-personal-memory' };
});
const TEST_DATA_DIR = '/tmp/nanoclaw-test-personal-memory';

import { initTestDb, closeDb, runMigrations, getDb } from './db/index.js';
import { createMessagingGroup } from './db/messaging-groups.js';
import { createPerson, linkHandle } from './people/index.js';
import { personalMemoryMounts } from './personal-memory.js';
import type { Session } from './types.js';

const now = () => new Date().toISOString();
const AG = 'ag-1';

function seedUser(id: string, kind: string): void {
  getDb().prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?,?,NULL,?)`).run(id, kind, now());
}
function makeMg(id: string, channelType: string, platformId: string, isGroup = 0): void {
  createMessagingGroup({
    id,
    channel_type: channelType,
    platform_id: platformId,
    name: null,
    is_group: isGroup,
    unknown_sender_policy: 'request_approval',
    denied_at: null,
    created_at: now(),
  });
}
/** A session bound to its resolving sender (user_id), as resolveSession records. */
function session(id: string, mgId: string | null, userId: string | null): Session {
  return {
    id,
    agent_group_id: AG,
    messaging_group_id: mgId,
    thread_id: null,
    user_id: userId,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  };
}
const findMount = (mounts: { containerPath: string; hostPath: string; readonly: boolean }[], cp: string) =>
  mounts.find((m) => m.containerPath === cp);

describe('per-person memory mounts', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    runMigrations(initTestDb());
  });
  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('mounts /shared always and /personal for a session bound to a resolved person', () => {
    const p = createPerson({ first_name: 'Ada', last_name: 'L' });
    seedUser('signal:+15550100001', 'signal');
    linkHandle('signal:+15550100001', p.id);
    makeMg('mg-sig', 'signal', '+15550100001');

    const mounts = personalMemoryMounts(AG, session('s1', 'mg-sig', 'signal:+15550100001'));
    const shared = findMount(mounts, '/shared')!;
    const personal = findMount(mounts, '/personal')!;
    expect(shared).toBeTruthy();
    expect(personal).toBeTruthy();
    expect(personal.hostPath).toContain(path.join('memory', 'people', p.id, AG));
    expect(shared.readonly).toBe(false);
    expect(personal.readonly).toBe(false);
    // Scaffolds: /shared → MEMORY.md, /personal → CLAUDE.local.md (the familiar
    // "my memory" filename, so the agent actually uses it).
    expect(fs.existsSync(path.join(shared.hostPath, 'MEMORY.md'))).toBe(true);
    expect(fs.existsSync(path.join(personal.hostPath, 'CLAUDE.local.md'))).toBe(true);
  });

  it('mounts /personal for a PHONE caller — bound user, not the routing mg', () => {
    // The fix: mg is `phone-call:<venue>` but the person handle is `pstn:<num>`.
    // resolveSessionPerson uses the bound session.user_id, so it resolves.
    const p = createPerson({ first_name: 'Ada', last_name: 'L' });
    seedUser('pstn:+15550100001', 'pstn');
    linkHandle('pstn:+15550100001', p.id);
    makeMg('mg-phone', 'phone-call', '+15550100001'); // platform_id = caller number (routing)
    const mounts = personalMemoryMounts(AG, session('s-phone', 'mg-phone', 'pstn:+15550100001'));
    const personal = findMount(mounts, '/personal');
    expect(personal).toBeTruthy();
    expect(personal!.hostPath).toContain(p.id);
  });

  it('does NOT mount /personal for a group chat (no single person)', () => {
    makeMg('mg-grp', 'signal', 'group-123', 1);
    // Even with a bound user_id, a group session gets /shared only.
    const mounts = personalMemoryMounts(AG, session('s2', 'mg-grp', 'signal:+15550100001'));
    expect(findMount(mounts, '/shared')).toBeTruthy();
    expect(findMount(mounts, '/personal')).toBeUndefined();
  });

  it('does NOT mount /personal for anonymous (anam-web) or unbound/unregistered sessions', () => {
    makeMg('mg-anam', 'anam-web', 'anam-web:visitor-uuid');
    // Anonymous visitor handle → no person.
    expect(
      findMount(personalMemoryMounts(AG, session('s-anam', 'mg-anam', 'anam-web:visitor-uuid')), '/personal'),
    ).toBeUndefined();
    // Legacy session with no bound user_id → no /personal.
    makeMg('mg-x', 'signal', '+15550100009');
    expect(findMount(personalMemoryMounts(AG, session('s-legacy', 'mg-x', null)), '/personal')).toBeUndefined();
    // Bound but unregistered handle → no person.
    makeMg('mg-u', 'signal', '+19998887777');
    expect(
      findMount(personalMemoryMounts(AG, session('s-unreg', 'mg-u', 'signal:+19998887777')), '/personal'),
    ).toBeUndefined();
  });

  it('LEAK CHECK: two people get distinct /personal dirs; same person stable across sessions', () => {
    const a = createPerson({ first_name: 'Ada', last_name: 'L' });
    const b = createPerson({ first_name: 'Alan', last_name: 'T' });
    seedUser('signal:+15550100001', 'signal');
    seedUser('signal:+15550100002', 'signal');
    linkHandle('signal:+15550100001', a.id);
    linkHandle('signal:+15550100002', b.id);
    makeMg('mg-a', 'signal', '+15550100001');
    makeMg('mg-b', 'signal', '+15550100002');

    const personalA = findMount(personalMemoryMounts(AG, session('sa', 'mg-a', 'signal:+15550100001')), '/personal')!;
    const personalB = findMount(personalMemoryMounts(AG, session('sb', 'mg-b', 'signal:+15550100002')), '/personal')!;
    expect(personalA.hostPath).not.toBe(personalB.hostPath);
    expect(personalA.hostPath).toContain(a.id);
    expect(personalB.hostPath).toContain(b.id);
    // Same person, different session → SAME personal dir (cross-session memory).
    const personalA2 = findMount(personalMemoryMounts(AG, session('sa2', 'mg-a', 'signal:+15550100001')), '/personal')!;
    expect(personalA2.hostPath).toBe(personalA.hostPath);
  });
});
