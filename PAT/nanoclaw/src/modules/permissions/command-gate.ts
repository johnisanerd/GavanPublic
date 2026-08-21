/**
 * PAT: Admin-bypass flag for the approval cascade.
 *
 * When `PAT_ADMINS_BYPASS_APPROVAL=1`, callers whose role is `owner` or
 * `admin` skip the unknown-sender and unknown-channel approval flows
 * entirely. This lets admin-driven demos run without hitting approval cards.
 *
 * Pattern mirrors `realtime-owners.ts`: lazy-cached env read with a
 * test-helper reset.
 */

const ENV_VAR = 'PAT_ADMINS_BYPASS_APPROVAL';

let cached: boolean | null = null;

/** Read the bypass flag, caching after first call. */
export function isAdminBypassEnabled(): boolean {
  if (cached !== null) return cached;
  const raw = process.env[ENV_VAR] ?? '';
  cached = raw === '1' || raw.toLowerCase() === 'true';
  return cached;
}

/** Test helper — drop the cache so `process.env` changes are re-read. */
export function resetAdminBypassCache(): void {
  cached = null;
}
