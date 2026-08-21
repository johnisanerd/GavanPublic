/**
 * PAT: pending_mcp_activations — approved-but-not-yet-active MCP servers,
 * waiting on their credential to land in the OneCLI vault.
 *
 * Why: an approved `add_mcp_server` whose credential isn't in the vault yet
 * would 401 at the fresh container's MCP handshake — and the agent-runner
 * holds one long-lived SDK query, so a failed handshake is dead for the
 * container's life (no retry; see plans/credential-activation-implementation.md
 * Step 0 result). Instead of wiring a broken MCP, the approval handler parks
 * the request here; the credential watcher polls the vault (a local,
 * source-free existence check) and activates — config write + respawn — the
 * moment the credential exists. See plans/mcp-management.md §"Credential-gated
 * activation".
 *
 * Modeling notes:
 *   - PK (agent_group_id, name): one pending activation per MCP server per
 *     group; a re-request upserts (fresh payload + deadline).
 *   - payload: the full approval payload JSON, replayed verbatim at activation
 *     so the wired entry is byte-identical to what was approved.
 *   - session_id: the requesting session — where activation/slow notices go.
 *   - host_pattern: what the watcher matches against vault entries.
 *   - secret_name: canonical AGENT_<X> key, for operator-facing messages.
 *   - fast_deadline: until this instant the watcher polls fast (~4s); after,
 *     it notifies once (notified_slow) and keeps checking at idle cadence
 *     (~60s) forever — a very late credential still activates.
 *   - Rows are DELETEd on activation (house style, like pending_approvals);
 *     history lives in the mcp.activation-* structured log events.
 *
 * Idempotent (CREATE TABLE IF NOT EXISTS).
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration024PatPendingMcpActivations: Migration = {
  version: 24,
  name: 'pat-pending-mcp-activations',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pending_mcp_activations (
        agent_group_id TEXT NOT NULL,             -- group whose config gains the MCP entry
        name           TEXT NOT NULL,             -- MCP server name (config key)
        session_id     TEXT NOT NULL,             -- requesting session (notify target)
        payload        TEXT NOT NULL,             -- full add_mcp_server approval payload (JSON)
        host_pattern   TEXT NOT NULL,             -- vault host the watcher waits for
        secret_name    TEXT,                      -- canonical AGENT_<X> key (operator messages)
        notified_slow  INTEGER NOT NULL DEFAULT 0,-- 1 = the one-time past-deadline notice was sent
        created_at     TEXT NOT NULL,
        fast_deadline  TEXT NOT NULL,             -- fast-poll window end (ISO)
        PRIMARY KEY (agent_group_id, name)
      );
    `);
  },
};
