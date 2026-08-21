/**
 * People-spine business logic for the dashboard, on top of the nanoclaw client.
 *
 * - ensurePersonForOperator(): the login→person mint. On every authenticated
 *   load we resolve the operator's verified email to a person, CREATING one (+
 *   a verified `email` identifier) if none exists. Idempotent (resolve-first)
 *   and fails SOFT — a people-spine hiccup must never block login.
 * - listPeople(): the People tab feed (people + identifiers + handles + role).
 * - listHandles(): the linking dialog's source — every messaging handle (a
 *   `users` row), its type (platform prefix), and whether it's already linked.
 * - link/unlinkHandle(): attach/detach a handle to a person via ncl.
 *
 * Reads go through the read-only /admin/db browser; writes through the
 * allowlisted ncl bridge. See server/nanoclaw.ts.
 */
import type { Operator } from './auth';
import { nanoclawTable, nclWrite, type NclFrame } from './nanoclaw';

export interface Person {
  id: string;
  first_name: string;
  last_name: string;
  created_at?: string;
}
interface IdentifierRow {
  person_id: string;
  kind: string;
  value: string;
  verified: number;
}
interface PersonUserRow {
  user_id: string;
  person_id: string;
  link_method: string;
}
interface RoleRow {
  person_id: string;
  role: string;
}
interface UserRow {
  id: string;
}

/** Platform prefix of a handle id, e.g. "telegram:123" -> "telegram". */
const kindOf = (userId: string): string => {
  const i = userId.indexOf(':');
  return i < 0 ? 'other' : userId.slice(0, i).toLowerCase();
};

async function resolveByEmail(email: string, signal?: AbortSignal): Promise<Person | null> {
  const [people, idents] = await Promise.all([
    nanoclawTable<Person>('people', signal),
    nanoclawTable<IdentifierRow>('person_identifiers', signal),
  ]);
  const e = email.toLowerCase();
  const match = idents.find((i) => i.kind === 'email' && i.value.toLowerCase() === e);
  if (!match) return null;
  return people.find((p) => p.id === match.person_id) ?? null;
}

/**
 * Login mint: ensure a person exists for the operator's (Clerk-verified) email.
 * Returns the person, or null if the people spine is unreachable (caller treats
 * null as "no person yet" and does NOT fail the request).
 */
export async function ensurePersonForOperator(op: Operator): Promise<Person | null> {
  try {
    const existing = await resolveByEmail(op.email);
    if (existing) return existing;
    // last_name is NOT NULL in the schema — fall back when Clerk has no surname.
    const first = (op.firstName ?? op.email.split('@')[0]) || op.email;
    const last = op.lastName || '(unknown)';
    const created = await nclWrite<Person>('people-create', { first_name: first, last_name: last });
    if (!created.ok || !created.data) return null;
    // Clerk OAuth verified the email, so mark the identifier verified.
    await nclWrite('people-add-identifier', {
      person_id: created.data.id,
      kind: 'email',
      value: op.email,
      verified: true,
    });
    return created.data;
  } catch {
    return null; // never block login on a people-spine failure
  }
}

export async function getRole(personId: string, signal?: AbortSignal): Promise<string | null> {
  const roles = await nanoclawTable<RoleRow>('person_roles', signal);
  return roles.find((r) => r.person_id === personId)?.role ?? null;
}

/**
 * The identifiers for one person (phone/email/...). Powers /api/me's
 * first-login phone-capture check on the client. Fails SOFT — any read error
 * yields `[]` so it never breaks /api/me (same contract as the login mint).
 */
export async function getIdentifiers(
  personId: string,
  signal?: AbortSignal,
): Promise<{ kind: string; value: string; verified: number }[]> {
  try {
    const idents = await nanoclawTable<IdentifierRow>('person_identifiers', signal);
    return idents
      .filter((i) => i.person_id === personId)
      .map((i) => ({ kind: i.kind, value: i.value, verified: i.verified }));
  } catch {
    return [];
  }
}

/**
 * The handles (platform users rows) currently linked to one person — powers the
 * "My Handles" view on /api/me. Fails SOFT (→ []) so it never breaks /api/me,
 * same contract as getIdentifiers / the login mint.
 */
export async function getHandlesForPerson(
  personId: string,
  signal?: AbortSignal,
): Promise<{ user_id: string; kind: string; link_method: string }[]> {
  try {
    const links = await nanoclawTable<PersonUserRow>('person_users', signal);
    return links
      .filter((l) => l.person_id === personId)
      .map((l) => ({ user_id: l.user_id, kind: kindOf(l.user_id), link_method: l.link_method }));
  } catch {
    return [];
  }
}

export interface PersonRow {
  id: string;
  first_name: string;
  last_name: string;
  role: string | null;
  identifiers: { kind: string; value: string; verified: number }[];
  handles: { user_id: string; link_method: string }[];
}

export async function listPeople(signal?: AbortSignal): Promise<PersonRow[]> {
  const [people, idents, links, roles] = await Promise.all([
    nanoclawTable<Person>('people', signal),
    nanoclawTable<IdentifierRow>('person_identifiers', signal),
    nanoclawTable<PersonUserRow>('person_users', signal),
    nanoclawTable<RoleRow>('person_roles', signal),
  ]);
  return people.map((p) => ({
    id: p.id,
    first_name: p.first_name,
    last_name: p.last_name,
    role: roles.find((r) => r.person_id === p.id)?.role ?? null,
    identifiers: idents
      .filter((i) => i.person_id === p.id)
      .map((i) => ({ kind: i.kind, value: i.value, verified: i.verified })),
    handles: links
      .filter((l) => l.person_id === p.id)
      .map((l) => ({ user_id: l.user_id, link_method: l.link_method })),
  }));
}

export interface Handle {
  user_id: string;
  kind: string;
  linked_person_id: string | null;
}

/** Linking-dialog source: all active handle types + handles matching kind/q.
 *  NOTE: capped at the nanoclawTable() 500-row read; revisit if `users` grows. */
export async function listHandles(
  kind: string | undefined,
  q: string | undefined,
  limit = 50,
  signal?: AbortSignal,
): Promise<{ kinds: string[]; handles: Handle[] }> {
  const [users, links] = await Promise.all([
    nanoclawTable<UserRow>('users', signal),
    nanoclawTable<PersonUserRow>('person_users', signal),
  ]);
  const linkMap = new Map(links.map((l) => [l.user_id, l.person_id]));
  const kinds = Array.from(new Set(users.map((u) => kindOf(u.id)))).sort();
  let handles: Handle[] = users.map((u) => ({
    user_id: u.id,
    kind: kindOf(u.id),
    linked_person_id: linkMap.get(u.id) ?? null,
  }));
  if (kind) handles = handles.filter((h) => h.kind === kind);
  if (q) {
    const ql = q.toLowerCase();
    handles = handles.filter((h) => h.user_id.toLowerCase().includes(ql));
  }
  handles.sort((a, b) => a.user_id.localeCompare(b.user_id));
  return { kinds, handles: handles.slice(0, limit) };
}

/** Add an identifier (phone/email) to a person. nanoclaw normalizes the value
 *  (E.164 for phone) and rejects malformed input — surfaced as the frame error. */
export function addIdentifier(
  personId: string,
  kind: string,
  value: string,
  verified: boolean,
): Promise<NclFrame> {
  return nclWrite('people-add-identifier', { person_id: personId, kind, value, verified });
}

/** Remove an identifier (keyed by kind+value, as the people resource expects). */
export function removeIdentifier(kind: string, value: string): Promise<NclFrame> {
  return nclWrite('people-remove-identifier', { kind, value });
}

export function linkHandle(personId: string, userId: string): Promise<NclFrame> {
  return nclWrite('people-link', { user_id: userId, person_id: personId });
}

export function unlinkHandle(userId: string): Promise<NclFrame> {
  return nclWrite('people-unlink', { user_id: userId });
}

/**
 * Delete a person AND cascade-deregister every linked handle (membership,
 * roles, DM cache, dedicated 1:1 DM groups + wiring, in-flight approvals,
 * pairing audit, and the users row) — reverting each handle to
 * unknown/unapproved. nanoclaw runs the whole cascade in one transaction and
 * KEEPS shared group chats (returned in the frame's data). Destructive: the
 * route gates this on requireOperator and the UI requires a name-confirm. */
export function deletePerson(personId: string): Promise<NclFrame> {
  return nclWrite('people-delete', { id: personId });
}

// ─────────────────────────── Pairing codes ───────────────────────────

export interface PairingCodeRow {
  id: string;
  code: string;
  person_id: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  linked_user_id: string | null;
}

/** Mint a pairing code for a person (the operator's own). nanoclaw enforces the
 *  6-digit / 5-min / single-use / per-person-cap rules; errors surface as the
 *  frame error. */
export function createPairingCode(personId: string): Promise<NclFrame<PairingCodeRow>> {
  return nclWrite<PairingCodeRow>('pairing-codes-create', { person_id: personId });
}

/** Read one pairing code row by id (the modal's poll source — flips to paired
 *  when consumed_at/linked_user_id appear). Reads the table directly via the
 *  read-only browser; scoped to the requested id by the caller. */
export async function getPairingCode(id: string, signal?: AbortSignal): Promise<PairingCodeRow | null> {
  const rows = await nanoclawTable<PairingCodeRow>('pairing_codes', signal);
  return rows.find((r) => r.id === id) ?? null;
}
