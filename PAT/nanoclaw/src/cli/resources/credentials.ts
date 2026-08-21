// PAT: credentials resource — the credential_routing table (DB source of
// truth for vault injection) + the reconcile that derives the OneCLI vault
// from it. Values are NEVER read, shown, or accepted here — this surface is
// routing metadata + presence only (raw keys arrive out-of-band as AGENT_<X>
// Fly secrets / 1Password). Deliberately NOT in the dispatch.ts group-scope
// allowlist, so group-scoped agents can't reach it at all.
// See plans/credential-activation-implementation.md.
import { listCredentialRoutes } from '../../db/credential-routing.js';
import { listPendingMcpActivations } from '../../db/pending-mcp-activations.js';
import { reconcileCredentials } from '../../modules/credentials/reconcile.js';
import { listSecrets, vaultConfigured } from '../../modules/credentials/onecli-vault.js';
import { registerResource } from '../crud.js';

registerResource({
  name: 'credential',
  plural: 'credentials',
  table: 'credential_routing',
  description:
    'Credential routing rows (DB source of truth: vault-entry name → host/header/format + the AGENT_<X> secret that provides the value) and the reconcile that derives the OneCLI vault from them. Metadata only — secret values never pass through this resource.',
  idColumn: 'name',
  columns: [
    {
      name: 'name',
      type: 'string',
      description: 'Vault entry name (doubles as the MCP server name for agent-added routes).',
    },
    { name: 'host_pattern', type: 'string', description: 'Host the credential injects on (e.g. api.firecrawl.dev).' },
    {
      name: 'header_name',
      type: 'string',
      description: 'Header to set. NULL for type=anthropic (gateway auto x-api-key).',
    },
    { name: 'value_format', type: 'string', description: "e.g. 'Bearer {value}' or '{value}'." },
    {
      name: 'type',
      type: 'string',
      description: 'generic | anthropic | openai.',
      enum: ['generic', 'anthropic', 'openai'],
    },
    {
      name: 'secret_name',
      type: 'string',
      description: 'Canonical AGENT_<X> secret providing the value (name only, never the value).',
    },
    {
      name: 'deleted',
      type: 'number',
      description: 'Tombstone (0/1) — a tombstoned route deletes its vault entry at reconcile.',
    },
    { name: 'created_at', type: 'string', description: 'Auto-set.' },
    { name: 'updated_at', type: 'string', description: 'Auto-set.' },
  ],
  operations: { list: 'open', get: 'open' },
  customOperations: {
    status: {
      access: 'open',
      description:
        'Routing rows joined with vault presence (does an entry for the host exist?) plus any MCPs parked awaiting a credential. Names/hosts only.',
      handler: async () => {
        const routes = listCredentialRoutes(true);
        let vaultHosts: Set<string> | null = null;
        if (vaultConfigured()) {
          try {
            vaultHosts = new Set((await listSecrets()).map((s) => s.hostPattern).filter(Boolean) as string[]);
          } catch {
            vaultHosts = null; // gateway unreachable — presence unknown
          }
        }
        return {
          vault: vaultHosts ? 'reachable' : 'unreachable-or-unconfigured',
          routes: routes.map((r) => ({
            name: r.name,
            host: r.host_pattern,
            secret: r.secret_name ? `AGENT_${r.secret_name}` : null,
            deleted: r.deleted === 1,
            in_vault: vaultHosts ? vaultHosts.has(r.host_pattern) : 'unknown',
            value_on_host: r.secret_name ? Boolean(process.env[`AGENT_${r.secret_name}`]) : false,
          })),
          pending_mcp_activations: listPendingMcpActivations().map((p) => ({
            name: p.name,
            agent_group_id: p.agent_group_id,
            host: p.host_pattern,
            secret: p.secret_name ? `AGENT_${p.secret_name}` : null,
            since: p.created_at,
            slow: p.notified_slow === 1,
          })),
        };
      },
    },
    reconcile: {
      access: 'approval',
      description:
        'Reconcile routing rows into the OneCLI vault: create missing entries (value from AGENT_<X> env), refresh env-backed ones, delete tombstoned ones. Use --dry-run to preview without writing.',
      handler: async (args) => {
        // normalizeArgs rewrites --dry-run to args.dry_run before handlers run.
        const dryRun = Boolean(args.dry_run);
        return reconcileCredentials({ dryRun });
      },
    },
  },
});
