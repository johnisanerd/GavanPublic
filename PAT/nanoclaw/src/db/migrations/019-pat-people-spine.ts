/**
 * PAT: People spine — three ADDITIVE tables, zero edits to upstream `users`.
 *
 * A "person" is one human. They can reach PAT by many handles (phone call,
 * Signal, Telegram, dashboard login via Google) — each handle is a `users`
 * row today. This spine groups those handles under a single identity without
 * touching the upstream `users` table, so an upstream sync can't clobber us
 * and the eventual upstream PR is "here are three self-contained tables."
 *
 * Design rationale lives in plans/admin-dashboard-and-people.md (Phase 1).
 * Key invariants:
 *   - `people` is pure identity (names + timestamps). No tier/access column,
 *     no default-handle columns — both deferred (see plan backlog).
 *   - `person_identifiers` PK (kind, value) ⇒ an email/phone maps to EXACTLY
 *     ONE person → deterministic auto-enroll match.
 *   - `person_users` PK user_id ⇒ each handle belongs to at most one person.
 *     This is the additive replacement for a `users.person_id` column.
 *
 * Fully idempotent (CREATE TABLE IF NOT EXISTS) so a re-run is a no-op.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration019PatPeopleSpine: Migration = {
  version: 19,
  name: 'pat-people-spine',
  up: (db: Database.Database) => {
    // 1. The human. Deliberately minimal for v1 — identity + names, nothing else.
    db.exec(`
      CREATE TABLE IF NOT EXISTS people (
        id          TEXT PRIMARY KEY,
        first_name  TEXT NOT NULL,
        last_name   TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT
      );
    `);

    // 2. Universal identifiers a person can be RECOGNIZED by — the auto-enroll
    //    front door. Exists independent of any account; can be pre-seeded
    //    before the person ever messages. PK (kind, value) is the deterministic
    //    match key (one normalized email/phone → exactly one person).
    db.exec(`
      CREATE TABLE IF NOT EXISTS person_identifiers (
        person_id  TEXT NOT NULL REFERENCES people(id),
        kind       TEXT NOT NULL,      -- 'email' | 'phone'
        value      TEXT NOT NULL,      -- normalized: lowercased email / E164 phone
        verified   INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        PRIMARY KEY (kind, value)
      );
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_person_identifiers_person ON person_identifiers(person_id);`);

    // 3. Realized links from handles (`users` rows) → person. PK on user_id
    //    (NOT a many-to-many join) enforces "each handle belongs to at most one
    //    person" without touching `users`. Home for linked_at / link_method.
    db.exec(`
      CREATE TABLE IF NOT EXISTS person_users (
        user_id     TEXT PRIMARY KEY REFERENCES users(id),
        person_id   TEXT NOT NULL REFERENCES people(id),
        linked_at   TEXT NOT NULL,
        link_method TEXT               -- 'manual' | 'auto:phone' | 'auto:email' | 'backfill:phone' | ...
      );
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_person_users_person ON person_users(person_id);`);
  },
};
