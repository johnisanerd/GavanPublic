import type { MessagingGroup, MessagingGroupAgent, UnknownSenderPolicy } from '../types.js';
// Transitional tier violation: core imports from optional agent-to-agent module.
// `createMessagingGroupAgent` auto-creates a destination row on wiring — the
// two concerns are currently bundled. When agent-to-agent isn't installed,
// the table doesn't exist and this import chain remains dormant because
// `createMessagingGroupAgent` is only called from setup/admin paths that
// also only run when wiring channels to agents (which implicitly requires
// agent-to-agent for the destination ACL to mean anything). A cleaner split
// (or making the destination side effect module-owned) is tracked in the
// refactor plan.
import {
  createDestination,
  getDestinationByName,
  getDestinationByTarget,
  normalizeName,
} from '../modules/agent-to-agent/db/agent-destinations.js';
import { getDb, hasTable } from './connection.js';

// ── Messaging Groups ──

export function createMessagingGroup(group: MessagingGroup): void {
  getDb()
    .prepare(
      `INSERT INTO messaging_groups (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at)
       VALUES (@id, @channel_type, @platform_id, @instance, @name, @is_group, @unknown_sender_policy, @created_at)`,
    )
    .run({ ...group, instance: group.instance ?? group.channel_type });
}

export function getMessagingGroup(id: string): MessagingGroup | undefined {
  return getDb().prepare('SELECT * FROM messaging_groups WHERE id = ?').get(id) as MessagingGroup | undefined;
}

/**
 * Outbound / cold-DM / setup lookup by platform address.
 *
 * Instance semantics are deliberately ASYMMETRIC with the router's
 * `getMessagingGroupWithAgentCount` (exact-only): outbound callers usually
 * don't know (or care) which adapter instance owns a chat, so an unset
 * `instance` resolves the default instance first (instance = channel_type),
 * falling back deterministically to the lexically-first named instance.
 * A set `instance` is exact-only — unknown instance returns undefined.
 */
export function getMessagingGroupByPlatform(
  channelType: string,
  platformId: string,
  instance?: string,
): MessagingGroup | undefined {
  if (instance !== undefined) {
    return getDb()
      .prepare('SELECT * FROM messaging_groups WHERE channel_type = ? AND platform_id = ? AND instance = ?')
      .get(channelType, platformId, instance) as MessagingGroup | undefined;
  }
  return getDb()
    .prepare(
      `SELECT * FROM messaging_groups
        WHERE channel_type = ? AND platform_id = ?
     ORDER BY (instance = channel_type) DESC, instance ASC
        LIMIT 1`,
    )
    .get(channelType, platformId) as MessagingGroup | undefined;
}

/**
 * Combined lookup for the router's fast-drop path. Returns the messaging
 * group (if it exists) and a count of wired agents in one query — lets
 * `routeInbound` short-circuit messages for unwired / unknown channels
 * with a single DB read instead of four (mg lookup, sender upsert, agents
 * lookup, dropped_messages insert).
 *
 * Returns `null` when no messaging_groups row exists for this channel.
 * Returns `{ mg, agentCount: 0 }` when the row exists but has no wired
 * agents. Uses the `UNIQUE(channel_type, platform_id, instance)` index plus
 * the `UNIQUE(messaging_group_id, agent_group_id)` index for the JOIN — both
 * covered by existing SQLite auto-indexes from the UNIQUE constraints.
 *
 * `instance` is EXACT-ONLY, with no fallback — deliberately asymmetric with
 * `getMessagingGroupByPlatform`'s default-instance-first resolution. An
 * unknown named instance must return null so the router auto-creates a
 * per-instance group instead of hijacking a sibling instance's row. The
 * default param (= channelType) keeps instance-less callers resolving the
 * default instance, identical to pre-instance behavior.
 */
export function getMessagingGroupWithAgentCount(
  channelType: string,
  platformId: string,
  instance: string = channelType,
): { mg: MessagingGroup; agentCount: number } | null {
  const row = getDb()
    .prepare(
      `SELECT mg.*, COUNT(mga.id) AS agent_count
         FROM messaging_groups mg
    LEFT JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
        WHERE mg.channel_type = ? AND mg.platform_id = ? AND mg.instance = ?
     GROUP BY mg.id`,
    )
    .get(channelType, platformId, instance) as (MessagingGroup & { agent_count: number }) | undefined;
  if (!row) return null;
  const { agent_count, ...mg } = row;
  return { mg: mg as MessagingGroup, agentCount: agent_count };
}

export function getAllMessagingGroups(): MessagingGroup[] {
  return getDb().prepare('SELECT * FROM messaging_groups ORDER BY name').all() as MessagingGroup[];
}

/**
 * All messaging groups on a platform, across every adapter instance.
 * Semantics intentionally unchanged by the instance dimension — channel_type
 * stays the semantic platform key. No live caller today; if a caller needs
 * a single instance's rows, filter on `mg.instance`.
 */
export function getMessagingGroupsByChannel(channelType: string): MessagingGroup[] {
  return getDb().prepare('SELECT * FROM messaging_groups WHERE channel_type = ?').all(channelType) as MessagingGroup[];
}

export function updateMessagingGroup(
  id: string,
  updates: Partial<Pick<MessagingGroup, 'name' | 'is_group' | 'unknown_sender_policy'>>,
): void {
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }
  if (fields.length === 0) return;

  getDb()
    .prepare(`UPDATE messaging_groups SET ${fields.join(', ')} WHERE id = @id`)
    .run(values);
}

export function deleteMessagingGroup(id: string): void {
  getDb().prepare('DELETE FROM messaging_groups WHERE id = ?').run(id);
}

/**
 * Mark a messaging group as denied by the owner (channel-registration flow).
 * Future mentions on this channel silently drop until an admin explicitly
 * wires it via `createMessagingGroupAgent`, which implicitly clears the
 * denied state by making `agentCount > 0` — the router's denied-channel
 * check sits on the `agentCount === 0` branch.
 *
 * Passing null unsets the flag (used by tests or a future "unblock channel"
 * admin command).
 */
export function setMessagingGroupDeniedAt(id: string, deniedAt: string | null): void {
  getDb().prepare('UPDATE messaging_groups SET denied_at = ? WHERE id = ?').run(deniedAt, id);
}

// ── Messaging Group Agents ──

/**
 * Wire a messaging group to an agent group. Also auto-creates the matching
 * `agent_destinations` row so the agent can deliver to this chat as a
 * target, not just reply to the origin. Without this, routing to chats that
 * aren't the session's origin (agent-shared sessions, cross-channel sends)
 * would require an operator to hand-insert destination rows every time.
 *
 * The destination row is skipped if one already exists for the same target,
 * so re-wiring is a no-op. The local_name uses the messaging group's `name`
 * field when set, falling back to `${channel_type}-${mg_id prefix}`, with
 * a numeric suffix to break collisions within the agent's namespace. This
 * mirrors the backfill logic in migration 004.
 */
export function createMessagingGroupAgent(mga: MessagingGroupAgent): void {
  getDb()
    .prepare(
      `INSERT INTO messaging_group_agents (
         id, messaging_group_id, agent_group_id,
         engage_mode, engage_pattern, sender_scope, ignored_message_policy,
         session_mode, priority, created_at
       )
       VALUES (
         @id, @messaging_group_id, @agent_group_id,
         @engage_mode, @engage_pattern, @sender_scope, @ignored_message_policy,
         @session_mode, @priority, @created_at
       )`,
    )
    .run(mga);

  // Auto-create an agent_destinations row so delivery's ACL doesn't block
  // outbound messages that target this chat. Guarded: when the agent-to-agent
  // module isn't installed the table doesn't exist — skip silently. Without
  // the module, the ACL check in delivery is also skipped (same guard), so
  // channel sends still work.
  //
  // ⚠️  DESTINATION PROJECTION NOTE: this function only writes the central
  // `agent_destinations` row. It does NOT project into any running
  // agent's session inbound.db (see top-of-file invariant in
  // src/modules/agent-to-agent/db/agent-destinations.ts). In practice this
  // is fine because the only real callers are one-shot setup scripts
  // (setup/register.ts, scripts/init-first-agent.ts, /manage-channels
  // skill) that run in a separate process from the host. Any already-
  // running container for `mga.agent_group_id` will keep serving the
  // stale projection until its next wake (idle timeout or next inbound
  // message) at which point spawnContainer's writeDestinations call
  // refreshes from central. If you call this from code that runs INSIDE
  // the host process and need the refresh to happen immediately,
  // explicitly call the module's `writeDestinations(mga.agent_group_id,
  // <sessionId>)` afterwards.
  if (!hasTable(getDb(), 'agent_destinations')) return;

  const existing = getDestinationByTarget(mga.agent_group_id, 'channel', mga.messaging_group_id);
  if (existing) return;

  const mg = getMessagingGroup(mga.messaging_group_id);
  if (!mg) return;

  const base = normalizeName(mg.name || `${mg.channel_type}-${mga.messaging_group_id.slice(0, 8)}`);
  let localName = base;
  let suffix = 2;
  while (getDestinationByName(mga.agent_group_id, localName)) {
    localName = `${base}-${suffix}`;
    suffix++;
  }

  createDestination({
    agent_group_id: mga.agent_group_id,
    local_name: localName,
    target_type: 'channel',
    target_id: mga.messaging_group_id,
    created_at: mga.created_at,
  });
}

export function getMessagingGroupAgents(messagingGroupId: string): MessagingGroupAgent[] {
  return getDb()
    .prepare('SELECT * FROM messaging_group_agents WHERE messaging_group_id = ? ORDER BY priority DESC')
    .all(messagingGroupId) as MessagingGroupAgent[];
}

export function getMessagingGroupAgentByPair(
  messagingGroupId: string,
  agentGroupId: string,
): MessagingGroupAgent | undefined {
  return getDb()
    .prepare('SELECT * FROM messaging_group_agents WHERE messaging_group_id = ? AND agent_group_id = ?')
    .get(messagingGroupId, agentGroupId) as MessagingGroupAgent | undefined;
}

export function getMessagingGroupAgent(id: string): MessagingGroupAgent | undefined {
  return getDb().prepare('SELECT * FROM messaging_group_agents WHERE id = ?').get(id) as
    | MessagingGroupAgent
    | undefined;
}

export function updateMessagingGroupAgent(
  id: string,
  updates: Partial<
    Pick<
      MessagingGroupAgent,
      'engage_mode' | 'engage_pattern' | 'sender_scope' | 'ignored_message_policy' | 'session_mode' | 'priority'
    >
  >,
): void {
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }
  if (fields.length === 0) return;

  getDb()
    .prepare(`UPDATE messaging_group_agents SET ${fields.join(', ')} WHERE id = @id`)
    .run(values);
}

export function deleteMessagingGroupAgent(id: string): void {
  getDb().prepare('DELETE FROM messaging_group_agents WHERE id = ?').run(id);
}

/** Get all messaging groups wired to an agent group (reverse lookup). */
export function getMessagingGroupsByAgentGroup(agentGroupId: string): MessagingGroup[] {
  return getDb()
    .prepare(
      `SELECT mg.* FROM messaging_groups mg
       JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
       WHERE mga.agent_group_id = ?`,
    )
    .all(agentGroupId) as MessagingGroup[];
}

// ── Lazy-provisioning helpers ──
//
// The channel adapters (signal, phone-call, anam-web) all need to lazily
// auto-create a messaging_group + wired mga the first time a new
// platform_id appears for their channel. The pattern was duplicated in
// each adapter; these helpers extract the load-bearing primitives so
// each ensure-function in `src/channels/<channel>.ts` stays focused on
// channel-specific bits (mg.name normalization, agent-group resolution
// strategy, post-provisioning side effects).

/**
 * Find an existing messaging_group of `channelType` to copy wiring from.
 * Returns the first matching mg + its first wired mga, or null when no
 * mgs of this channel exist (or when the first one has no wired mga).
 *
 * Used by adapters whose first-contact flow inherits agent-wiring from
 * any existing mg of the channel (signal, phone-call). Adapters that
 * resolve the agent group differently (env-var default, e.g. anam-web)
 * skip this and call `provisionMessagingGroup` directly.
 */
export function resolveSeedAgentForChannel(
  channelType: string,
): { seedMg: MessagingGroup; seedMga: MessagingGroupAgent } | null {
  // PAT: return the first messaging group on this channel that actually has a
  // wired agent — NOT just seedMgs[0]. An unwired leftover mg (e.g. an orphaned
  // test DM whose wiring was removed) can sort first; taking it blindly made
  // this return null, which silently blocked ALL new-sender provisioning on the
  // channel — including pairing-code linking (an unprovisionable sender is
  // dropped before the pairing pre-check ever runs).
  for (const mg of getMessagingGroupsByChannel(channelType)) {
    const seedMga = getMessagingGroupAgents(mg.id)[0];
    if (seedMga) return { seedMg: mg, seedMga };
  }
  return null;
}

export interface ProvisionMessagingGroupArgs {
  channelType: string;
  platformId: string;
  /** mg.name — controls the default destination's local_name via
   *  createMessagingGroupAgent's auto-destination side effect. Set to
   *  the canonical destination name (e.g. `signal-15550100000`) so
   *  normalizeName(mg.name) produces the desired value without an
   *  extra createDestination call. */
  mgName: string;
  /** is_group flag. Defaults to 0. */
  isGroup?: 0 | 1;
  unknownSenderPolicy: UnknownSenderPolicy;
  /** Full mga row minus auto-supplied fields (id, messaging_group_id,
   *  created_at — set internally). The agent_group_id field is
   *  required and resolved by the caller. */
  mga: Omit<MessagingGroupAgent, 'id' | 'messaging_group_id' | 'created_at'>;
}

export interface ProvisionMessagingGroupResult {
  id: string;
  platform_id: string;
  agent_group_id: string;
  /** Same as mgName — exposed for the caller's structured-log emit. */
  destination_name: string;
}

/**
 * Insert a fresh messaging_group + wired mga in one transaction-like
 * sequence (no actual DB transaction — the two inserts are independent
 * but the caller doesn't care about partial-failure recovery; on rare
 * crash between the two, the next ensure call will see the mg and
 * createMessagingGroupAgent for it). Returns the resulting ids.
 *
 * Channel adapters wrap this with their channel-specific bits:
 *   - existence check (skip if mg already provisioned)
 *   - agent-group resolution (seed-from-channel or env-var default)
 *   - mg.name derivation (channel-specific normalization)
 *   - post-provisioning side effects (user_dms upsert, destinations
 *     projection, structured-log emit)
 */
export function provisionMessagingGroup(args: ProvisionMessagingGroupArgs): ProvisionMessagingGroupResult {
  const mgId = `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const mgaId = `mga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  createMessagingGroup({
    id: mgId,
    channel_type: args.channelType,
    platform_id: args.platformId,
    name: args.mgName,
    is_group: args.isGroup ?? 0,
    unknown_sender_policy: args.unknownSenderPolicy,
    created_at: now,
  });
  createMessagingGroupAgent({
    ...args.mga,
    id: mgaId,
    messaging_group_id: mgId,
    created_at: now,
  });
  return {
    id: mgId,
    platform_id: args.platformId,
    agent_group_id: args.mga.agent_group_id,
    destination_name: args.mgName,
  };
}
