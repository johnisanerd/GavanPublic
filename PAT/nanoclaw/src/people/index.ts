/**
 * PAT: people spine — the single source of truth for all writes to the three
 * additive person tables (`people`, `person_identifiers`, `person_users`).
 *
 * nanoclaw is the only writer to v2.db; both auto-enroll (inbound path) and
 * operators (`ncl people` CLI / admin API) go through these functions. The
 * dashboard, when it lands, forwards mutations here rather than writing the DB
 * directly. See plans/admin-dashboard-and-people.md (Phase 1).
 *
 * Invariants enforced here, not just in the schema:
 *   - Auto-enroll LINKS, never CREATES (names are NOT NULL; an unknown inbound
 *     stays unlinked until a human names + claims it).
 *   - An identifier (kind, value) maps to exactly one person — re-adding it for
 *     a different person throws.
 *   - Deleting a person CASCADES: every linked handle is fully deregistered
 *     (reverted to unknown/unapproved) — see deletePerson / deregisterHandle.
 *     Shared group chats are conservatively kept.
 */
import { randomUUID } from 'crypto';

import { getDb, hasTable } from '../db/connection.js';
import { log } from '../log.js';
// PAT: cross-channel auto-approve grants membership when a sender resolves to a
// known person. addMember is INSERT OR IGNORE + idempotent. No import cycle:
// agent-group-members only reaches into user-roles, never back into people.
import { addMember, hasMembershipRow } from '../modules/permissions/db/agent-group-members.js';
import { normalizeIdentifier, parseHandle, type IdentifierKind } from './normalize.js';

export interface Person {
  id: string;
  first_name: string;
  last_name: string;
  created_at: string;
  updated_at: string | null;
}

export interface PersonIdentifier {
  person_id: string;
  kind: IdentifierKind;
  value: string;
  created_at: string;
}

export interface PersonUser {
  user_id: string;
  person_id: string;
  linked_at: string;
  link_method: string | null;
}

const now = (): string => new Date().toISOString();

// ──────────────────── People directory events (pat_enrichment) ────────────
//
// PAT: every people-spine MUTATION emits a structured event so the
// `pat_enrichment` directory stream (built by pat-observability's forwarder)
// stays fresh without polling. The forwarder routes `people.*` events to
// `pat_enrichment`, NOT `pat_events` — so the display_name + handles these
// carry never land beside message bodies. `pat_enrichment` is the id↔name/
// handles directory the resolver (`resolve_person` MCP / `patobs resolve`)
// reads at query time.
//
// `people.upserted` — create / name-update / identifier-add / handle-link.
// `people.removed`  — delete (tombstone, empty snapshot) / unlink /
//                     identifier-remove (snapshot reflects what REMAINS).
//
// DEFENSIVE: a logging failure must NEVER break the underlying mutation. The
// snapshot is built from the existing helpers (getPerson / getHandlesForPerson
// / getIdentifiers); `override` lets deletePerson pass an explicit tombstone
// (empty handles/identifiers) since the person row is already gone.
function emitPeopleEvent(
  kind: 'people.upserted' | 'people.removed',
  personId: string,
  override?: { display_name?: string; handles?: string[]; identifiers?: { kind: string; value: string }[] },
): void {
  try {
    const person = getPerson(personId);
    const display_name =
      override?.display_name ?? (person ? [person.first_name, person.last_name].filter(Boolean).join(' ').trim() : '');
    const handles = override?.handles ?? (person ? getHandlesForPerson(personId).map((h) => h.user_id) : []);
    const identifiers =
      override?.identifiers ?? (person ? getIdentifiers(personId).map((i) => ({ kind: i.kind, value: i.value })) : []);
    log.event({ kind, data: { person_id: personId, display_name, handles, identifiers } });
    // Intentional catch-all: directory enrichment is best-effort; a logging
    // hiccup must never roll back or break the mutation that already happened.
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (e) {
    log.warn('emitPeopleEvent failed', {
      person_id: personId,
      kind,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// ─────────────────────────── People ───────────────────────────

export function createPerson(input: { first_name: string; last_name: string; id?: string }): Person {
  const first = input.first_name?.trim();
  const last = input.last_name?.trim();
  if (!first) throw new Error('first_name is required');
  if (!last) throw new Error('last_name is required');

  const person: Person = {
    id: input.id ?? `person-${randomUUID()}`,
    first_name: first,
    last_name: last,
    created_at: now(),
    updated_at: null,
  };
  getDb()
    .prepare(
      `INSERT INTO people (id, first_name, last_name, created_at, updated_at)
       VALUES (@id, @first_name, @last_name, @created_at, @updated_at)`,
    )
    .run(person);
  log.info('Person created', { person_id: person.id });
  emitPeopleEvent('people.upserted', person.id); // PAT: keep pat_enrichment fresh
  return person;
}

export function getPerson(id: string): Person | undefined {
  return getDb().prepare('SELECT * FROM people WHERE id = ?').get(id) as Person | undefined;
}

export function listPeople(): Person[] {
  return getDb().prepare('SELECT * FROM people ORDER BY created_at').all() as Person[];
}

export function updatePerson(id: string, patch: { first_name?: string; last_name?: string }): Person {
  const existing = getPerson(id);
  if (!existing) throw new Error(`person not found: ${id}`);

  const first = patch.first_name?.trim();
  const last = patch.last_name?.trim();
  if (first === undefined && last === undefined) {
    throw new Error('nothing to update — provide --first-name and/or --last-name');
  }
  if (patch.first_name !== undefined && !first) throw new Error('first_name cannot be empty');
  if (patch.last_name !== undefined && !last) throw new Error('last_name cannot be empty');

  getDb()
    .prepare('UPDATE people SET first_name = ?, last_name = ?, updated_at = ? WHERE id = ?')
    .run(first ?? existing.first_name, last ?? existing.last_name, now(), id);
  emitPeopleEvent('people.upserted', id); // PAT: keep pat_enrichment fresh
  return getPerson(id) as Person;
}

// ─────────────────────── Handle deregistration (cascade) ───────────────────────

/**
 * PAT: report of what a single-handle deregistration removed vs deliberately
 * kept. Surfaced up through `deletePerson` so an operator (and the tests) can
 * see the exact cascade scope — leftovers would make the handle look "still
 * approved", so the report is the contract.
 */
export interface DeregisterHandleResult {
  user_id: string;
  /** Counts of rows removed, per handle-keyed table. */
  removed: {
    agent_group_members: number;
    user_roles: number;
    user_dms: number;
    sessions: number;
    pending_sender_approvals: number;
    pending_channel_approvals: number;
    pending_approvals: number;
    unregistered_senders: number;
    pairing_codes: number;
    messaging_groups: number;
    messaging_group_agents: number;
    agent_destinations: number;
  };
  /** Dedicated DM messaging_groups deleted (id list, for audit). */
  deleted_dm_groups: string[];
  /** messaging_groups referenced by this handle's DM cache that were KEPT
   *  because they look shared (is_group=1, or used by other handles/sessions).
   *  An operator can review these by hand. */
  kept_shared_groups: { id: string; reason: string }[];
}

/**
 * Is a messaging_group safe to delete as this handle's PRIVATE 1:1 DM channel?
 *
 * Conservative by design — a wrong "yes" deletes a shared group chat. Returns a
 * keep-reason string when NOT safe (so the caller can report it), or null when
 * it IS safe to delete. A group is deletable only when ALL hold:
 *   - it's a DM (is_group = 0),
 *   - no `user_dms` row OTHER than this handle's points at it,
 *   - no `sessions` row for a DIFFERENT user_id (or NULL system user_id) uses it.
 *
 * `unknown_sender_policy='public'` (e.g. the anam-web shared venue) is treated
 * as shared even at is_group=0 — flagged, never auto-deleted.
 */
function dmGroupKeepReason(messagingGroupId: string, userId: string): string | null {
  const db = getDb();
  const mg = db
    .prepare('SELECT id, is_group, unknown_sender_policy FROM messaging_groups WHERE id = ?')
    .get(messagingGroupId) as { id: string; is_group: number; unknown_sender_policy: string } | undefined;
  if (!mg) return null; // already gone — nothing to keep
  if (mg.is_group === 1) return 'is_group=1 (group chat)';
  if (mg.unknown_sender_policy === 'public') return 'unknown_sender_policy=public (shared venue)';

  const otherDm = db
    .prepare('SELECT COUNT(*) AS n FROM user_dms WHERE messaging_group_id = ? AND user_id != ?')
    .get(messagingGroupId, userId) as { n: number };
  if (otherDm.n > 0) return `referenced by ${otherDm.n} other handle(s) in user_dms`;

  // A session pinned to a different (or system/NULL) user is a strong shared
  // signal — refuse to delete the group out from under it.
  const otherSession = db
    .prepare('SELECT COUNT(*) AS n FROM sessions WHERE messaging_group_id = ? AND (user_id IS NULL OR user_id != ?)')
    .get(messagingGroupId, userId) as { n: number };
  if (otherSession.n > 0) return `has ${otherSession.n} session(s) for another/unknown user`;

  return null;
}

/**
 * PAT: fully DEREGISTER a single handle (`users.id`) — revert it to the
 * unknown/unapproved state, as if it had never been approved. After this, an
 * inbound from the handle is treated as a brand-new unlinked handle (pairing
 * pre-check / drop), with NO residual access, role, membership, DM cache, or
 * person link.
 *
 * MUST be called inside a transaction (see deletePerson). FK order matters
 * (foreign_keys=ON, no ON DELETE CASCADE in the schema): every child of `users`
 * and of any deleted DM `messaging_group` is removed BEFORE its parent, ending
 * with the `users` row itself.
 *
 * Conservative on shared rows: a `messaging_group` is deleted only when it is
 * this handle's dedicated 1:1 DM (see `dmGroupKeepReason`). Shared group chats
 * and any row another person depends on are KEPT and reported.
 *
 * Note: `person_users` is NOT touched here — the caller (`deletePerson`) owns
 * the person link rows and clears them after deregistering every handle.
 */
export function deregisterHandle(userId: string): DeregisterHandleResult {
  const db = getDb();
  const removed: DeregisterHandleResult['removed'] = {
    agent_group_members: 0,
    user_roles: 0,
    user_dms: 0,
    sessions: 0,
    pending_sender_approvals: 0,
    pending_channel_approvals: 0,
    pending_approvals: 0,
    unregistered_senders: 0,
    pairing_codes: 0,
    messaging_groups: 0,
    messaging_group_agents: 0,
    agent_destinations: 0,
  };
  const deletedDmGroups: string[] = [];
  const keptSharedGroups: { id: string; reason: string }[] = [];

  // 1) Decide which DM messaging_groups are this handle's dedicated 1:1 channels
  //    (capture BEFORE we delete the user_dms rows that point at them).
  const dmRows = db.prepare('SELECT messaging_group_id FROM user_dms WHERE user_id = ?').all(userId) as {
    messaging_group_id: string;
  }[];
  const dedicatedDmGroupIds: string[] = [];
  for (const { messaging_group_id } of dmRows) {
    const reason = dmGroupKeepReason(messaging_group_id, userId);
    if (reason) keptSharedGroups.push({ id: messaging_group_id, reason });
    else dedicatedDmGroupIds.push(messaging_group_id);
  }

  // 2) Handle-keyed access rows — these are what make the handle "approved".
  removed.agent_group_members = db.prepare('DELETE FROM agent_group_members WHERE user_id = ?').run(userId).changes;
  // user_roles audit refs: a deleted handle that GRANTED other roles would leave
  // a dangling granted_by FK once its users row is gone — null those first.
  db.prepare('UPDATE user_roles SET granted_by = NULL WHERE granted_by = ?').run(userId);
  db.prepare('UPDATE agent_group_members SET added_by = NULL WHERE added_by = ?').run(userId);
  removed.user_roles = db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(userId).changes;
  removed.user_dms = db.prepare('DELETE FROM user_dms WHERE user_id = ?').run(userId).changes;

  // 3) Sessions: delete the handle's OWN sessions on its dedicated DM groups;
  //    for shared/group sessions, just detach the handle (NULL user_id) so the
  //    session survives for others but no longer points back at this handle.
  if (dedicatedDmGroupIds.length > 0) {
    const placeholders = dedicatedDmGroupIds.map(() => '?').join(',');
    removed.sessions = db
      .prepare(`DELETE FROM sessions WHERE user_id = ? AND messaging_group_id IN (${placeholders})`)
      .run(userId, ...dedicatedDmGroupIds).changes;
  }
  db.prepare('UPDATE sessions SET user_id = NULL WHERE user_id = ?').run(userId);

  // 4) In-flight approval residue keyed to this handle (sender + approver refs).
  if (hasTable(db, 'pending_sender_approvals')) {
    removed.pending_sender_approvals = db
      .prepare('DELETE FROM pending_sender_approvals WHERE sender_identity = ? OR approver_user_id = ?')
      .run(userId, userId).changes;
  }
  if (hasTable(db, 'pending_channel_approvals')) {
    removed.pending_channel_approvals = db
      .prepare('DELETE FROM pending_channel_approvals WHERE approver_user_id = ?')
      .run(userId).changes;
  }
  if (hasTable(db, 'pending_approvals')) {
    removed.pending_approvals = db
      .prepare('DELETE FROM pending_approvals WHERE approver_user_id = ?')
      .run(userId).changes;
  }
  if (hasTable(db, 'unregistered_senders')) {
    removed.unregistered_senders = db.prepare('DELETE FROM unregistered_senders WHERE user_id = ?').run(userId).changes;
  }
  if (hasTable(db, 'pairing_codes')) {
    // The handle's pairing audit trail — drop it so re-messaging is treated as
    // brand-new (no residual "this handle consumed code X for person Y").
    removed.pairing_codes = db.prepare('DELETE FROM pairing_codes WHERE linked_user_id = ?').run(userId).changes;
  }

  // 5) Tear down each dedicated DM messaging_group: its wiring (mga) +
  //    auto-created channel destination(s) first, then the group itself.
  for (const mgId of dedicatedDmGroupIds) {
    if (hasTable(db, 'agent_destinations')) {
      removed.agent_destinations += db
        .prepare("DELETE FROM agent_destinations WHERE target_type = 'channel' AND target_id = ?")
        .run(mgId).changes;
    }
    removed.messaging_group_agents += db
      .prepare('DELETE FROM messaging_group_agents WHERE messaging_group_id = ?')
      .run(mgId).changes;
    // pending approvals can also reference the mg directly (channel-registration);
    // clear any lingering rows before dropping the group to avoid dangling FKs.
    if (hasTable(db, 'pending_channel_approvals')) {
      db.prepare('DELETE FROM pending_channel_approvals WHERE messaging_group_id = ?').run(mgId);
    }
    if (hasTable(db, 'pending_sender_approvals')) {
      db.prepare('DELETE FROM pending_sender_approvals WHERE messaging_group_id = ?').run(mgId);
    }
    const delMg = db.prepare('DELETE FROM messaging_groups WHERE id = ?').run(mgId).changes;
    removed.messaging_groups += delMg;
    if (delMg > 0) deletedDmGroups.push(mgId);
  }

  // 6) Finally the users row itself — the handle ceases to exist.
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);

  log.info('Handle deregistered', { user_id: userId, removed, deleted_dm_groups: deletedDmGroups });
  return { user_id: userId, removed, deleted_dm_groups: deletedDmGroups, kept_shared_groups: keptSharedGroups };
}

export interface DeletePersonResult {
  deleted: string;
  /** The handles deregistered, with each handle's per-table cascade report. */
  deregistered_handles: DeregisterHandleResult[];
  removed_identifiers: number;
  removed_person_roles: number;
  removed_pairing_codes: number;
  /** Aggregated shared groups KEPT across all handles — operator review list. */
  kept_shared_groups: { id: string; reason: string }[];
}

/**
 * PAT: delete a person AND fully deregister every handle linked to them — a
 * CASCADE that reverts each handle to the unknown/unapproved state, as if the
 * person had never been approved. After this, any of the (former) handles
 * messaging again is treated as a brand-new unlinked handle.
 *
 * All-or-nothing: the entire cascade runs in ONE transaction, so a partial
 * failure (which would leave a handle half-approved) rolls back cleanly.
 *
 * What gets DELETED (per handle): agent_group_members, user_roles, user_dms,
 * the handle's own sessions on its dedicated DM groups, in-flight approval
 * residue (pending_sender/channel/approvals), unregistered_senders, the
 * handle's pairing audit rows, its dedicated 1:1 DM messaging_groups (+ their
 * wiring + auto-destinations), and finally the `users` row. Then the person's
 * person_users links, person_identifiers, person_roles, person-owned
 * pairing_codes, and the people row.
 *
 * What is deliberately KEPT (conservative — leaving these is correct, deleting
 * them would break others): SHARED group-chat messaging_groups and any row
 * another person depends on (reported in `kept_shared_groups`); sessions on
 * shared groups (detached: user_id set NULL, session preserved for others).
 */
export function deletePerson(id: string): DeletePersonResult {
  const db = getDb();
  const existing = getPerson(id);
  if (!existing) throw new Error(`person not found: ${id}`);
  // PAT: capture the display name BEFORE the cascade deletes the row, so the
  // pat_enrichment tombstone (`people.removed`) below carries it.
  const displayName = [existing.first_name, existing.last_name].filter(Boolean).join(' ').trim();

  const run = db.transaction((): DeletePersonResult => {
    const handles = db.prepare('SELECT user_id FROM person_users WHERE person_id = ?').all(id) as {
      user_id: string;
    }[];

    const deregistered: DeregisterHandleResult[] = [];
    const keptShared: { id: string; reason: string }[] = [];
    for (const { user_id } of handles) {
      // Clear the person link FIRST so deregisterHandle's users-row delete
      // doesn't trip the person_users → users FK.
      db.prepare('DELETE FROM person_users WHERE user_id = ?').run(user_id);
      const r = deregisterHandle(user_id);
      deregistered.push(r);
      keptShared.push(...r.kept_shared_groups);
    }

    // Any person_users rows that somehow lacked a users row (shouldn't happen,
    // but be exhaustive) — clear them so the person row can drop.
    db.prepare('DELETE FROM person_users WHERE person_id = ?').run(id);
    const removedIdentifiers = db.prepare('DELETE FROM person_identifiers WHERE person_id = ?').run(id).changes;
    let removedPersonRoles = 0;
    if (hasTable(db, 'person_roles')) {
      removedPersonRoles = db.prepare('DELETE FROM person_roles WHERE person_id = ?').run(id).changes;
    }
    let removedPairingCodes = 0;
    if (hasTable(db, 'pairing_codes')) {
      // Outstanding (unconsumed) codes minted for this person — drop them so a
      // stray code can't link a fresh handle to a now-deleted person id.
      removedPairingCodes = db.prepare('DELETE FROM pairing_codes WHERE person_id = ?').run(id).changes;
    }
    db.prepare('DELETE FROM people WHERE id = ?').run(id);

    return {
      deleted: id,
      deregistered_handles: deregistered,
      removed_identifiers: removedIdentifiers,
      removed_person_roles: removedPersonRoles,
      removed_pairing_codes: removedPairingCodes,
      kept_shared_groups: keptShared,
    };
  });

  const result = run();
  log.info('Person deleted (cascade)', {
    person_id: id,
    handles: result.deregistered_handles.length,
    kept_shared_groups: result.kept_shared_groups.length,
  });
  // PAT: tombstone the directory row — the person is fully gone, so the
  // snapshot is empty (handles + identifiers deregistered in the cascade).
  emitPeopleEvent('people.removed', id, { display_name: displayName, handles: [], identifiers: [] });
  return result;
}

// ─────────────────────────── Identifiers ───────────────────────────

/**
 * Attach a recognizable identifier (email / phone) to a person. Normalizes the
 * value. Idempotent for the same person; throws if the normalized identifier
 * already belongs to a DIFFERENT person (the PK promise).
 */
export function addIdentifier(input: { person_id: string; kind: IdentifierKind; value: string }): PersonIdentifier {
  if (input.kind !== 'email' && input.kind !== 'phone') {
    throw new Error(`kind must be 'email' or 'phone' (got '${input.kind}')`);
  }
  if (!getPerson(input.person_id)) throw new Error(`person not found: ${input.person_id}`);
  const value = normalizeIdentifier(input.kind, input.value);
  if (!value) throw new Error(`could not normalize ${input.kind} value: ${JSON.stringify(input.value)}`);

  const db = getDb();
  const existing = db
    .prepare('SELECT * FROM person_identifiers WHERE kind = ? AND value = ?')
    .get(input.kind, value) as PersonIdentifier | undefined;

  if (existing) {
    if (existing.person_id !== input.person_id) {
      throw new Error(`${input.kind} ${value} already belongs to person ${existing.person_id} — remove it there first`);
    }
    // Idempotent re-add for the same person — no-op beyond keeping enrichment fresh.
    emitPeopleEvent('people.upserted', input.person_id); // PAT: keep pat_enrichment fresh
    return existing;
  }

  const row: PersonIdentifier = {
    person_id: input.person_id,
    kind: input.kind,
    value,
    created_at: now(),
  };
  db.prepare(
    `INSERT INTO person_identifiers (person_id, kind, value, created_at)
     VALUES (@person_id, @kind, @value, @created_at)`,
  ).run(row);
  log.info('Identifier added', { person_id: input.person_id, kind: input.kind });
  emitPeopleEvent('people.upserted', input.person_id); // PAT: keep pat_enrichment fresh
  return row;
}

export function removeIdentifier(kind: IdentifierKind, value: string): { removed: { kind: string; value: string } } {
  const normalized = normalizeIdentifier(kind, value) ?? value;
  // PAT: capture the owning person BEFORE the delete so we can emit the
  // people.removed directory event with the REMAINING snapshot afterward.
  const owner = getDb()
    .prepare('SELECT person_id FROM person_identifiers WHERE kind = ? AND value = ?')
    .get(kind, normalized) as { person_id: string } | undefined;
  const result = getDb().prepare('DELETE FROM person_identifiers WHERE kind = ? AND value = ?').run(kind, normalized);
  if (result.changes === 0) throw new Error(`identifier not found: ${kind} ${normalized}`);
  if (owner) emitPeopleEvent('people.removed', owner.person_id); // PAT: snapshot reflects what remains
  return { removed: { kind, value: normalized } };
}

export function getIdentifiers(personId: string): PersonIdentifier[] {
  return getDb()
    .prepare('SELECT * FROM person_identifiers WHERE person_id = ? ORDER BY created_at')
    .all(personId) as PersonIdentifier[];
}

/** Resolve a person by a (kind, value) identifier — the deterministic match. */
export function resolvePersonByIdentifier(kind: IdentifierKind, value: string): Person | undefined {
  const normalized = normalizeIdentifier(kind, value);
  if (!normalized) return undefined;
  const row = getDb()
    .prepare('SELECT person_id FROM person_identifiers WHERE kind = ? AND value = ?')
    .get(kind, normalized) as { person_id: string } | undefined;
  return row ? getPerson(row.person_id) : undefined;
}

// ─────────────────────────── Handle links ───────────────────────────

/**
 * Link a `users` handle to a person. PK on user_id means a handle links to at
 * most one person; re-linking to a different person re-points the row (upsert).
 */
export function linkHandle(userId: string, personId: string, linkMethod = 'manual'): PersonUser {
  if (!getPerson(personId)) throw new Error(`person not found: ${personId}`);
  const row: PersonUser = { user_id: userId, person_id: personId, linked_at: now(), link_method: linkMethod };
  getDb()
    .prepare(
      `INSERT INTO person_users (user_id, person_id, linked_at, link_method)
       VALUES (@user_id, @person_id, @linked_at, @link_method)
       ON CONFLICT(user_id) DO UPDATE SET
         person_id = excluded.person_id,
         linked_at = excluded.linked_at,
         link_method = excluded.link_method`,
    )
    .run(row);
  log.info('Handle linked', { user_id: userId, person_id: personId, link_method: linkMethod });
  // PAT: a handle is now in this person's directory snapshot. Covers autoEnroll /
  // linkHandleByIdentifier / backfill transitively (they all route through here).
  emitPeopleEvent('people.upserted', personId);
  return row;
}

export function unlinkHandle(userId: string): { unlinked: string } {
  // PAT: capture the owning person BEFORE the delete so we can emit the
  // people.removed directory event with the REMAINING snapshot afterward.
  const owner = getDb().prepare('SELECT person_id FROM person_users WHERE user_id = ?').get(userId) as
    | { person_id: string }
    | undefined;
  const result = getDb().prepare('DELETE FROM person_users WHERE user_id = ?').run(userId);
  if (result.changes === 0) throw new Error(`handle not linked: ${userId}`);
  if (owner) emitPeopleEvent('people.removed', owner.person_id); // PAT: snapshot reflects what remains
  return { unlinked: userId };
}

export function getPersonByUser(userId: string): Person | undefined {
  const row = getDb().prepare('SELECT person_id FROM person_users WHERE user_id = ?').get(userId) as
    | { person_id: string }
    | undefined;
  return row ? getPerson(row.person_id) : undefined;
}

/**
 * PAT: defensive person-identity lookup for `inbound.received` /
 * `routing.message-routed` log enrichment. Resolves a namespaced senderId
 * (`<channel>:<handle>`) to an OPAQUE `{ personId }` for the structured-log
 * emit so the centralized store can anchor message bodies to a person id.
 *
 * person_name is DELIBERATELY NOT returned here — names must never land next
 * to message bodies in `pat_events` (privacy / denormalization smell). The
 * id→name mapping lives in the `pat_enrichment` directory stream (kept fresh
 * by `people.upserted` / `people.removed` events + a periodic dump); the
 * resolver (`resolve_person` MCP tool / `patobs resolve`) does the lookup at
 * query time.
 *
 * NEVER throws and never returns undefined — on a null/empty userId, an
 * unlinked handle, or any DB error it returns `{ personId: null }`. Logging
 * enrichment must not break message delivery.
 *
 * Used by both the chat-SDK funnel (router) and the realtime channel shims
 * (phone-call / anam-web), which pass the result into the orchestrator's
 * `inbound.received` event.
 */
export function resolvePersonIdentity(userId: string | null | undefined): {
  personId: string | null;
} {
  if (!userId) return { personId: null };
  try {
    const person = getPersonByUser(userId);
    if (!person) return { personId: null };
    return { personId: person.id };
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    return { personId: null };
  }
}

export function getHandlesForPerson(personId: string): PersonUser[] {
  return getDb()
    .prepare('SELECT * FROM person_users WHERE person_id = ? ORDER BY linked_at')
    .all(personId) as PersonUser[];
}

/**
 * PAT: link a handle to a person by an OUT-OF-BAND identifier the handle itself
 * doesn't carry. The phone/email auto-enroll path (parseHandle) covers channels
 * whose handle IS a phone/email (signal, pstn, imessage, resend); this covers
 * the channels where the identifier has to be fetched from the platform API —
 * Slack (`users.info` → email) and Telegram (`request_contact` → phone).
 *
 * Resolves the (kind, value) to a person, links the handle if found, and is
 * idempotent (already-linked-to-same-person is a no-op). Returns the person id
 * or null. Never throws — callers run on adapter inbound paths.
 */
export function linkHandleByIdentifier(userId: string, kind: IdentifierKind, value: string): string | null {
  try {
    const person = resolvePersonByIdentifier(kind, value);
    if (!person) return null;

    const existing = getDb().prepare('SELECT person_id FROM person_users WHERE user_id = ?').get(userId) as
      | { person_id: string }
      | undefined;
    if (existing?.person_id === person.id) return person.id; // already linked, no churn

    linkHandle(userId, person.id, `auto:${kind}`);
    log.event({
      kind: 'people.auto-enrolled',
      data: { user_id: userId, person_id: person.id, kind },
    });
    return person.id;
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (e) {
    log.warn('linkHandleByIdentifier failed', {
      user_id: userId,
      kind,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

// ─────────────────────────── Auto-enroll ───────────────────────────

/**
 * Auto-enroll an inbound handle: parse it to a normalized identifier, look up
 * the owning person, and link the handle if found. LINKS, never CREATES.
 * Idempotent — a handle already linked to the resolved person is a no-op.
 * Returns the linked person id, or null if the handle carries no recognizable
 * identifier or no person owns it yet.
 *
 * Called once on the inbound path (extractAndUpsertUser). Must not throw on the
 * hot path — failures are logged and swallowed.
 */
export function autoEnroll(userId: string): string | null {
  try {
    const parsed = parseHandle(userId);
    if (!parsed) return null;

    const person = resolvePersonByIdentifier(parsed.kind, parsed.value);
    if (!person) return null;

    const existing = getDb().prepare('SELECT person_id FROM person_users WHERE user_id = ?').get(userId) as
      | { person_id: string }
      | undefined;
    if (existing?.person_id === person.id) return person.id; // already linked, no churn

    linkHandle(userId, person.id, `auto:${parsed.kind}`);
    log.event({
      kind: 'people.auto-enrolled',
      data: { user_id: userId, person_id: person.id, kind: parsed.kind },
    });
    return person.id;
    // Intentional catch-all: auto-enroll runs on the inbound hot path and must
    // never throw (a DB hiccup here can't be allowed to drop a message).
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (e) {
    log.warn('autoEnroll failed', { user_id: userId, error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

// ─────────────────────────── Auto-approve ───────────────────────────

/**
 * PAT: cross-channel auto-approve. A "person" is a human an operator has
 * vouched for (created via dashboard OAuth login or operator-seeded). Once a
 * handle is linked to a person — `person_users`, populated by autoEnroll for
 * phone/email handles, or by linkHandleByIdentifier for slack/telegram — that
 * sender should NEVER hit an approval card or a silent drop. They are known.
 *
 * This grants durable, agent-group-SCOPED access: it persists an
 * `agent_group_members` row for exactly (userId, agentGroupId), mirroring the
 * approve-card handler, so the grant survives restarts and shows up in the
 * dashboard's members view. It does NOT grant any role and does NOT touch other
 * agent groups.
 *
 * Returns the resolved person, or null if the handle is NOT linked to a person
 * (in which case the caller must fall through to the normal card/drop path —
 * we NEVER auto-approve a handle that doesn't resolve to a person).
 *
 * Idempotent and safe on the hot path: a handle already a member is a cheap
 * no-op; any DB error is logged and swallowed (returns null → normal gate).
 */
export function autoApproveKnownPerson(userId: string, agentGroupId: string): Person | null {
  try {
    const person = getPersonByUser(userId);
    if (!person) return null;

    if (hasMembershipRow(userId, agentGroupId)) return person; // already granted, no churn

    addMember({
      user_id: userId,
      agent_group_id: agentGroupId,
      added_by: null, // system grant — vouched-for by an operator via the person record
      added_at: now(),
    });
    log.event({
      kind: 'people.auto-approved',
      data: { user_id: userId, person_id: person.id, agent_group_id: agentGroupId },
    });
    return person;
    // Intentional catch-all: runs on the inbound access-gate hot path and must
    // never throw — a failure here falls back to the normal card/drop path.
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (e) {
    log.warn('autoApproveKnownPerson failed', { user_id: userId, error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/**
 * Retroactively run auto-enroll over every existing `users` row. Seeds
 * person_users for handles that arrived BEFORE their person was seeded (so the
 * inbound hook never matched them). Idempotent: re-running only links the
 * still-unlinked, deterministic matches. Returns a summary.
 */
export function backfillFromUsers(): { scanned: number; linked: number; already: number; unmatched: number } {
  const users = getDb().prepare('SELECT id FROM users').all() as { id: string }[];
  let linked = 0;
  let already = 0;
  let unmatched = 0;
  for (const u of users) {
    const parsed = parseHandle(u.id);
    if (!parsed) {
      unmatched++;
      continue;
    }
    const person = resolvePersonByIdentifier(parsed.kind, parsed.value);
    if (!person) {
      unmatched++;
      continue;
    }
    const existing = getDb().prepare('SELECT person_id FROM person_users WHERE user_id = ?').get(u.id) as
      | { person_id: string }
      | undefined;
    if (existing?.person_id === person.id) {
      already++;
      continue;
    }
    linkHandle(u.id, person.id, `backfill:${parsed.kind}`);
    linked++;
  }
  const summary = { scanned: users.length, linked, already, unmatched };
  log.info('People backfill complete', summary);
  return summary;
}
