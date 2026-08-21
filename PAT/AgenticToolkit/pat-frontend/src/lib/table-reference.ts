// Data dictionary for the nanoclaw central SQLite DB (`data/v2.db`), consumed
// by the PAT dashboard's Database browser. Researched from the nanoclaw source
// of truth: src/db/migrations/* (schema), src/cli/resources/* (operator-facing
// intent), src/people/ + src/state-sqlite.ts (read/write code), and
// docs/db-central.md, cross-checked against docs.nanoclaw.dev + chat-sdk.dev.
// Tables absent here render a disabled "?".
//
// Architecture context: nanoclaw runs a single host Node process that owns this
// central DB (the admin plane). Per-session agent containers never touch it —
// they communicate only through per-session inbound.db / outbound.db files. So
// every table below is host-owned admin/routing state, never live message bodies.

export interface TableDoc {
  /** Comma-free one-liner for a hover tooltip (~8–16 words). What the table IS. */
  summary: string;
  /** Markdown. Fuller explanation for a modal (rendered with a markdown
   *  renderer): role in nanoclaw, when rows are written, relationships. Use
   *  paragraphs, `inline code` for table/column/identifier names, bullet lists
   *  for relationships, and [label](url) links. 2–5 sentences worth. */
  description: string;
  /** Per-column one-liners (keyed by exact column name). Cover every column. */
  columns: Record<string, string>;
  /** External references to live docs / authoritative source. Real URLs only. */
  docs?: { label: string; url: string }[];
}

const NANOCLAW_REPO = 'https://github.com/qwibitai/nanoclaw';
const DB_CENTRAL_DOC = `${NANOCLAW_REPO}/blob/main/docs/db-central.md`;
const NANOCLAW_DOCS = 'https://docs.nanoclaw.dev';
const GROUPS_CONCEPT_DOC = `${NANOCLAW_DOCS}/concepts/groups`;
const CHAT_SDK_ADAPTERS = 'https://chat-sdk.dev/adapters';

/** Keyed by exact table name. Tables absent here render a disabled "?" in the UI. */
export const TABLE_REFERENCE: Record<string, TableDoc> = {
  agent_groups: {
    summary: 'Agent workspaces — one row per assistant persona and its filesystem',
    description:
      'The core "who is the agent" table. Each row maps 1:1 to a `groups/<folder>/` directory holding `CLAUDE.md`, skills, personality, and per-group memory, and is the unit that privilege and routing attach to.\n\n' +
      '- Runtime container config (provider, model, packages) lives separately in `container_configs`; a `container.json` is materialized at spawn time.\n' +
      '- Wired to chats many-to-many via `messaging_group_agents`.\n' +
      '- Written by `src/db/agent-groups.ts`; read across the session manager, router, and delivery loop.',
    columns: {
      id: 'Primary key — opaque agent-group id referenced everywhere',
      name: 'Human-readable display name for the agent',
      folder: 'Unique groups/<folder> directory name on disk for this agent',
      agent_provider: 'Default provider hint (e.g. claude); usually NULL, overridden per container_configs',
      created_at: 'ISO timestamp when the group was created',
    },
    docs: [
      { label: 'Group isolation (concepts)', url: GROUPS_CONCEPT_DOC },
      { label: 'Central DB schema — agent_groups', url: `${DB_CENTRAL_DOC}#11-agent_groups` },
    ],
  },

  messaging_groups: {
    summary: 'One row per platform chat — a Slack channel DM or phone-call venue',
    description:
      'Represents a single chat on one platform per adapter instance: one WhatsApp group, one Slack channel, one 1:1 DM, one phone-call number. Inbound messages route from here to an agent group via `messaging_group_agents`.\n\n' +
      '- Identity is `(channel_type, platform_id, instance)` — that triple is the UNIQUE key.\n' +
      '- `unknown_sender_policy` governs how a non-member is treated; `denied_at` permanently silences a chat an owner refused to register.\n' +
      '- Written by `src/db/messaging-groups.ts` and channel setup flows.',
    columns: {
      id: 'Primary key — opaque messaging-group id',
      channel_type: 'Platform kind (slack discord telegram phone-call signal email ...)',
      platform_id: 'Platform-native chat/channel/handle id within that channel_type',
      instance: 'Adapter-instance name that owns this chat; defaults to channel_type',
      name: 'Optional human-readable chat name (nullable)',
      is_group: '1 if a multi-party group chat 0 if a 1:1 DM',
      unknown_sender_policy: "How to treat non-members: 'strict' drop / 'request_approval' / 'public'",
      created_at: 'ISO timestamp when the chat was first seen or wired',
      denied_at: 'ISO timestamp set when an owner denied auto-registration; drops future messages silently',
    },
    docs: [
      { label: 'Group isolation (concepts)', url: GROUPS_CONCEPT_DOC },
      { label: 'Central DB schema — messaging_groups', url: `${DB_CENTRAL_DOC}#12-messaging_groups` },
    ],
  },

  messaging_group_agents: {
    summary: 'Wiring rows linking a chat to the agent group that handles it',
    description:
      'The many-to-many wiring between `messaging_groups` and `agent_groups` — one chat can route to several agents and one agent can serve many chats. Per the docs the wiring (not the agent, not the chat) holds the four orthogonal behavior axes:\n\n' +
      '- `engage_mode` + `engage_pattern` — *when* the agent engages.\n' +
      '- `sender_scope` — *whose* messages it answers.\n' +
      '- `ignored_message_policy` — what happens to non-engaging messages.\n' +
      '- `session_mode` — how conversations map to sessions.\n\n' +
      'Creating a wiring must also populate `agent_destinations`. Written by `src/db/messaging-groups.ts`.',
    columns: {
      id: 'Primary key — opaque wiring id',
      messaging_group_id: 'FK to messaging_groups — the chat side of the wiring',
      agent_group_id: 'FK to agent_groups — the agent side of the wiring',
      session_mode: "How sessions are partitioned: 'shared' / 'per-thread' / 'agent-shared'",
      priority: 'Evaluation order when multiple agents are wired to one chat (default 0)',
      created_at: 'ISO timestamp when the wiring was created',
      engage_mode: "When the agent engages: 'pattern' / 'mention' / 'mention-sticky'",
      engage_pattern: "Regex used when engage_mode='pattern' ('.' means always-engage)",
      sender_scope: "Whose messages the agent answers: 'all' or 'known' (members only)",
      ignored_message_policy: "Non-engaging messages: 'drop' (silent) or 'accumulate' (context not waking)",
    },
    docs: [
      { label: 'Group isolation — wiring axes', url: GROUPS_CONCEPT_DOC },
      { label: 'Central DB schema — messaging_group_agents', url: `${DB_CENTRAL_DOC}#13-messaging_group_agents` },
    ],
  },

  users: {
    summary: 'Platform user identities — one row per channel handle a human uses',
    description:
      'Platform-namespaced identities such as `tg:123456`, `signal:+1555...`, `pstn:+1555...`, `email:a@x.com`. Privilege (`user_roles`) and membership (`agent_group_members`) attach to user rows.\n\n' +
      '- One human may own several rows (one per channel); upstream has no cross-channel linking.\n' +
      '- The PAT people spine groups these handles into a single person via `person_users`.\n' +
      '- Written by `src/db/users.ts` and channel auth flows.',
    columns: {
      id: 'Primary key — namespaced handle "<channel>:<platform-handle>"',
      kind: 'Identity kind / channel family for this handle',
      display_name: 'Best-known display name for the handle (nullable)',
      created_at: 'ISO timestamp when the handle was first recorded',
    },
    docs: [{ label: 'Central DB schema — users', url: `${DB_CENTRAL_DOC}#14-users` }],
  },

  user_roles: {
    summary: 'Agent-runtime privilege grants — owner or admin keyed by user handle',
    description:
      'Permissions are **user-level, never agent-group-level**. The router command gate and approver selection read this directly.\n\n' +
      "- `role = 'owner'` is always global (`agent_group_id` NULL).\n" +
      "- `role = 'admin'` is global (NULL) or scoped to one agent group.\n" +
      '- Admin on a group implies membership there with no `agent_group_members` row.\n\n' +
      'Distinct from `person_roles`, which governs PAT dashboard data-visibility rather than agent runtime.',
    columns: {
      user_id: 'FK to users — the handle that holds the role',
      role: "Privilege level: 'owner' (always global) or 'admin'",
      agent_group_id: 'FK to agent_groups; NULL = global, else scoped to that group',
      granted_by: 'FK to users — who granted this role (nullable)',
      granted_at: 'ISO timestamp the role was granted',
    },
    docs: [
      { label: 'Group isolation — access control', url: GROUPS_CONCEPT_DOC },
      { label: 'Central DB schema — user_roles', url: `${DB_CENTRAL_DOC}#15-user_roles` },
    ],
  },

  agent_group_members: {
    summary: 'Explicit membership rows gating access for non-privileged users',
    description:
      'The unprivileged access gate: a plain user must have a row here to interact with an agent group. Owners and admins are *implicit* members and need no row.\n\n' +
      '- Consulted in the access-resolution path (`canAccessAgentGroup`), which walks owner → global admin → group admin → member → denied.',
    columns: {
      user_id: 'FK to users — the member handle',
      agent_group_id: 'FK to agent_groups — the group they may access',
      added_by: 'FK to users — who added the member (nullable)',
      added_at: 'ISO timestamp the membership was granted',
    },
    docs: [
      { label: 'Group isolation — access control', url: GROUPS_CONCEPT_DOC },
      { label: 'Central DB schema — agent_group_members', url: `${DB_CENTRAL_DOC}#16-agent_group_members` },
    ],
  },

  user_dms: {
    summary: 'Cache mapping a user+channel to their direct-message messaging group',
    description:
      "Cold-DM discovery cache so the host can send a user an unsolicited DM (approval card, pairing code) without re-hitting the platform's `openConversation` API.\n\n" +
      '- Populated lazily by `ensureUserDm()` in `src/modules/permissions/user-dm.ts`.\n' +
      '- Keyed per `(user_id, channel_type)` — per-platform, resolved via the default adapter instance, not per-instance.',
    columns: {
      user_id: 'FK to users — whose DM channel this is',
      channel_type: 'Platform kind the DM lives on',
      messaging_group_id: 'FK to messaging_groups — the resolved DM chat row',
      resolved_at: 'ISO timestamp the DM channel was discovered',
    },
    docs: [{ label: 'Central DB schema — user_dms', url: `${DB_CENTRAL_DOC}#17-user_dms` }],
  },

  sessions: {
    summary: 'Session registry — one row per live agent-runtime conversation',
    description:
      'Lifecycle metadata only (no message bodies) for each `(agent_group, messaging_group, thread)` tuple, subject to the wiring `session_mode`. Resolved by `resolveSession()` in `src/session-manager.ts`.\n\n' +
      '- Creating a session also provisions its folder and the two per-session DBs (`inbound.db` / `outbound.db`), the sole IO surface to the container.\n' +
      '- `user_id` (a PAT addition) records the resolving sender so a session’s person is derivable even for venue channels like `phone-call`, where the `messaging_group` is the number but the person is `pstn:<number>`.',
    columns: {
      id: 'Primary key — session id; also the per-session DB folder name',
      agent_group_id: 'FK to agent_groups — which agent runs this session',
      messaging_group_id: 'FK to messaging_groups — the originating chat (nullable)',
      thread_id: 'Thread identity within the chat for per-thread sessions (nullable)',
      agent_provider: 'Provider this session is pinned to (nullable)',
      status: "Session lifecycle status (default 'active')",
      container_status: "Container lifecycle ('stopped' / running ...; default 'stopped')",
      last_active: 'ISO timestamp of last activity (nullable)',
      created_at: 'ISO timestamp the session was created',
      user_id: 'PAT: resolving sender handle, for deriving the session’s person (nullable)',
    },
    docs: [{ label: 'Central DB schema — sessions', url: `${DB_CENTRAL_DOC}#18-sessions` }],
  },

  pending_questions: {
    summary: 'Parked interactive questions from the ask_user_question MCP tool',
    description:
      'When an agent calls the `ask_user_question` MCP tool, the question is parked here; the container later matches an incoming `system` reply back to it by `question_id`. Holds the routing identity needed to re-deliver the prompt and re-match the answer.',
    columns: {
      question_id: 'Primary key — id the answer is matched back against',
      session_id: 'FK to sessions — which session asked',
      message_out_id: 'Outbound message id of the question that was sent',
      platform_id: 'Platform chat id the question was posted to (nullable)',
      channel_type: 'Channel the question was posted on (nullable)',
      thread_id: 'Thread the question was posted in (nullable)',
      title: 'Question prompt text',
      options_json: 'JSON array of answer options offered',
      created_at: 'ISO timestamp the question was parked',
    },
    docs: [{ label: 'Central DB schema — pending_questions', url: `${DB_CENTRAL_DOC}#19-pending_questions` }],
  },

  agent_destinations: {
    summary: 'Per-agent ACL and name map for who an agent may send messages to',
    description:
      'Both the routing map **and** the ACL for outbound sends. A row exists iff the source agent may send to that target — no row means unauthorized:\n\n' +
      "- `send_message(to='dev-channel')` only works if a row has `local_name='dev-channel'`, else the send is rejected as *unknown destination*.\n" +
      '- Names are scoped per source agent (worker-1 may call admin "parent" while admin calls it "worker-1").\n' +
      '- The central table is the source of truth; running containers read a projection in their `inbound.db`, so any mutation must also call `writeDestinations()`.',
    columns: {
      agent_group_id: 'FK to agent_groups — the sending agent',
      local_name: "The agent's private alias for the target (e.g. 'parent', 'dev-channel')",
      target_type: "What the target is: 'channel' or 'agent'",
      target_id: 'messaging_group_id (channel) or agent_group_id (agent)',
      created_at: 'ISO timestamp the destination was granted',
    },
    docs: [{ label: 'Central DB schema — agent_destinations', url: `${DB_CENTRAL_DOC}#110-agent_destinations` }],
  },

  agent_message_policies: {
    summary: 'Per-edge approval gate on agent-to-agent messaging',
    description:
      'Defines a per-message approval requirement on a *directed* agent-to-agent connection. **No row means messages flow freely**; a row names the `approver` who must sign off on each message from one agent group to another. The approval itself lands in `pending_approvals` (with `approver_user_id` set).',
    columns: {
      from_agent_group_id: 'FK to agent_groups — the sending agent',
      to_agent_group_id: 'FK to agent_groups — the receiving agent',
      approver: 'Who must approve each message on this edge',
      created_at: 'ISO timestamp the policy was created',
    },
    docs: [
      { label: 'migration 017-agent-message-policies', url: `${NANOCLAW_REPO}/blob/main/src/db/migrations/017-agent-message-policies.ts` },
    ],
  },

  pending_approvals: {
    summary: 'Host records for approval-gated actions — package installs and credentials',
    description:
      'Backs two approval workflows that share one table:\n\n' +
      '- **Session-bound MCP approvals** (`install_packages`, `add_mcp_server`) — `session_id` is set.\n' +
      '- **OneCLI credential approvals** from the SDK manual-approval callback — `session_id` may be NULL; `agent_group_id` + `channel_type` + `platform_id` route the admin card.\n\n' +
      '`platform_message_id` lets the host edit the card in place after a decision. Sweep + delivery: `src/modules/approvals/onecli-approvals.ts`.',
    columns: {
      approval_id: 'Primary key — id of the approval request',
      session_id: 'FK to sessions (nullable for OneCLI credential approvals)',
      request_id: 'Originating request id the approval corresponds to',
      action: 'Action being gated (install_packages add_mcp_server onecli_credential ...)',
      payload: 'JSON describing the requested action',
      created_at: 'ISO timestamp the request was raised',
      agent_group_id: 'FK to agent_groups — routes the admin card (nullable)',
      channel_type: 'Channel to deliver the approval card on (nullable)',
      platform_id: 'Platform chat id for the approval card (nullable)',
      platform_message_id: 'Posted card message id so the host can edit it in place (nullable)',
      expires_at: 'ISO timestamp the request expires (nullable)',
      status: "Decision state: 'pending' / 'approved' / 'rejected' / 'expired'",
      title: 'Card title text shown to the approver',
      options_json: 'JSON array of decision options on the card',
      approver_user_id: 'If set only this exact user may resolve (a2a policy approver); else group/owner path',
    },
    docs: [{ label: 'Central DB schema — pending_approvals', url: `${DB_CENTRAL_DOC}#111-pending_approvals` }],
  },

  pending_sender_approvals: {
    summary: 'In-flight approval cards for messages from unknown senders',
    description:
      "When a messaging group has `unknown_sender_policy='request_approval'`, a non-member's message raises a card to the appropriate admin, and an in-flight row here dedups concurrent attempts from the same sender.\n\n" +
      '- `UNIQUE(messaging_group_id, sender_identity)` is the dedup; the row is cleared on approve or deny.\n' +
      '- Stores the serialized original `InboundEvent` so it can be replayed on approval.',
    columns: {
      id: 'Primary key — approval-request id',
      messaging_group_id: 'FK to messaging_groups — the chat the sender wrote in',
      agent_group_id: 'FK to agent_groups — the agent the chat would route to',
      sender_identity: 'Namespaced user id of the unknown sender (channel_type:handle)',
      sender_name: 'Best-known display name of the sender (nullable)',
      original_message: 'JSON-serialized InboundEvent replayed if approved',
      approver_user_id: 'User the approval card was sent to',
      created_at: 'ISO timestamp the card was raised',
      title: 'Card title text (default empty)',
      options_json: 'JSON array of decision options (default empty)',
    },
    docs: [
      { label: 'migration 011-pending-sender-approvals', url: `${NANOCLAW_REPO}/blob/main/src/db/migrations/011-pending-sender-approvals.ts` },
    ],
  },

  pending_channel_approvals: {
    summary: 'In-flight approval cards to register a brand-new unwired channel',
    description:
      'When a channel not wired to any agent receives a mention or DM, the router escalates to the owner before wiring it.\n\n' +
      '- `PRIMARY KEY (messaging_group_id)` gives free dedup — a second mention while the card is pending is dropped.\n' +
      '- Approve creates a `messaging_group_agents` wiring and replays the event; deny stamps `messaging_groups.denied_at`.',
    columns: {
      messaging_group_id: 'Primary key + FK — the unwired chat awaiting registration',
      agent_group_id: 'FK to agent_groups — the agent the approved wiring will target',
      original_message: 'JSON-serialized InboundEvent replayed if approved',
      approver_user_id: 'User (owner) the registration card was sent to',
      created_at: 'ISO timestamp the card was raised',
      title: 'Card title text (default empty)',
      options_json: 'JSON array of decision options (default empty)',
    },
    docs: [
      { label: 'migration 012-channel-registration', url: `${NANOCLAW_REPO}/blob/main/src/db/migrations/012-channel-registration.ts` },
    ],
  },

  unregistered_senders: {
    summary: 'Audit counter of dropped messages from unknown senders',
    description:
      'Audit trail: every time a message is dropped (unknown sender under a strict/denied policy) a counter here is incremented so admins can see who has been knocking.\n\n' +
      '- Written by `recordDroppedMessage()` in `src/db/dropped-messages.ts`; on conflict it bumps `message_count` and `last_seen`.\n' +
      '- Surfaced read-only via the `dropped-messages` ncl resource.',
    columns: {
      channel_type: 'Platform the dropped message came from (part of PK)',
      platform_id: 'Platform handle/chat id of the sender (part of PK)',
      user_id: 'Resolved users id if known (nullable)',
      sender_name: 'Best-known display name of the sender (nullable)',
      reason: 'Why the message was dropped',
      messaging_group_id: 'Chat the message targeted if known (nullable)',
      agent_group_id: 'Agent the chat would route to if known (nullable)',
      message_count: 'How many times this sender has been dropped (default 1)',
      first_seen: 'ISO timestamp of the first drop',
      last_seen: 'ISO timestamp of the most recent drop',
    },
    docs: [{ label: 'Central DB schema — unregistered_senders', url: `${DB_CENTRAL_DOC}#112-unregistered_senders` }],
  },

  container_configs: {
    summary: 'Per-agent-group container runtime config — provider model packages MCP',
    description:
      'Source of truth for *how* an agent group’s container runs: provider, model, effort, image, installed apt/npm packages, wired MCP servers, extra mounts, and the ncl CLI scope.\n\n' +
      '- Materialized to `groups/<folder>/container.json` at spawn time so the container runner can read it.\n' +
      '- Managed via `ncl groups config` and the self-mod MCP tools; one row per agent group (`ON DELETE CASCADE`).\n' +
      '- `cli_scope` gates what the in-container agent can do with `ncl`: `disabled` / `group` (own group only) / `global`.',
    columns: {
      agent_group_id: 'Primary key + FK to agent_groups (ON DELETE CASCADE)',
      provider: 'Agent provider (e.g. claude); nullable falls back to default',
      model: 'Model id override for this group (nullable)',
      effort: 'Effort/reasoning level hint (nullable)',
      image_tag: 'Pinned container image tag (nullable)',
      assistant_name: 'Display name the assistant uses inside the container (nullable)',
      max_messages_per_prompt: 'Cap on messages batched into one agent prompt (nullable)',
      skills: "JSON of which container skills to mount (default '\"all\"')",
      mcp_servers: "JSON map of wired MCP servers (default '{}')",
      packages_apt: "JSON array of extra apt packages to install (default '[]')",
      packages_npm: "JSON array of extra npm packages to install (default '[]')",
      additional_mounts: "JSON array of extra bind mounts (default '[]')",
      cli_scope: "What ncl the container can use: 'disabled' / 'group' / 'global'",
      updated_at: 'ISO timestamp of the last config change',
    },
    docs: [{ label: 'Central DB schema — container_configs', url: `${DB_CENTRAL_DOC}#115-container_configs` }],
  },

  schema_version: {
    summary: 'Migration ledger — one row per applied schema migration',
    description:
      'Migration bookkeeping written by `runMigrations()`. Each applied migration appends a row.\n\n' +
      '- Uniqueness is keyed on `name` (not `version`) so module migrations added by install skills can pick arbitrary version numbers without coordinating.\n' +
      '- The stored `version` is an auto-assigned applied-order number.',
    columns: {
      version: 'Auto-assigned applied-order number (primary key)',
      name: 'Migration name — the real dedup key (unique)',
      applied: 'ISO timestamp the migration was applied',
    },
    docs: [{ label: 'Central DB schema — migration system', url: `${DB_CENTRAL_DOC}#2-migration-system` }],
  },

  chat_sdk_kv: {
    summary: 'Key-value store backing the embedded Chat SDK state adapter',
    description:
      'A Chat SDK bridge table owned by the `SqliteStateAdapter` (`src/state-sqlite.ts`) — nanoclaw business logic rarely touches it directly. The SDK uses it as a generic expiring KV cache, including webhook **dedupe keys** (`dedupe:<adapter>:<msgId>`) via `setIfNotExists` so a redelivered message is processed once. Expired rows are swept on access.',
    columns: {
      key: 'Primary key — the KV key (may be adapter-instance-namespaced)',
      value: 'Stored value (JSON-encoded)',
      expires_at: 'Optional unix-ms expiry; NULL means no expiry',
    },
    docs: [
      { label: 'Chat SDK — adapters', url: CHAT_SDK_ADAPTERS },
      { label: 'Central DB schema — Chat SDK bridge', url: `${DB_CENTRAL_DOC}#113-chat-sdk-bridge-tables` },
    ],
  },

  chat_sdk_lists: {
    summary: 'Ordered-list and per-thread queue store for the Chat SDK adapter',
    description:
      'A Chat SDK bridge table owned by the `SqliteStateAdapter`. Stores ordered lists as `(key, idx)` rows with optional `maxLength` trimming and per-entry TTL.\n\n' +
      '- It also backs the SDK message **queue**: `queue:<threadId>` keys hold per-thread pending entries that `enqueue`/`dequeue`/`queueDepth` drain in order.\n' +
      '- Nanoclaw code rarely reads it directly.',
    columns: {
      key: 'List name (part of PK); queues use the form queue:<threadId>',
      idx: 'Monotonic position within the list (part of PK)',
      value: 'Stored list-entry value (JSON-encoded)',
      expires_at: 'Optional unix-ms expiry; NULL means no expiry',
    },
    docs: [
      { label: 'Chat SDK — adapters', url: CHAT_SDK_ADAPTERS },
      { label: 'Central DB schema — Chat SDK bridge', url: `${DB_CENTRAL_DOC}#113-chat-sdk-bridge-tables` },
    ],
  },

  chat_sdk_locks: {
    summary: 'Per-thread mutex locks backing the embedded Chat SDK state adapter',
    description:
      'A Chat SDK bridge table owned by the `SqliteStateAdapter`. Implements per-thread advisory locks: a random `token` claims a `thread_id` until `expires_at`, serializing concurrent processing of the same thread so two instances do not double-process one webhook. Acquire is `INSERT OR IGNORE` after pruning expired holders; release/extend are token-checked.',
    columns: {
      thread_id: 'Primary key — the locked thread (may be namespaced)',
      token: 'Opaque random token identifying the current lock holder',
      expires_at: 'Unix-ms when the lock auto-expires',
    },
    docs: [
      { label: 'Chat SDK — adapters', url: CHAT_SDK_ADAPTERS },
      { label: 'Central DB schema — Chat SDK bridge', url: `${DB_CENTRAL_DOC}#113-chat-sdk-bridge-tables` },
    ],
  },

  chat_sdk_subscriptions: {
    summary: 'Thread subscription registry for the embedded Chat SDK state adapter',
    description:
      'A Chat SDK bridge table owned by the `SqliteStateAdapter`. Records which threads the bot is subscribed to so `onSubscribedMessage` keeps firing on every message in that thread after the initial mention — persisting engagement across host restarts. Nanoclaw code rarely reads it directly.',
    columns: {
      thread_id: 'Primary key — the subscribed thread (may be namespaced)',
      subscribed_at: 'ISO timestamp of subscription (defaults to now)',
    },
    docs: [
      { label: 'Chat SDK — adapters', url: CHAT_SDK_ADAPTERS },
      { label: 'Central DB schema — Chat SDK bridge', url: `${DB_CENTRAL_DOC}#113-chat-sdk-bridge-tables` },
    ],
  },

  people: {
    summary: 'PAT people spine — one row per human identity across all handles',
    description:
      'A PAT addition (not upstream). A "person" is one human who can reach PAT by many handles (phone, Signal, Telegram, dashboard login).\n\n' +
      '- Pure identity — names plus timestamps, no tier/access columns.\n' +
      '- Handles (`users` rows) link in via `person_users`; recognition identifiers (email/phone) live in `person_identifiers`.\n' +
      '- Designed as three additive tables so an upstream sync never clobbers the upstream `users` table. Written only by `src/people/`.',
    columns: {
      id: 'Primary key — person-<uuid>',
      first_name: 'Given name (required)',
      last_name: 'Family name (required)',
      created_at: 'ISO timestamp the person was created',
      updated_at: 'ISO timestamp of the last name update (nullable)',
    },
    docs: [
      { label: 'migration 019-pat-people-spine', url: `${NANOCLAW_REPO}/blob/main/src/db/migrations/019-pat-people-spine.ts` },
    ],
  },

  person_identifiers: {
    summary: 'Email/phone identifiers a person is auto-recognized and enrolled by',
    description:
      'A PAT addition — the auto-enroll front door.\n\n' +
      '- `PRIMARY KEY (kind, value)` means a normalized email/phone maps to **exactly one** person, so an inbound handle carrying that identifier deterministically resolves.\n' +
      '- Rows can be pre-seeded before the person ever messages.\n' +
      '- Written only by `src/people/`.',
    columns: {
      person_id: 'FK to people — who this identifier belongs to',
      kind: "Identifier kind: 'email' or 'phone'",
      value: 'Normalized value: lowercased email or E.164 phone (part of PK)',
      verified: '1 if the identifier has been verified else 0',
      created_at: 'ISO timestamp the identifier was added',
    },
    docs: [
      { label: 'migration 019-pat-people-spine', url: `${NANOCLAW_REPO}/blob/main/src/db/migrations/019-pat-people-spine.ts` },
    ],
  },

  person_users: {
    summary: 'Links each platform handle (users row) to exactly one person',
    description:
      'A PAT addition — the realized link from a handle to a person, the additive replacement for a `users.person_id` column.\n\n' +
      '- `PRIMARY KEY (user_id)` enforces that each handle belongs to at most one person without touching the upstream `users` table.\n' +
      '- Records when and how the link was made. Written only by `src/people/`.',
    columns: {
      user_id: 'Primary key + FK to users — the linked handle',
      person_id: 'FK to people — the person this handle resolves to',
      linked_at: 'ISO timestamp the link was made',
      link_method: "How it was linked: 'manual' / 'auto:phone' / 'auto:email' / 'backfill:phone' / ...",
    },
    docs: [
      { label: 'migration 019-pat-people-spine', url: `${NANOCLAW_REPO}/blob/main/src/db/migrations/019-pat-people-spine.ts` },
    ],
  },

  person_roles: {
    summary: 'PAT dashboard access role for a person — admin or employee',
    description:
      'A PAT addition — data-visibility authority for the pat-frontend dashboard, keyed on **person** (one role per person).\n\n' +
      '- The dashboard resolves a Clerk login → person → this role; a code-side `ROLE_CAPS` map expands the role into capabilities.\n' +
      '- Distinct from `user_roles` (agent-runtime authority, handle-keyed). Managed via `ncl person-roles`.',
    columns: {
      person_id: 'Primary key + FK to people — who holds the dashboard role',
      role: "'admin' = full dashboard access / 'employee' = read-only own-scoped",
      granted_by: 'person_id of the granting admin (informational, nullable)',
      granted_at: 'ISO timestamp the role was granted',
    },
    docs: [
      { label: 'migration 021-pat-person-roles', url: `${NANOCLAW_REPO}/blob/main/src/db/migrations/021-pat-person-roles.ts` },
    ],
  },

  pairing_codes: {
    summary: 'Short-lived codes for self-service handle linking (proof of possession)',
    description:
      'A PAT addition — backs the dashboard "Link new handle" flow. An operator mints a 6-digit code for their person, then sends a message containing it FROM the new channel; the inbound path links that handle to the code\'s person.\n\n' +
      '- 6-digit numeric, 5-minute TTL, single-use; substring-matched against inbound message text.\n' +
      '- Only an UNLINKED handle can pair. Written by `src/people/pairing.ts`; matched + consumed on the inbound path (`src/modules/permissions/pairing.ts`).\n' +
      '- The primary self-serve linking path — replaces the approval-card unknown-sender registration.',
    columns: {
      id: 'Primary key (pair-<uuid>)',
      code: '6-digit numeric code (TEXT to preserve leading zeros)',
      person_id: 'FK to people — who a consuming handle links to',
      created_at: 'ISO timestamp the code was minted',
      expires_at: 'Absolute ISO; active = now < this AND not consumed',
      consumed_at: 'When a handle consumed it (NULL = unused; single-use)',
      linked_user_id: 'The handle that consumed the code (success view + audit)',
    },
    docs: [
      { label: 'migration 022-pat-pairing-codes', url: `${NANOCLAW_REPO}/blob/main/src/db/migrations/022-pat-pairing-codes.ts` },
    ],
  },

  credential_routing: {
    summary: 'Where each credential injects: host, header, format (source of truth; the vault is derived)',
    description:
      'A PAT addition — declarative routing for OneCLI vault credential injection. Each row says "the credential named X injects on host Y in header Z with this format", plus which `AGENT_<name>` secret provides the value. The OneCLI vault is reconciled FROM these rows at host boot (and via `ncl credentials reconcile`) — the table is the source of truth, the vault a derived cache.\n\n' +
      '- Secret VALUES never live here — only names and routing metadata. Values arrive out-of-band (AGENT_ Fly secrets today, 1Password later).\n' +
      '- Rows are written by the agent itself during an approved `add_mcp_server` (one-call routing) or seeded by scripts.\n' +
      '- `deleted` is a tombstone so the staging↔prod promote can see a removal; a tombstoned route deletes its vault entry at reconcile.',
    columns: {
      name: 'Vault entry name (doubles as the MCP server name for agent-added routes). Primary key.',
      host_pattern: 'Host this credential injects on (e.g. api.firecrawl.dev)',
      header_name: 'Header to set; NULL for type=anthropic (the gateway auto-sets x-api-key)',
      value_format: "e.g. 'Bearer {value}' or '{value}'",
      type: 'generic | anthropic | openai (anthropic/openai are gateway-auto-configured)',
      secret_name: 'Canonical AGENT_<X> secret providing the value (name only, never the value)',
      deleted: 'Tombstone (0/1) — lets the promote propagate a removal',
      created_at: 'ISO timestamp the route was declared',
      updated_at: 'ISO timestamp of the last change',
    },
    docs: [
      { label: 'migration 023-pat-credential-routing', url: `${NANOCLAW_REPO}/blob/main/src/db/migrations/023-pat-credential-routing.ts` },
    ],
  },

  pending_mcp_activations: {
    summary: 'Approved MCP servers parked until their credential lands in the vault',
    description:
      'A PAT addition — the "watch" state of credential-gated MCP activation. When an approved `add_mcp_server` needs a credential that is not in the OneCLI vault yet, the MCP is parked here instead of being wired into a container that would fail its MCP handshake (401) and stay dead. A host-side watcher polls the vault (a local existence check — never the credential\'s own service) and, the moment the credential exists, wires the config + restarts the session\'s container so the handshake succeeds first try.\n\n' +
      '- Rows are deleted on activation; history lives in the `mcp.activation-*` structured log events.\n' +
      '- One row per (agent group, MCP name); a re-request replaces the row.\n' +
      '- After ~5 minutes without the credential the requester gets a one-time "still waiting" notice and polling drops to ~once a minute, forever.',
    columns: {
      agent_group_id: 'Agent group whose config gains the MCP entry on activation',
      name: 'MCP server name (the config key). PK with agent_group_id.',
      session_id: 'Requesting session — where activation/still-waiting notices go',
      payload: 'Full approval payload (JSON), replayed verbatim at activation',
      host_pattern: 'Vault host the watcher waits for',
      secret_name: 'Canonical AGENT_<X> key, for operator-facing messages (name only)',
      notified_slow: '1 = the one-time past-deadline notice was sent',
      created_at: 'ISO timestamp the request was parked',
      fast_deadline: 'Until this instant the watcher polls fast (~4s); after, ~60s',
    },
    docs: [
      { label: 'migration 024-pat-pending-mcp-activations', url: `${NANOCLAW_REPO}/blob/main/src/db/migrations/024-pat-pending-mcp-activations.ts` },
    ],
  },
};

export function getTableDoc(table: string): TableDoc | undefined {
  return TABLE_REFERENCE[table];
}
