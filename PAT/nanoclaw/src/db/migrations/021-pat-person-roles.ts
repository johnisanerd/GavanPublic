/**
 * PAT: person_roles — dashboard data-visibility authority, keyed on PERSON.
 *
 * Distinct axis from user_roles (agent-runtime authority, handle-keyed). The
 * pat-frontend dashboard resolves a Clerk login → person → this role, and a
 * code-side ROLE_CAPS map expands the role into resource:action:scope
 * capabilities. One role per person (PK person_id). Deliberately named
 * `person_roles` because the eventual user_roles → person_roles runtime
 * migration converges here. See plans/dashboard-permissions.md.
 *
 * Additive CREATE (FK-safe, no table rebuild). Idempotent guard.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration021PatPersonRoles: Migration = {
  version: 21,
  name: 'pat-person-roles',
  up: (db: Database.Database) => {
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='person_roles'").get();
    if (!exists) {
      db.exec(`
        CREATE TABLE person_roles (
          person_id   TEXT PRIMARY KEY REFERENCES people(id),
          role        TEXT NOT NULL,
          granted_by  TEXT,
          granted_at  TEXT NOT NULL
        );
      `);
    }
  },
};
