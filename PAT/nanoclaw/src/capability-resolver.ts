/**
 * PAT: Host-side capability resolvers — split into install-state vs
 * per-inbound caller context (TaskList #8).
 *
 *  - `buildInstallCapabilities({ agentGroupId })` returns the install
 *    surface (channels, MCP tools, skills, sdk tools, slash commands,
 *    host verbs, in-tree primitives, external MCP servers,
 *    container.json). Resolved ONCE per agent group at boot (and at
 *    agent-group provision time when a new group is added at
 *    runtime). The host then calls `setInstallCapabilities(agentGroupId,
 *    snapshot)` to seed the realtime library's process-local cache.
 *    Each front-mind prompt looks up the rendered install block via
 *    `getInstallCapabilitiesBlock(agentGroupId)` and prepends it to
 *    SYSTEM — which keeps SYSTEM cacheable across inbounds.
 *
 *  - `createCallerContextResolver({ channelType })` returns a per-
 *    inbound resolver wired into `ChannelOrchestrator.callerContextResolver`.
 *    Called per inbound (and per rendition) with the caller's senderId.
 *    Returns the `CallerContext` block — caller identity + suffix-
 *    matched known handles + permissions — that lands in the USER
 *    message via the prompt's `render()`.
 *
 * Why this file exists
 * --------------------
 * The capability surface (channels, MCP tools, skills, caller identity,
 * known handles, permissions) is *resolved* host-side because that's
 * where DB access, the channel registry, and `groups/<folder>/container.json`
 * live. The library defines the shape and renders the prompts; this
 * file derives the inputs.
 *
 * Determinism
 * -----------
 * Pure DB reads + filesystem reads. No model calls. No network.
 * Tolerant of missing rows (returns the partial snapshot — renderer
 * drops empty categories). Throws never propagate to the caller boot
 * loop (which wraps + swallows) or to the orchestrator's per-inbound
 * resolve (which also wraps + swallows).
 */
import fs from 'fs';
import path from 'path';

import type {
  CallerContext,
  CallerContextResolver,
  CallerIdentity,
  CapabilityEntry,
  ChannelCapability,
  InstallCapabilities,
  KnownHandle,
  PermissionsSurface,
} from '@agentic-toolkit/realtime';

import { GROUPS_DIR } from './config.js';

/** Path to the on-disk container/skills/ catalog. Computed from
 *  `GROUPS_DIR`'s sibling — keeps the resolver independent of `cwd`
 *  while still pointing at the repo's container tree. */
const CONTAINER_SKILLS_DIR = path.resolve(GROUPS_DIR, '..', 'container', 'skills');
import { configFromDb } from './container-config.js';
import { getContainerConfig } from './db/container-configs.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getMessagingGroupAgents, getMessagingGroupByPlatform } from './db/messaging-groups.js';
import { getAllUsers, getUser } from './modules/permissions/db/users.js';
import { getUserDmsForUser } from './modules/permissions/db/user-dms.js';
import { getUserRoles, isGlobalAdmin, isOwner } from './modules/permissions/db/user-roles.js';
import { getRegisteredChannelNames } from './channels/channel-registry.js';

// ─────────────────────────── Static catalogs ─────────────────────────

/** Per-channel-type message shapes. Hand-maintained; mirrors what each
 *  adapter's `deliver()` actually supports. Keys are channel_type strings
 *  (what `getRegisteredChannelNames()` returns). */
const CHANNEL_SHAPES: Record<string, readonly string[]> = {
  signal: ['text', 'file', 'voice-memo', 'reaction', 'edit'],
  slack: ['text', 'file', 'card', 'reaction', 'edit'],
  'phone-call': ['text'],
  'anam-web': ['text'],
  telegram: ['text', 'file', 'card', 'reaction', 'edit'],
  whatsapp: ['text', 'file', 'voice-memo', 'reaction'],
  discord: ['text', 'file', 'reaction', 'edit'],
  imessage: ['text', 'file', 'reaction'],
  teams: ['text', 'card', 'edit'],
  webex: ['text', 'card'],
  linear: ['text'],
  github: ['text'],
  gchat: ['text', 'card'],
  resend: ['text'],
  matrix: ['text', 'file', 'reaction', 'edit'],
  'whatsapp-cloud': ['text', 'file', 'reaction'],
  deltachat: ['text', 'file'],
};

/** Container-side MCP tools the back-mind can call. Mirrors the imports
 *  in `nanoclaw/container/agent-runner/src/mcp-tools/index.ts`. */
const CONTAINER_MCP_TOOLS: readonly CapabilityEntry[] = [
  { name: 'send_message', summary: 'Send a message on any wired destination (warm or cold E.164).' },
  { name: 'send_file', summary: 'Send a file attachment on a destination that supports files.' },
  { name: 'edit_message', summary: 'Edit a previously-sent message in place.' },
  { name: 'add_reaction', summary: 'React to a message with an emoji.' },
  { name: 'send_voice_memo', summary: 'Cartesia-TTS a script and deliver as a native voice memo (Signal).' },
  { name: 'schedule_task', summary: 'Schedule a one-shot or recurring task; cron in user timezone.' },
  { name: 'list_tasks', summary: 'List scheduled tasks for this agent group.' },
  { name: 'cancel_task', summary: 'Cancel a scheduled task.' },
  { name: 'pause_task', summary: 'Pause a recurring task without deleting it.' },
  { name: 'resume_task', summary: 'Resume a paused recurring task.' },
  { name: 'update_task', summary: 'Update prompt/schedule of an existing scheduled task.' },
  { name: 'ask_user_question', summary: 'Pose a structured question to a human and wait for the reply.' },
  { name: 'send_card', summary: 'Send a rich card payload on adapters that support cards.' },
  { name: 'create_agent', summary: 'Spawn a new agent group from a CLAUDE.md spec.', flags: ['admin-only'] },
  {
    name: 'install_packages',
    summary: "Install apt/npm packages into this group's container.",
    flags: ['admin-only', 'approval-gated'],
  },
  {
    name: 'add_mcp_server',
    summary: 'Wire a new MCP server into container.json.',
    flags: ['admin-only', 'approval-gated'],
  },
  { name: 'start_presentation', summary: 'Begin a packet-driven slide presentation (scenario mode).' },
  { name: 'end_presentation', summary: 'End the active presentation and tear down deck state.' },
  { name: 'present_advance', summary: 'Advance the deck to a specific 1-indexed slide.' },
  { name: 'present_resume', summary: 'Resume a presentation at a specific slide after interruption.' },
  { name: 'present_get_slide', summary: 'Read the YAML + notes for a specific slide.' },
  { name: 'present_inject_slide', summary: 'Inject an ad-hoc slide into the active deck.' },
];

/** Claude Agent SDK tools the back-mind has by default. */
const SDK_TOOLS: readonly CapabilityEntry[] = [
  { name: 'Read', summary: 'Read a file from the workspace or mounted paths.' },
  { name: 'Edit', summary: 'Edit a file in place with exact string replacement.' },
  { name: 'Write', summary: 'Write or overwrite a file.' },
  { name: 'Bash', summary: 'Run shell commands inside the container.' },
  { name: 'Glob', summary: 'List files matching a glob pattern.' },
  { name: 'Grep', summary: 'Search file contents with ripgrep semantics.' },
  { name: 'WebFetch', summary: 'Fetch a URL and read its content.' },
  { name: 'WebSearch', summary: 'Search the web.' },
  { name: 'Task', summary: 'Spawn a subagent thread for a focused task.' },
  { name: 'TodoWrite', summary: 'Maintain a structured task list for the current thread.' },
];

/** Affordances the host owns — not back-mind-callable, but the
 *  front-mind should know they exist so it can answer accurately. */
const HOST_VERBS: readonly CapabilityEntry[] = [
  { name: 'barge-in', summary: 'User interrupt cancels in-flight back-mind work + TTS.' },
  { name: 'narration', summary: 'Cadence-driven filler from the narration brain while back-mind runs.' },
  { name: 'scenario-dispatch', summary: 'Tag-stream presentations (slide-nav, fragments, verbatim splices).' },
  { name: 'multi-context-rendition', summary: 'Merges back-to-back chat rows into one coherent utterance.' },
];

// PAT: slash_commands catalog removed from install-caps render — front-mind
// never narrates/acks about slash commands (admin operator surface). Back-mind
// owns slash-command knowledge; gating still lives in command-gate.ts + the
// ADMIN_GATED_VERBS list below.

/** In-tree primitives — TypeScript helpers / CLIs the back-mind can
 *  shell out to. Distinct from container skills (which carry SKILL.md
 *  instructions) and from MCP tools (which are JSON-RPC primitives). */
const IN_TREE_PRIMITIVES: readonly CapabilityEntry[] = [
  { name: 'agent-browser', summary: 'CLI Chromium for fetching JS-rendered pages.' },
  { name: 'pat-trace.py', summary: "Pull a call's structured log + render an interrupt-aware timeline." },
];

// ─────────────────────────── Helpers ───────────────────────────

/** Extract an E.164 suffix from a `<channel>:+E164` platform id, or
 *  return null if the handle isn't phone-bearing. Used for the
 *  suffix-match known-handles list (plans/one-flow-well.md §5). */
function extractE164(platformId: string): string | null {
  // Anam-web ids are `anam-web:<uuid>`; phone ids are `pstn:+E164`,
  // signal `signal:+E164`, whatsapp `whatsapp:+E164`, etc. We accept
  // any `<channel>:+<digits>` shape; reject anything else.
  const idx = platformId.indexOf(':');
  if (idx < 0) return null;
  const handle = platformId.slice(idx + 1);
  if (!handle.startsWith('+')) return null;
  const digits = handle.slice(1);
  if (!/^\d+$/.test(digits)) return null;
  return handle; // includes the '+' for downstream display
}

/** Last 4 characters of a handle. For phone handles strip non-digits
 *  first so `+15550100000` → `4959`; otherwise just slice the raw
 *  string so `anam-web:abc12345` → `2345`. */
function lastFour(handle: string): string {
  const digits = handle.replace(/[^0-9]/g, '');
  if (digits.length >= 4) return digits.slice(-4);
  return handle.slice(-4);
}

/** Map a channel_type prefix to the platform_id namespace it occupies
 *  (mostly identity today; carve-out for clarity). */
function channelOfPlatformId(platformId: string): string {
  const idx = platformId.indexOf(':');
  if (idx < 0) return platformId;
  return platformId.slice(0, idx);
}

/** Resolve the caller's role against this agent group. Owner > global
 *  admin > member > unknown. We don't yet check
 *  agent_group_members for plain "member" status — the absence of any
 *  role on a known user maps to 'member', missing user to 'unknown'. */
function resolveCallerRole(senderId: string, agentGroupId: string | null): 'owner' | 'admin' | 'member' | 'unknown' {
  const user = getUser(senderId);
  if (!user) return 'unknown';
  if (isOwner(senderId)) return 'owner';
  if (isGlobalAdmin(senderId)) return 'admin';
  if (agentGroupId) {
    const roles = getUserRoles(senderId);
    for (const r of roles) {
      if (r.role === 'admin' && r.agent_group_id === agentGroupId) return 'admin';
    }
  }
  return 'member';
}

/** Verbs the caller can invoke that require admin (or owner) privilege.
 *  Mirrors the `admin-only` flags on container MCP tools above. */
const ADMIN_GATED_VERBS: readonly string[] = [
  'install_packages',
  'add_mcp_server',
  'create_agent',
  '/clear',
  '/compact',
  '/context',
  '/cost',
  '/files',
];

function permissionsForCaller(role: 'owner' | 'admin' | 'member' | 'unknown'): PermissionsSurface {
  if (role === 'owner' || role === 'admin') {
    return { callerRole: role, callerVerbs: ADMIN_GATED_VERBS };
  }
  return { callerRole: role, approvalGatedVerbs: ADMIN_GATED_VERBS };
}

/** Build the channels list. Pulls registered names from the channel
 *  registry and decorates each with the supported message shapes from
 *  the static map. Unknown channel types render with no `shapes`. */
function buildChannels(): ChannelCapability[] {
  const names = getRegisteredChannelNames();
  return names.map((type) => {
    const shapes = CHANNEL_SHAPES[type];
    return shapes ? { type, shapes } : { type };
  });
}

/** Read container.json for the given agent-group folder and return
 *  (a) MCP servers as capability entries and (b) skills filtered
 *  against the on-disk catalog. */
function containerSurface(agentGroupId: string): {
  externalMcpServers: CapabilityEntry[];
  containerSkills: CapabilityEntry[];
} {
  // upstream v2.1.19 moved container config from groups/<folder>/container.json
  // to the central DB (container-config-to-db). Read the row + materialize the
  // typed config in-memory; degrade gracefully to empty if no row exists.
  const group = getAgentGroup(agentGroupId);
  const row = group ? getContainerConfig(agentGroupId) : null;
  const cfg = row && group ? configFromDb(row, group) : null;
  const mcpServers = cfg?.mcpServers ?? {};
  const externalMcpServers: CapabilityEntry[] = Object.entries(mcpServers).map(([name, server]) => {
    const transport = (server as { transport?: string }).transport ?? 'stdio';
    return { name, summary: `external MCP server (${transport})` };
  });

  const containerSkills: CapabilityEntry[] = [];
  const skillsRoot = CONTAINER_SKILLS_DIR;
  let installed: string[] = [];
  try {
    if (fs.existsSync(skillsRoot)) {
      installed = fs
        .readdirSync(skillsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    }
  } catch {
    // Best-effort — missing dir or perms issue just yields an empty list.
  }
  const enabledNames: string[] = !cfg || cfg.skills === 'all' || cfg.skills === undefined ? installed : cfg.skills;
  for (const name of enabledNames) {
    if (!installed.includes(name)) continue; // skip skills not actually present
    containerSkills.push({ name });
  }
  return { externalMcpServers, containerSkills };
}

/** Compute the known-handles list for the human behind `senderId`.
 *  Suffix-match heuristic (plans/one-flow-well.md §5) over the central
 *  `users` table — any user whose id has the same E.164 suffix as the
 *  caller's is treated as the same human. Phone-bearing only;
 *  non-phone senders return []. */
function computeKnownHandles(senderId: string): KnownHandle[] {
  const callerE164 = extractE164(senderId);
  if (!callerE164) return [];
  const out: KnownHandle[] = [];
  const seen = new Set<string>();
  const users = getAllUsers();
  for (const u of users) {
    const otherE164 = extractE164(u.id);
    if (!otherE164) continue;
    if (otherE164 !== callerE164) continue;
    if (seen.has(u.id)) continue;
    seen.add(u.id);
    out.push({
      platformId: u.id,
      channelType: channelOfPlatformId(u.id),
      label: u.display_name ?? null,
      suffix: lastFour(otherE164),
      isCurrentCaller: u.id === senderId,
    });
  }
  // Also surface the caller's own handle when it exists only in the
  // user_dms cache — the cold-DM resolution path can populate user_dms
  // before any users row is upserted, and the suffix-match loop above
  // only sees users rows.
  if (senderId && !seen.has(senderId)) {
    try {
      const dms = getUserDmsForUser(senderId);
      if (dms.length > 0) {
        seen.add(senderId);
        out.push({
          platformId: senderId,
          channelType: channelOfPlatformId(senderId),
          label: null,
          suffix: lastFour(callerE164),
          isCurrentCaller: true,
        });
      }
    } catch {
      // user_dms table may not exist in older installs; ignore.
    }
  }
  return out;
}

// ─────────────────────── Install capabilities (per agent group) ──────────

/** Build the install-side capability snapshot for one agent group.
 *  Called at host boot (per row in `agent_groups`) and at provision
 *  time when a new agent group is created. Pure DB + filesystem reads;
 *  no per-inbound state. Tolerant of missing folder / container.json
 *  — returns the partial snapshot (renderer drops empty categories).
 *
 *  The host wires this into the realtime library via
 *  `setInstallCapabilities(agentGroupId, snapshot)`. Per-prompt lookup
 *  goes through `getInstallCapabilitiesBlock(agentGroupId)` inside the
 *  prompt's `render()`. */
export function buildInstallCapabilities(args: { agentGroupId: string }): InstallCapabilities {
  const ag = getAgentGroup(args.agentGroupId);
  const folder = ag?.folder ?? null;

  let externalMcpServers: CapabilityEntry[] = [];
  let containerSkills: CapabilityEntry[] = [];
  if (folder) {
    const surface = containerSurface(args.agentGroupId);
    externalMcpServers = surface.externalMcpServers;
    containerSkills = surface.containerSkills;
  }

  return {
    agentGroupId: args.agentGroupId,
    agentGroupName: ag?.name ?? undefined,
    channels: buildChannels(),
    containerMcpTools: CONTAINER_MCP_TOOLS,
    containerSkills,
    sdkTools: SDK_TOOLS,
    inTreePrimitives: IN_TREE_PRIMITIVES,
    externalMcpServers,
    hostVerbs: HOST_VERBS,
  };
}

// ─────────────────────── Caller context (per inbound) ────────────────────

/** Build the per-inbound caller-context snapshot. Used by the
 *  orchestrator's resolver to render the `<caller>` + `<known_handles>`
 *  + `<permissions>` block into the USER message of every front-mind
 *  call site. Varies per inbound (different callers in the same agent
 *  group have different roles + handles). */
export function buildCallerContext(args: { agentGroupId: string; senderId: string }): CallerContext {
  const { agentGroupId, senderId } = args;

  const callerRole = resolveCallerRole(senderId, agentGroupId);
  const callerUser = getUser(senderId);
  const callerE164 = extractE164(senderId);

  const caller: CallerIdentity = {
    platformId: senderId,
    channelType: channelOfPlatformId(senderId),
    displayName: callerUser?.display_name ?? null,
    role: callerRole,
    suffix: callerE164 ? lastFour(callerE164) : lastFour(senderId),
  };

  const knownHandles = computeKnownHandles(senderId);

  return {
    agentGroupId,
    caller,
    knownHandles,
    permissions: permissionsForCaller(callerRole),
  };
}

/** Resolve the agent_group_id wired to (channel_type, platform_id). One
 *  mg may have multiple agents; we pick the highest-priority one (the
 *  ones the router would dispatch to first). Returns null when there's
 *  no mg or no wired agent. Exported because the channel adapter needs
 *  it for the `agentGroupId` arg on `handleUserMessage` / `deliverChat`. */
export function resolveAgentGroupForPlatform(
  channelType: string,
  platformId: string,
): { agentGroupId: string; agentGroupName: string | null; folder: string | null } | null {
  const mg = getMessagingGroupByPlatform(channelType, platformId);
  if (!mg) return null;
  const mgas = getMessagingGroupAgents(mg.id);
  if (mgas.length === 0) return null;
  const top = mgas.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0]!;
  const ag = getAgentGroup(top.agent_group_id);
  return {
    agentGroupId: top.agent_group_id,
    agentGroupName: ag?.name ?? null,
    folder: ag?.folder ?? null,
  };
}

// ─────────────────────────── Public resolver factory ─────────────────────

/** Build the per-inbound caller-context resolver passed to
 *  `ChannelOrchestrator` as `callerContextResolver`. Constructed once
 *  at adapter startup; called per inbound + per rendition with the
 *  caller's senderId.
 *
 *  Install-side capabilities are NOT resolved here — they live in the
 *  realtime library's process-local cache, populated at boot via
 *  `setInstallCapabilities` (see `buildInstallCapabilities` above). */
export function createCallerContextResolver(_opts: { channelType: string }): CallerContextResolver {
  return async ({ agentGroupId, senderId }) => {
    return buildCallerContext({ agentGroupId, senderId });
  };
}
