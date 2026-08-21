/**
 * PAT: credential reconcile — make the OneCLI vault match the DB
 * `credential_routing` table (the declarative source of truth; the vault is a
 * derived cache). Runs at boot (src/index.ts step 1d, BEFORE channel adapters
 * so no container can spawn against a stale vault) and on demand via
 * `ncl credentials reconcile`.
 *
 * Per non-deleted route:
 *   - value available (seam 1 non-null) + no vault entry  → create
 *   - value available + entry exists                      → replace (refresh —
 *     the list API returns no values, so a changed AGENT_ secret is
 *     undetectable; unconditional refresh is what makes rotation-by-Fly-secret
 *     propagate: set secret → machine restart → boot reconcile → fresh value)
 *   - value unavailable + entry exists                    → untouched (hand-
 *     managed entry, e.g. today's exa — never clobber or delete it)
 *   - value unavailable + no entry                        → awaiting (declared
 *     intent; the activation watcher is likely waiting on this host)
 * Tombstoned route (deleted=1): delete the vault entry if present.
 *
 * Never fatal: vault-unconfigured or per-route errors are collected in the
 * summary and logged; boot continues. Values are write-only (never read back,
 * never logged).
 *
 * Caveat: replace = delete+create (update endpoint unverified), which changes
 * the entry id. Harmless for secretMode='all' agents (host-matched, the only
 * mode this install uses); would orphan a 'selective' agent's secret-id list.
 */
import { listCredentialRoutes } from '../../db/credential-routing.js';
import { log } from '../../log.js';
import { createSecret, deleteSecret, listSecrets, replaceSecret, vaultConfigured } from './onecli-vault.js';
import { resolveVaultSecretSpec } from './sources.js';

export interface ReconcileSummary {
  /** Entry names created (value present, was missing). */
  created: string[];
  /** Entry names replaced to refresh the value (rotation propagation). */
  refreshed: string[];
  /** Entry names deleted (tombstoned routes). */
  deleted: string[];
  /** Routes declared but awaiting their AGENT_ value (no entry yet). */
  awaiting: string[];
  /** Entries left alone (no env value; hand-managed vault entry). */
  untouched: string[];
  /** "name: message" per route that errored. */
  errors: string[];
  dry_run: boolean;
}

export async function reconcileCredentials(opts: { dryRun?: boolean } = {}): Promise<ReconcileSummary> {
  const dryRun = opts.dryRun ?? false;
  const summary: ReconcileSummary = {
    created: [],
    refreshed: [],
    deleted: [],
    awaiting: [],
    untouched: [],
    errors: [],
    dry_run: dryRun,
  };

  if (!vaultConfigured()) {
    summary.errors.push('vault not configured (ONECLI_URL / ONECLI_API_KEY unset) — reconcile skipped');
    log.warn('Credential reconcile skipped: OneCLI vault not configured');
    return summary;
  }

  const routes = listCredentialRoutes(true); // include tombstones
  let secrets;
  try {
    secrets = await listSecrets();
  } catch (err) {
    summary.errors.push(`vault unreachable: ${err instanceof Error ? err.message : String(err)}`);
    log.warn('Credential reconcile skipped: vault unreachable', { err });
    return summary;
  }

  for (const route of routes) {
    try {
      const existing = secrets.find((s) => s.name === route.name);
      if (route.deleted) {
        if (existing) {
          if (!dryRun) await deleteSecret(existing.id);
          summary.deleted.push(route.name);
        }
        continue;
      }
      const spec = resolveVaultSecretSpec(route);
      if (!spec) {
        (existing ? summary.untouched : summary.awaiting).push(route.name);
        continue;
      }
      if (existing) {
        if (!dryRun) await replaceSecret(existing, spec);
        summary.refreshed.push(route.name);
      } else {
        if (!dryRun) await createSecret(spec);
        summary.created.push(route.name);
      }
    } catch (err) {
      summary.errors.push(`${route.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  log.event({
    kind: 'secrets.reconcile-summary',
    level: summary.errors.length > 0 ? 'warn' : 'info',
    data: { ...summary },
  });
  return summary;
}
