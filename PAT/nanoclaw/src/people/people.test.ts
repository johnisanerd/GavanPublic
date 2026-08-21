/**
 * PAT: people-spine test suite (Phase 1).
 *
 * Covers the invariants the plan calls out: person CRUD, identifier uniqueness
 * (one identifier → one person), handle linking, auto-enroll LINKS-not-CREATES,
 * the conservative handle parser, backfill idempotency, identifier resolution,
 * and the delete-cleanup contract (never cascades into upstream `users`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, runMigrations, getDb } from '../db/index.js';
import { parseHandle, normalizePhone } from './normalize.js';
import {
  createPerson,
  getPerson,
  listPeople,
  updatePerson,
  deletePerson,
  addIdentifier,
  removeIdentifier,
  getIdentifiers,
  resolvePersonByIdentifier,
  linkHandle,
  unlinkHandle,
  getPersonByUser,
  getHandlesForPerson,
  autoEnroll,
  autoApproveKnownPerson,
  linkHandleByIdentifier,
  backfillFromUsers,
} from './index.js';
import { hasMembershipRow } from '../modules/permissions/db/agent-group-members.js';

function seedUser(id: string, kind = 'signal'): void {
  getDb()
    .prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)`)
    .run(id, kind, null, new Date().toISOString());
}

function seedAgentGroup(id: string): void {
  getDb()
    .prepare(`INSERT INTO agent_groups (id, name, folder, created_at) VALUES (?, ?, ?, ?)`)
    .run(id, id, id, new Date().toISOString());
}

describe('people spine', () => {
  beforeEach(() => {
    const db = initTestDb(); // :memory:, foreign_keys = ON
    runMigrations(db); // runs the full migration array, incl. 019
  });
  afterEach(() => closeDb());

  // ─────────────────── Person CRUD ───────────────────

  describe('person CRUD', () => {
    it('creates, gets, and lists people', () => {
      const p = createPerson({ first_name: 'Ada', last_name: 'Lovelace' });
      expect(p.id).toMatch(/^person-/);
      expect(p.updated_at).toBeNull();
      expect(getPerson(p.id)).toMatchObject({ first_name: 'Ada', last_name: 'Lovelace' });
      createPerson({ first_name: 'Alan', last_name: 'Turing' });
      expect(listPeople()).toHaveLength(2);
    });

    it('trims and requires both names on create', () => {
      const p = createPerson({ first_name: '  Grace  ', last_name: '  Hopper ' });
      expect(p.first_name).toBe('Grace');
      expect(p.last_name).toBe('Hopper');
      expect(() => createPerson({ first_name: '', last_name: 'X' })).toThrow(/first_name is required/);
      expect(() => createPerson({ first_name: 'X', last_name: '   ' })).toThrow(/last_name is required/);
    });

    it('updates names and bumps updated_at', () => {
      const p = createPerson({ first_name: 'Ada', last_name: 'Lovelace' });
      const updated = updatePerson(p.id, { last_name: 'Byron' });
      expect(updated.first_name).toBe('Ada');
      expect(updated.last_name).toBe('Byron');
      expect(updated.updated_at).not.toBeNull();
      expect(() => updatePerson(p.id, {})).toThrow(/nothing to update/);
      expect(() => updatePerson('person-nope', { first_name: 'X' })).toThrow(/not found/);
    });
  });

  // ─────────────────── Identifiers ───────────────────

  describe('identifiers', () => {
    it('normalizes phone and email on add', () => {
      const p = createPerson({ first_name: 'Ada', last_name: 'Lovelace' });
      addIdentifier({ person_id: p.id, kind: 'phone', value: '+1 (555) 010-0001' });
      addIdentifier({ person_id: p.id, kind: 'email', value: '  Ada@Example.COM ' });
      const ids = getIdentifiers(p.id);
      expect(ids.map((i) => i.value).sort()).toEqual(['+15550100001', 'ada@example.com']);
    });

    it('enforces one identifier → one person (PK on kind,value)', () => {
      const a = createPerson({ first_name: 'Ada', last_name: 'L' });
      const b = createPerson({ first_name: 'Alan', last_name: 'T' });
      addIdentifier({ person_id: a.id, kind: 'phone', value: '+15550100001' });
      // Same normalized phone for a different person → reject.
      expect(() => addIdentifier({ person_id: b.id, kind: 'phone', value: '+1 555 010 0001' })).toThrow(
        /already belongs to person/,
      );
    });

    it('is idempotent for the same person', () => {
      const p = createPerson({ first_name: 'Ada', last_name: 'L' });
      addIdentifier({ person_id: p.id, kind: 'phone', value: '+15550100001' });
      // A re-add (e.g. a seed-script re-run), including a differently-formatted
      // value that normalizes the same, is a no-op — no duplicate row.
      addIdentifier({ person_id: p.id, kind: 'phone', value: '+1 555 010 0001' });
      const ids = getIdentifiers(p.id);
      expect(ids).toHaveLength(1);
      expect(ids[0].value).toBe('+15550100001');
    });

    it('rejects an unknown person and a bad kind', () => {
      expect(() => addIdentifier({ person_id: 'person-nope', kind: 'phone', value: '+15550100001' })).toThrow(
        /person not found/,
      );
      const p = createPerson({ first_name: 'Ada', last_name: 'L' });
      // @ts-expect-error — exercising the runtime guard
      expect(() => addIdentifier({ person_id: p.id, kind: 'fax', value: 'x' })).toThrow(/kind must be/);
    });

    it('removes identifiers (normalized) and reports missing', () => {
      const p = createPerson({ first_name: 'Ada', last_name: 'L' });
      addIdentifier({ person_id: p.id, kind: 'phone', value: '+15550100001' });
      expect(removeIdentifier('phone', '+1 555 010 0001')).toEqual({
        removed: { kind: 'phone', value: '+15550100001' },
      });
      expect(getIdentifiers(p.id)).toHaveLength(0);
      expect(() => removeIdentifier('phone', '+15550100001')).toThrow(/not found/);
    });

    it('resolves a person by normalized identifier', () => {
      const p = createPerson({ first_name: 'Ada', last_name: 'L' });
      addIdentifier({ person_id: p.id, kind: 'phone', value: '+15550100001' });
      expect(resolvePersonByIdentifier('phone', '+1 (555) 010-0001')?.id).toBe(p.id);
      expect(resolvePersonByIdentifier('phone', '+19999999999')).toBeUndefined();
    });
  });

  // ─────────────────── Handle links ───────────────────

  describe('handle links', () => {
    it('links, re-points, and unlinks a handle', () => {
      const a = createPerson({ first_name: 'Ada', last_name: 'L' });
      const b = createPerson({ first_name: 'Alan', last_name: 'T' });
      seedUser('signal:+15550100001');

      linkHandle('signal:+15550100001', a.id);
      expect(getPersonByUser('signal:+15550100001')?.id).toBe(a.id);
      expect(getHandlesForPerson(a.id)).toHaveLength(1);

      // Re-link to a different person → re-points (PK on user_id).
      linkHandle('signal:+15550100001', b.id, 'manual');
      expect(getPersonByUser('signal:+15550100001')?.id).toBe(b.id);
      expect(getHandlesForPerson(a.id)).toHaveLength(0);

      expect(unlinkHandle('signal:+15550100001')).toEqual({ unlinked: 'signal:+15550100001' });
      expect(getPersonByUser('signal:+15550100001')).toBeUndefined();
      expect(() => unlinkHandle('signal:+15550100001')).toThrow(/not linked/);
    });

    it('rejects linking to an unknown person', () => {
      seedUser('signal:+15550100001');
      expect(() => linkHandle('signal:+15550100001', 'person-nope')).toThrow(/person not found/);
    });
  });

  // ─────────────────── Auto-enroll ───────────────────

  describe('autoEnroll', () => {
    it('links a matching handle to its seeded person (never creates)', () => {
      const p = createPerson({ first_name: 'Ada', last_name: 'L' });
      addIdentifier({ person_id: p.id, kind: 'phone', value: '+15550100001' });
      seedUser('signal:+15550100001');

      expect(autoEnroll('signal:+15550100001')).toBe(p.id);
      expect(getPersonByUser('signal:+15550100001')?.id).toBe(p.id);
      expect(getHandlesForPerson(p.id)[0].link_method).toBe('auto:phone');
      // No new person was invented.
      expect(listPeople()).toHaveLength(1);
    });

    it('is idempotent and does not churn an existing link', () => {
      const p = createPerson({ first_name: 'Ada', last_name: 'L' });
      addIdentifier({ person_id: p.id, kind: 'phone', value: '+15550100001' });
      seedUser('signal:+15550100001');
      autoEnroll('signal:+15550100001');
      const first = getHandlesForPerson(p.id)[0].linked_at;
      expect(autoEnroll('signal:+15550100001')).toBe(p.id);
      expect(getHandlesForPerson(p.id)[0].linked_at).toBe(first); // unchanged
    });

    it('returns null for an unknown number, an unparseable handle, and a UUID/JID', () => {
      const p = createPerson({ first_name: 'Ada', last_name: 'L' });
      addIdentifier({ person_id: p.id, kind: 'phone', value: '+15550100001' });
      seedUser('signal:+19999999999');
      seedUser('telegram:123');
      seedUser('signal:abc-uuid-no-plus');
      seedUser('whatsapp:15550100001@s.whatsapp.net');

      expect(autoEnroll('signal:+19999999999')).toBeNull(); // no person owns it
      expect(autoEnroll('telegram:123')).toBeNull(); // not phone/email-bearing
      expect(autoEnroll('signal:abc-uuid-no-plus')).toBeNull(); // UUID fallback, no '+'
      expect(autoEnroll('whatsapp:15550100001@s.whatsapp.net')).toBeNull(); // JID excluded
      expect(getHandlesForPerson(p.id)).toHaveLength(0);
    });

    it('enrolls an imessage email handle to an email identifier', () => {
      const p = createPerson({ first_name: 'Ada', last_name: 'L' });
      addIdentifier({ person_id: p.id, kind: 'email', value: 'ada@example.com' });
      seedUser('imessage:Ada@Example.com', 'imessage');
      expect(autoEnroll('imessage:Ada@Example.com')).toBe(p.id);
      expect(getHandlesForPerson(p.id)[0].link_method).toBe('auto:email');
    });
  });

  // ─────────────────── Backfill ───────────────────

  describe('backfillFromUsers', () => {
    it('retroactively links existing handles and is idempotent', () => {
      const p = createPerson({ first_name: 'Ada', last_name: 'L' });
      addIdentifier({ person_id: p.id, kind: 'phone', value: '+15550100001' });
      // Handles that existed BEFORE the person was seeded.
      seedUser('signal:+15550100001');
      seedUser('pstn:+15550100001', 'pstn');
      seedUser('telegram:999', 'telegram'); // unmatched (no identifier)
      seedUser('signal:+19999999999'); // unmatched (no person)

      const first = backfillFromUsers();
      expect(first.scanned).toBe(4);
      expect(first.linked).toBe(2);
      expect(first.unmatched).toBe(2);
      expect(getHandlesForPerson(p.id)).toHaveLength(2);
      expect(getHandlesForPerson(p.id).every((h) => h.link_method === 'backfill:phone')).toBe(true);

      // Re-run: nothing new to link.
      const second = backfillFromUsers();
      expect(second.linked).toBe(0);
      expect(second.already).toBe(2);
    });
  });

  // ─────────────────── Delete contract ───────────────────

  describe('deletePerson (cascade deregister)', () => {
    it('removes the person + identifiers, and fully deregisters every linked handle', () => {
      const db = getDb();
      const p = createPerson({ first_name: 'Ada', last_name: 'L' });
      addIdentifier({ person_id: p.id, kind: 'phone', value: '+15550100001' });
      seedAgentGroup('ag-1');
      seedUser('signal:+15550100001');
      linkHandle('signal:+15550100001', p.id);
      // The access rows that make the handle "approved".
      db.prepare('INSERT INTO agent_group_members (user_id, agent_group_id, added_by, added_at) VALUES (?,?,?,?)').run(
        'signal:+15550100001',
        'ag-1',
        null,
        new Date().toISOString(),
      );
      db.prepare(
        'INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?,?,?,?,?)',
      ).run('signal:+15550100001', 'admin', 'ag-1', null, new Date().toISOString());

      const result = deletePerson(p.id);
      expect(result.deleted).toBe(p.id);
      expect(result.removed_identifiers).toBe(1);
      expect(result.deregistered_handles).toHaveLength(1);
      expect(result.deregistered_handles[0]!.removed).toMatchObject({ agent_group_members: 1, user_roles: 1 });

      // Person + link gone.
      expect(getPerson(p.id)).toBeUndefined();
      expect(getPersonByUser('signal:+15550100001')).toBeUndefined();
      // Handle reverted to unknown: users row AND all access rows gone.
      expect(db.prepare('SELECT id FROM users WHERE id = ?').get('signal:+15550100001')).toBeUndefined();
      expect(
        db.prepare('SELECT 1 FROM agent_group_members WHERE user_id = ?').get('signal:+15550100001'),
      ).toBeUndefined();
      expect(db.prepare('SELECT 1 FROM user_roles WHERE user_id = ?').get('signal:+15550100001')).toBeUndefined();
      expect(() => deletePerson(p.id)).toThrow(/not found/);
    });

    it('deletes a dedicated 1:1 DM messaging_group but KEEPS a shared group chat', () => {
      const db = getDb();
      const now = new Date().toISOString();
      const p = createPerson({ first_name: 'Grace', last_name: 'H' });
      seedAgentGroup('ag-1');
      seedUser('signal:+15550100002');
      linkHandle('signal:+15550100002', p.id);

      // Dedicated DM group for this handle.
      db.prepare(
        'INSERT INTO messaging_groups (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at) VALUES (?,?,?,?,?,?,?,?)',
      ).run('mg-dm', 'signal', '+15550100002', 'signal', 'Grace DM', 0, 'strict', now);
      // Shared group chat the handle is also in.
      db.prepare(
        'INSERT INTO messaging_groups (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at) VALUES (?,?,?,?,?,?,?,?)',
      ).run('mg-shared', 'signal', 'group.xyz', 'signal', 'Team chat', 1, 'strict', now);
      db.prepare('INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at) VALUES (?,?,?,?)').run(
        'signal:+15550100002',
        'signal',
        'mg-dm',
        now,
      );

      const result = deletePerson(p.id);
      const handle = result.deregistered_handles[0]!;
      expect(handle.deleted_dm_groups).toContain('mg-dm');
      expect(handle.removed.user_dms).toBe(1);

      expect(db.prepare('SELECT 1 FROM messaging_groups WHERE id = ?').get('mg-dm')).toBeUndefined();
      // Shared group chat survives untouched.
      expect(db.prepare('SELECT 1 FROM messaging_groups WHERE id = ?').get('mg-shared')).toBeTruthy();
    });

    it('KEEPS a DM group still referenced by another handle and reports the reason', () => {
      const db = getDb();
      const now = new Date().toISOString();
      const p = createPerson({ first_name: 'Alan', last_name: 'T' });
      seedUser('signal:+15550100003');
      seedUser('signal:+15550100004');
      linkHandle('signal:+15550100003', p.id);

      db.prepare(
        'INSERT INTO messaging_groups (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at) VALUES (?,?,?,?,?,?,?,?)',
      ).run('mg-x', 'signal', '+15550100003', 'signal', 'shared dm', 0, 'strict', now);
      // Both handles' DM cache points at the same group → shared, must keep.
      db.prepare('INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at) VALUES (?,?,?,?)').run(
        'signal:+15550100003',
        'signal',
        'mg-x',
        now,
      );
      db.prepare('INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at) VALUES (?,?,?,?)').run(
        'signal:+15550100004',
        'signal',
        'mg-x',
        now,
      );

      const result = deletePerson(p.id);
      expect(result.kept_shared_groups.some((g) => g.id === 'mg-x')).toBe(true);
      expect(db.prepare('SELECT 1 FROM messaging_groups WHERE id = ?').get('mg-x')).toBeTruthy();
    });

    it('detaches the handle from a shared session (NULLs user_id) without deleting it', () => {
      const db = getDb();
      const now = new Date().toISOString();
      const p = createPerson({ first_name: 'Edsger', last_name: 'D' });
      seedAgentGroup('ag-1');
      seedUser('signal:+15550100005');
      linkHandle('signal:+15550100005', p.id);
      db.prepare(
        'INSERT INTO messaging_groups (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at) VALUES (?,?,?,?,?,?,?,?)',
      ).run('mg-grp', 'signal', 'group.abc', 'signal', 'grp', 1, 'strict', now);
      db.prepare(
        'INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, user_id, status, container_status, created_at) VALUES (?,?,?,?,?,?,?,?)',
      ).run('sess-1', 'ag-1', 'mg-grp', null, 'signal:+15550100005', 'active', 'stopped', now);

      deletePerson(p.id);
      const sess = db.prepare('SELECT user_id FROM sessions WHERE id = ?').get('sess-1') as
        | { user_id: string | null }
        | undefined;
      expect(sess).toBeTruthy();
      expect(sess!.user_id).toBeNull();
    });
  });

  // ─────────────────── Parser unit checks ───────────────────

  describe('parseHandle (conservative)', () => {
    it('parses trusted phone/email shapes and rejects the rest', () => {
      expect(parseHandle('signal:+15550100001')).toEqual({ kind: 'phone', value: '+15550100001' });
      expect(parseHandle('pstn:+15550100001')).toEqual({ kind: 'phone', value: '+15550100001' });
      expect(parseHandle('email:Ada@Example.com')).toEqual({ kind: 'email', value: 'ada@example.com' });
      expect(parseHandle('imessage:ada@example.com')).toEqual({ kind: 'email', value: 'ada@example.com' });
      expect(parseHandle('imessage:+15550100001')).toEqual({ kind: 'phone', value: '+15550100001' });
      expect(parseHandle('resend:ada@example.com')).toEqual({ kind: 'email', value: 'ada@example.com' });

      // Rejected: opaque ids, UUID fallback, whatsapp JID, dead `phone:` prefix.
      expect(parseHandle('telegram:123')).toBeNull();
      expect(parseHandle('discord:456')).toBeNull();
      expect(parseHandle('anam-web:abc-uuid')).toBeNull();
      expect(parseHandle('signal:abc-uuid')).toBeNull();
      expect(parseHandle('whatsapp:15550100001@s.whatsapp.net')).toBeNull();
      expect(parseHandle('phone:+15550100001')).toBeNull();
      expect(parseHandle('no-colon')).toBeNull();
    });

    it('normalizePhone strips formatting', () => {
      expect(normalizePhone('+1 (555) 010-0001')).toBe('+15550100001');
      expect(normalizePhone('no digits')).toBeNull();
    });

    it('normalizePhone assumes US (+1) for bare 10-digit input, leaves explicit country codes alone', () => {
      expect(normalizePhone('5550100000')).toBe('+15550100000');
      expect(normalizePhone('555-010-0000')).toBe('+15550100000');
      expect(normalizePhone('1 555-010-0000')).toBe('+15550100000');
      expect(normalizePhone('+15550100000')).toBe('+15550100000');
      expect(normalizePhone('+44 7911 123456')).toBe('+447911123456');
    });
  });

  // ─────────────────── Cross-channel auto-approve ───────────────────

  describe('autoApproveKnownPerson', () => {
    it('grants agent-group-scoped membership when the handle resolves to a person', () => {
      seedAgentGroup('ag-1');
      const p = createPerson({ first_name: 'Ada', last_name: 'Lovelace' });
      addIdentifier({ person_id: p.id, kind: 'phone', value: '+15550100001' });
      seedUser('signal:+15550100001');
      // autoEnroll links the handle (the inbound-path step that runs first).
      expect(autoEnroll('signal:+15550100001')).toBe(p.id);

      expect(hasMembershipRow('signal:+15550100001', 'ag-1')).toBe(false);
      const resolved = autoApproveKnownPerson('signal:+15550100001', 'ag-1');
      expect(resolved?.id).toBe(p.id);
      expect(hasMembershipRow('signal:+15550100001', 'ag-1')).toBe(true);
    });

    it('returns null and grants nothing for an UNLINKED handle', () => {
      seedAgentGroup('ag-1');
      seedUser('signal:+15559999999');
      expect(autoApproveKnownPerson('signal:+15559999999', 'ag-1')).toBeNull();
      expect(hasMembershipRow('signal:+15559999999', 'ag-1')).toBe(false);
    });

    it('is scoped strictly to the target agent group', () => {
      seedAgentGroup('ag-1');
      seedAgentGroup('ag-2');
      const p = createPerson({ first_name: 'Ada', last_name: 'Lovelace' });
      seedUser('slack:U0ABC', 'slack');
      linkHandle('slack:U0ABC', p.id, 'manual');

      autoApproveKnownPerson('slack:U0ABC', 'ag-1');
      expect(hasMembershipRow('slack:U0ABC', 'ag-1')).toBe(true);
      expect(hasMembershipRow('slack:U0ABC', 'ag-2')).toBe(false);
    });

    it('is idempotent — re-calling does not error or duplicate', () => {
      seedAgentGroup('ag-1');
      const p = createPerson({ first_name: 'Ada', last_name: 'Lovelace' });
      seedUser('slack:U0ABC', 'slack');
      linkHandle('slack:U0ABC', p.id, 'manual');
      autoApproveKnownPerson('slack:U0ABC', 'ag-1');
      autoApproveKnownPerson('slack:U0ABC', 'ag-1');
      const rows = getDb()
        .prepare('SELECT COUNT(*) AS n FROM agent_group_members WHERE user_id = ? AND agent_group_id = ?')
        .get('slack:U0ABC', 'ag-1') as { n: number };
      expect(rows.n).toBe(1);
    });
  });

  describe('linkHandleByIdentifier (out-of-band: slack email / telegram phone)', () => {
    it('links a slack handle to a person by resolved email', () => {
      const p = createPerson({ first_name: 'Ada', last_name: 'Lovelace' });
      addIdentifier({ person_id: p.id, kind: 'email', value: 'ada@example.com' });
      seedUser('slack:U0ABC', 'slack');
      expect(linkHandleByIdentifier('slack:U0ABC', 'email', 'Ada@Example.com')).toBe(p.id);
      expect(getPersonByUser('slack:U0ABC')?.id).toBe(p.id);
    });

    it('returns null when no person owns the identifier', () => {
      seedUser('slack:U0XYZ', 'slack');
      expect(linkHandleByIdentifier('slack:U0XYZ', 'email', 'stranger@example.com')).toBeNull();
      expect(getPersonByUser('slack:U0XYZ')).toBeUndefined();
    });
  });
});
