/**
 * PAT: pairing codes — self-service handle linking by proof-of-possession.
 *
 * Flow: an operator generates a code in the dashboard (createPairingCode for
 * their person), then sends a message CONTAINING that code FROM the new handle
 * they want to link. The inbound path calls matchPairingCodeInText for any
 * message from an UNLINKED handle; on a hit the caller links the handle, then
 * calls consumePairingCode (single-use). See src/modules/permissions/pairing.ts
 * for the ingress wiring, and plans/pairing-handle-linking.md for the design.
 *
 * This module owns only the codes table — it deliberately does NOT link handles
 * or wire messaging groups (that's the ingress hook's job, reusing the existing
 * people-spine + permissions machinery). Single-writer discipline mirrors
 * src/people/index.ts.
 *
 * Security posture (internal tool, reasonable-not-paranoid):
 *   - 6-digit numeric, 5-minute TTL, single-use.
 *   - Substring match (the code can sit inside a natural-language message).
 *   - Only UNLINKED handles can pair (enforced by the caller) — a code can
 *     never re-point an already-claimed handle.
 *   - createPairingCode caps the active codes per person (anti-spam) and prunes
 *     expired rows opportunistically.
 */
import { randomInt, randomUUID } from 'crypto';

import { getDb } from '../db/connection.js';
import { log } from '../log.js';

export interface PairingCode {
  id: string;
  code: string;
  person_id: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  linked_user_id: string | null;
}

/** 6-digit numeric code, zero-padded (so "000123" is valid). */
const CODE_DIGITS = 6;
// PAT (security): cap how many distinct code candidates one inbound message may
// probe. With the standalone-token rule in matchPairingCodeInText this bounds
// blind guessing of the pairing code.
const MAX_PAIRING_CANDIDATES = 8;
/** 5-minute TTL. */
export const PAIRING_TTL_MS = 5 * 60 * 1000;
/** Anti-spam: at most this many active (unexpired, unconsumed) codes per person. */
const MAX_ACTIVE_PER_PERSON = 5;

const now = (): number => Date.now();
const iso = (ms: number): string => new Date(ms).toISOString();

function generateCode(): string {
  return String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0');
}

/** Drop rows whose TTL has lapsed. Cheap housekeeping run on create. */
function pruneExpired(): void {
  getDb().prepare('DELETE FROM pairing_codes WHERE consumed_at IS NULL AND expires_at < ?').run(iso(now()));
}

/**
 * Mint a fresh pairing code for a person. The person must exist. Returns the
 * row. Generates a code that doesn't currently collide with another person's
 * ACTIVE code (so a substring match is unambiguous about which person it pairs
 * to). Enforces a per-person active-code cap.
 */
export function createPairingCode(personId: string): PairingCode {
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM people WHERE id = ?').get(personId)) {
    throw new Error(`person not found: ${personId}`);
  }

  pruneExpired();

  const nowMs = now();
  const active = db
    .prepare('SELECT COUNT(*) AS n FROM pairing_codes WHERE person_id = ? AND consumed_at IS NULL AND expires_at >= ?')
    .get(personId, iso(nowMs)) as { n: number };
  if (active.n >= MAX_ACTIVE_PER_PERSON) {
    throw new Error(`too many active pairing codes for this person (max ${MAX_ACTIVE_PER_PERSON}) — let one expire`);
  }

  // Avoid an active-code collision across people: a code that's active for
  // someone else would make a substring match ambiguous. Retry a few times.
  let code = generateCode();
  for (let i = 0; i < 8; i++) {
    const clash = db
      .prepare('SELECT 1 FROM pairing_codes WHERE code = ? AND consumed_at IS NULL AND expires_at >= ?')
      .get(code, iso(nowMs));
    if (!clash) break;
    code = generateCode();
  }

  const row: PairingCode = {
    id: `pair-${randomUUID()}`,
    code,
    person_id: personId,
    created_at: iso(nowMs),
    expires_at: iso(nowMs + PAIRING_TTL_MS),
    consumed_at: null,
    linked_user_id: null,
  };
  db.prepare(
    `INSERT INTO pairing_codes (id, code, person_id, created_at, expires_at, consumed_at, linked_user_id)
     VALUES (@id, @code, @person_id, @created_at, @expires_at, @consumed_at, @linked_user_id)`,
  ).run(row);
  log.event({
    kind: 'people.pairing-code-created',
    data: { id: row.id, person_id: personId, expires_at: row.expires_at },
  });
  return row;
}

export function getPairingCode(id: string): PairingCode | undefined {
  return getDb().prepare('SELECT * FROM pairing_codes WHERE id = ?').get(id) as PairingCode | undefined;
}

/** A person's codes, newest first (for the dashboard poll). rowid tiebreaks
 *  same-millisecond inserts so ordering is deterministic. */
export function listPairingCodesForPerson(personId: string): PairingCode[] {
  return getDb()
    .prepare('SELECT * FROM pairing_codes WHERE person_id = ? ORDER BY created_at DESC, rowid DESC')
    .all(personId) as PairingCode[];
}

/**
 * Find the single ACTIVE pairing code whose digits appear as a substring of
 * `text`. Active = not consumed AND not expired. Returns undefined when no
 * active code matches.
 *
 * Codes are short numeric strings, so we first extract the candidate digit runs
 * from the text and probe each against the (indexed) code column, rather than
 * scanning every active code. Order by expiry so the soonest-to-die wins if the
 * text somehow contains two (shouldn't happen — active codes are unique).
 */
export function matchPairingCodeInText(text: string): PairingCode | undefined {
  if (!text) return undefined;
  // PAT (security): only a STANDALONE CODE_DIGITS-length digit run is a
  // candidate — not every CODE_DIGITS-wide window of every digit run. The old
  // windowing let one ~32k-digit message probe ~32k codes and sweep the whole
  // 10^6 space in ~31 messages (this inbound path has no rate limit). A code
  // arrives as its own token in practice ("your code is 123456"); an attacker
  // can no longer pack thousands of guesses into one long number. The
  // MAX_PAIRING_CANDIDATES cap guards against a token-spam message.
  const candidates = new Set<string>();
  for (const run of text.match(/\d+/g) ?? []) {
    if (run.length !== CODE_DIGITS) continue;
    candidates.add(run);
    if (candidates.size >= MAX_PAIRING_CANDIDATES) break;
  }
  if (candidates.size === 0) return undefined;

  const db = getDb();
  const nowIso = iso(now());
  const placeholders = Array.from(candidates, () => '?').join(', ');
  return db
    .prepare(
      `SELECT * FROM pairing_codes
       WHERE code IN (${placeholders}) AND consumed_at IS NULL AND expires_at >= ?
       ORDER BY expires_at ASC
       LIMIT 1`,
    )
    .get(...candidates, nowIso) as PairingCode | undefined;
}

/**
 * Mark a code consumed by a handle (single-use). Idempotent guard: only
 * transitions an unconsumed, unexpired row. Returns the updated row, or
 * undefined if it was already consumed / expired (lost a race).
 */
export function consumePairingCode(id: string, linkedUserId: string): PairingCode | undefined {
  const db = getDb();
  const result = db
    .prepare(
      `UPDATE pairing_codes
       SET consumed_at = ?, linked_user_id = ?
       WHERE id = ? AND consumed_at IS NULL AND expires_at >= ?`,
    )
    .run(iso(now()), linkedUserId, id, iso(now()));
  if (result.changes === 0) return undefined;
  const row = getPairingCode(id);
  if (row) {
    log.event({
      kind: 'people.pairing-code-consumed',
      data: { id, person_id: row.person_id, linked_user_id: linkedUserId },
    });
  }
  return row;
}
