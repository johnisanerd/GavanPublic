/**
 * CRUD for `credential_routing` — the DB-sourced credential routing table
 * (migration 023). Declarative source of truth; the OneCLI vault is reconciled
 * FROM these rows at boot (reconcile step added later). See
 * plans/deployment-and-credentials.md (Pillar B).
 */
import { getDb } from './connection.js';

export interface CredentialRoute {
  /** Vault entry name (e.g. 'firecrawl', 'anthropic-prod'). */
  name: string;
  /** Host this credential injects on (e.g. 'api.firecrawl.dev'). */
  host_pattern: string;
  /** Header to set; NULL for type='anthropic' (auto x-api-key). */
  header_name: string | null;
  /** e.g. 'Bearer {value}' or '{value}'. */
  value_format: string;
  /** generic | anthropic | openai. */
  type: string;
  /** Canonical AGENT_<X> secret providing the value; NULL until boot-reconcile wired. */
  secret_name: string | null;
  /** Tombstone (0/1) — lets the promote propagate a removal. */
  deleted: number;
  created_at: string;
  updated_at: string;
}

export function getCredentialRoute(name: string): CredentialRoute | undefined {
  return getDb().prepare('SELECT * FROM credential_routing WHERE name = ?').get(name) as CredentialRoute | undefined;
}

export function listCredentialRoutes(includeDeleted = false): CredentialRoute[] {
  const sql = includeDeleted
    ? 'SELECT * FROM credential_routing ORDER BY name'
    : 'SELECT * FROM credential_routing WHERE deleted = 0 ORDER BY name';
  return getDb().prepare(sql).all() as CredentialRoute[];
}

/** Insert or update a route by name (clears any tombstone on re-add). */
export function upsertCredentialRoute(
  route: Omit<CredentialRoute, 'created_at' | 'updated_at' | 'deleted'> & { deleted?: number },
): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO credential_routing
         (name, host_pattern, header_name, value_format, type, secret_name, deleted, created_at, updated_at)
       VALUES (@name, @host_pattern, @header_name, @value_format, @type, @secret_name, @deleted, @created_at, @updated_at)
       ON CONFLICT(name) DO UPDATE SET
         host_pattern = excluded.host_pattern,
         header_name  = excluded.header_name,
         value_format = excluded.value_format,
         type         = excluded.type,
         secret_name  = excluded.secret_name,
         deleted      = excluded.deleted,
         updated_at   = excluded.updated_at`,
    )
    .run({
      name: route.name,
      host_pattern: route.host_pattern,
      header_name: route.header_name ?? null,
      value_format: route.value_format,
      type: route.type,
      secret_name: route.secret_name ?? null,
      deleted: route.deleted ?? 0,
      created_at: now,
      updated_at: now,
    });
}

/** Soft-delete (tombstone) a route so the promote can propagate the removal. */
export function tombstoneCredentialRoute(name: string): void {
  getDb()
    .prepare('UPDATE credential_routing SET deleted = 1, updated_at = ? WHERE name = ?')
    .run(new Date().toISOString(), name);
}
