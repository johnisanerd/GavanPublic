/**
 * PAT: CRUD for `pending_mcp_activations` (migration 024) — approved MCP
 * servers parked until their credential lands in the OneCLI vault. The
 * credential watcher (src/modules/credentials/watcher.ts) is the consumer;
 * the add_mcp_server approval handler (src/modules/self-mod/apply.ts) is the
 * producer. Rows are deleted on activation — history lives in the
 * mcp.activation-* structured log events.
 */
import { getDb } from './connection.js';

export interface PendingMcpActivation {
  agent_group_id: string;
  /** MCP server name (the config key). */
  name: string;
  /** Requesting session — where activation/slow notices go. */
  session_id: string;
  /** Full add_mcp_server approval payload (JSON), replayed at activation. */
  payload: string;
  /** Vault host the watcher waits for. */
  host_pattern: string;
  /** Canonical AGENT_<X> key for operator-facing messages. */
  secret_name: string | null;
  /** 1 = the one-time past-deadline notice was sent. */
  notified_slow: number;
  created_at: string;
  /** Fast-poll window end (ISO). After this the watcher idles at ~60s. */
  fast_deadline: string;
}

/** Insert or replace (a re-request refreshes payload + deadline). */
export function upsertPendingMcpActivation(
  row: Omit<PendingMcpActivation, 'notified_slow' | 'created_at'> & { created_at?: string },
): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO pending_mcp_activations
         (agent_group_id, name, session_id, payload, host_pattern, secret_name,
          notified_slow, created_at, fast_deadline)
       VALUES (@agent_group_id, @name, @session_id, @payload, @host_pattern, @secret_name,
          0, @created_at, @fast_deadline)`,
    )
    .run({
      created_at: new Date().toISOString(),
      ...row,
      secret_name: row.secret_name ?? null,
    });
}

export function listPendingMcpActivations(): PendingMcpActivation[] {
  return getDb().prepare('SELECT * FROM pending_mcp_activations ORDER BY created_at').all() as PendingMcpActivation[];
}

export function deletePendingMcpActivation(agentGroupId: string, name: string): void {
  getDb().prepare('DELETE FROM pending_mcp_activations WHERE agent_group_id = ? AND name = ?').run(agentGroupId, name);
}

/** Mark the one-time past-deadline notice as sent. */
export function markPendingMcpActivationSlow(agentGroupId: string, name: string): void {
  getDb()
    .prepare('UPDATE pending_mcp_activations SET notified_slow = 1 WHERE agent_group_id = ? AND name = ?')
    .run(agentGroupId, name);
}
