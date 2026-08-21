/**
 * PAT: raw REST client for the OneCLI gateway's secrets API.
 *
 * The @onecli-sh/sdk has NO secrets surface (only container-config /
 * ensureAgent / approvals), so vault CRUD goes over the gateway's REST API
 * directly: GET/POST /api/secrets, DELETE /api/secrets/:id — the same calls
 * scripts/seed-routing-from-vault.py proved over flyctl ssh.
 *
 * SAFETY: the SDK silently falls back to the hosted https://api.onecli.sh
 * when ONECLI_URL is unset. This client must never do that — an unset
 * ONECLI_URL disables vault operations entirely (vaultConfigured() false;
 * callers skip with a warn). Fail toward "do nothing", never toward SaaS.
 *
 * Secret VALUES flow one way (host env → vault) and are never read back;
 * the list endpoint returns metadata only.
 */
import { ONECLI_API_KEY, ONECLI_URL } from '../../config.js';

/** Metadata shape of GET /api/secrets entries (no value field). */
export interface VaultSecret {
  id: string;
  name: string;
  type: string;
  /** 'inline' (value stored in the gateway) | op-ref variants (1Password). */
  valueSource?: string;
  opRef?: string | null;
  hostPattern: string | null;
  pathPattern?: string | null;
  injectionConfig?: { headerName?: string; valueFormat?: string } | null;
}

/** POST /api/secrets body. anthropic/openai types are gateway-auto-configured
 *  (no injectionConfig); generic requires one. */
export interface VaultSecretSpec {
  name: string;
  type: string;
  value: string;
  hostPattern: string;
  injectionConfig?: { headerName: string; valueFormat: string };
}

const FETCH_TIMEOUT_MS = 6_000;

export function vaultConfigured(): boolean {
  return Boolean(ONECLI_URL && ONECLI_API_KEY);
}

function baseUrl(): string {
  if (!ONECLI_URL || !ONECLI_API_KEY) {
    throw new Error('OneCLI vault not configured (ONECLI_URL / ONECLI_API_KEY unset)');
  }
  return ONECLI_URL.replace(/\/$/, '');
}

async function vaultFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${ONECLI_API_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return res;
}

export async function listSecrets(): Promise<VaultSecret[]> {
  const res = await vaultFetch('/api/secrets');
  if (!res.ok) throw new Error(`vault list failed: HTTP ${res.status}`);
  return (await res.json()) as VaultSecret[];
}

export async function createSecret(spec: VaultSecretSpec): Promise<void> {
  const res = await vaultFetch('/api/secrets', { method: 'POST', body: JSON.stringify(spec) });
  if (!res.ok) {
    // Never echo the body — it could contain gateway-side detail about the
    // secret. Name + status is enough to act on.
    throw new Error(`vault create "${spec.name}" failed: HTTP ${res.status}`);
  }
}

export async function deleteSecret(id: string): Promise<void> {
  const res = await vaultFetch(`/api/secrets/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    throw new Error(`vault delete ${id} failed: HTTP ${res.status}`);
  }
}

/**
 * Replace an existing entry with a fresh spec (value refresh / rotation).
 * The gateway's update endpoint is unverified (docs only show POST), so this
 * is delete-then-create. At boot that's gap-free (no containers running yet);
 * at runtime (ncl reconcile) there's a sub-second injection gap — acceptable,
 * and swappable for a PUT inside this one function if the endpoint exists.
 */
export async function replaceSecret(existing: VaultSecret, spec: VaultSecretSpec): Promise<void> {
  await deleteSecret(existing.id);
  await createSecret(spec);
}

// ── Agents (secret scoping) ────────────────────────────────────────────────
// PAT: the gateway's per-agent secret scoping. secretMode 'all' = every
// host-matching secret injects; 'selective' = only assigned secretIds.
// Endpoints verified live 2026-07-02 (PATCH /agents/:id/secret-mode,
// PUT /agents/:id/secrets — the PUT REPLACES the whole list).

export interface VaultAgent {
  id: string;
  name: string;
  identifier: string;
  secretMode: 'all' | 'selective';
}

export async function listAgents(): Promise<VaultAgent[]> {
  const res = await vaultFetch('/api/agents');
  if (!res.ok) throw new Error(`agent list failed: HTTP ${res.status}`);
  return (await res.json()) as VaultAgent[];
}

export async function setAgentSecretMode(agentId: string, mode: 'all' | 'selective'): Promise<void> {
  const res = await vaultFetch(`/api/agents/${encodeURIComponent(agentId)}/secret-mode`, {
    method: 'PATCH',
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) throw new Error(`set secret-mode ${mode} failed: HTTP ${res.status}`);
}

/** REPLACES the agent's full assigned-secret list. */
export async function setAgentSecrets(agentId: string, secretIds: string[]): Promise<void> {
  const res = await vaultFetch(`/api/agents/${encodeURIComponent(agentId)}/secrets`, {
    method: 'PUT',
    body: JSON.stringify({ secretIds }),
  });
  if (!res.ok) throw new Error(`set agent secrets failed: HTTP ${res.status}`);
}
