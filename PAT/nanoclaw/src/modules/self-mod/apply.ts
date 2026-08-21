/**
 * Approval handlers for self-modification actions.
 *
 * The approvals module calls these when an admin clicks Approve on a
 * pending_approvals row whose action matches. Each handler mutates the
 * container config in the DB, rebuilds/kills the container as needed,
 * and writes an on_wake message so the fresh container picks up where
 * the old one left off.
 *
 * install_packages: update DB + rebuild image + kill container + on_wake.
 * add_mcp_server: update DB + kill container + on_wake.
 */
import { buildAgentGroupImage, killContainer, wakeContainer } from '../../container-runner.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import { listCredentialRoutes, upsertCredentialRoute } from '../../db/credential-routing.js';
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { ApprovalHandler } from '../approvals/index.js';
// PAT: credential-gated activation — an approved MCP whose credential isn't in
// the vault yet is parked (pending_mcp_activations) instead of wired into a
// container that would 401 at its MCP handshake and stay dead. The watcher
// activates it the moment the credential exists. See
// plans/mcp-management.md §"Credential-gated activation".
import { buildMcpServerEntry, enqueuePendingActivation, writeMcpServerToConfig } from '../credentials/activation.js';
import { credentialAvailableForHost } from '../credentials/sources.js';
import { vaultConfigured } from '../credentials/onecli-vault.js';
import { kickCredentialWatcher } from '../credentials/watcher.js';

export const applyInstallPackages: ApprovalHandler = async ({ session, payload, userId, notify }) => {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notify('install_packages approved but agent group missing.');
    return;
  }

  const configRow = getContainerConfig(agentGroup.id);
  if (!configRow) {
    notify('install_packages approved but container config missing.');
    return;
  }

  // Append new packages to existing lists in the DB (deduplicated)
  if (payload.apt) {
    const existing = JSON.parse(configRow.packages_apt) as string[];
    for (const pkg of payload.apt as string[]) {
      if (!existing.includes(pkg)) existing.push(pkg);
    }
    updateContainerConfigJson(agentGroup.id, 'packages_apt', existing);
  }
  if (payload.npm) {
    const existing = JSON.parse(configRow.packages_npm) as string[];
    for (const pkg of payload.npm as string[]) {
      if (!existing.includes(pkg)) existing.push(pkg);
    }
    updateContainerConfigJson(agentGroup.id, 'packages_npm', existing);
  }

  const pkgs = [
    ...((payload.apt as string[] | undefined) || []),
    ...((payload.npm as string[] | undefined) || []),
  ].join(', ');
  log.info('Package install approved', { agentGroupId: session.agent_group_id, userId });
  try {
    await buildAgentGroupImage(session.agent_group_id);
    writeSessionMessage(session.agent_group_id, session.id, {
      id: `appr-note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({
        text: `Packages installed (${pkgs}) and container rebuilt. Verify the new packages are available (e.g. run them or check versions) and report the result to the user.`,
        sender: 'system',
        senderId: 'system',
      }),
      onWake: 1,
    });
    killContainer(session.id, 'rebuild applied', () => {
      const s = getSession(session.id);
      if (s) wakeContainer(s);
    });
    log.info('Container rebuild completed (bundled with install)', { agentGroupId: session.agent_group_id });
  } catch (e) {
    notify(
      `Packages added to config (${pkgs}) but rebuild failed: ${e instanceof Error ? e.message : String(e)}. Tell the user — an admin will need to retry the install_packages request or inspect the build logs.`,
    );
    log.error('Bundled rebuild failed after install approval', { agentGroupId: session.agent_group_id, err: e });
  }
};

export const applyAddMcpServer: ApprovalHandler = async ({ session, payload, userId, notify }) => {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notify('add_mcp_server approved but agent group missing.');
    return;
  }

  const configRow = getContainerConfig(agentGroup.id);
  if (!configRow) {
    notify('add_mcp_server approved but container config missing.');
    return;
  }

  const name = payload.name as string;
  const isHttp = payload.transport === 'http' || !!payload.url;
  const secretName = payload.secret_name as string | undefined;

  if (isHttp && secretName) {
    const authHeader = (payload.auth_header as string) || 'Authorization';
    let hostPattern = '';
    try {
      hostPattern = new URL(payload.url as string).host;
    } catch {
      hostPattern = '';
    }
    if (hostPattern) {
      // PAT (security): a credential may only inject toward ONE host. Reject
      // if this secret_name is already routed to a DIFFERENT host — otherwise an
      // add_mcp_server could bind an existing credential (e.g. the Folk key) to an
      // attacker host under a new route name, OR silently repoint a legit route,
      // and boot-reconcile would inject the real value there. Egress lockdown does
      // not help (the gateway is the sender). Rebinding a credential to a new host
      // is a deliberate operator CLI action, not agent-approvable.
      const rebind = secretName
        ? listCredentialRoutes().find((r) => r.secret_name === secretName && r.host_pattern !== hostPattern)
        : undefined;
      if (rebind) {
        notify(
          `add_mcp_server "${name}" refused: credential AGENT_${secretName} is already bound to ` +
            `host ${rebind.host_pattern} (route "${rebind.name}"). A credential can only inject toward ` +
            `one host; pointing it at ${hostPattern} would let it be sent elsewhere. If this is truly ` +
            `intended, an operator must change the routing via the CLI.`,
        );
        log.warn('add_mcp_server refused: credential rebind to a new host ', {
          agentGroupId: session.agent_group_id,
          name,
          secretName,
          requestedHost: hostPattern,
          existingHost: rebind.host_pattern,
          existingRoute: rebind.name,
        });
        return;
      }
      // One-call routing: register the vault injection for this server's host so
      // the real key (added out-of-band as AGENT_<secret_name>) is injected at
      // egress. Declared intent — written whether or not the value exists yet.
      upsertCredentialRoute({
        name, // MCP server name doubles as the vault entry name
        host_pattern: hostPattern,
        header_name: authHeader,
        value_format: (payload.auth_format as string) || 'Bearer {value}',
        type: 'generic',
        secret_name: secretName,
      });
      log.info('credential route registered for MCP', { name, host: hostPattern, secret: secretName });

      // PAT: credential-gated activation. If the credential isn't in the vault
      // yet, park the MCP instead of wiring it — a fresh container would 401 at
      // its MCP handshake and the failed server stays dead for the container's
      // life (one long-lived SDK query, no handshake retry). The watcher
      // activates + respawns the moment the credential exists. On a vault
      // error, fall through to immediate wiring (behave like before).
      let available = true;
      if (vaultConfigured()) {
        try {
          available = await credentialAvailableForHost(hostPattern);
        } catch (err) {
          log.warn('add_mcp_server: vault presence check failed — wiring immediately', { name, err });
        }
      }
      if (!available) {
        enqueuePendingActivation({ session, name, payload, hostPattern, secretName });
        kickCredentialWatcher();
        notify(
          `MCP server "${name}" approved and queued. Its credential isn't in the vault yet — ` +
            `once \`AGENT_${secretName}\` is added it will activate automatically (I'm checking for it). ` +
            `Tell the user the add succeeded and what you're waiting on.`,
        );
        log.info('MCP server add parked pending credential', {
          agentGroupId: session.agent_group_id,
          name,
          host: hostPattern,
          userId,
        });
        return;
      }
    } else {
      notify(`add_mcp_server "${name}": could not parse host from url — MCP wired but no credential route created.`);
    }
  }

  writeMcpServerToConfig(agentGroup.id, name, buildMcpServerEntry(payload));

  writeSessionMessage(session.agent_group_id, session.id, {
    id: `appr-note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({
      text: `MCP server "${payload.name}" added. Verify it's available (e.g. list your tools) and report the result to the user.`,
      sender: 'system',
      senderId: 'system',
    }),
    onWake: 1,
  });
  killContainer(session.id, 'mcp server added', () => {
    const s = getSession(session.id);
    if (s) wakeContainer(s);
  });
  log.info('MCP server add approved', { agentGroupId: session.agent_group_id, userId });
};
