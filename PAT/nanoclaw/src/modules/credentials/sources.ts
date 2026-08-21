/**
 * PAT: the two credential-source seams. Everything source-specific lives
 * behind these two functions — nothing else in the codebase may know where a
 * credential value comes from or how presence is checked. That is the whole
 * op:// (1Password) compatibility contract: adopting 1P later means swapping
 * the internals here (spec → {opRef} instead of {value}; presence →
 * items.list on the vault, never items.get), not touching callers. See
 * plans/credential-activation-implementation.md §"Compatibility contract".
 *
 * Inline/AGENT_ implementations (today):
 *   - value: process.env.AGENT_<secret_name> (a Fly secret on the host).
 *   - presence: does the OneCLI vault have an entry for the host? A local
 *     gateway read — never touches the credential's source service.
 */
import type { CredentialRoute } from '../../db/credential-routing.js';
import { listSecrets, type VaultSecret, type VaultSecretSpec } from './onecli-vault.js';

/**
 * SEAM 1 — value materialization. Build the vault secret spec for a routing
 * row, or null when the value isn't available yet ("awaiting value" — the
 * route is declared intent; the vault entry appears when the operator adds
 * the AGENT_<secret_name> secret and the host reboots into reconcile).
 */
export function resolveVaultSecretSpec(route: CredentialRoute): VaultSecretSpec | null {
  if (!route.secret_name || !route.host_pattern) return null;
  const value = process.env[`AGENT_${route.secret_name}`];
  if (!value) return null;
  const type = route.type || 'generic';
  return {
    name: route.name,
    type,
    value,
    hostPattern: route.host_pattern,
    // anthropic/openai types are gateway-auto-configured; only generic
    // carries an explicit injection config.
    ...(type === 'generic'
      ? {
          injectionConfig: {
            headerName: route.header_name ?? 'Authorization',
            valueFormat: route.value_format || 'Bearer {value}',
          },
        }
      : {}),
  };
}

/** Pure matcher half of seam 2 — lets the watcher check many rows against one
 *  listSecrets() snapshot instead of fetching per row. */
export function hostHasCredential(hostPattern: string, secrets: VaultSecret[]): boolean {
  if (!hostPattern) return false;
  return secrets.some((s) => s.hostPattern === hostPattern);
}

/**
 * SEAM 2 — presence check: "will an MCP on this host authenticate if we
 * (re)handshake now?" Source-free by construction: reads the local gateway,
 * never the credential's own service.
 */
export async function credentialAvailableForHost(hostPattern: string): Promise<boolean> {
  return hostHasCredential(hostPattern, await listSecrets());
}
