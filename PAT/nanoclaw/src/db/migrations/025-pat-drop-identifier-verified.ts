/**
 * PAT: drop the dead `person_identifiers.verified` column.
 *
 * The flag was written (`ncl people add-identifier --verified`) but NEVER read by
 * any trust decision — a misleading no-op that repeatedly read as a security
 * control it wasn't (pre-CRM red-team 2026-07-07; an internal security review).
 * Removed at the source; this migration drops the column so the schema matches.
 * `verified` is not indexed, so DROP COLUMN is safe. Guarded (only if the column
 * exists) for idempotency — 019 creates it, 025 drops it, on both fresh and
 * partially-migrated DBs.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration025PatDropIdentifierVerified: Migration = {
  version: 25,
  name: 'pat-drop-identifier-verified',
  up: (db: Database.Database) => {
    const cols = db.pragma('table_info(person_identifiers)') as Array<{ name: string }>;
    if (cols.some((c) => c.name === 'verified')) {
      db.exec('ALTER TABLE person_identifiers DROP COLUMN verified');
    }
  },
};
