/**
 * PAT: credential-gated MCP activation — the "activate" half of the
 * request → watch → activate flow (plans/mcp-management.md §"Credential-gated
 * activation").
 *
 * An approved add_mcp_server whose credential isn't in the vault yet is
 * parked in pending_mcp_activations by the approval handler (self-mod/
 * apply.ts) instead of being wired into a container that would 401 at its
 * MCP handshake and stay dead (the agent-runner holds one long-lived SDK
 * query — no handshake retry; see plans/credential-activation-implementation.md
 * Step 0 result). When the credential watcher sees the credential exist, it
 * calls activatePendingMcp(): write the config entry, then the same
 * onWake-message + kill/respawn sequence applyAddMcpServer uses, so the fresh
 * container handshakes WITH the credential present.
 *
 * buildMcpServerEntry / writeMcpServerToConfig are shared with apply.ts so
 * the parked payload activates byte-identically to the immediate path.
 */
import type { McpServerConfig } from '../../container-config.js';
import { isContainerRunning, killContainer, wakeContainer } from '../../container-runner.js';
import { getContainerConfig, getAllContainerConfigs, updateContainerConfigJson } from '../../db/container-configs.js';
import {
  deletePendingMcpActivation,
  upsertPendingMcpActivation,
  type PendingMcpActivation,
} from '../../db/pending-mcp-activations.js';
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';

/** Non-empty placeholder for an authed remote MCP's header: the http client
 *  sends it, and the OneCLI vault overwrites it with the real key at egress
 *  by host-match. The real key is never in the DB or container env. */
export const VAULT_PLACEHOLDER = 'onecli-gateway-managed';

/** How long the watcher polls fast (~4s) before dropping to idle cadence. */
export const FAST_WINDOW_MS = 5 * 60_000;

/** Build the mcp_servers config entry from an add_mcp_server approval
 *  payload. http (remote) vs stdio is discriminated by transport/url. */
export function buildMcpServerEntry(payload: Record<string, unknown>): McpServerConfig {
  const isHttp = payload.transport === 'http' || !!payload.url;
  if (isHttp) {
    const authHeader = (payload.auth_header as string) || 'Authorization';
    return {
      transport: 'http',
      url: payload.url as string,
      // With a secret_name the auth header is a placeholder the vault
      // overwrites; otherwise honor whatever headers the caller passed.
      headers: payload.secret_name
        ? { [authHeader]: VAULT_PLACEHOLDER }
        : (payload.headers as Record<string, string>) || {},
    };
  }
  return {
    command: payload.command as string,
    args: (payload.args as string[]) || [],
    env: (payload.env as Record<string, string>) || {},
  };
}

/** Merge one server entry into the group's mcp_servers JSON. Returns false
 *  when the group has no container config row. */
export function writeMcpServerToConfig(agentGroupId: string, name: string, entry: McpServerConfig): boolean {
  const configRow = getContainerConfig(agentGroupId);
  if (!configRow) return false;
  const servers = JSON.parse(configRow.mcp_servers) as Record<string, McpServerConfig>;
  servers[name] = entry;
  updateContainerConfigJson(agentGroupId, 'mcp_servers', servers);
  return true;
}

/** Agent groups whose live (non-tombstoned) http MCP entries point at this
 *  host. Used to answer "who is affected by this credential". */
export function groupsUsingHost(hostPattern: string): string[] {
  if (!hostPattern) return [];
  const out: string[] = [];
  for (const row of getAllContainerConfigs()) {
    let servers: Record<string, McpServerConfig>;
    try {
      servers = JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>;
    } catch {
      continue;
    }
    for (const entry of Object.values(servers)) {
      if (entry.deleted) continue;
      if (!('url' in entry) || !entry.url) continue;
      try {
        if (new URL(entry.url).host === hostPattern) {
          out.push(row.agent_group_id);
          break;
        }
      } catch {
        // unparseable url — skip entry
      }
    }
  }
  return out;
}

/** Park an approved MCP until its credential exists. Caller (apply.ts) kicks
 *  the watcher after this so the first check happens immediately. */
export function enqueuePendingActivation(args: {
  session: Session;
  name: string;
  payload: Record<string, unknown>;
  hostPattern: string;
  secretName: string;
}): void {
  upsertPendingMcpActivation({
    agent_group_id: args.session.agent_group_id,
    name: args.name,
    session_id: args.session.id,
    payload: JSON.stringify(args.payload),
    host_pattern: args.hostPattern,
    secret_name: args.secretName,
    fast_deadline: new Date(Date.now() + FAST_WINDOW_MS).toISOString(),
  });
  log.event({
    kind: 'mcp.activation-pending',
    data: {
      name: args.name,
      host_pattern: args.hostPattern,
      secret_name: args.secretName,
      agent_group_id: args.session.agent_group_id,
    },
  });
}

/**
 * The credential exists — wire the parked MCP and respawn so the fresh
 * container's handshake finds it. Mirrors applyAddMcpServer's activation
 * sequence: config write → onWake:1 message (only a FRESH container's first
 * poll may consume it — dying containers skip on_wake rows) → kill + respawn
 * via onExit, or a plain wake when nothing is running.
 */
export async function activatePendingMcp(row: PendingMcpActivation): Promise<void> {
  const payload = JSON.parse(row.payload) as Record<string, unknown>;
  const wrote = writeMcpServerToConfig(row.agent_group_id, row.name, buildMcpServerEntry(payload));
  deletePendingMcpActivation(row.agent_group_id, row.name);
  const waitedMs = Date.now() - Date.parse(row.created_at);
  log.event({
    kind: 'mcp.activation-activated',
    session_id: row.session_id,
    data: {
      name: row.name,
      host_pattern: row.host_pattern,
      agent_group_id: row.agent_group_id,
      waited_ms: Number.isFinite(waitedMs) ? waitedMs : 0,
    },
  });
  if (!wrote) {
    log.warn('MCP activation: container config row missing — entry not written', {
      agentGroupId: row.agent_group_id,
      name: row.name,
    });
    return;
  }

  const session = getSession(row.session_id);
  if (!session) {
    // Session gone (closed/deleted) — the config is written; the group's next
    // container spawn picks it up. Nothing to notify.
    return;
  }
  writeSessionMessage(row.agent_group_id, session.id, {
    id: `mcp-act-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: row.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({
      text:
        `MCP server "${row.name}" is now active — its credential was added and the container restarted. ` +
        `Verify it's available (e.g. list your tools) and report the result to the user.`,
      sender: 'system',
      senderId: 'system',
    }),
    onWake: 1,
  });
  if (isContainerRunning(session.id)) {
    killContainer(session.id, 'mcp credential arrived', () => {
      const s = getSession(session.id);
      if (s) void wakeContainer(s);
    });
  } else {
    void wakeContainer(session);
  }
}
