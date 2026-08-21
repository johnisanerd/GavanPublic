/**
 * PAT: add sessions.user_id — the resolving sender's handle, recorded when a
 * session is created (resolveSession). Makes a session's person trivially
 * derivable as getPersonByUser(session.user_id) instead of re-deriving from
 * routing ids (which fails for venue-style channels like phone-call, where the
 * messaging_group is `phone-call:<number>` but the person is `pstn:<number>`).
 *
 * Additive ALTER (FK-safe, no table rebuild). Idempotent guard in case the
 * column already exists. Legacy rows stay NULL → no person → /shared only,
 * until a fresh session is created post-migration.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration020PatSessionUserId: Migration = {
  version: 20,
  name: 'pat-session-user-id',
  up: (db: Database.Database) => {
    const cols = db.prepare("PRAGMA table_info('sessions')").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'user_id')) {
      db.exec(`ALTER TABLE sessions ADD COLUMN user_id TEXT`);
    }
  },
};
