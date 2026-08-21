/**
 * Capability context — partial composed into every front-mind prompt
 * (banter-ack, banter-render, banter-narration, request-layer).
 *
 * Lifecycle split (TaskList #8): the rendered capability surface lives
 * in two distinct slots with different cadences:
 *
 *  1. INSTALL CAPABILITIES — channels, MCP tools, skills, sdk tools,
 *     host verbs, in-tree primitives, external MCP servers, agent group
 *     identity. These don't vary by who's calling
 *     or which inbound arrived; they vary by `agent_group_id`. The host
 *     resolves them ONCE per agent group at boot (or at provision time
 *     when a new agent group is created) and caches the rendered
 *     markdown block. Each prompt's `render()` looks the block up by
 *     `ctx.agentGroupId` and prepends it to SYSTEM — which keeps SYSTEM
 *     cacheable across inbounds (Anthropic prompt cache), and prevents
 *     repeated DB walks for stable data.
 *
 *  2. CALLER CONTEXT — caller identity, suffix-matched known handles,
 *     permissions for the caller against the agent group. These DO vary
 *     per inbound (different callers in the same agent group have
 *     different roles, different handles). Rendered fresh each inbound
 *     by `renderCallerContext(ctx)` and threaded into the USER message.
 *
 * Contract: composition stays inside each prompt's `render()` function.
 * No callsite outside `prompts/*.ts` should inject into SYSTEM. The
 * install block is reached via `getInstallCapabilitiesBlock(...)`; the
 * caller block is reached via `renderCallerContext(...)`. Both lookups
 * happen inside the prompt file.
 *
 * Cache shape: a process-local `Map<agentGroupId, renderedBlock>`. The
 * host populates it at boot by walking `agent_groups` and calling
 * `setInstallCapabilities(agentGroupId, snapshot)` once each. New agent
 * groups created at runtime call the same setter at provision time.
 *
 * Surface taxonomy (the 10 categories from plans/one-flow-well.md
 * §"Skills vs tools"):
 *
 *   Install-side (per agent group):
 *     1. Container MCP tools  — `nanoclaw/container/agent-runner/src/mcp-tools/*.ts`
 *     2. Container skills     — `nanoclaw/container/skills/<name>/SKILL.md`
 *     3. Registered channels  — host `getRegisteredChannelNames()`
 *     4. SDK-native tools     — Read/Edit/Bash/Grep/Glob/...
 *     5. In-tree primitives   — TypeScript skills / CLIs the back-mind invokes
 *     6. External MCP servers — `container.json:mcpServers`
 *     8. (channels include their supported message shapes — folded in #3)
 *    10. Host-side verbs      — barge-in, scenario dispatch, narration cadence
 *
 *  Slash commands intentionally excluded — front-mind never narrates/acks
 *  about them; back-mind owns slash-command knowledge.
 *
 *   Caller-side (per inbound):
 *     - <caller>           — current speaker's platform_id, channel, role, suffix
 *     - <known_handles>    — suffix-matched handles for the same human
 *     - <permissions> (#9)— caller_role + verbs unlocked / approval-gated
 */

/** A single capability entry. `name` is what the back-mind sees as a
 *  tool/skill/feature handle; `summary` is a one-line gist for the
 *  front-mind to ground "can you X?" calibration. Either field can be
 *  omitted — empty strings render as just the other half. */
export interface CapabilityEntry {
  /** Stable identifier or human label (e.g. `send_message`, `wiki`,
   *  `signal`, `Bash`). The front-mind doesn't dispatch on this — it
   *  just helps the model decide whether something fits. */
  name: string;
  /** One-line gist of what this affordance does. Lives next to `name`
   *  in the rendered block. Skip for self-evident names. */
  summary?: string;
  /** Optional caller-visible flag — e.g. `admin-only`, `approval-gated`.
   *  Shown inline so the front-mind can ack accurately ("yeah but
   *  needs admin approval"). */
  flags?: readonly string[];
}

/** A registered channel adapter and what message shapes it supports.
 *  Channel adapters aren't agent-callable directly — the agent uses
 *  `send_message` and the host routes — but the front-mind benefits
 *  from knowing the wire-format surface so it can answer "can you
 *  send a voice memo on slack?" honestly (no, only signal). */
export interface ChannelCapability {
  /** Channel type id (`signal`, `slack`, `phone-call`, `anam-web`,
   *  `telegram`, ...). What `getRegisteredChannelNames()` returns. */
  type: string;
  /** Supported outbound shapes for this channel — `text`, `file`,
   *  `voice-memo`, `card`, `reaction`, `edit`. Front-mind reads this
   *  to calibrate confidence on "can you X over Y?" questions. */
  shapes?: readonly string[];
}

/** Caller identity — always-present block. The orchestrator already
 *  has this from the inbound's senderId; we thread it through so the
 *  front-mind never has to guess who's talking. */
export interface CallerIdentity {
  /** Namespaced platform id of the current speaker, e.g.
   *  `pstn:+15550100000`, `signal:+15550100000`, `slack:U07L...`. */
  platformId: string;
  /** Channel type the caller arrived on. Redundant with the prefix in
   *  platformId but cheaper to read for the model. */
  channelType: string;
  /** Display name when known; null in cold-contact cases. */
  displayName?: string | null;
  /** Resolved role for the caller against this agent group.
   *   - 'owner'        — global owner
   *   - 'admin'        — global or group-scoped admin
   *   - 'member'       — known but unprivileged
   *   - 'unknown'      — first contact, not yet registered
   */
  role?: 'owner' | 'admin' | 'member' | 'unknown';
  /** Suffix of the caller's handle (last 4 of E.164 for phone-bearing
   *  channels; last 4 of the platform id otherwise). Convenience —
   *  saves the model from string-slicing platformId. */
  suffix?: string;
}

/** Other handles known for the same human as the current caller —
 *  computed host-side via the suffix-match heuristic from
 *  `plans/one-flow-well.md §5`. Front-mind reads this when the caller
 *  says "send it to me on signal ending in 4959" so it doesn't have
 *  to round-trip the back-mind for "which of Gavan's Signal numbers
 *  did they mean."
 *
 *  Each entry carries its own suffix so disambiguation works on
 *  *partial* matches the way the user actually speaks ("the one
 *  ending in 4959"). */
export interface KnownHandle {
  /** Full namespaced platform id (`signal:+15550100000`). */
  platformId: string;
  /** Channel type — same as the prefix in platformId. */
  channelType: string;
  /** Display label if any (display_name, or a contact note). */
  label?: string | null;
  /** Last 4 of the handle. Pre-computed so the model doesn't slice. */
  suffix: string;
  /** True iff this is the same handle as the current caller's. Saves
   *  the model from comparing platformIds and accidentally "sending
   *  to myself" when the caller meant "to me, here". */
  isCurrentCaller?: boolean;
}

/** Permissions / roles surface — what *this caller* can ask Pat to do
 *  that other callers couldn't, plus the operator-relevant gating
 *  notes. Sourced from `user_roles` for the active agent group. */
export interface PermissionsSurface {
  /** Verbatim role for the caller against this agent group (mirrors
   *  CallerIdentity.role). Carried here too so the permissions block
   *  reads standalone. */
  callerRole: 'owner' | 'admin' | 'member' | 'unknown';
  /** Verbs the caller is currently allowed to perform that an
   *  unprivileged caller couldn't — e.g. `install_packages` (admin),
   *  `create_agent` (admin), unrestricted `send_message`-to-cold-handle
   *  (owner). Keep short; one line per verb. */
  callerVerbs?: readonly string[];
  /** Verbs the caller is NOT allowed to perform without an approval
   *  card going to an owner/admin. Surfaces "yeah I can do that but
   *  it'll need approval" honesty for the front-mind. */
  approvalGatedVerbs?: readonly string[];
}

/** Install-state snapshot — agent-group-scoped, stable across inbounds.
 *  Resolved once per agent group at boot (or at provision time when a
 *  new group is created) and cached as a rendered markdown block by
 *  `setInstallCapabilities(agentGroupId, snapshot)`. Lives in the
 *  SYSTEM prompt so the Anthropic prompt cache stays effective. */
export interface InstallCapabilities {
  /** Agent group identifier. Included verbatim so the back-mind's
   *  authoritative answer can be cross-referenced against this group's
   *  config when needed. Optional; rendered as a single line when set. */
  agentGroupId?: string;
  /** Human-readable name for this agent group (`Pat`,
   *  `palisade-internal`, etc.). Surfaced so "who am I right now"
   *  answers correctly. */
  agentGroupName?: string;

  // ── The install-side capability categories ──

  /** 1. Container MCP tools — agent-callable from inside the
   *     container. `send_message`, `schedule_task`, `ask_user_question`,
   *     `install_packages`, etc. */
  containerMcpTools?: readonly CapabilityEntry[];
  /** 2. Container skills — passive instruction-load skills mounted in
   *     the agent's workspace. `wiki`, `agent-browser`, `apify`,
   *     `present-slides`, etc. */
  containerSkills?: readonly CapabilityEntry[];
  /** 3. Registered channels — adapters this install has wired up.
   *     `signal`, `phone-call`, `anam-web`, `slack`, ... */
  channels?: readonly ChannelCapability[];
  /** 4. Claude Agent SDK tools available to the back-mind. `Read`,
   *     `Edit`, `Bash`, `Grep`, `Glob`, `WebFetch`, `WebSearch`,
   *     `Write`, `Task`, `TodoWrite`, etc. */
  sdkTools?: readonly CapabilityEntry[];
  /** 5. In-tree primitives — TypeScript helpers / CLIs the back-mind
   *     can shell out to (`agent-browser`, `pat-trace.py`, etc.). */
  inTreePrimitives?: readonly CapabilityEntry[];
  /** 6. External MCP servers registered in `container.json:mcpServers`
   *     for this agent group. e.g. `apify`, `context7`, `gmail`. */
  externalMcpServers?: readonly CapabilityEntry[];
  /** 10. Host-side action verbs — affordances the channel
   *      orchestrator owns, not the back-mind. Barge-in, narration
   *      cadence, scenario dispatch, multi-context rendition. */
  hostVerbs?: readonly CapabilityEntry[];
}

/** Per-inbound caller context — varies by who's talking. Resolved
 *  fresh on every inbound by the channel adapter's `callerContextResolver`
 *  and rendered into the USER message. */
export interface CallerContext {
  /** Agent group identifier the caller arrived against. Mirrors the
   *  install-side `agentGroupId`; carried here so a single
   *  `<caller_context>` block reads standalone. */
  agentGroupId?: string;
  /** Current caller's identity — always present when the orchestrator
   *  resolved a caller. Null only in test fixtures or pre-handshake
   *  edge cases. */
  caller?: CallerIdentity | null;
  /** Known handles for the human behind the current caller — the
   *  suffix-match output. Empty array means "no other channels
   *  registered for them" (or the resolver didn't run). */
  knownHandles?: readonly KnownHandle[];
  /** Permissions surface for THIS caller against THIS agent group.
   *  Per-inbound because role is caller-scoped, not group-scoped. */
  permissions?: PermissionsSurface;
}

// ─────────────────────────── Renderers ───────────────────────────

/** Render one capability category as a markdown bullet list inside an
 *  XML tag. Returns '' when entries is empty so the prompt block stays
 *  tight. Keeping the XML tag here (not in the caller) means callers
 *  can blindly join the parts and not worry about empties. */
function renderCategory(tag: string, entries: readonly CapabilityEntry[] | undefined): string {
  if (!entries || entries.length === 0) return '';
  const lines = entries.map((e) => {
    const parts = [`- **${e.name}**`];
    if (e.summary) parts.push(`— ${e.summary}`);
    if (e.flags && e.flags.length > 0) parts.push(`*[${e.flags.join(', ')}]*`);
    return parts.join(' ');
  });
  return `<${tag}>\n${lines.join('\n')}\n</${tag}>`;
}

function renderChannels(channels: readonly ChannelCapability[] | undefined): string {
  if (!channels || channels.length === 0) return '';
  const lines = channels.map((c) => {
    const shapes = c.shapes && c.shapes.length > 0 ? ` (${c.shapes.join(', ')})` : '';
    return `- **${c.type}**${shapes}`;
  });
  return `<channels>\n${lines.join('\n')}\n</channels>`;
}

function renderPermissions(perms: PermissionsSurface | undefined): string {
  if (!perms) return '';
  const lines: string[] = [];
  lines.push(`caller_role: ${perms.callerRole}`);
  if (perms.callerVerbs && perms.callerVerbs.length > 0) {
    lines.push(`unlocked_verbs:`);
    for (const v of perms.callerVerbs) lines.push(`  - ${v}`);
  }
  if (perms.approvalGatedVerbs && perms.approvalGatedVerbs.length > 0) {
    lines.push(`approval_gated_verbs:`);
    for (const v of perms.approvalGatedVerbs) lines.push(`  - ${v}`);
  }
  return `<permissions>\n${lines.join('\n')}\n</permissions>`;
}

function renderCaller(caller: CallerIdentity | null | undefined): string {
  if (!caller) return '';
  const lines: string[] = [];
  lines.push(`platform_id: ${caller.platformId}`);
  lines.push(`channel: ${caller.channelType}`);
  if (caller.displayName) lines.push(`display_name: ${caller.displayName}`);
  if (caller.role) lines.push(`role: ${caller.role}`);
  if (caller.suffix) lines.push(`suffix: ${caller.suffix}`);
  return `<caller>\n${lines.join('\n')}\n</caller>`;
}

function renderKnownHandles(handles: readonly KnownHandle[] | undefined): string {
  if (!handles || handles.length === 0) return '';
  const lines = handles.map((h) => {
    const me = h.isCurrentCaller ? ' (THIS CALL)' : '';
    const label = h.label ? ` — ${h.label}` : '';
    return `- **${h.platformId}** ending in ${h.suffix}${label}${me}`;
  });
  return `<known_handles>\n${lines.join('\n')}\n</known_handles>`;
}

/** Build the install-capabilities markdown block for one agent group.
 *  Pure function over the snapshot; cached by `setInstallCapabilities`.
 *  Empty categories drop out so the prompt stays bounded. */
export function renderInstallCapabilities(snap: InstallCapabilities): string {
  const meta: string[] = [];
  if (snap.agentGroupName) meta.push(`agent_group_name: ${snap.agentGroupName}`);
  if (snap.agentGroupId) meta.push(`agent_group_id: ${snap.agentGroupId}`);

  const parts: string[] = [];
  parts.push(`<capabilities>`);
  parts.push(
    `Authoritative list of what THIS install of Pat — this agent group, on this host — can actually do. Resolved once per agent group from the live install state (channels wired, MCP tools mounted, container skills present, container.json contents). Use this to:`,
  );
  parts.push(
    `- Calibrate confidence on "can you X?" / "do you have access to Y?" questions. Listed = lean optimistic ("yeah I think so, lemme double-check"). Not listed = lean uncertain ("hmm, not sure, lemme check"). Either way the back-mind answers; you set expectation.`,
  );
  parts.push(
    `- Never hallucinate a capability that isn't listed. If a category below is missing, that capability is NOT wired into this install today.`,
  );
  parts.push(
    `- For caller identity ("who am I talking to right now") and recipient disambiguation ("send to the Signal ending in 4959"), see the <caller_context> block in the user message. This install block is stable across inbounds; caller context varies per inbound.`,
  );
  if (meta.length > 0) {
    parts.push('');
    parts.push(meta.join('\n'));
  }
  parts.push(`</capabilities>`);

  // The install-side capability sections — emitted in the taxonomy
  // order from plans/one-flow-well.md. Empty categories drop out so
  // the prompt stays bounded.
  const channels = renderChannels(snap.channels);
  if (channels) parts.push('\n' + channels);

  for (const [tag, entries] of [
    ['container_mcp_tools', snap.containerMcpTools],
    ['container_skills', snap.containerSkills],
    ['sdk_tools', snap.sdkTools],
    ['in_tree_primitives', snap.inTreePrimitives],
    ['external_mcp_servers', snap.externalMcpServers],
    ['host_verbs', snap.hostVerbs],
  ] as const) {
    const block = renderCategory(tag, entries);
    if (block) parts.push('\n' + block);
  }

  return parts.join('\n');
}

/** Stub install-capabilities block — used when no snapshot has been
 *  registered for the requested agent group. Keeps the prompt anchor
 *  stable so the front-mind always has SOMETHING to read; pushes
 *  capability questions to the back-mind. */
export function stubInstallCapabilitiesBlock(): string {
  return [
    `<capabilities>`,
    `(no install capability snapshot registered for this agent group — running with empty surface; defer all "can you X?" questions to the back-mind for an authoritative answer.)`,
    `</capabilities>`,
  ].join('\n');
}

/** Render the per-inbound caller context block — caller identity,
 *  known handles, permissions. Returns the stub-string when ctx is
 *  null so prompts always have an anchor; empty when ctx is null AND
 *  the caller didn't supply any sub-fields. */
export function renderCallerContext(ctx: CallerContext | null | undefined): string {
  if (!ctx) {
    return [
      `<caller_context>`,
      `(no live caller context threaded — running without a resolved caller; defer recipient / permissions questions to the back-mind.)`,
      `</caller_context>`,
    ].join('\n');
  }

  const parts: string[] = [];
  parts.push(`<caller_context>`);
  parts.push(
    `Live per-inbound context for the human currently speaking. Use to disambiguate recipients ("the Signal ending in 4959" → pick from <known_handles>), gauge what the caller is allowed to authorize (<permissions>), and address them correctly (<caller>). Varies per inbound; the <capabilities> block in SYSTEM is the install-wide surface.`,
  );
  if (ctx.agentGroupId) {
    parts.push('');
    parts.push(`agent_group_id: ${ctx.agentGroupId}`);
  }
  parts.push(`</caller_context>`);

  const caller = renderCaller(ctx.caller);
  if (caller) parts.push('\n' + caller);
  const known = renderKnownHandles(ctx.knownHandles);
  if (known) parts.push('\n' + known);
  const perms = renderPermissions(ctx.permissions);
  if (perms) parts.push('\n' + perms);

  return parts.join('\n');
}

// ─────────────────── Install-capabilities cache (per agent group) ─────────

/** Cache entry: the resolved snapshot AND the rendered markdown block.
 *  We store both so `setInstallCapabilities` can be called eagerly with
 *  a snapshot, and `getInstallCapabilitiesBlock` returns the pre-rendered
 *  string with no per-lookup work. */
interface InstallCacheEntry {
  snapshot: InstallCapabilities;
  rendered: string;
}

const installCacheByAgentGroup = new Map<string, InstallCacheEntry>();

/** Register the install-capabilities snapshot for an agent group. Called
 *  at boot (host walks `agent_groups`, calls this per group) and at
 *  provision time (when a new agent group is created). Replaces any
 *  prior entry for the same id.
 *
 *  Rendering happens here, not at lookup time, so the cost is paid once
 *  and `getInstallCapabilitiesBlock` is a Map.get(). */
export function setInstallCapabilities(agentGroupId: string, snapshot: InstallCapabilities): void {
  installCacheByAgentGroup.set(agentGroupId, {
    snapshot,
    rendered: renderInstallCapabilities(snapshot),
  });
}

/** Get the rendered install-capabilities block for an agent group.
 *  Returns the stub block when no snapshot has been registered for the
 *  requested id — keeps the prompt anchor stable in dev / tests / before
 *  the host has run its boot-time hook. */
export function getInstallCapabilitiesBlock(agentGroupId: string | null | undefined): string {
  if (!agentGroupId) return stubInstallCapabilitiesBlock();
  const entry = installCacheByAgentGroup.get(agentGroupId);
  return entry ? entry.rendered : stubInstallCapabilitiesBlock();
}

/** Read the raw snapshot for an agent group, if registered. Exposed for
 *  the structured-log emit + smoketests that want to inspect the
 *  resolved surface directly (vs the rendered markdown). */
export function getInstallCapabilities(agentGroupId: string | null | undefined): InstallCapabilities | null {
  if (!agentGroupId) return null;
  const entry = installCacheByAgentGroup.get(agentGroupId);
  return entry ? entry.snapshot : null;
}

/** Drop a registered snapshot. Mostly for tests; production lifecycle is
 *  set-at-boot + replace-on-provision, no explicit delete. */
export function clearInstallCapabilities(agentGroupId?: string): void {
  if (agentGroupId === undefined) {
    installCacheByAgentGroup.clear();
    return;
  }
  installCacheByAgentGroup.delete(agentGroupId);
}

/** List agent group ids that currently have a cached snapshot. Useful
 *  for the boot-time emit loop and for forensics. */
export function listRegisteredAgentGroups(): string[] {
  return Array.from(installCacheByAgentGroup.keys());
}
