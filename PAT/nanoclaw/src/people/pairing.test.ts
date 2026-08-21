/**
 * PAT: pairing-code test suite.
 *
 * Covers the invariants: 6-digit/5-min/single-use, substring match (incl.
 * embedded in natural language), active-only matching (expired + consumed
 * excluded), consume races, per-person active cap, and active-code uniqueness.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations, getDb } from '../db/index.js';
import { createPerson } from './index.js';
import {
  createPairingCode,
  getPairingCode,
  listPairingCodesForPerson,
  matchPairingCodeInText,
  consumePairingCode,
  PAIRING_TTL_MS,
} from './pairing.js';

describe('pairing codes', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
  });
  afterEach(() => {
    vi.useRealTimers();
    closeDb();
  });

  function newPerson() {
    return createPerson({ first_name: 'Ada', last_name: 'Lovelace' });
  }

  it('mints a 6-digit code with a ~5min TTL', () => {
    const p = newPerson();
    const c = createPairingCode(p.id);
    expect(c.code).toMatch(/^\d{6}$/);
    expect(c.person_id).toBe(p.id);
    expect(c.consumed_at).toBeNull();
    const ttl = new Date(c.expires_at).getTime() - new Date(c.created_at).getTime();
    expect(ttl).toBe(PAIRING_TTL_MS);
  });

  it('rejects an unknown person', () => {
    expect(() => createPairingCode('person-nope')).toThrow(/person not found/);
  });

  it('matches the code as a bare string and embedded in natural language', () => {
    const p = newPerson();
    const c = createPairingCode(p.id);
    expect(matchPairingCodeInText(c.code)?.id).toBe(c.id);
    expect(matchPairingCodeInText(`hey pat my code is ${c.code} thanks`)?.id).toBe(c.id);
    // PAT (security): a code embedded INSIDE a longer digit run no longer
    // matches — only standalone CODE_DIGITS-length tokens are candidates. The
    // old window-every-substring behavior over-generated code candidates
    // from a single long-number message.
    expect(matchPairingCodeInText(`x99${c.code}99x`)).toBeUndefined();
    // A long digit run (the long-run case) yields no candidates at all.
    expect(matchPairingCodeInText('9'.repeat(5000))).toBeUndefined();
  });

  it('does not match when the text has no code', () => {
    newPerson();
    expect(matchPairingCodeInText('just saying hi, no numbers here')).toBeUndefined();
    expect(matchPairingCodeInText('order #12345')).toBeUndefined(); // 5 digits, too short
  });

  it('does not match a consumed code', () => {
    const p = newPerson();
    const c = createPairingCode(p.id);
    consumePairingCode(c.id, 'signal:+15551112222');
    expect(matchPairingCodeInText(c.code)).toBeUndefined();
  });

  it('does not match an expired code', () => {
    vi.useFakeTimers();
    const p = newPerson();
    const c = createPairingCode(p.id);
    vi.setSystemTime(Date.now() + PAIRING_TTL_MS + 1000);
    expect(matchPairingCodeInText(c.code)).toBeUndefined();
  });

  it('consume is single-use (second consume is a no-op)', () => {
    const p = newPerson();
    const c = createPairingCode(p.id);
    const first = consumePairingCode(c.id, 'signal:+15551112222');
    expect(first?.linked_user_id).toBe('signal:+15551112222');
    const second = consumePairingCode(c.id, 'signal:+15559998888');
    expect(second).toBeUndefined();
    // the original consumer is recorded, not the second
    expect(getPairingCode(c.id)?.linked_user_id).toBe('signal:+15551112222');
  });

  it('consume of an expired code is a no-op', () => {
    vi.useFakeTimers();
    const p = newPerson();
    const c = createPairingCode(p.id);
    vi.setSystemTime(Date.now() + PAIRING_TTL_MS + 1000);
    expect(consumePairingCode(c.id, 'signal:+15551112222')).toBeUndefined();
  });

  it("lists a person's codes newest-first", () => {
    const p = newPerson();
    const a = createPairingCode(p.id);
    const b = createPairingCode(p.id);
    const list = listPairingCodesForPerson(p.id);
    expect(list.map((c) => c.id)).toEqual([b.id, a.id]);
  });

  it('caps active codes per person', () => {
    const p = newPerson();
    for (let i = 0; i < 5; i++) createPairingCode(p.id);
    expect(() => createPairingCode(p.id)).toThrow(/too many active/);
  });

  it('does not count expired codes against the cap', () => {
    vi.useFakeTimers();
    const p = newPerson();
    for (let i = 0; i < 5; i++) createPairingCode(p.id);
    vi.setSystemTime(Date.now() + PAIRING_TTL_MS + 1000);
    // expired ones are pruned on the next create; this should succeed
    expect(() => createPairingCode(p.id)).not.toThrow();
  });

  it('active codes are unique across people (no ambiguous substring match)', () => {
    const p1 = createPerson({ first_name: 'A', last_name: 'One' });
    const p2 = createPerson({ first_name: 'B', last_name: 'Two' });
    const codes = new Set<string>();
    for (let i = 0; i < 5; i++) codes.add(createPairingCode(p1.id).code);
    for (let i = 0; i < 5; i++) codes.add(createPairingCode(p2.id).code);
    // 10 active codes, all distinct
    expect(codes.size).toBe(10);
    // each resolves to exactly one row
    for (const code of codes) {
      expect(matchPairingCodeInText(code)).toBeDefined();
    }
  });

  it('prunes expired rows on create', () => {
    vi.useFakeTimers();
    const p = newPerson();
    const old = createPairingCode(p.id);
    vi.setSystemTime(Date.now() + PAIRING_TTL_MS + 1000);
    createPairingCode(p.id);
    // the expired one was deleted by pruneExpired()
    expect(getPairingCode(old.id)).toBeUndefined();
  });
});
