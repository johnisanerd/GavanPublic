/**
 * NanoClaw — main entry point.
 *
 * Thin orchestrator: init DB, run migrations, start channel adapters,
 * start delivery polls, start sweep, handle shutdown.
 */
// PAT: HOST_ prefix router MUST be the first import — config.ts and the
// realtime library read process.env at module-import time, and ES module
// evaluation runs imports in source order. See env-prefix-router.ts.
import { prefixRouterResult } from './env-prefix-router.js';

import path from 'path';

import { setInstallCapabilities, setProviderFallbackHook } from '@agentic-toolkit/realtime';

import { buildInstallCapabilities } from './capability-resolver.js';
import { backfillContainerConfigs } from './backfill-container-configs.js';
import { DATA_DIR } from './config.js';
import { enforceStartupBackoff, resetCircuitBreaker } from './circuit-breaker.js';
import { migrateGroupsToClaudeLocal } from './claude-md-compose.js';
import { initDb, getDb } from './db/connection.js';
import { getAllAgentGroups } from './db/agent-groups.js';
import { runMigrations } from './db/migrations/index.js';
import { ensureContainerRuntimeRunning, cleanupOrphans } from './container-runtime.js';
import {
  startActiveDeliveryPoll,
  startSweepDeliveryPoll,
  setDeliveryAdapter,
  stopDeliveryPolls,
  registerColdContactApprovalHandler,
} from './delivery.js';
import { startHostSweep, stopHostSweep } from './host-sweep.js';
// PAT 2026-06-25: external Signal health probe. nanoclaw is the only observer
// off the signal-cli daemon machine, so it owns daemon-down + account-lapsed
// detection + admin alerting. See src/modules/signal-health/.
import { startSignalHealthProbe, stopSignalHealthProbe } from './modules/signal-health/index.js';
// PAT: credential reconcile (routing table → OneCLI vault, boot step 1d) and
// the credential watcher (activates approved MCPs parked on a missing
// credential). See plans/credential-activation-implementation.md.
import { reconcileCredentials } from './modules/credentials/reconcile.js';
import { startCredentialWatcher, stopCredentialWatcher } from './modules/credentials/watcher.js';
import { routeInbound } from './router.js';
import { log } from './log.js';
import { enforceUpgradeTripwire } from './upgrade-state.js';

// Response + shutdown registries live in response-registry.ts to break the
// circular import cycle: src/index.ts imports src/modules/index.js for side
// effects, and the modules call registerResponseHandler/onShutdown at top
// level — which would hit a TDZ error if the arrays lived here. Re-exported
// here so existing callers see the same surface.
import {
  registerResponseHandler,
  getResponseHandlers,
  onShutdown,
  getShutdownCallbacks,
  type ResponsePayload,
  type ResponseHandler,
} from './response-registry.js';
export { registerResponseHandler, onShutdown };
export type { ResponsePayload, ResponseHandler };

async function dispatchResponse(payload: ResponsePayload): Promise<void> {
  for (const handler of getResponseHandlers()) {
    try {
      const claimed = await handler(payload);
      if (claimed) return;
    } catch (err) {
      log.error('Response handler threw', { questionId: payload.questionId, err });
    }
  }
  log.warn('Unclaimed response', { questionId: payload.questionId, value: payload.value });
}

// Channel barrel — each enabled channel self-registers on import.
// Channel skills uncomment lines in channels/index.ts to enable them.
import './channels/index.js';

// Modules barrel — default modules (typing, mount-security) ship here; skills
// append registry-based modules. Imported for side effects (registrations).
import './modules/index.js';

// CLI command barrel — populates the `ncl` registry before the CLI server
// accepts connections.
import './cli/commands/index.js';
import './cli/delivery-action.js';
import './conversations/recall-action.js'; // PAT: conversation recall delivery action
import { startCliServer, stopCliServer } from './cli/socket-server.js';

import type { ChannelAdapter, ChannelSetup } from './channels/adapter.js';
import {
  initChannelAdapters,
  teardownChannelAdapters,
  createChannelDeliveryAdapter,
} from './channels/channel-registry.js';

async function main(): Promise<void> {
  log.info('NanoClaw starting');
  // PAT: summary of the HOST_ prefix routing that already ran at first-import
  // time (names only, never values). `shadowed` = an unprefixed twin existed
  // with a DIFFERENT value and was overridden — expected during the rename
  // transition, worth eyeballing after.
  log.info('Env prefix router applied', {
    mapped: prefixRouterResult.mapped,
    shadowed: prefixRouterResult.shadowed,
  });

  // 0a. Wire silent-fallback warning. FallbackProvider previously emitted
  // nothing when it routed a failed primary call to the Anthropic
  // fallback — the dispatcher bug in 2026-05-23 spent a full day routing
  // every "Llama" call to Haiku before anyone noticed. With this hook,
  // any silent fallback shows up as a level='warn' `llm.provider-fallback`
  // event in the dashboard and the structured log.
  setProviderFallbackHook((info) => {
    log.event({
      kind: 'llm.provider-fallback',
      level: 'warn',
      data: {
        layer: info.layer,
        primary: info.primary,
        fallback: info.fallback,
        primary_error: info.primaryError,
        primary_latency_ms: info.primaryLatencyMs,
      },
    });
  });

  // 0. Circuit breaker — backoff on rapid restarts
  await enforceStartupBackoff();

  // 0.5 Upgrade tripwire — refuse to start if this install was updated
  // outside the sanctioned path (raw `git pull` instead of /update-nanoclaw).
  enforceUpgradeTripwire();

  // 1. Init central DB
  const dbPath = path.join(DATA_DIR, 'v2.db');
  const db = initDb(dbPath);
  runMigrations(db);
  log.info('Central DB ready', { path: dbPath });

  // 1b. Backfill container_configs from legacy container.json files.
  // Idempotent — skips groups that already have a config row.
  backfillContainerConfigs();

  // 1c. One-time filesystem cutover — idempotent, no-op after first run.
  migrateGroupsToClaudeLocal();

  // 1d. PAT: reconcile credential_routing → OneCLI vault (values from AGENT_*
  // env; the DB table is the source of truth, the vault a derived cache).
  // Must complete BEFORE channel adapters (step 3) — an inbound can spawn a
  // container the moment adapters are up, and spawn-time credential injection
  // reads the vault. Never fatal: a down gateway logs and boot continues.
  try {
    const summary = await reconcileCredentials();
    log.info('Credential reconcile done', {
      created: summary.created.length,
      refreshed: summary.refreshed.length,
      deleted: summary.deleted.length,
      awaiting: summary.awaiting.length,
      errors: summary.errors.length,
    });
  } catch (err) {
    log.warn('Credential reconcile failed (non-fatal)', { err });
  }

  // 2. Container runtime
  ensureContainerRuntimeRunning();
  cleanupOrphans();
  // PAT: no Docker containers survive a process restart (cleanupOrphans
  // kills them above). Reset all in-DB "running"/"idle" states so
  // getRunningSessions() starts clean. Without this, stale sessions
  // accumulate across deploys — 139 stale "running" sessions on prod
  // caused 35s delivery poll cycles (each opens 2 SQLite files on the
  // volume, queries, marks delivered — sequentially).
  getDb()
    .prepare("UPDATE sessions SET container_status = 'stopped' WHERE container_status IN ('running', 'idle')")
    .run();

  // 3. Channel adapters
  await initChannelAdapters((adapter: ChannelAdapter): ChannelSetup => {
    return {
      onInbound(platformId, threadId, message) {
        routeInbound({
          channelType: adapter.channelType,
          // The one host-side stamping seam: adapters stay instance-blind,
          // the host stamps the receiving instance on every inbound event.
          instance: adapter.instance ?? adapter.channelType,
          platformId,
          threadId,
          message: {
            id: message.id,
            kind: message.kind,
            content: JSON.stringify(message.content),
            timestamp: message.timestamp,
            isMention: message.isMention,
            isGroup: message.isGroup,
          },
        }).catch((err) => {
          log.error('Failed to route inbound message', { channelType: adapter.channelType, err });
        });
      },
      onInboundEvent(event) {
        routeInbound(event).catch((err) => {
          log.error('Failed to route inbound event', {
            sourceAdapter: adapter.channelType,
            targetChannelType: event.channelType,
            err,
          });
        });
      },
      onMetadata(platformId, name, isGroup) {
        log.info('Channel metadata discovered', {
          channelType: adapter.channelType,
          platformId,
          name,
          isGroup,
        });
      },
      onAction(questionId, selectedOption, userId) {
        dispatchResponse({
          questionId,
          value: selectedOption,
          userId,
          channelType: adapter.channelType,
          // platformId/threadId aren't surfaced by the current onAction
          // signature — registered handlers look them up from the
          // pending_question / pending_approval row.
          platformId: '',
          threadId: null,
        }).catch((err) => {
          log.error('Failed to handle question response', { questionId, err });
        });
      },
    };
  });

  // 3b. PAT (TaskList #8): seed the realtime library's
  //     install-capabilities cache, one entry per agent group.
  //
  //     Lifecycle split: install-state (channels wired, MCP tools
  //     mounted, container skills present, container.json contents) is
  //     stable per agent group and lives in the SYSTEM prompt — which
  //     keeps SYSTEM cacheable across inbounds (Anthropic prompt cache).
  //     Per-inbound caller context (identity, known handles,
  //     permissions) is resolved fresh by the channel adapter's
  //     `callerContextResolver` and rides in the USER message.
  //
  //     Channel adapters self-registered above in step 3 — channels
  //     list is now available to `buildInstallCapabilities` via
  //     `getRegisteredChannelNames()`. Provision-time hooks (when a new
  //     agent group is created at runtime) should ALSO call
  //     `setInstallCapabilities(agentGroupId, buildInstallCapabilities(...))`.
  try {
    const groups = getAllAgentGroups();
    for (const g of groups) {
      try {
        const snap = buildInstallCapabilities({ agentGroupId: g.id });
        setInstallCapabilities(g.id, snap);
        log.event({
          kind: 'capability.install-resolved',
          level: 'debug',
          data: {
            agent_group_id: g.id,
            resolved: true,
            snapshot: serializeInstallSnapshotForLog(snap),
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('buildInstallCapabilities threw for agent group', { agentGroupId: g.id, err: msg });
        log.event({
          kind: 'capability.install-resolved',
          level: 'debug',
          data: {
            agent_group_id: g.id,
            resolved: false,
            resolver_error: msg,
            snapshot: null,
          },
        });
      }
    }
    log.info('Install capabilities seeded', { groupCount: groups.length });
  } catch (err) {
    log.warn('Install capabilities boot-time seed failed', { err: String(err) });
  }

  // 4. Delivery adapter bridge — dispatches to channel adapters by EXACT
  // registry key (instance ?? channelType): a named instance with an
  // offline adapter is never rerouted through a sibling bot. See
  // createChannelDeliveryAdapter in channels/channel-registry.ts.
  setDeliveryAdapter(createChannelDeliveryAdapter());
  registerColdContactApprovalHandler(); // PAT : cold-contact send → admin approval → grant

  // 5. Start delivery polls
  startActiveDeliveryPoll();
  startSweepDeliveryPoll();
  log.info('Delivery polls started');

  // 6. Start host sweep
  startHostSweep();
  log.info('Host sweep started');

  // 6a. PAT: credential watcher — activates approved MCPs parked on a missing
  // credential the moment it lands in the vault (respawns the session's
  // container so the MCP handshake finds it). Idle cost: one SQL read/min.
  startCredentialWatcher();

  // 6b. Start the external Signal health probe (no-op without a Signal
  // channel). Must run after the delivery adapter is set (step 4) so it can
  // DM admins on a degraded transition.
  startSignalHealthProbe();

  // 7. Start the `ncl` CLI socket server (data/ncl.sock).
  await startCliServer();

  log.info('NanoClaw running');
}

/** Graceful shutdown. */
async function shutdown(signal: string): Promise<void> {
  log.info('Shutdown signal received', { signal });
  for (const cb of getShutdownCallbacks()) {
    try {
      await cb();
    } catch (err) {
      log.error('Shutdown callback threw', { err });
    }
  }
  stopDeliveryPolls();
  stopHostSweep();
  stopSignalHealthProbe();
  stopCredentialWatcher(); // PAT
  await stopCliServer();
  try {
    await teardownChannelAdapters();
  } finally {
    // Always reset on graceful shutdown — even if teardown threw, we got here
    // via SIGTERM/SIGINT, not a crash, so the next start shouldn't be counted
    // as one.
    resetCircuitBreaker();
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

/** Snake-case + pass-through helper for the `capability.install-resolved`
 *  log event. Mirrors the realtime library's `InstallCapabilities`
 *  field-for-field. Single emit site means the wire payload stays
 *  consistent across boot + provision-time emits. */
function serializeInstallSnapshotForLog(
  snap: import('@agentic-toolkit/realtime').InstallCapabilities,
): Record<string, unknown> {
  return {
    ...(snap.agentGroupId !== undefined ? { agent_group_id: snap.agentGroupId } : {}),
    ...(snap.agentGroupName !== undefined ? { agent_group_name: snap.agentGroupName } : {}),
    ...(snap.containerMcpTools !== undefined ? { container_mcp_tools: snap.containerMcpTools } : {}),
    ...(snap.containerSkills !== undefined ? { container_skills: snap.containerSkills } : {}),
    ...(snap.channels !== undefined ? { channels: snap.channels } : {}),
    ...(snap.sdkTools !== undefined ? { sdk_tools: snap.sdkTools } : {}),
    ...(snap.inTreePrimitives !== undefined ? { in_tree_primitives: snap.inTreePrimitives } : {}),
    ...(snap.externalMcpServers !== undefined ? { external_mcp_servers: snap.externalMcpServers } : {}),
    // PAT: slash_commands dropped from install-caps payload — see capability-resolver.ts
    ...(snap.hostVerbs !== undefined ? { host_verbs: snap.hostVerbs } : {}),
  };
}

main().catch((err) => {
  log.fatal('Startup failed', { err });
  process.exit(1);
});
