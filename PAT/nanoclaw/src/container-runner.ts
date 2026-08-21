/**
 * Container Runner v2
 * Spawns agent containers with session folder + agent group folder mounts.
 * The container runs the v2 agent-runner which polls the session DB.
 */
import { ChildProcess, execSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  CONTAINER_IMAGE,
  CONTAINER_IMAGE_BASE,
  CONTAINER_INSTALL_LABEL,
  DATA_DIR,
  GROUPS_DIR,
  ONECLI_API_KEY,
  ONECLI_URL,
  TIMEZONE,
} from './config.js';
import { materializeContainerJson } from './container-config.js';
import { getContainerConfig } from './db/container-configs.js';
import { updateContainerConfigScalars } from './db/container-configs.js';
import { CONTAINER_RUNTIME_BIN, hostGatewayArgs, readonlyMountArgs, stopContainer } from './container-runtime.js';
import { EGRESS_NETWORK, egressNetworkArgs, ensureEgressNetwork } from './egress-lockdown.js';
import { composeGroupClaudeMd } from './claude-md-compose.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getDb, hasTable } from './db/connection.js';
import { initGroupFilesystem } from './group-init.js';
import { stopTypingRefresh } from './modules/typing/index.js';
import { applyNewAgentSecretPolicy } from './modules/credentials/agent-policy.js'; // PAT: selective-by-default
import { log } from './log.js';
import { validateAdditionalMounts } from './modules/mount-security/index.js';
import { personalMemoryMounts } from './personal-memory.js'; // PAT: per-person + shared memory
// Provider host-side config barrel — each provider that needs host-side
// container setup self-registers on import.
import './providers/index.js';
import {
  getProviderContainerConfig,
  providerProvidesAgentSurfaces,
  type ProviderContainerContribution,
  type VolumeMount,
} from './providers/provider-container-registry.js';
import {
  heartbeatPath,
  markContainerRunning,
  markContainerStopped,
  sessionDir,
  writeSessionRouting,
} from './session-manager.js';
import type { AgentGroup, Session } from './types.js';

const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

// PAT: sentinel prefix the container's agent-runner writes on stderr for
// structured events it can't ship directly (6PN / egress lockdown). The host
// stderr tee below matches it, parses the JSON, and re-emits it into the
// host's OWN shipped structured-log stream. Mirror of PAT_EVENT_SENTINEL in
// container/agent-runner/src/providers/claude.ts.
const PAT_EVENT_STDERR_SENTINEL = '@@PATEVENT@@';

/**
 * PAT: parse a sentinel stderr line from a container and re-emit it as a host
 * structured event with authoritative ids from the spawn context. Best effort
 * — a malformed line must never break the stderr tee. Returns true if the line
 * was a (well-formed) sentinel and was handled.
 */
export function reEmitContainerStderrEvent(line: string, session: Session, agentGroup: AgentGroup): boolean {
  try {
    const payload = JSON.parse(line.slice(PAT_EVENT_STDERR_SENTINEL.length).trim()) as {
      kind?: string;
      data?: Record<string, unknown>;
    };
    if (!payload.kind) return false;
    log.event({
      kind: payload.kind,
      source: 'agent-runner',
      session_id: session.id,
      thread_id: session.thread_id ?? null,
      data: { ...(payload.data ?? {}), agent_group_id: agentGroup.id },
    });
    return true;
  } catch {
    return false;
  }
}

/** Active containers tracked by session ID. */
const activeContainers = new Map<string, { process: ChildProcess; containerName: string }>();

/**
 * In-flight wake promises, keyed by session id. Deduplicates concurrent
 * `wakeContainer` calls while the first spawn is still mid-setup (async
 * buildContainerArgs, OneCLI gateway apply, etc.) — otherwise a second
 * wake in that window passes the `activeContainers.has` check and spawns
 * a duplicate container against the same session directory, producing
 * racy double-replies.
 */
const wakePromises = new Map<string, Promise<boolean>>();

export function getActiveContainerCount(): number {
  return activeContainers.size;
}

export function isContainerRunning(sessionId: string): boolean {
  return activeContainers.has(sessionId);
}

/**
 * Wake up a container for a session. If already running or mid-spawn, no-op
 * (the in-flight wake promise is reused).
 *
 * The container runs the v2 agent-runner which polls the session DB.
 *
 * Contract: never throws. Returns `true` on successful spawn, `false` on
 * transient spawn failure (e.g. OneCLI gateway unreachable). Callers don't
 * need to wrap — the inbound row stays pending and host-sweep retries on
 * its next tick. Callers that care (e.g. the router's typing indicator)
 * can branch on the boolean.
 */
export function wakeContainer(session: Session): Promise<boolean> {
  if (activeContainers.has(session.id)) {
    log.debug('Container already running', { sessionId: session.id });
    return Promise.resolve(true);
  }
  const existing = wakePromises.get(session.id);
  if (existing) {
    log.debug('Container wake already in-flight — joining existing promise', { sessionId: session.id });
    return existing;
  }
  const promise = spawnContainer(session)
    .then(() => true)
    .catch((err) => {
      log.warn('wakeContainer failed — host-sweep will retry', { sessionId: session.id, err });
      return false;
    })
    .finally(() => {
      wakePromises.delete(session.id);
    });
  wakePromises.set(session.id, promise);
  return promise;
}

async function spawnContainer(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    log.error('Agent group not found', { agentGroupId: session.agent_group_id });
    return;
  }

  // Refresh the destination map and default reply routing so any admin
  // changes take effect on wake. Destinations come from the agent-to-agent
  // module — skip when the module isn't installed (table absent).
  if (hasTable(getDb(), 'agent_destinations')) {
    const { writeDestinations } = await import('./modules/agent-to-agent/write-destinations.js');
    writeDestinations(agentGroup.id, session.id);
  }
  writeSessionRouting(agentGroup.id, session.id);

  // Materialize container.json from DB — writes fresh file and returns
  // the config object, threaded through provider resolution, buildMounts,
  // and buildContainerArgs so we don't re-read.
  const containerConfig = materializeContainerJson(agentGroup.id);

  // Per-group filesystem state lives forever after first creation. Init is
  // idempotent: it only writes paths that don't already exist, so this call
  // is a no-op for groups that have spawned before. Runs before the provider
  // contribution so a surfaces-providing provider finds the group dir ready.
  const providerName = resolveProviderName(session.agent_provider, containerConfig.provider);
  initGroupFilesystem(agentGroup, { provider: providerName });

  // Resolve the effective provider + any host-side contribution it declares
  // (extra mounts, env passthrough). Computed once and threaded through both
  // buildMounts and buildContainerArgs so side effects (mkdir, etc.) fire once.
  const { provider, contribution } = resolveProviderContribution(session, agentGroup, containerConfig);

  const mounts = buildMounts(agentGroup, session, containerConfig, provider, contribution);
  const containerName = `nanoclaw-v2-${agentGroup.folder}-${Date.now()}`;
  // OneCLI agent identifier is always the agent group id — stable across
  // sessions and reversible via getAgentGroup() for approval routing.
  const agentIdentifier = agentGroup.id;
  const args = await buildContainerArgs(
    mounts,
    containerName,
    agentGroup,
    containerConfig,
    provider,
    contribution,
    agentIdentifier,
    session.thread_id ?? null,
  );

  log.info('Spawning container', { sessionId: session.id, agentGroup: agentGroup.name, containerName });

  // Clear any orphan heartbeat from a previous container instance — the
  // sweep's ceiling check treats a missing file as "fresh spawn, give grace"
  // (host-sweep.ts line 87). Without this, the stale mtime can trigger an
  // immediate kill before the new container touches the file itself.
  fs.rmSync(heartbeatPath(agentGroup.id, session.id), { force: true });

  const container = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  activeContainers.set(session.id, { process: container, containerName });
  markContainerRunning(session.id);
  log.event({
    kind: 'container.spawned',
    session_id: session.id,
    data: { agent_group: agentGroup.name, container_name: containerName },
  });

  // PAT: persistent stderr capture per session. Containers run with --rm,
  // so the Claude Code subprocess's init / MCP-connect / @-import-load
  // chatter (all on stderr) is lost on exit. Tee into a bounded file on
  // the session dir so a post-mortem can `flyctl ssh + cat` even after
  // the container is gone. 50MB cap with truncate-with-tail-friendly
  // semantics: once the cap is hit we stop writing entirely (no rotation
  // — this is dev/per-call forensics, not long-running audit). The
  // process is `docker run` itself, so we also capture early Docker
  // errors (image-pull failures, OneCLI proxy startup issues, etc.).
  const stderrLogPath = path.join(sessionDir(agentGroup.id, session.id), 'container.stderr.log');
  const STDERR_CAP_BYTES = 50 * 1024 * 1024;
  let stderrFileStream: fs.WriteStream | null = null;
  let stderrBytesWritten = 0;
  let stderrCappedNoticeEmitted = false;
  try {
    stderrFileStream = fs.createWriteStream(stderrLogPath, { flags: 'w' });
    stderrFileStream.on('error', (err) => {
      log.warn('container stderr log write failed — disabling tee', { sessionId: session.id, err });
      stderrFileStream = null;
    });
  } catch (err) {
    log.warn('container stderr log open failed — skipping tee', { sessionId: session.id, err });
    stderrFileStream = null;
  }

  // Log stderr (live to host log) + keep a tail for upstream's boot-failure
  // tripwire (surfaced on non-zero exit; debug is below default log level) +
  // tee to the per-session file with cap.
  const stderrTail: string[] = [];
  container.stderr?.on('data', (data: Buffer) => {
    for (const line of data.toString().trim().split('\n')) {
      if (!line) continue;
      // PAT: structured events the container piggybacks on stderr (it can't
      // reach the forwarder directly — egress lockdown). Re-emit into the
      // host's shipped log stream and skip the debug log + boot-failure tail
      // so they don't pollute crash diagnostics. They still land in the
      // per-session container.stderr.log via the file tee below.
      if (line.startsWith(PAT_EVENT_STDERR_SENTINEL)) {
        reEmitContainerStderrEvent(line, session, agentGroup);
        continue;
      }
      log.debug(line, { container: agentGroup.folder });
      stderrTail.push(line);
      if (stderrTail.length > 10) stderrTail.shift();
    }
    if (!stderrFileStream) return;
    if (stderrBytesWritten >= STDERR_CAP_BYTES) {
      if (!stderrCappedNoticeEmitted) {
        stderrCappedNoticeEmitted = true;
        try {
          stderrFileStream.write(`\n[container-stderr capped at ${STDERR_CAP_BYTES} bytes]\n`);
        } catch {
          /* best effort */
        }
      }
      return;
    }
    const remaining = STDERR_CAP_BYTES - stderrBytesWritten;
    const chunk = data.length <= remaining ? data : data.subarray(0, remaining);
    stderrFileStream.write(chunk);
    stderrBytesWritten += chunk.length;
    if (chunk.length < data.length && !stderrCappedNoticeEmitted) {
      stderrCappedNoticeEmitted = true;
      try {
        stderrFileStream.write(`\n[container-stderr capped at ${STDERR_CAP_BYTES} bytes]\n`);
      } catch {
        /* best effort */
      }
    }
  });

  const closeStderrFile = (): void => {
    if (!stderrFileStream) return;
    try {
      stderrFileStream.end();
    } catch {
      /* already closed */
    }
    stderrFileStream = null;
  };

  // stdout is unused in v2 (all IO is via session DB)
  container.stdout?.on('data', () => {});

  // No host-side idle timeout. Stale/stuck detection is driven by the host
  // sweep reading heartbeat mtime + processing_ack claim age + container_state
  // (see src/host-sweep.ts). This avoids killing long-running legitimate work
  // on a wall-clock timer.

  container.on('close', (code) => {
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    closeStderrFile();
    // code null = killed by signal (normal shutdown path), not a boot failure.
    if (code !== 0 && code !== null && stderrTail.length > 0) {
      log.warn('Container exited non-zero', { sessionId: session.id, code, containerName, stderrTail });
    } else {
      log.info('Container exited', { sessionId: session.id, code, containerName });
    }
    log.event({
      kind: 'container.exited',
      session_id: session.id,
      data: { exit_code: code ?? -1, container_name: containerName },
    });
  });

  container.on('error', (err) => {
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    closeStderrFile();
    log.error('Container spawn error', { sessionId: session.id, err });
    log.event({
      kind: 'container.exited',
      level: 'error',
      session_id: session.id,
      data: {
        exit_code: -2,
        container_name: containerName,
        error: err instanceof Error ? err.message : String(err),
      },
    });
  });
}

/** Kill a container for a session. */
export function killContainer(sessionId: string, reason: string, onExit?: () => void): void {
  const entry = activeContainers.get(sessionId);
  if (!entry) return;

  if (onExit) {
    entry.process.once('close', onExit);
  }

  log.info('Killing container', { sessionId, reason, containerName: entry.containerName });
  try {
    stopContainer(entry.containerName);
  } catch {
    entry.process.kill('SIGKILL');
  }
}

/**
 * Resolve the provider name for a session:
 *
 *   sessions.agent_provider
 *     → container_configs.provider
 *     → 'claude'
 *
 * Pure so the precedence can be unit-tested without a DB or filesystem.
 */
export function resolveProviderName(
  sessionProvider: string | null | undefined,
  containerConfigProvider: string | null | undefined,
): string {
  return (sessionProvider || containerConfigProvider || 'claude').toLowerCase();
}

function resolveProviderContribution(
  session: Session,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
): { provider: string; contribution: ProviderContainerContribution } {
  const provider = resolveProviderName(session.agent_provider, containerConfig.provider);
  const fn = getProviderContainerConfig(provider);
  const contribution = fn
    ? fn({
        sessionDir: sessionDir(agentGroup.id, session.id),
        agentGroupId: agentGroup.id,
        groupDir: path.resolve(GROUPS_DIR, agentGroup.folder),
        selectedSkills: selectedSkillNames(containerConfig),
        hostEnv: process.env,
      })
    : {};
  return { provider, contribution };
}

export function buildMounts(
  agentGroup: AgentGroup,
  session: Session,
  containerConfig: import('./container-config.js').ContainerConfig,
  provider: string,
  providerContribution: ProviderContainerContribution,
): VolumeMount[] {
  const projectRoot = process.cwd();

  // Default agent surfaces (composed project doc, skill links, provider state
  // dir) apply unless the provider's registration declares it provides its
  // own — a capability, never a provider name. See provider-container-registry.
  const defaultSurfaces = !providerProvidesAgentSurfaces(provider);

  const claudeDir = path.join(DATA_DIR, 'v2-sessions', agentGroup.id, '.claude-shared');
  if (defaultSurfaces) {
    // Sync skill symlinks based on container.json selection before mounting.
    syncSkillSymlinks(claudeDir, containerConfig);

    // Compose CLAUDE.md fresh every spawn from the shared base, enabled skill
    // fragments, and MCP server instructions. See `claude-md-compose.ts`.
    composeGroupClaudeMd(agentGroup);
  }

  const mounts: VolumeMount[] = [];
  const sessDir = sessionDir(agentGroup.id, session.id);
  const groupDir = path.resolve(GROUPS_DIR, agentGroup.folder);

  // Session folder at /workspace (contains inbound.db, outbound.db, outbox/, .claude/)
  mounts.push({ hostPath: sessDir, containerPath: '/workspace', readonly: false });

  // Agent group folder at /workspace/agent (RW for working files + CLAUDE.local.md)
  mounts.push({ hostPath: groupDir, containerPath: '/workspace/agent', readonly: false });

  // container.json — nested RO mount on top of RW group dir so the agent
  // can read its config but cannot modify it.
  const containerJsonPath = path.join(groupDir, 'container.json');
  if (fs.existsSync(containerJsonPath)) {
    mounts.push({ hostPath: containerJsonPath, containerPath: '/workspace/agent/container.json', readonly: true });
  }

  // Composer-managed CLAUDE.md artifacts — nested RO mounts. These are
  // regenerated from the shared base + fragments on every spawn; any
  // agent-side writes would be clobbered, so enforce read-only. Only
  // CLAUDE.local.md (per-group memory) remains RW via the group-dir mount.
  // `.claude-shared.md` is a symlink whose target (`/app/CLAUDE.md`) is
  // already RO-mounted, so writes through it fail regardless — no need for
  // a nested mount there.
  const composedClaudeMd = path.join(groupDir, 'CLAUDE.md');
  if (defaultSurfaces && fs.existsSync(composedClaudeMd)) {
    mounts.push({ hostPath: composedClaudeMd, containerPath: '/workspace/agent/CLAUDE.md', readonly: true });
  }
  const fragmentsDir = path.join(groupDir, '.claude-fragments');
  if (defaultSurfaces && fs.existsSync(fragmentsDir)) {
    mounts.push({ hostPath: fragmentsDir, containerPath: '/workspace/agent/.claude-fragments', readonly: true });
  }

  // Global memory directory — always read-only.
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    mounts.push({ hostPath: globalDir, containerPath: '/workspace/global', readonly: true });
  }

  // PAT: install-wide PAT prompt content lives in the parent
  // agentic_toolkit repo at `../pat-prompts/` so it's tracked separately
  // from nanoclaw (which is a soft-fork of upstream and stays clean of
  // PAT-specific markdown). Mounted RO at /workspace/pat-shared/ so the
  // in-container @-import path stays stable. Each PAT agent group's
  // CLAUDE.local.md @-imports specific files from there to opt in.
  const patSharedDir = path.resolve(process.cwd(), '..', 'pat-prompts');
  if (fs.existsSync(patSharedDir)) {
    mounts.push({ hostPath: patSharedDir, containerPath: '/workspace/pat-shared', readonly: true });
  }

  // Shared CLAUDE.md — read-only, imported by the composed entry point via
  // the `.claude-shared.md` symlink inside the group dir.
  const sharedClaudeMd = path.join(process.cwd(), 'container', 'CLAUDE.md');
  if (defaultSurfaces && fs.existsSync(sharedClaudeMd)) {
    mounts.push({ hostPath: sharedClaudeMd, containerPath: '/app/CLAUDE.md', readonly: true });
  }

  // Per-group .claude-shared at /home/node/.claude (Claude state, settings,
  // skill symlinks)
  if (defaultSurfaces) {
    mounts.push({ hostPath: claudeDir, containerPath: '/home/node/.claude', readonly: false });
  }

  // Shared agent-runner source — read-only, same code for all groups.
  const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
  mounts.push({ hostPath: agentRunnerSrc, containerPath: '/app/src', readonly: true });

  // Shared skills — read-only, symlinks in .claude-shared/skills/ point here.
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  if (fs.existsSync(skillsSrc)) {
    mounts.push({ hostPath: skillsSrc, containerPath: '/app/skills', readonly: true });
  }

  // PAT: per-person + shared memory spaces (Phase 3). /shared (per agent group)
  // is always mounted; /personal (per person) only for 1:1 sessions where the
  // people spine resolves the sender to a person. Fixes the shared-memory leak —
  // person-specific facts no longer land in the group-shared CLAUDE.local.md.
  // See src/personal-memory.ts + plans/admin-dashboard-and-people.md (Phase 3).
  mounts.push(...personalMemoryMounts(agentGroup.id, session));

  // Additional mounts from container config
  if (containerConfig.additionalMounts && containerConfig.additionalMounts.length > 0) {
    const validated = validateAdditionalMounts(containerConfig.additionalMounts, agentGroup.name);
    mounts.push(...validated);
  }

  // Provider-contributed mounts (e.g. opencode-xdg)
  if (providerContribution.mounts) {
    mounts.push(...providerContribution.mounts);
  }

  return mounts;
}

/**
 * Sync skill symlinks in .claude-shared/skills/ to match the container.json
 * selection. Each symlink points to a container path (/app/skills/<name>)
 * so it's dangling on the host but valid inside the container.
 */
function syncSkillSymlinks(claudeDir: string, containerConfig: import('./container-config.js').ContainerConfig): void {
  const skillsDir = path.join(claudeDir, 'skills');
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  const desired = selectedSkillNames(containerConfig);
  const desiredSet = new Set(desired);

  // Remove symlinks not in the desired set
  for (const entry of fs.readdirSync(skillsDir)) {
    const entryPath = path.join(skillsDir, entry);
    let isSymlink = false;
    try {
      isSymlink = fs.lstatSync(entryPath).isSymbolicLink();
    } catch {
      continue;
    }
    if (isSymlink && !desiredSet.has(entry)) {
      fs.unlinkSync(entryPath);
    }
  }

  // Create symlinks for desired skills (container path targets)
  for (const skill of desired) {
    const linkPath = path.join(skillsDir, skill);
    let exists = false;
    try {
      fs.lstatSync(linkPath);
      exists = true;
    } catch {
      /* missing */
    }
    if (!exists) {
      fs.symlinkSync(`/app/skills/${skill}`, linkPath);
    }
  }
}

/**
 * Resolve the group's skill selection to concrete names — `'all'` recomputes
 * from `container/skills/` so newly-added upstream skills appear automatically.
 */
function selectedSkillNames(containerConfig: import('./container-config.js').ContainerConfig): string[] {
  if (containerConfig.skills !== 'all') return containerConfig.skills;
  const sharedSkillsDir = path.join(process.cwd(), 'container', 'skills');
  return fs.existsSync(sharedSkillsDir)
    ? fs.readdirSync(sharedSkillsDir).filter((e) => {
        try {
          return fs.statSync(path.join(sharedSkillsDir, e)).isDirectory();
        } catch {
          return false;
        }
      })
    : [];
}

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
  _provider: string,
  providerContribution: ProviderContainerContribution,
  agentIdentifier: string | undefined,
  threadId: string | null,
): Promise<string[]> {
  const args: string[] = ['run', '--rm', '--name', containerName, '--label', CONTAINER_INSTALL_LABEL];

  // Environment — only vars read by code we don't own.
  // Everything NanoClaw-specific is in container.json (read by runner at startup).
  args.push('-e', `TZ=${TIMEZONE}`);

  // PAT: forward DEBUG_DUMP_PROMPT so the back-mind agent-runner can emit
  // the full materialized system-prompt chain (preset + composed CLAUDE.md
  // + @-imports + CLAUDE.local.md) on every llm.call event. Opt-in via
  // host env to keep llm.call payloads small in the default case.
  if (process.env.DEBUG_DUMP_PROMPT === '1') {
    args.push('-e', 'DEBUG_DUMP_PROMPT=1');
  }

  // PAT: forward front-mind model env vars so the back-mind can answer
  // "what model is each layer running?" accurately. The front-mind itself
  // runs on the host; without forwarding, the back-mind would see only
  // its own NANOCLAW_MODEL and guess at the rest. Resolution + fallback
  // logic lives in destinations.ts:buildModelsSection().
  for (const key of [
    'NANOCLAW_MODEL',
    'FAST_MODEL',
    'REQUEST_LAYER_MODEL',
    'BANTER_ACK_MODEL',
    'BANTER_RENDER_MODEL',
    'NARRATION_MODEL',
  ]) {
    const value = process.env[key];
    if (value) args.push('-e', `${key}=${value}`);
  }

  // PAT (S5, security): stdio MCP servers are OFF by default (supply-chain
  // surface). Pass the enable flag through only when an operator has set it, so
  // add_mcp_server's stdio path can be turned on per-deployment.
  if (process.env.PAT_ALLOW_STDIO_MCP === '1') args.push('-e', 'PAT_ALLOW_STDIO_MCP=1');

  // Provider-contributed env vars (e.g. XDG_DATA_HOME, OPENCODE_*, NO_PROXY).
  if (providerContribution.env) {
    for (const [key, value] of Object.entries(providerContribution.env)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  // PAT: derive the scenario slug from presenter agent-group folder names
  // (`presenter-<slug>`) and pass it as PAT_WEB_SCENARIO_SLUG. The
  // agent-runner MCP tools (start_presentation / present_advance / etc.
  // in container/agent-runner/src/mcp-tools/present.ts) read this env to
  // route slide-bus POSTs to the right room. Without it the tools default
  // to slug 'default' — pat-web subscribes to the real slug, container
  // posts to 'default', the deck pane never opens. Was a TODO in
  // src/presentation/provision.ts; ContainerConfig has no env field, so
  // the spawn site (this one) is the right place to wire it.
  if (agentGroup.folder.startsWith('presenter-')) {
    const scenarioSlug = agentGroup.folder.replace(/^presenter-/, '');
    args.push('-e', `PAT_WEB_SCENARIO_SLUG=${scenarioSlug}`);
    // PAT: thread-keyed slide-bus state. Each call gets a fresh
    // (slug, thread) bucket on pat-web so a stale cursor from a
    // previous call doesn't replay into a new one. The container's
    // present.* MCP tools read this and stamp it on every slide-bus
    // POST.
    if (threadId) {
      args.push('-e', `PAT_WEB_THREAD_ID=${threadId}`);
    }
  }

  // Egress lockdown when enabled — throws if it can't be established, aborting
  // the spawn rather than running with open egress. Otherwise the host gateway.
  // NOTE: the OneCLI gateway apply lives AFTER the volume-mount loop below
  // (upstream moved it there so credential-stub mounts aren't shadowed). PAT's
  // TMPDIR-redirect + NODE_EXTRA_CA_CERTS workarounds were re-homed onto that
  // surviving block during the v2.1.19 merge.
  if (ensureEgressNetwork()) {
    args.push(...egressNetworkArgs());
    log.info('Egress lockdown active', { containerName, network: EGRESS_NETWORK });
  } else {
    args.push(...hostGatewayArgs());
  }

  // User mapping
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  // Volume mounts
  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  // OneCLI gateway — injects HTTPS_PROXY + certs so container API calls
  // are routed through the agent vault for credential injection, and mounts
  // any credential stubs the gateway serves (e.g. a sentinel auth file).
  // Runs AFTER the volume mounts so a stub nested inside one of our mounts
  // (a parent dir mounted RW above it) lands later in the args and isn't
  // shadowed by it. Treated as a transient hard failure: if we can't wire
  // the gateway, we don't spawn. The caller (router or host-sweep) catches
  // the throw, leaves the inbound message pending, and the next sweep tick
  // retries.
  if (agentIdentifier) {
    const ensured = await onecli.ensureAgent({ name: agentGroup.name, identifier: agentIdentifier });
    // PAT: selective-by-default. The gateway's own default for a new agent is
    // secretMode 'all' (every host-matching vault secret injects) — fine for
    // the one owner group, a footgun for every future group. A NEWLY-created
    // agent (= a new agent group's first spawn) is flipped to 'selective'
    // with only the baseline assignment (anthropic — required for the
    // container's own model calls). Existing agents are never touched.
    // Throws → no spawn → host-sweep retries (same contract as the rest of
    // the gateway wiring above).
    if (ensured.created) {
      await applyNewAgentSecretPolicy(agentIdentifier);
    }
  }
  // PAT: On macOS+Colima, the SDK writes its CA bundle under os.tmpdir()
  // (= /var/folders/<user>/T/), but Colima only bind-mounts $HOME by default,
  // so Docker silently creates an empty DIRECTORY at the container CA path and
  // Node fetch falls back to system trust (SELF_SIGNED_CERT_IN_CHAIN on every
  // api.anthropic.com call). Redirect TMPDIR to a $HOME-visible cache dir so
  // the cert bind-mount resolves to a real file. No-op on Linux.
  const onecliCacheDir = path.join(process.env.HOME ?? os.homedir(), '.cache', 'nanoclaw', 'onecli');
  fs.mkdirSync(onecliCacheDir, { recursive: true });
  const savedTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = onecliCacheDir;
  let onecliApplied: boolean;
  try {
    onecliApplied = await onecli.applyContainerConfig(args, { addHostMapping: false, agent: agentIdentifier });
  } finally {
    if (savedTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmpdir;
  }
  if (!onecliApplied) {
    throw new Error('OneCLI gateway not applied — refusing to spawn container without credentials');
  }
  // PAT: applyContainerConfig sets SSL_CERT_FILE + DENO_CERT for the OneCLI
  // proxy CA, but Claude Code (Node-based) only honors NODE_EXTRA_CA_CERTS —
  // verified still true in @onecli-sh/sdk 2.2.1 (lib/index.js sets only
  // SSL_CERT_FILE/DENO_CERT and mounts the CA at /tmp/onecli-combined-ca.pem).
  // Without this, claude-code aborts with "Self-signed certificate detected"
  // the moment it calls api.anthropic.com through the proxy.
  args.push('-e', 'NODE_EXTRA_CA_CERTS=/tmp/onecli-combined-ca.pem');
  log.info('OneCLI gateway applied', { containerName });

  // Override entrypoint: run v2 entry point directly via Bun (no tsc, no stdin).
  args.push('--entrypoint', 'bash');

  // Use per-agent-group image if one has been built, otherwise base image
  const imageTag = containerConfig.imageTag || CONTAINER_IMAGE;
  args.push(imageTag);

  args.push('-c', 'exec bun run /app/src/index.ts');

  return args;
}

/** Build a per-agent-group Docker image with custom packages. */
export async function buildAgentGroupImage(agentGroupId: string): Promise<void> {
  const agentGroup = getAgentGroup(agentGroupId);
  if (!agentGroup) throw new Error('Agent group not found');

  const configRow = getContainerConfig(agentGroup.id);
  if (!configRow) throw new Error('Container config not found');
  const aptPackages = JSON.parse(configRow.packages_apt) as string[];
  const npmPackages = JSON.parse(configRow.packages_npm) as string[];
  if (aptPackages.length === 0 && npmPackages.length === 0) {
    throw new Error('No packages to install. Use install_packages first.');
  }

  let dockerfile = `FROM ${CONTAINER_IMAGE}\nUSER root\n`;
  if (aptPackages.length > 0) {
    dockerfile += `RUN apt-get update && apt-get install -y ${aptPackages.join(' ')} && rm -rf /var/lib/apt/lists/*\n`;
  }
  if (npmPackages.length > 0) {
    // pnpm skips build scripts unless packages are allowlisted. Append each
    // to /root/.npmrc (base image sets it up for agent-browser) so packages
    // with postinstall — e.g. playwright, puppeteer, native addons — don't
    // install silently broken.
    const allowlist = npmPackages.map((p) => `echo 'only-built-dependencies[]=${p}' >> /root/.npmrc`).join(' && ');
    dockerfile += `RUN ${allowlist} && pnpm install -g ${npmPackages.join(' ')}\n`;
  }
  dockerfile += 'USER node\n';

  const imageTag = `${CONTAINER_IMAGE_BASE}:${agentGroupId}`;

  log.info('Building per-agent-group image', { agentGroupId, imageTag, apt: aptPackages, npm: npmPackages });

  // Write Dockerfile to temp file and build
  const tmpDockerfile = path.join(DATA_DIR, `Dockerfile.${agentGroupId}`);
  fs.writeFileSync(tmpDockerfile, dockerfile);
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} build -t ${imageTag} -f ${tmpDockerfile} .`, {
      cwd: DATA_DIR,
      stdio: 'pipe',
      timeout: 900_000,
    });
  } finally {
    fs.unlinkSync(tmpDockerfile);
  }

  // Store the image tag in the DB
  updateContainerConfigScalars(agentGroup.id, { image_tag: imageTag });

  log.info('Per-agent-group image built', { agentGroupId, imageTag });
}
