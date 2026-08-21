/**
 * Reference copy of the current v2 schema.
 * Read this to understand the DB structure.
 * Actual creation is done by migrations — do not use this at runtime.
 */

export const SCHEMA = `
-- Agent workspaces: folder, skills, CLAUDE.md.
-- All workspaces are equal; privilege lives on users, not groups.
-- Container config lives in the container_configs table (see migration 014).
CREATE TABLE agent_groups (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  folder           TEXT NOT NULL UNIQUE,
  agent_provider   TEXT,
  created_at       TEXT NOT NULL
);

-- Platform groups/channels. unknown_sender_policy governs what happens
-- when a sender we've never seen before posts in this chat.
-- The column DEFAULT is "strict" (inherited from migration 001), but it
-- only matters if something inserts without specifying the field, which no
-- current callsite does. Router auto-create hardcodes "request_approval"
-- (see src/router.ts:151); setup scripts pick per context.
-- instance = adapter-instance name; the default instance IS the channel
-- type (migration 016 backfill), so single-instance installs never see it.
-- Inbound lookups are exact-on-instance; outbound lookups default-first.
CREATE TABLE messaging_groups (
  id                    TEXT PRIMARY KEY,
  channel_type          TEXT NOT NULL,
  platform_id           TEXT NOT NULL,
  instance              TEXT NOT NULL,
  name                  TEXT,
  is_group              INTEGER DEFAULT 0,
  unknown_sender_policy TEXT NOT NULL DEFAULT 'strict',
                        -- 'strict' | 'request_approval' | 'public'
  created_at            TEXT NOT NULL,
  denied_at             TEXT,
  UNIQUE(channel_type, platform_id, instance)
);

-- Which agent groups handle which messaging groups.
-- engage_mode / engage_pattern / sender_scope / ignored_message_policy are
-- the four orthogonal axes that together replace v1's opaque trigger_rules
-- JSON + response_scope enum. See docs/v1-vs-v2/ACTION-ITEMS.md item 1.
CREATE TABLE messaging_group_agents (
  id                     TEXT PRIMARY KEY,
  messaging_group_id     TEXT NOT NULL REFERENCES messaging_groups(id),
  agent_group_id         TEXT NOT NULL REFERENCES agent_groups(id),
  engage_mode            TEXT NOT NULL DEFAULT 'mention',
                         -- 'pattern' | 'mention' | 'mention-sticky'
  engage_pattern         TEXT,   -- regex; required when engage_mode='pattern';
                                 -- '.' means "match every message" (the "always" flavor)
  sender_scope           TEXT NOT NULL DEFAULT 'all',    -- 'all' | 'known'
  ignored_message_policy TEXT NOT NULL DEFAULT 'drop',   -- 'drop' | 'accumulate'
  session_mode           TEXT DEFAULT 'shared',
  priority               INTEGER DEFAULT 0,
  created_at             TEXT NOT NULL,
  UNIQUE(messaging_group_id, agent_group_id)
);

-- Users are messaging-platform identifiers, namespaced "<channel_type>:<handle>"
-- — the prefix IS the channel_type: "signal:+1555...", "pstn:+1555...",
-- "telegram:123", "discord:456", "anam-web:<uuid>", "resend:a@x.com". A single
-- human can own multiple user rows across channels; PAT's people spine (below)
-- groups them under one person without modifying this table.
CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  display_name TEXT,
  created_at   TEXT NOT NULL
);

-- Role grants on users. Privilege is user-level, not group-level.
--   role ∈ {owner, admin}
--   owner: always global (agent_group_id IS NULL)
--   admin: agent_group_id NULL = global, else scoped to that agent group
-- Invariant: admin @ A implies membership in A (no row needed).
CREATE TABLE user_roles (
  user_id        TEXT NOT NULL REFERENCES users(id),
  role           TEXT NOT NULL,
  agent_group_id TEXT REFERENCES agent_groups(id),
  granted_by     TEXT REFERENCES users(id),
  granted_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, role, agent_group_id)
);
CREATE INDEX idx_user_roles_scope ON user_roles(agent_group_id, role);

-- "Known" membership in an agent group. Required for an unprivileged user
-- to interact with a workspace. Admin @ A is implicitly a member of A.
CREATE TABLE agent_group_members (
  user_id        TEXT NOT NULL REFERENCES users(id),
  agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  added_by       TEXT REFERENCES users(id),
  added_at       TEXT NOT NULL,
  PRIMARY KEY (user_id, agent_group_id)
);

-- Cached mapping from (user, channel) to the DM messaging group. Lets the
-- host initiate cold DMs (pairing, approvals) without reprobing the
-- platform API on every send. Populated lazily by ensureUserDm().
CREATE TABLE user_dms (
  user_id            TEXT NOT NULL REFERENCES users(id),
  channel_type       TEXT NOT NULL,
  messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
  resolved_at        TEXT NOT NULL,
  PRIMARY KEY (user_id, channel_type)
);

-- Sessions: one folder = one session = one container when running
CREATE TABLE sessions (
  id                 TEXT PRIMARY KEY,
  agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id),
  messaging_group_id TEXT REFERENCES messaging_groups(id),
  thread_id          TEXT,
  -- PAT (migration 020): the resolving sender's handle, recorded at creation.
  -- The session's person is getPersonByUser(user_id). NULL for system /
  -- agent-to-agent / legacy sessions.
  user_id            TEXT,
  agent_provider     TEXT,
  status             TEXT DEFAULT 'active',
  container_status   TEXT DEFAULT 'stopped',
  last_active        TEXT,
  created_at         TEXT NOT NULL
);
CREATE INDEX idx_sessions_agent_group ON sessions(agent_group_id);
CREATE INDEX idx_sessions_lookup ON sessions(messaging_group_id, thread_id);

-- Pending interactive questions
CREATE TABLE pending_questions (
  question_id    TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(id),
  message_out_id TEXT NOT NULL,
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  title          TEXT NOT NULL,
  options_json   TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

-- Pending approvals for unknown senders (unknown_sender_policy='request_approval').
-- In-flight dedup via UNIQUE(messaging_group_id, sender_identity): a second
-- message from the same unknown sender while a card is pending is silently
-- dropped instead of spamming the admin.
CREATE TABLE pending_sender_approvals (
  id                 TEXT PRIMARY KEY,
  messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
  agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id),
  sender_identity    TEXT NOT NULL,    -- namespaced user id (channel_type:handle)
  sender_name        TEXT,
  original_message   TEXT NOT NULL,    -- JSON of the original InboundEvent
  approver_user_id   TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  UNIQUE(messaging_group_id, sender_identity)
);

-- PAT: people spine (migration 019). Three ADDITIVE tables that group a human's
-- many channel handles (users rows) under one identity, with zero edits to the
-- upstream tables above. See plans/admin-dashboard-and-people.md.
--
-- people: pure identity (names + timestamps). No tier/access or default-handle
-- columns — both deferred.
CREATE TABLE people (
  id          TEXT PRIMARY KEY,
  first_name  TEXT NOT NULL,
  last_name   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT
);

-- person_identifiers: universal identifiers (email/phone) a person is
-- RECOGNIZED by — the auto-enroll front door. PK (kind, value) ⇒ an
-- identifier maps to EXACTLY ONE person (deterministic match). Can be
-- pre-seeded before the person ever messages.
CREATE TABLE person_identifiers (
  person_id  TEXT NOT NULL REFERENCES people(id),
  kind       TEXT NOT NULL,      -- 'email' | 'phone'
  value      TEXT NOT NULL,      -- normalized: lowercased email / E164 phone
  created_at TEXT NOT NULL,
  PRIMARY KEY (kind, value)
);

-- person_users: realized links from handles (users rows) → person. PK user_id
-- ⇒ each handle belongs to at most one person. Additive replacement for a
-- users.person_id column. No ON DELETE CASCADE — deleting a person cleans up
-- its own rows in code (src/people/), and a users delete must drop its link
-- row explicitly (pat-frontend cascade list).
CREATE TABLE person_users (
  user_id     TEXT PRIMARY KEY REFERENCES users(id),
  person_id   TEXT NOT NULL REFERENCES people(id),
  linked_at   TEXT NOT NULL,
  link_method TEXT               -- 'manual' | 'auto:phone' | 'auto:email' | 'backfill:phone' | ...
);

-- person_roles (migration 021): dashboard data-visibility authority, keyed on
-- PERSON (not handle). Distinct axis from user_roles (which is agent-runtime
-- authority, handle-keyed) — see plans/dashboard-permissions.md. One role per
-- person (PK person_id); role names map to capabilities in app code (ROLE_CAPS),
-- not the DB. Intended convergence target when user_roles later deprecates.
CREATE TABLE person_roles (
  person_id   TEXT PRIMARY KEY REFERENCES people(id),
  role        TEXT NOT NULL,      -- 'admin' | 'employee'
  granted_by  TEXT,               -- person_id of the granting admin (audit); null for host-seeded
  granted_at  TEXT NOT NULL
);

-- pairing_codes (migration 022): self-service handle linking by proof-of-
-- possession. An operator generates a short numeric code in the dashboard, then
-- messages it FROM the new handle; while the code is active the inbound path
-- matches it (substring) against any message from an UNLINKED handle and links
-- that handle to the code's person. Replaces the approval-card registration as
-- the primary self-serve flow — see plans/pairing-handle-linking.md.
CREATE TABLE pairing_codes (
  id             TEXT PRIMARY KEY,
  code           TEXT NOT NULL,    -- numeric (TEXT to keep leading zeros)
  person_id      TEXT NOT NULL REFERENCES people(id),
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,    -- absolute ISO; active = now < this AND consumed_at IS NULL
  consumed_at    TEXT,             -- NULL = unused; single-use
  linked_user_id TEXT              -- the handle that consumed it (audit + dashboard success view)
);
`;

/**
 * Session DB schemas — split into two files so each has exactly one writer.
 * This eliminates SQLite write contention across the host-container mount boundary.
 *
 *   inbound.db  — host writes, container reads (read-only mount or open read-only)
 *   outbound.db — container writes, host reads (read-only open)
 */

/** Host-owned: inbound messages + delivery tracking + destination map. */
export const INBOUND_SCHEMA = `
CREATE TABLE IF NOT EXISTS messages_in (
  id             TEXT PRIMARY KEY,
  seq            INTEGER UNIQUE,
  kind           TEXT NOT NULL,
  timestamp      TEXT NOT NULL,
  status         TEXT DEFAULT 'pending',
  process_after  TEXT,
  recurrence     TEXT,
  series_id      TEXT,
  tries          INTEGER DEFAULT 0,
  trigger        INTEGER NOT NULL DEFAULT 1,
                 -- 0 = accumulated context (don't wake), 1 = wake agent
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  content        TEXT NOT NULL,
  -- For agent-to-agent inbound rows: the source session that emitted the
  -- triggering outbound. Used as a return path when the target replies —
  -- the reply routes back to this exact session, not to the source agent
  -- group's "newest" session. NULL on channel-side inbound and on a2a rows
  -- written before this column existed.
  source_session_id TEXT,
  on_wake        INTEGER NOT NULL DEFAULT 0
               -- 1 = only deliver on the container's first poll (fresh start).
               -- Dying containers (past first poll) skip these rows.
);
CREATE INDEX IF NOT EXISTS idx_messages_in_series ON messages_in(series_id);

-- Host tracks delivery outcomes for messages_out IDs.
-- Avoids writing to outbound.db (container-owned).
CREATE TABLE IF NOT EXISTS delivered (
  message_out_id      TEXT PRIMARY KEY,
  platform_message_id TEXT,
  status              TEXT NOT NULL DEFAULT 'delivered',
  delivered_at        TEXT NOT NULL
);

-- Destination map for this session's agent.
-- Host overwrites on every container wake AND on demand (rewires, new child
-- agents, etc.). Container queries this live on every lookup, so changes
-- take effect mid-session without requiring a container restart.
CREATE TABLE IF NOT EXISTS destinations (
  name            TEXT PRIMARY KEY,
  display_name    TEXT,
  type            TEXT NOT NULL,   -- 'channel' | 'agent'
  channel_type    TEXT,            -- for type='channel'
  platform_id     TEXT,            -- for type='channel'
  agent_group_id  TEXT             -- for type='agent'
);

-- Default reply routing for this session. Single-row table (id=1).
-- Host overwrites on every container wake from the session's messaging_group
-- and thread_id. Container reads it in send_message / ask_user_question to
-- default the channel/thread of outbound messages when the agent doesn't
-- specify an explicit destination.
CREATE TABLE IF NOT EXISTS session_routing (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  channel_type TEXT,
  platform_id  TEXT,
  thread_id    TEXT
);
`;

/** Container-owned: outbound messages + processing acknowledgments. */
export const OUTBOUND_SCHEMA = `
CREATE TABLE IF NOT EXISTS messages_out (
  id             TEXT PRIMARY KEY,
  seq            INTEGER UNIQUE,
  in_reply_to    TEXT,
  timestamp      TEXT NOT NULL,
  deliver_after  TEXT,
  recurrence     TEXT,
  kind           TEXT NOT NULL,
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  content        TEXT NOT NULL
);

-- Container tracks processing status here instead of updating messages_in.
-- Host reads this to know which messages have been processed.
-- On container startup, stale 'processing' entries are cleared (crash recovery).
CREATE TABLE IF NOT EXISTS processing_ack (
  message_id     TEXT PRIMARY KEY,
  status         TEXT NOT NULL,
  status_changed TEXT NOT NULL
);

-- Persistent key/value state owned by the container. Used (among other things)
-- to store the SDK session ID so the agent's conversation resumes across
-- container restarts. Cleared by /clear.
CREATE TABLE IF NOT EXISTS session_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Current tool-in-flight state. Single-row table (id=1). Container writes on
-- PreToolUse and clears on PostToolUse / PostToolUseFailure. Host reads in the
-- sweep to extend the stuck-tolerance window when Bash is running with a
-- declared timeout > 60s (long-running scripts shouldn't be flagged as stuck).
CREATE TABLE IF NOT EXISTS container_state (
  id                       INTEGER PRIMARY KEY CHECK (id = 1),
  current_tool             TEXT,
  tool_declared_timeout_ms INTEGER,
  tool_started_at          TEXT,
  updated_at               TEXT NOT NULL
);
`;
