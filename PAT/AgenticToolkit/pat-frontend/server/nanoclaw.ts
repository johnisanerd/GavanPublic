/**
 * Server-side client for talking to nanoclaw over the 6PN-internal network.
 *
 * Two surfaces, both authed with PAT_ADMIN_TOKEN (server-side only — never
 * reaches the browser):
 *   - nanoclawTable(): READ a central-DB table via the read-only /admin/db
 *     browser (SELECT/PRAGMA only). Used to assemble the People views.
 *   - nclWrite(): WRITE through the /admin/ncl bridge (single-writer), but
 *     ALLOWLISTED to the people-spine commands the dashboard actually needs —
 *     so even a compromised pat-frontend can't dispatch arbitrary ncl. The raw
 *     bridge stays full-power but reachable only from inside Fly (:8767 is
 *     6PN-internal-only); operator identity is enforced one layer up (the
 *     /api routes gate on requireOperator before calling these).
 */
const NANOCLAW_HOST = process.env.NANOCLAW_INTERNAL_HOST ?? 'pat-nanoclaw.internal:8767';
const NANOCLAW_SCHEME = process.env.NANOCLAW_INTERNAL_SCHEME ?? 'http';
const NANOCLAW_TOKEN = process.env.PAT_ADMIN_TOKEN ?? '';

function authedUrl(path: string): string {
  const sep = path.includes('?') ? '&' : '?';
  return (
    `${NANOCLAW_SCHEME}://${NANOCLAW_HOST}${path}` +
    (NANOCLAW_TOKEN ? `${sep}token=${encodeURIComponent(NANOCLAW_TOKEN)}` : '')
  );
}

/** Read every row of a central-DB table (capped at 500 — fine for the small
 *  identity tables; callers note the cap where it could bite). */
export async function nanoclawTable<T = Record<string, unknown>>(
  table: string,
  signal?: AbortSignal,
): Promise<T[]> {
  const res = await fetch(authedUrl(`/admin/db/${encodeURIComponent(table)}?limit=500`), { signal });
  if (!res.ok) throw new Error(`admin/db/${table} -> ${res.status}`);
  const j = (await res.json()) as { rows?: T[]; exists?: boolean };
  return j.rows ?? [];
}

export interface NclFrame<T = unknown> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

// The ONLY ncl commands the dashboard may dispatch (people-spine writes).
const NCL_WRITE_ALLOW = new Set([
  'people-create',
  'people-add-identifier',
  'people-remove-identifier',
  'people-link',
  'people-unlink',
  // Destructive: delete a person + cascade-deregister every linked handle
  // (reverts each to unknown/unapproved). Operator-gated one layer up
  // (requireOperator on the route) + name-confirm in the UI.
  'people-delete',
  // Pairing-code self-serve handle linking: mint a code for the operator's
  // own person. The handle linking itself happens nanoclaw-side when the code
  // is messaged from the new handle — this only mints + the dashboard polls.
  'pairing-codes-create',
]);

/** Dispatch a WRITE through the /admin/ncl bridge. Throws on a non-allowlisted
 *  command (defense in depth) or transport error; returns the ncl frame
 *  otherwise (ok/error). Requires PAT_ENABLE_NCL_HTTP=1 on the nanoclaw side. */
export async function nclWrite<T = unknown>(
  command: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<NclFrame<T>> {
  if (!NCL_WRITE_ALLOW.has(command)) throw new Error(`ncl command not allowed: ${command}`);
  const res = await fetch(authedUrl('/admin/ncl'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command, args }),
    signal,
  });
  return (await res.json()) as NclFrame<T>;
}
