/**
 * PAT: credential_routing — the DB-sourced credential routing table.
 *
 * Routing (which credential injects which header at which host) is the
 * declarative source of truth here; the OneCLI vault becomes a derived runtime
 * cache that a boot step reconciles FROM this table. Why DB not vault: it rides
 * the same staging↔prod DB promote as MCP entries (one path), and removes the
 * dependency on `onecli secrets list`. See plans/deployment-and-credentials.md
 * (Pillar B) + plans/mcp-management.md (promote).
 *
 * Modeling notes:
 *   - `name` = the VAULT entry name (e.g. 'firecrawl', 'anthropic-prod',
 *     'apify-api', 'apify-mcp'). Keyed this way so one vendor with two hosts
 *     (apify api + mcp) is two rows, mirroring the vault one-to-one.
 *   - `secret_name` = the canonical `AGENT_<X>` secret that PROVIDES the value
 *     (e.g. both apify rows → 'APIFY_API_KEY'). This is the name-map that lets the
 *     boot router match a Fly secret to a vault entry WITHOUT renaming live vault
 *     entries. NULL until the boot-reconcile is wired.
 *   - `type='anthropic'` carries the SDK's special header behavior (auto x-api-key,
 *     strips inbound Authorization) — header_name is NULL for it.
 *   - `deleted` = tombstone, so the promote can propagate a removal (same pattern
 *     as MCP soft-delete).
 *
 * This migration creates the table EMPTY. It is inert until (a) populated
 * (seed-from-vault, deliberate, ground-truth-sourced) and (b) the boot-reconcile
 * step is added — both deferred so nothing touches live vendor auth here.
 *
 * Idempotent (CREATE TABLE IF NOT EXISTS).
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration023PatCredentialRouting: Migration = {
  version: 23,
  name: 'pat-credential-routing',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS credential_routing (
        name          TEXT PRIMARY KEY,                 -- vault entry name (e.g. 'firecrawl', 'anthropic-prod')
        host_pattern  TEXT NOT NULL,                    -- e.g. 'api.firecrawl.dev'
        header_name   TEXT,                             -- NULL for type='anthropic' (auto x-api-key)
        value_format  TEXT NOT NULL DEFAULT '{value}',  -- e.g. 'Bearer {value}'
        type          TEXT NOT NULL DEFAULT 'generic',  -- generic | anthropic | openai
        secret_name   TEXT,                             -- canonical AGENT_<X> secret providing the value; NULL until boot-reconcile wired
        deleted       INTEGER NOT NULL DEFAULT 0,       -- tombstone for the staging<->prod promote
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
    `);
  },
};
