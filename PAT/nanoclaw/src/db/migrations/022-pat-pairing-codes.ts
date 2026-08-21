/**
 * PAT: pairing_codes — self-service handle linking by proof-of-possession.
 *
 * An operator generates a short numeric code in the dashboard, then sends a
 * message CONTAINING that code from the new handle they want to link. While the
 * code is active (not expired, not consumed) the inbound path matches it against
 * any message from an UNLINKED handle and instantly links that handle to the
 * code's person — replacing the manual approval-card registration flow with a
 * "prove you own it" gesture.
 *
 * One ADDITIVE table, no edits to upstream. Design: pairing replaces the
 * approval-card flow as the primary self-serve linking path (see
 * plans/pairing-handle-linking.md).
 *
 * Invariants:
 *   - `code` is the lookup key for substring matching (numeric, but stored TEXT
 *     to preserve leading zeros). Indexed for the hot-path scan.
 *   - `consumed_at` NULL ⇒ unused; single-use, set when a handle pairs.
 *   - `expires_at` is an absolute ISO timestamp; active = now < expires_at AND
 *     consumed_at IS NULL.
 *   - `linked_user_id` records WHICH handle consumed the code (for the
 *     dashboard's success view + audit).
 *
 * Idempotent (CREATE TABLE IF NOT EXISTS).
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration022PatPairingCodes: Migration = {
  version: 22,
  name: 'pat-pairing-codes',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pairing_codes (
        id             TEXT PRIMARY KEY,
        code           TEXT NOT NULL,                          -- numeric, TEXT to keep leading zeros
        person_id      TEXT NOT NULL REFERENCES people(id),
        created_at     TEXT NOT NULL,
        expires_at     TEXT NOT NULL,                          -- absolute ISO; active = now < this AND consumed_at IS NULL
        consumed_at    TEXT,                                   -- NULL = unused; single-use
        linked_user_id TEXT                                    -- the handle that consumed it (audit + success view)
      );
    `);
    // Hot-path: the inbound scan looks up active codes to substring-match
    // against message text. Index on code for the lookup; on person for the
    // dashboard's "my codes" poll.
    db.exec(`CREATE INDEX IF NOT EXISTS idx_pairing_codes_code ON pairing_codes(code);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_pairing_codes_person ON pairing_codes(person_id);`);
  },
};
