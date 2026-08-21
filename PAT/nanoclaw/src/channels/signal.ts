/**
 * Signal channel adapter for NanoClaw v2.
 *
 * Uses signal-cli's TCP JSON-RPC daemon for bidirectional messaging.
 * Requires signal-cli (https://github.com/AsamK/signal-cli) installed
 * and a linked account.
 *
 * Ported from v1 — see v1 source for commit history.
 *
 * PAT: in PAT's deployment, signal-cli runs as a sibling Fly process in
 * pat-transports (process group `signal`), bound to `0.0.0.0:7583`
 * (signal-cli's SocketHandler can't bind to a hostname literal — needs
 * an IP or wildcard). This adapter runs in pat-nanoclaw with
 * SIGNAL_MANAGE_DAEMON=false and connects across 6PN via
 * SIGNAL_TCP_HOST=signal.process.pat-transports.internal (process-group
 * scoped DNS — bare pat-transports.internal round-robins to cartesia
 * machines without port 7583 open). Deviation from the slack pattern:
 * signal is a native adapter (no chat-sdk-bridge), so the bridge pattern
 * in src/channels/slack.ts is the *operational* reference (env loading,
 * register-on-import, openDM coordination) but not the code pattern.
 * The chat-sdk has no Signal adapter to wrap.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { synthesizeVoiceMemo } from '../modules/voice/synth.js';
import { transcribeVoice } from '../modules/voice/transcribe.js';

import type { ChannelAdapter, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
// PAT: lazy mg + agent_destinations auto-provisioning. Mirrors realtime.ts's
// ensureRealtimeMessagingGroup pattern but with signal-specific destination
// naming (`signal-<E164 without leading +>`) and a writeDestinations sync
// against any already-running container session of the agent group, since
// signal uses session_mode='shared' (one container for the whole agent group)
// rather than per-thread like realtime. Without the sync, the running
// container's inbound.db destinations table stays stale until next wake and
// the back-mind's reverse-lookup for "reply to source" returns nothing.
import {
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
  provisionMessagingGroup,
  resolveSeedAgentForChannel,
} from '../db/messaging-groups.js';
import { getSessionsByAgentGroup } from '../db/sessions.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';

// ---------------------------------------------------------------------------
// Signal CLI daemon management
// ---------------------------------------------------------------------------

interface DaemonHandle {
  stop: () => void;
  exited: Promise<void>;
  isExited: () => boolean;
}

function spawnSignalDaemon(cliPath: string, account: string, host: string, port: number): DaemonHandle {
  const args: string[] = [];
  if (account) args.push('-a', account);
  args.push('daemon', '--tcp', `${host}:${port}`, '--no-receive-stdout');
  args.push('--receive-mode', 'on-start');

  const child = spawn(cliPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let exited = false;

  const exitedPromise = new Promise<void>((resolve) => {
    child.once('exit', (code, signal) => {
      exited = true;
      if (code !== 0 && code !== null) {
        const reason = signal ? `signal ${signal}` : `code ${code}`;
        log.error('signal-cli daemon exited', { reason });
      }
      resolve();
    });
    child.on('error', (err) => {
      exited = true;
      log.error('signal-cli spawn error', { err });
      resolve();
    });
  });

  child.stdout?.on('data', (data: Buffer) => {
    for (const line of data.toString().split(/\r?\n/)) {
      if (line.trim()) log.debug('signal-cli stdout', { line: line.trim() });
    }
  });
  child.stderr?.on('data', (data: Buffer) => {
    for (const line of data.toString().split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (/\b(ERROR|WARN|FAILED|SEVERE)\b/i.test(line)) {
        log.warn('signal-cli stderr', { line: line.trim() });
      } else {
        log.debug('signal-cli stderr', { line: line.trim() });
      }
    }
  });

  return {
    stop: () => {
      if (!child.killed && !exited) child.kill('SIGTERM');
    },
    exited: exitedPromise,
    isExited: () => exited,
  };
}

// ---------------------------------------------------------------------------
// TCP JSON-RPC client for signal-cli daemon (--tcp mode)
//
// signal-cli 0.14.x --tcp exposes a newline-delimited JSON-RPC socket.
// Requests are sent as JSON + newline; responses and push notifications
// (inbound messages) arrive the same way.
// ---------------------------------------------------------------------------

const RPC_TIMEOUT_MS = 15_000;

class SignalTcpClient {
  private socket: Socket | null = null;
  private buffer = '';
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private onNotification: ((method: string, params: unknown) => void) | null = null;
  private onClose: (() => void) | null = null;

  constructor(
    private host: string,
    private port: number,
  ) {}

  connect(handlers?: {
    onNotification?: (method: string, params: unknown) => void;
    onClose?: () => void;
  }): Promise<void> {
    this.onNotification = handlers?.onNotification ?? null;
    this.onClose = handlers?.onClose ?? null;
    return new Promise((resolve, reject) => {
      const sock = createConnection(this.port, this.host, () => {
        this.socket = sock;
        resolve();
      });
      sock.on('error', (err) => {
        if (!this.socket) {
          reject(err);
          return;
        }
        log.warn('Signal TCP socket error', { err });
      });
      sock.on('data', (chunk) => this.onData(chunk));
      sock.on('close', () => {
        const wasConnected = this.socket !== null;
        this.socket = null;
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error('Signal TCP connection closed'));
        }
        this.pending.clear();
        if (wasConnected) this.onClose?.();
      });
    });
  }

  // PAT (task #10): optional per-call timeout override. Default stays at
  // RPC_TIMEOUT_MS for send/sendTyping/updateConfiguration; getAttachment
  // bumps it to a higher value since base64-encoding a 100MB image over
  // the JSON-RPC pipe can run long.
  async rpc<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs: number = RPC_TIMEOUT_MS,
  ): Promise<T> {
    if (!this.socket) throw new Error('Signal TCP not connected');
    const id = Math.random().toString(36).slice(2);
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params, id }) + '\n';

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Signal RPC timeout: ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      this.socket!.write(msg);
    });
  }

  close() {
    this.socket?.destroy();
    this.socket = null;
  }

  isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  private onData(chunk: Buffer) {
    this.buffer += chunk.toString();
    let newlineIdx = this.buffer.indexOf('\n');
    while (newlineIdx !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (line) this.handleLine(line);
      newlineIdx = this.buffer.indexOf('\n');
    }
  }

  private handleLine(line: string) {
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      log.debug('Signal TCP: unparseable line', { line: line.slice(0, 200) });
      return;
    }

    if (parsed.id && this.pending.has(parsed.id)) {
      const p = this.pending.get(parsed.id)!;
      this.pending.delete(parsed.id);
      clearTimeout(p.timer);
      if (parsed.error) {
        p.reject(new Error(parsed.error.message ?? 'Signal RPC error'));
      } else {
        p.resolve(parsed.result);
      }
      return;
    }

    if (parsed.method && this.onNotification) {
      this.onNotification(parsed.method, parsed.params);
    }
  }
}

async function signalTcpCheck(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(result);
    };
    const sock = createConnection(port, host, () => finish(true));
    sock.on('error', () => finish(false));
    const timer = setTimeout(() => finish(false), 5000);
  });
}

// ---------------------------------------------------------------------------
// Echo cache
// ---------------------------------------------------------------------------

const ECHO_TTL_MS = 10_000;

/**
 * Per-recipient dedup for messages we sent ourselves.
 *
 * signal-cli echoes our own outbound back via syncMessage (and, for Note to
 * Self, via sentMessage-with-self-destination). Without dedup, the agent sees
 * its own replies as new inbound and loops. We remember `(platformId, text)`
 * briefly after every send, and drop the first match within TTL.
 *
 * Keying on text alone is not enough: if we send "hi" to Alice and Bob then
 * sends "hi" from a different chat, Bob's real message gets silently dropped.
 */
class EchoCache {
  private entries = new Map<string, number>();

  private keyFor(platformId: string, text: string): string {
    return `${platformId}\x00${text.trim()}`;
  }

  remember(platformId: string, text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.entries.set(this.keyFor(platformId, trimmed), Date.now());
    this.cleanup();
  }

  isEcho(platformId: string, text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) return false;
    const key = this.keyFor(platformId, trimmed);
    const ts = this.entries.get(key);
    if (!ts) return false;
    if (Date.now() - ts > ECHO_TTL_MS) {
      this.entries.delete(key);
      return false;
    }
    this.entries.delete(key);
    return true;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, ts] of this.entries) {
      if (now - ts > ECHO_TTL_MS) this.entries.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// PAT: Lazy mg + destination auto-provisioning
// ---------------------------------------------------------------------------

/**
 * Strip a Signal E164 (`+15550100000`) down to the `signal-<digits>` form used
 * for the destination's local_name. Non-numeric platformIds (UUIDs without a
 * `+` prefix) fall through unchanged with the `signal-` prefix. Group ids land
 * as `signal-group-<8-char prefix>` so back-mind reverse-lookup against
 * (channel_type, platform_id) still finds something readable for groups.
 */
function destinationNameForSignal(platformId: string, isGroup: boolean): string {
  if (isGroup) {
    const groupId = platformId.startsWith('group:') ? platformId.slice('group:'.length) : platformId;
    return `signal-group-${groupId.slice(0, 8)}`;
  }
  // Strip leading + (E164) or namespace prefix; keep the rest verbatim so that
  // `+15550100000` → `signal-15550100000`, matching the pattern an operator
  // already sees on `realtime-15550100000`.
  const handle = platformId.replace(/^\+/, '');
  return `signal-${handle}`;
}

/**
 * Idempotent: ensure a `messaging_groups` row + `messaging_group_agents`
 * wiring exists for this signal sender. On first contact, copies wiring from
 * any existing signal mg (seeded once at install time via `/init-first-agent`
 * or manual SQL — see `.claude/skills/add-signal/SKILL.md`). Returns null
 * when no seed exists — caller falls through to the router's auto-create path
 * (which silently escalates to channel-approval and stays unwired under
 * `PAT_ADMINS_BYPASS_APPROVAL`).
 *
 * Side effects:
 *   - INSERT messaging_groups (mg.name = destinationNameForSignal so
 *     createMessagingGroupAgent's auto-destination uses the desired
 *     `signal-<E164>` local_name)
 *   - INSERT messaging_group_agents (also creates agent_destinations row
 *     via the implicit auto-create in createMessagingGroupAgent — see
 *     src/db/messaging-groups.ts:132)
 *   - writeDestinations() for any active session of the wired agent
 *     group so the running container's inbound.db destinations table
 *     learns about the new destination before the back-mind replies.
 *     Without this, session_mode='shared' containers serve a stale
 *     projection and reverse-lookup returns nothing.
 */
function ensureSignalMessagingGroup(
  platformId: string,
  isGroup: boolean,
): { id: string; platform_id: string; agent_group_id: string } | null {
  const existing = getMessagingGroupByPlatform('signal', platformId);
  if (existing) {
    // Already wired — just resolve the agent group so callers can decide
    // whether to refresh the destination projection (in case the row was
    // created but the destination got lost / the session is newly running).
    const mga = getMessagingGroupAgents(existing.id)[0];
    if (!mga) return null;
    return { id: existing.id, platform_id: existing.platform_id, agent_group_id: mga.agent_group_id };
  }

  const seed = resolveSeedAgentForChannel('signal');
  if (!seed) {
    log.warn('signal: ensureSignalMessagingGroup: no seed mg + wired agent to copy wiring from', { platformId });
    return null;
  }

  const destName = destinationNameForSignal(platformId, isGroup);
  const result = provisionMessagingGroup({
    channelType: 'signal',
    platformId,
    // Name controls the default destination local_name via normalizeName in
    // createMessagingGroupAgent — `signal-15550100000` survives normalization
    // unchanged, so the destination row lands with the desired name without
    // an extra createDestination call.
    mgName: destName,
    isGroup: isGroup ? 1 : 0,
    unknownSenderPolicy: seed.seedMg.unknown_sender_policy ?? 'public',
    mga: {
      agent_group_id: seed.seedMga.agent_group_id,
      engage_mode: seed.seedMga.engage_mode,
      engage_pattern: seed.seedMga.engage_pattern,
      sender_scope: seed.seedMga.sender_scope,
      ignored_message_policy: seed.seedMga.ignored_message_policy,
      session_mode: seed.seedMga.session_mode,
      priority: seed.seedMga.priority,
    },
  });

  log.event({
    kind: 'misc',
    data: {
      msg: 'signal: auto-provisioned messaging_group + destination for new sender',
      channel_type: 'signal',
      platform_id: platformId,
      is_group: isGroup,
      agent_group_id: result.agent_group_id,
      mg_id: result.id,
      destination_name: result.destination_name,
    },
  });

  // Project the new destination into any running session's inbound.db.
  // session_mode='shared' means one container handles every sender, so a
  // session is likely already running with a stale destinations table.
  // Without this, the back-mind's reverse-lookup for the new sender's
  // channel_type+platform_id returns nothing on the first turn.
  void refreshDestinationsForAgentGroup(result.agent_group_id);

  return { id: result.id, platform_id: result.platform_id, agent_group_id: result.agent_group_id };
}

/**
 * Re-project agent_destinations into the inbound.db of every active session
 * for an agent group. Used after auto-provisioning a new signal destination
 * so already-running containers (session_mode='shared') see the new row on
 * their next destinations lookup without waiting for next wake.
 *
 * Awaitable but fire-and-forget at call sites — best-effort sync, errors
 * logged. The writeDestinations module is dynamically imported so signal.ts
 * stays usable when the agent-to-agent module isn't installed (table
 * absent ⇒ no destinations to project).
 */
async function refreshDestinationsForAgentGroup(agentGroupId: string): Promise<void> {
  try {
    const sessions = getSessionsByAgentGroup(agentGroupId).filter((s) => s.status === 'active');
    if (sessions.length === 0) return;
    const { writeDestinations } = await import('../modules/agent-to-agent/write-destinations.js');
    for (const session of sessions) {
      try {
        writeDestinations(agentGroupId, session.id);
      } catch (err) {
        log.warn('signal: writeDestinations failed for session', { sessionId: session.id, err });
      }
    }
  } catch (err) {
    // Module not installed → table absent. Silent skip matches the
    // container-runner.ts guarded import pattern.
    log.debug('signal: refreshDestinationsForAgentGroup skipped', { err });
  }
}

// ---------------------------------------------------------------------------
// Signal envelope types
// ---------------------------------------------------------------------------

interface SignalQuote {
  id?: number;
  author?: string;
  authorNumber?: string;
  authorUuid?: string;
  authorName?: string;
  text?: string;
}

interface SignalMention {
  start?: number;
  length?: number;
  uuid?: string;
  number?: string;
  name?: string;
}

interface SignalDataMessage {
  timestamp?: number;
  message?: string;
  mentions?: SignalMention[];
  groupInfo?: { groupId?: string; groupName?: string; type?: string };
  groupV2?: { id?: string };
  quote?: SignalQuote;
  attachments?: Array<{
    id?: string;
    contentType?: string;
    filename?: string;
    size?: number;
  }>;
}

interface SignalEnvelope {
  source?: string;
  sourceName?: string;
  sourceNumber?: string;
  sourceUuid?: string;
  dataMessage?: SignalDataMessage;
  syncMessage?: {
    sentMessage?: SignalDataMessage & {
      destination?: string;
      destinationNumber?: string;
    };
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Replace inline `@<placeholder>` mention markers with display names so the
 * agent sees `@Alice` instead of a raw UUID. Signal's protocol uses a single
 * placeholder character (typically U+FFFC) at each mention's `start` offset.
 */
function resolveMentions(text: string, mentions?: SignalMention[]): string {
  if (!mentions || mentions.length === 0) return text;
  const sorted = [...mentions].sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  let result = '';
  let cursor = 0;
  for (const m of sorted) {
    const start = m.start ?? 0;
    const length = m.length ?? 1;
    const name = m.name || m.number || (m.uuid ? m.uuid.slice(0, 8) : 'someone');
    if (start < cursor) continue;
    result += text.slice(cursor, start) + `@${name}`;
    cursor = start + length;
  }
  result += text.slice(cursor);
  return result;
}

/**
 * Inbound voice-note transcription — unified onto the shared Scribe path
 * (src/modules/voice/transcribe.ts, ElevenLabs Scribe). Returns null on any
 * failure; caller falls back to a `[Voice Message]` placeholder.
 */
// PAT (task #10): fetch attachment bytes from signal-cli over the
// existing JSON-RPC channel. signal-cli's `getAttachment` command
// returns the bytes base64-encoded; we decode + write to a tempfile
// under tmpdir() so the caller can feed it through the same
// transcribe-audio / Read-tool pipeline that the local-host mode
// uses. Returns the tempfile path or null on any failure (RPC error,
// timeout, missing field). Caller is responsible for cleanup.
//
// `recipient` and `groupId` come from the originating envelope and
// scope the lookup — signal-cli's GetAttachmentCommand requires one
// or the other (mutually exclusive). For DMs, pass `recipient` =
// envelope.source. For groups, pass `groupId` = dataMessage.groupV2.id
// (or .groupInfo.groupId for legacy V1).
//
// Uses a 60s timeout instead of the default 15s — Signal supports
// attachments up to ~100MB, and base64-over-localhost can take long
// enough that the default would spuriously fail on legit images.
const RPC_ATTACHMENT_TIMEOUT_MS = 60_000;

async function fetchAttachmentViaRpc(
  tcp: SignalTcpClient,
  account: string,
  attachmentId: string,
  scope: { recipient?: string; groupId?: string },
  extension = '',
): Promise<string | null> {
  if (!scope.recipient && !scope.groupId) {
    log.warn('Signal: getAttachment called without recipient or groupId', { attachmentId });
    return null;
  }
  try {
    const params: Record<string, unknown> = { id: attachmentId };
    if (account) params.account = account;
    if (scope.recipient) params.recipient = scope.recipient;
    if (scope.groupId) params.groupId = scope.groupId;

    // signal-cli's JsonAttachmentData response shape (v0.14.x):
    //   { id, contentType, filename, size, data: "<base64>" }
    // The `data` field is the payload; everything else is metadata
    // already available from the inbound envelope.
    const result = await tcp.rpc<{ data?: string }>('getAttachment', params, RPC_ATTACHMENT_TIMEOUT_MS);
    const b64 = result?.data;
    if (typeof b64 !== 'string' || b64.length === 0) {
      log.warn('Signal: getAttachment returned no data', { attachmentId });
      return null;
    }
    const tempPath = join(
      tmpdir(),
      `signal-in-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${attachmentId}${extension}`,
    );
    writeFileSync(tempPath, Buffer.from(b64, 'base64'));
    return tempPath;
  } catch (err) {
    log.warn('Signal: getAttachment RPC failed', { attachmentId, err });
    return null;
  }
}

async function transcribeAudioOptional(filePath: string): Promise<string | null> {
  // PAT: unified onto the shared Scribe path. Signal voice notes are raw
  // AAC/ADTS, which ElevenLabs Scribe ingests directly (verified
  // 2026-06-19) — no ffmpeg pre-transcode needed. Host-side, so it relies
  // on ELEVENLABS_API_KEY (the host isn't OneCLI-proxied).
  try {
    const bytes = readFileSync(filePath);
    return await transcribeVoice(bytes, { mimeType: 'audio/aac' });
  } catch (err) {
    log.warn('Signal: voice transcription failed', { err });
    return null;
  }
}

async function synthesizeVoiceMemoOptional(text: string, voiceId?: string): Promise<string | null> {
  // PAT: unified onto the shared Cartesia Sonic synth. Signal's native iOS
  // voice-note bubble needs AAC/m4a (empirically — opus-in-ogg renders as a
  // generic tile), so we request that format. Returns a temp file path
  // (caller sendVoiceNote owns cleanup) or null → caller falls back to text.
  return synthesizeVoiceMemo(text, voiceId, { format: 'm4a' });
}

function chunkText(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt <= 0) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }
  return chunks;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Signal text styles — convert Markdown to Signal's offset-based formatting
// ---------------------------------------------------------------------------

interface SignalTextStyle {
  style: 'BOLD' | 'ITALIC' | 'STRIKETHROUGH' | 'MONOSPACE' | 'SPOILER';
  start: number;
  length: number;
}

interface StyledText {
  text: string;
  textStyles: SignalTextStyle[];
}

/**
 * Convert Markdown-ish input to Signal's offset-based style ranges.
 *
 * Walks the input recursively: at each level we find the leftmost matching
 * pattern, descend into its captured inner text (so `**bold with \`code\`
 * inside**` stays bold-plus-monospace rather than leaking stripped markers),
 * then continue past the match. Style offsets are recorded against the
 * *output* text length as it's built, so nested styles always point at the
 * right span of the final plain text.
 */
function parseSignalStyles(input: string): StyledText {
  const styles: SignalTextStyle[] = [];

  // Ordering matters: longer/greedier delimiters first so `` ``` `` beats
  // `` ` ``, `**` beats `*`. The italic-`*` pattern refuses to start on
  // whitespace so `*` isn't mistakenly opened on " * " in list-like text.
  const patterns: Array<{ regex: RegExp; style: SignalTextStyle['style'] }> = [
    { regex: /```([\s\S]+?)```/, style: 'MONOSPACE' },
    { regex: /`([^`]+)`/, style: 'MONOSPACE' },
    { regex: /\*\*([^]+?)\*\*/, style: 'BOLD' },
    { regex: /~~([^]+?)~~/, style: 'STRIKETHROUGH' },
    { regex: /\|\|([^]+?)\|\|/, style: 'SPOILER' },
    { regex: /\*([^*\s][^*]*?)\*/, style: 'ITALIC' },
    { regex: /_([^_\s][^_]*?)_/, style: 'ITALIC' },
  ];

  function walk(segment: string, outputBase: number): string {
    let earliest: { start: number; match: RegExpExecArray; style: SignalTextStyle['style'] } | null = null;
    for (const { regex, style } of patterns) {
      const m = regex.exec(segment);
      if (!m) continue;
      if (earliest === null || m.index < earliest.start) {
        earliest = { start: m.index, match: m, style };
      }
    }
    if (!earliest) return segment;

    const before = segment.slice(0, earliest.start);
    const fullMatch = earliest.match[0];
    const inner = earliest.match[1];
    const afterStart = earliest.start + fullMatch.length;
    const after = segment.slice(afterStart);

    const innerOut = walk(inner, outputBase + before.length);
    styles.push({
      style: earliest.style,
      start: outputBase + before.length,
      length: innerOut.length,
    });
    const afterOut = walk(after, outputBase + before.length + innerOut.length);

    return before + innerOut + afterOut;
  }

  const text = walk(input, 0);
  return { text, textStyles: styles };
}

// ---------------------------------------------------------------------------
// SignalAdapter — v2 ChannelAdapter implementation
// ---------------------------------------------------------------------------

/**
 * Platform ID format:
 *   DM:    phone number or UUID (e.g. "+15555550123")
 *   Group: "group:<groupId>" (e.g. "group:abc123")
 *
 * channelType is always "signal". The router combines channelType + platformId
 * to look up or create the messaging_group.
 */
export function createSignalAdapter(config: {
  cliPath: string;
  account: string;
  tcpHost: string;
  tcpPort: number;
  manageDaemon: boolean;
  signalDataDir: string;
}): ChannelAdapter {
  let daemon: DaemonHandle | null = null;
  let tcp: SignalTcpClient | null = null;
  let connected = false;
  const echoCache = new EchoCache();
  let setup: ChannelSetup | null = null;

  // PAT 2026-06-25: auto-reconnect state. The daemon lives in a sibling Fly
  // machine (pat-transports) and is restarted out-of-band — by deploys, by Fly
  // recycling, and now by the receive-liveness watchdog (transports/signal-cli/
  // watchdog.sh) when signal-cli's receive loop wedges on a poison envelope.
  // Each daemon bounce drops our TCP socket; without auto-reconnect the adapter
  // stayed silently disconnected until nanoclaw itself was restarted. We now
  // re-dial + re-`subscribeReceive` on a capped exponential backoff so a daemon
  // restart self-heals end-to-end. `stopped` gates the loop off during teardown.
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  const RECONNECT_BASE_MS = 1_000;
  const RECONNECT_MAX_MS = 30_000;

  // -- inbound handling --

  function handleNotification(method: string, params: unknown): void {
    if (method === 'receive') {
      const envelope = (params as any)?.envelope;
      if (envelope) {
        handleEnvelope(envelope).catch((err) => {
          log.error('Signal: error handling envelope', { err });
        });
      }
    }
  }

  async function handleEnvelope(envelope: SignalEnvelope): Promise<void> {
    if (!setup) return;

    // Sync messages (sent from another device)
    const syncSent = envelope.syncMessage?.sentMessage;
    if (syncSent) {
      const dest = (syncSent.destinationNumber ?? syncSent.destination ?? '').trim();
      // "Note to Self" — destination is our own account
      if (dest === config.account) {
        const text = (syncSent.message ?? '').trim();
        if (!text) return;
        const platformId = config.account;
        if (echoCache.isEcho(platformId, text)) return;
        const timestamp = syncSent.timestamp ? new Date(syncSent.timestamp).toISOString() : new Date().toISOString();

        setup.onMetadata(platformId, 'Note to Self', false);

        const msg: InboundMessage = {
          id: String(syncSent.timestamp ?? Date.now()),
          kind: 'chat',
          content: {
            text,
            sender: config.account,
            senderId: `signal:${config.account}`,
            senderName: 'Me',
            isFromMe: true,
            ...(syncSent.quote ? quoteToContent(syncSent.quote) : {}),
          },
          timestamp,
        };
        await setup.onInbound(platformId, null, msg);
        return;
      }
      // Other sync messages are our outbound — skip
      return;
    }

    const dataMessage = envelope.dataMessage;
    if (!dataMessage) return;

    const rawText = (dataMessage.message ?? '').trim();
    let text = rawText ? resolveMentions(rawText, dataMessage.mentions) : '';

    const audioAttachment = dataMessage.attachments?.find((a) => a.contentType?.startsWith('audio/') && a.id);
    const imageAttachments = dataMessage.attachments?.filter((a) => a.contentType?.startsWith('image/') && a.id) ?? [];
    const hasVoice = !text && !!audioAttachment;

    // PAT: document/video-only messages (no text, no audio, no image) were
    // silently dropped by the guard below, so the agent never saw them. Surface
    // a text stub naming the file(s) so the message still reaches the back-mind.
    const otherAttachments =
      dataMessage.attachments?.filter(
        (a) => !a.contentType || (!a.contentType.startsWith('audio/') && !a.contentType.startsWith('image/')),
      ) ?? [];
    if (!text && !hasVoice && imageAttachments.length === 0 && otherAttachments.length > 0) {
      text = otherAttachments
        .map((a) => `[received a file: ${a.filename ?? 'unnamed'}${a.contentType ? ` (${a.contentType})` : ''}]`)
        .join(' ');
    }

    if (!text && !hasVoice && imageAttachments.length === 0) return;

    const sender = (envelope.sourceNumber ?? envelope.sourceUuid ?? envelope.source ?? '').trim();
    if (!sender) return;

    const senderName = (envelope.sourceName?.trim() || sender).trim();

    // Modern Signal groups use groupV2; legacy groupInfo.groupId is the
    // pre-V2 fallback. Without the V2 read, V2-only groups appear as DMs
    // because `groupInfo` is undefined.
    const groupInfo = dataMessage.groupInfo;
    const groupId = dataMessage.groupV2?.id ?? groupInfo?.groupId;
    const isGroup = Boolean(groupId);

    const platformId = isGroup ? `group:${groupId}` : sender;

    if (text && echoCache.isEcho(platformId, text)) {
      log.debug('Signal: skipping echo', { platformId });
      return;
    }
    const timestamp = dataMessage.timestamp ? new Date(dataMessage.timestamp).toISOString() : new Date().toISOString();

    const chatName = groupInfo?.groupName ?? (isGroup ? `Group ${groupId?.slice(0, 8)}` : senderName);

    setup.onMetadata(platformId, chatName, isGroup);

    // PAT: lazy mg + destination provisioning for new senders. On first
    // contact this creates the messaging_groups row + messaging_group_agents
    // wiring (copying from any seed signal mg) AND the agent_destinations
    // row (auto-created by createMessagingGroupAgent with local_name
    // `signal-<E164 sans +>`). For already-known senders this is a single
    // DB read short-circuit. Skipped silently when no seed mg exists —
    // router.ts's auto-create path then runs and escalates to channel-
    // approval as the legacy behavior. Throwing here would silently break
    // legitimate inbound; we log and move on.
    try {
      ensureSignalMessagingGroup(platformId, isGroup);
    } catch (err) {
      log.warn('signal: ensureSignalMessagingGroup failed (continuing)', { platformId, err });
    }

    let content = text;

    // PAT (task #10): attachment access has two modes.
    //
    //   - SIGNAL_ATTACHMENTS_LOCAL=true — single-host install (dev
    //     laptop, shared filesystem). Dereference signal-cli's
    //     attachments/ dir directly. This is the stock upstream path
    //     preserved verbatim.
    //
    //   - default (PAT prod, cross-process) — fetch bytes via
    //     getAttachment over the existing JSON-RPC channel,
    //     materialize a tempfile, feed the same transcription /
    //     Read-tool pipeline. signal-cli's getAttachment requires
    //     either `recipient` or `groupId` to scope the lookup; both
    //     are already on the envelope.
    //
    // Any failure (RPC error, missing data, timeout) falls back to
    // the `[Voice Message]` / `[Image]` placeholder — agent still
    // sees an attachment existed, just without bytes.
    const attachmentsLocal = process.env.SIGNAL_ATTACHMENTS_LOCAL === 'true';
    const rpcScope: { recipient?: string; groupId?: string } = isGroup ? { groupId: groupId! } : { recipient: sender };

    if (hasVoice && audioAttachment?.id) {
      let voiceLocalPath: string | null = null;
      let isTempfile = false;

      if (attachmentsLocal) {
        const attachmentPath = join(config.signalDataDir, 'attachments', audioAttachment.id);
        if (existsSync(attachmentPath)) {
          voiceLocalPath = attachmentPath;
        } else {
          log.warn('Signal: voice attachment file not found', {
            id: audioAttachment.id,
            path: attachmentPath,
          });
          content = '[Voice Message - file not found]';
        }
      } else if (tcp) {
        voiceLocalPath = await fetchAttachmentViaRpc(
          tcp,
          config.account,
          audioAttachment.id,
          rpcScope,
          audioAttachment.contentType?.includes('aac') ? '.aac' : '',
        );
        isTempfile = voiceLocalPath !== null;
        if (!voiceLocalPath) {
          content = '[Voice Message]';
        }
      } else {
        content = '[Voice Message]';
      }

      if (voiceLocalPath) {
        log.info('Signal: voice attachment received', {
          platformId,
          attachmentId: audioAttachment.id,
          mode: attachmentsLocal ? 'local' : 'rpc',
        });
        const transcript = await transcribeAudioOptional(voiceLocalPath);
        if (transcript) {
          content = `[Voice: ${transcript}]`;
          log.info('Signal: voice transcribed', { platformId, length: transcript.length });
        } else {
          content = '[Voice Message]';
        }
        if (isTempfile) {
          try {
            unlinkSync(voiceLocalPath);
          } catch {
            /* best-effort */
          }
        }
      }
    }

    // PAT (task #10): image attachments — same two-mode pattern as
    // voice. Inject `[Image: <localpath>]` so the agent's Read tool
    // can dereference; in RPC mode the localpath is a tempfile we
    // just materialized. Tempfiles are left for OS cleanup since the
    // back-mind's Read tool may call several turns later.
    const attachmentRefs: Array<{ path?: string; contentType: string; id: string }> = [];
    for (const img of imageAttachments) {
      let imagePath: string | null = null;
      if (attachmentsLocal) {
        imagePath = join(config.signalDataDir, 'attachments', img.id!);
      } else if (tcp) {
        imagePath = await fetchAttachmentViaRpc(
          tcp,
          config.account,
          img.id!,
          rpcScope,
          (img.contentType || '').split('/')[1] ? `.${(img.contentType || '').split('/')[1]}` : '',
        );
      }
      if (imagePath) {
        const imageLine = `[Image: ${imagePath}]`;
        content = content ? `${content}\n${imageLine}` : imageLine;
        attachmentRefs.push({ path: imagePath, contentType: img.contentType || 'image/jpeg', id: img.id! });
      } else {
        const imageLine = `[Image]`;
        content = content ? `${content}\n${imageLine}` : imageLine;
        attachmentRefs.push({ contentType: img.contentType || 'image/jpeg', id: img.id! });
      }
    }

    const msg: InboundMessage = {
      id: String(dataMessage.timestamp ?? Date.now()),
      kind: 'chat',
      content: {
        text: content,
        sender,
        senderId: `signal:${sender}`,
        senderName,
        ...(attachmentRefs.length > 0 ? { attachments: attachmentRefs } : {}),
        ...(dataMessage.quote ? quoteToContent(dataMessage.quote) : {}),
      },
      timestamp,
    };
    await setup.onInbound(platformId, null, msg);

    log.info('Signal message received', { platformId, sender: senderName });

    // PAT 2026-05-14: explicit read receipt for this specific message.
    // The global `readReceipts: true` updateConfiguration we set is a
    // necessary precondition (without it, signal-cli refuses to send
    // receipts at all), but signal-cli ALSO requires an explicit
    // sendReceipt call per envelope to actually fire — it doesn't
    // auto-ack messages when the daemon receives them. Fire-and-forget,
    // best-effort: if it fails, the user just doesn't get the
    // double-check bubble, no functional regression.
    if (tcp && typeof dataMessage.timestamp === 'number' && sender) {
      try {
        const params: Record<string, unknown> = {
          recipient: sender,
          targetTimestamp: [dataMessage.timestamp],
          type: 'read',
        };
        if (config.account) params.account = config.account;
        await tcp.rpc('sendReceipt', params);
      } catch (err) {
        const errInfo = err instanceof Error ? { message: err.message, name: err.name } : { value: String(err) };
        log.debug('Signal: sendReceipt failed', { platformId, err: errInfo });
      }
    }
  }

  /**
   * Build the `replyTo` object the agent-runner formatter expects (see
   * `container/agent-runner/src/formatter.ts:formatReplyContext`). The
   * formatter requires both `sender` and `text` to render the
   * `<quoted_message>` block; absent either, it omits the block entirely.
   *
   * The previous shape (`replyToSenderName` / `replyToMessageContent` /
   * `replyToMessageId` flat keys) did not match the formatter contract, so
   * quote-reply context was silently dropped end-to-end.
   */
  function quoteToContent(quote: SignalQuote): Record<string, unknown> {
    const sender = quote.authorName || quote.authorNumber || quote.author || quote.authorUuid || 'someone';
    const text = quote.text || '';
    return {
      replyTo: {
        id: quote.id ? String(quote.id) : undefined,
        sender,
        text,
      },
    };
  }

  // -- send helpers --

  // PAT: signal-cli `send` RPC returns `{ timestamp: number }` on success
  // (the canonical Signal Service-side identifier). The timestamp is the
  // forensic anchor — it equals `dataMessage.timestamp` on the receiver's
  // inbound envelope and is what surfaces in the Signal Service ack flow.
  // Best-effort coercion: any object response with a numeric `timestamp`.
  // Falls back to 0 when signal-cli responds with a different shape (rare
  // in 0.14.x, but the structured event still records the ack happened).
  function extractSignalTimestamp(result: unknown): number {
    if (result && typeof result === 'object' && 'timestamp' in result) {
      const ts = (result as { timestamp: unknown }).timestamp;
      if (typeof ts === 'number') return ts;
      if (typeof ts === 'string') {
        const parsed = Number(ts);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
    return 0;
  }

  // PAT: pull the human-readable message off an Error so the structured
  // event records the actual signal-cli rejection (e.g. "Unregistered
  // user", "Group not found", "Network unreachable") rather than `{}`.
  function errorMessageOf(err: unknown): string {
    if (err instanceof Error) return err.message || err.name;
    return String(err);
  }

  // PAT: emit `signal.send-acked` / `signal.send-failed` after every
  // signal-cli `send` RPC roundtrip. Closes the observability gap where
  // the only post-enqueue evidence today is `routing.message-routed`
  // (which fires on enqueue, not on actual delivery to the Signal
  // Service). Today's silent try/catch around rpc('send') swallowed the
  // failure case entirely — `kind_detail` distinguishes the three RPC
  // call sites (text body vs plain attachment vs voice-memo) since each
  // has separate failure modes (textStyle rejection retry, MIME sniff
  // mismatch, staging-sidecar fallback, etc.).
  type SignalSendKindDetail = 'text' | 'attachment' | 'voice-memo';
  function emitSendAcked(
    platformId: string,
    rpcResult: unknown,
    kindDetail: SignalSendKindDetail,
    attemptNo?: number,
  ): void {
    const isGroup = platformId.startsWith('group:');
    const data: Record<string, unknown> = {
      account: config.account ?? '',
      recipient: isGroup ? '' : platformId,
      signal_timestamp: extractSignalTimestamp(rpcResult),
      kind_detail: kindDetail,
    };
    if (isGroup) data.group_id = platformId.slice('group:'.length);
    if (typeof attemptNo === 'number') data.attempt_no = attemptNo;
    log.event({ kind: 'signal.send-acked', platform_id: platformId, data });
  }
  function emitSendFailed(
    platformId: string,
    err: unknown,
    kindDetail: SignalSendKindDetail,
    attemptNo?: number,
  ): void {
    const isGroup = platformId.startsWith('group:');
    const data: Record<string, unknown> = {
      account: config.account ?? '',
      recipient: isGroup ? '' : platformId,
      error: errorMessageOf(err),
      kind_detail: kindDetail,
    };
    if (isGroup) data.group_id = platformId.slice('group:'.length);
    if (typeof attemptNo === 'number') data.attempt_no = attemptNo;
    log.event({ kind: 'signal.send-failed', level: 'error', platform_id: platformId, data });
  }

  async function sendText(platformId: string, text: string): Promise<void> {
    // PAT: throw (not silent-return) when the daemon is mid-reconnect so
    // adapter.deliver rejects and delivery.ts retries with backoff. Silent-
    // returning marked the row delivered during every pat-transports bounce
    // window — the reply was lost with no retry and outbound.sent still fired.
    if (!connected || !tcp) {
      throw new Error(`Signal not connected — deferring send to ${platformId} for retry`);
    }

    echoCache.remember(platformId, text);

    const MAX_CHUNK = 4000;
    const chunks = text.length <= MAX_CHUNK ? [text] : chunkText(text, MAX_CHUNK);

    for (const chunk of chunks) {
      // PAT: `attemptNo` lifted to the outer try scope so the outer
      // catch's `signal.send-failed` emit records which RPC roundtrip
      // (textStyle attempt 1 vs markup-fallback attempt 2) ultimately
      // failed.
      let attemptNo = 1;
      try {
        const { text: plainText, textStyles } = parseSignalStyles(chunk);
        const params: Record<string, unknown> = { message: plainText };
        if (config.account) params.account = config.account;
        if (textStyles.length > 0) {
          params.textStyle = textStyles.map((s) => `${s.start}:${s.length}:${s.style}`);
        }

        if (platformId.startsWith('group:')) {
          params.groupId = platformId.slice('group:'.length);
        } else {
          params.recipient = [platformId];
        }

        // PAT: each rpc('send') call site emits `signal.send-acked`
        // (success) or `signal.send-failed` (RPC rejected). Today's
        // silent outer try/catch swallowed the failure case — pat-trace
        // could only see `routing.message-routed` (enqueue) and had no
        // way to tell "queued in nanoclaw" from "actually shipped" from
        // "signal-cli rejected." These events close that gap.
        //
        // Pattern: success branches emit `signal.send-acked` inline at
        // the rpc('send') call site so retries record attempt 1 vs
        // attempt 2 distinctly. The textStyle-retry path also emits
        // `signal.send-failed` for attempt 1 before retrying (the
        // wire-level rejection still happened). The outer catch emits
        // the terminal failure when retry-or-no-retry exhausts.
        try {
          const result = await tcp.rpc('send', params);
          emitSendAcked(platformId, result, 'text', attemptNo);
        } catch (styledErr) {
          if (textStyles.length > 0) {
            log.debug('Signal: textStyle rejected, retrying with markup');
            // Record the textStyle-rejected attempt 1 up-front so the
            // timeline reflects what happened on the wire; the retry
            // either acks attempt 2 inline or rethrows into the outer
            // catch (which then logs attempt 2 as failed).
            emitSendFailed(platformId, styledErr, 'text', attemptNo);
            attemptNo = 2;
            delete params.textStyle;
            params.message = chunk;
            const result2 = await tcp.rpc('send', params);
            emitSendAcked(platformId, result2, 'text', attemptNo);
          } else {
            throw styledErr;
          }
        }
      } catch (err) {
        // PAT: emit the terminal failure structured event alongside the
        // historical log.error. Without this, the silent outer catch
        // dropped the failure signal — the back-mind's `send_message`
        // MCP tool returned success-on-enqueue and the user heard "I
        // sent it" with no log evidence the RPC ever errored.
        emitSendFailed(platformId, err, 'text', attemptNo);
        log.error('Signal: send failed', { platformId, err });
        // PAT: rethrow so adapter.deliver rejects → delivery.ts retry/mark-
        // failed path engages instead of marking a never-sent message
        // delivered. (A multi-chunk message may re-send earlier chunks on
        // retry — rare, and far better than silently losing the whole reply.)
        throw err;
      }
    }

    log.info('Signal message sent', { platformId, length: text.length });
  }

  /**
   * Send one or more file attachments via signal-cli's `send` JSON-RPC, which
   * accepts an `attachments` array of host filesystem paths. The OutboundFile
   * Buffer is materialized to an OS temp file so signal-cli can read it, then
   * removed in the finally block.
   *
   * Caption text, if any, is sent first via `sendText` (which handles chunking
   * + textStyles) — keeps this function single-purpose and avoids a long
   * caption colliding with signal-cli's per-message size limits.
   */
  async function sendAttachments(platformId: string, files: { filename: string; data: Buffer }[]): Promise<void> {
    // PAT: throw on disconnect (see sendText) so delivery retries rather than
    // silently marking the attachment delivered during a reconnect window.
    if (!connected || !tcp) {
      throw new Error(`Signal not connected — deferring attachment send to ${platformId} for retry`);
    }
    if (files.length === 0) return;

    // PAT 2026-05-13 (real fix): signal-cli runs on the sibling
    // pat-transports fly machine, NOT colocated with nanoclaw. The
    // earlier impl wrote bytes to /tmp on nanoclaw and passed the
    // local path to signal-cli — which then errored with
    // AttachmentInvalidException ("No such file or directory")
    // because /tmp on pat-nanoclaw and /tmp on pat-transports are
    // different filesystems. Bytes must cross the boundary inline.
    //
    // signal-cli 0.14.x accepts attachments as `data:<mime>;base64,…`
    // URLs in the `send` JSON-RPC params — mirrors how getAttachment
    // returns base64 on the inbound side. No tempfile needed.
    const dataUrls: string[] = files.map(
      (f) => `data:${guessMimeFromFilename(f.filename)};base64,${f.data.toString('base64')}`,
    );

    try {
      const params: Record<string, unknown> = { message: '', attachments: dataUrls };
      if (config.account) params.account = config.account;
      if (platformId.startsWith('group:')) {
        params.groupId = platformId.slice('group:'.length);
      } else {
        params.recipient = [platformId];
      }
      // PAT: emit `signal.send-acked` with the signal-cli timestamp on
      // success; `signal.send-failed` on RPC error. See sendText for
      // the rationale behind the kind_detail discriminator.
      const result = await tcp.rpc('send', params);
      emitSendAcked(platformId, result, 'attachment', 1);
      log.info('Signal attachments sent', { platformId, count: files.length, filenames: files.map((f) => f.filename) });
    } catch (err) {
      // PAT: Error objects serialize as `{}` because message/name/stack
      // are non-enumerable. Pull them out explicitly so the actual
      // signal-cli RPC reply surfaces in structured logs.
      const errInfo =
        err instanceof Error ? { message: err.message, name: err.name, stack: err.stack } : { value: String(err) };
      log.error('Signal: attachment send failed', { platformId, count: files.length, err: errInfo });
      emitSendFailed(platformId, err, 'attachment', 1);
      // PAT: rethrow so delivery.ts retries instead of marking delivered.
      throw err;
    }
  }

  // PAT 2026-05-13: best-effort filename → MIME mapping for data: URL
  // attachments. signal-cli's data-URL parser uses the MIME to route
  // the payload; unknown types fall back to application/octet-stream
  // (signal-cli still delivers, the Signal client renders based on
  // filename + magic-byte sniffing).
  function guessMimeFromFilename(filename: string): string {
    const m = /\.([a-z0-9]+)$/i.exec(filename);
    const ext = m?.[1]?.toLowerCase();
    switch (ext) {
      case 'png':
        return 'image/png';
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg';
      case 'gif':
        return 'image/gif';
      case 'webp':
        return 'image/webp';
      case 'pdf':
        return 'application/pdf';
      case 'txt':
        return 'text/plain';
      case 'md':
        return 'text/markdown';
      case 'mp3':
        return 'audio/mpeg';
      case 'mp4':
        return 'video/mp4';
      case 'mov':
        return 'video/quicktime';
      case 'webm':
        return 'video/webm';
      case 'json':
        return 'application/json';
      default:
        return 'application/octet-stream';
    }
  }

  /**
   * PAT (task #15): send an ogg/opus audio file as a Signal voice note.
   *
   * Mirrors `sendAttachments` but adds `voiceNote: true` to the JSON-RPC
   * `send` params — signal-cli 0.14.3's SendCommand has this flag
   * (`--voice-note` in CLI form) which marks the attachment for inline
   * voice-note rendering in Signal clients (the hold-to-listen bubble,
   * not a generic audio tile). The caller owns the on-disk path and
   * passes it through — we unlink it in the finally regardless of RPC
   * outcome so the caller doesn't have to.
   */
  async function sendVoiceNote(platformId: string, oggPath: string): Promise<boolean> {
    if (!connected || !tcp) return false;
    // PAT 2026-05-13 (real fix): voice notes need to come into signal-cli
    // as a real local path on the same machine — not a data: URL —
    // because the Signal client only renders the native voice-memo
    // bubble (waveform, hold-to-listen, server transcription, speed
    // controls) when the AttachmentPointer carries both the VOICE_MESSAGE
    // flag AND a non-null filename, with content sniffed from a file
    // upload rather than a data URI buffer.
    //
    // The data: URL approach (works fine for plain attachments) was
    // shipping bytes through, but Signal clients fell back to a generic
    // "audio file" tile. We stage the bytes onto signal-cli's machine
    // first via a tiny HTTP sidecar (transports/signal_staging.py),
    // then pass the resulting `/tmp/signal-stage-XXX.ogg` path to the
    // `send` JSON-RPC — same as if signal-cli were colocated.
    //
    // Falls back to the data: URL path if staging is unreachable, so
    // voice memos still arrive (just as plain attachments) rather than
    // silently dropping.
    const stagingBase =
      process.env.SIGNAL_STAGING_URL ?? `http://${config.tcpHost}:${process.env.SIGNAL_STAGING_PORT ?? '7584'}`;
    let bytes: Buffer;
    try {
      bytes = readFileSync(oggPath);
    } catch (err) {
      const errInfo = err instanceof Error ? { message: err.message, name: err.name } : { value: String(err) };
      log.error('Signal: voice note read failed', { platformId, oggPath, err: errInfo });
      return false;
    }

    // PAT: extension MUST match the actual encoded format so signal-cli's
    // MimeUtils.getFileMimeType picks the right Content-Type. Switched
    // from `.ogg` to `.m4a` 2026-05-13 alongside the encoder swap to
    // AAC — iOS Signal only renders voice-note bubbles for AAC m4a.
    let remotePath: string | null = null;
    try {
      const res = await fetch(`${stagingBase}/stage?ext=.m4a`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(bytes),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        const body = (await res.json()) as { path?: string };
        if (typeof body.path === 'string' && body.path.startsWith('/tmp/')) {
          remotePath = body.path;
        } else {
          log.warn('Signal: staging returned unexpected body', { body });
        }
      } else {
        log.warn('Signal: staging POST non-2xx', { status: res.status });
      }
    } catch (err) {
      const errInfo = err instanceof Error ? { message: err.message, name: err.name } : { value: String(err) };
      log.warn('Signal: staging POST failed (falling back to data: URL)', { err: errInfo });
    }

    // Build attachment ref: prefer the staged path on signal-cli's
    // machine; fall back to data: URL with filename param if staging
    // was unreachable.
    const attachmentRef = remotePath ?? `data:audio/mp4;filename=voice-memo.m4a;base64,${bytes.toString('base64')}`;

    try {
      const params: Record<string, unknown> = {
        message: '',
        attachments: [attachmentRef],
        voiceNote: true,
      };
      if (config.account) params.account = config.account;
      if (platformId.startsWith('group:')) {
        params.groupId = platformId.slice('group:'.length);
      } else {
        params.recipient = [platformId];
      }
      // PAT: voice memos are the third distinct send RPC site — keeping
      // `kind_detail='voice-memo'` separate from 'attachment' lets
      // forensics tell apart voice-note rendering failures (staging
      // sidecar unreachable, MIME mismatch, AAC encoder hiccup) from
      // plain attachment send failures.
      const result = await tcp.rpc('send', params);
      emitSendAcked(platformId, result, 'voice-memo', 1);
      log.info('Signal voice note sent', { platformId, via: remotePath ? 'staged-path' : 'data-url' });
      return true;
    } catch (err) {
      const errInfo =
        err instanceof Error ? { message: err.message, name: err.name, stack: err.stack } : { value: String(err) };
      log.error('Signal: voice note send failed', { platformId, err: errInfo });
      emitSendFailed(platformId, err, 'voice-memo', 1);
      return false;
    } finally {
      try {
        unlinkSync(oggPath);
      } catch {
        /* best-effort cleanup */
      }
    }
  }

  async function waitForDaemon(): Promise<boolean> {
    const maxWait = 30_000;
    const pollInterval = 1000;
    const start = Date.now();

    while (Date.now() - start < maxWait) {
      if (daemon?.isExited()) return false;
      const ok = await signalTcpCheck(config.tcpHost, config.tcpPort);
      if (ok) return true;
      await sleep(pollInterval);
    }
    return false;
  }

  // PAT 2026-06-25: (re)establish the TCP socket to the signal-cli daemon and
  // (re)subscribe for inbound. Called once from setup() and again from the
  // reconnect loop after the daemon bounces. Idempotent: builds a fresh
  // SignalTcpClient each time (the old one is dead once onClose fired) and
  // re-applies the profile/config/subscription the daemon needs per client
  // connection. `subscribeReceive` is the load-bearing call — without it the
  // daemon never pushes `receive` notifications to this socket.
  async function connectAndSubscribe(): Promise<void> {
    const client = new SignalTcpClient(config.tcpHost, config.tcpPort);
    await client.connect({
      onNotification: handleNotification,
      // The daemon dropped us (restart / network blip / watchdog-forced
      // recycle). Mark disconnected and schedule a backoff reconnect so the
      // channel self-heals without a nanoclaw restart.
      onClose: () => {
        if (tcp !== client) return; // stale client from a prior generation
        connected = false;
        tcp = null;
        log.warn('Signal channel lost TCP connection to signal-cli daemon', {
          account: config.account,
          host: config.tcpHost,
          port: config.tcpPort,
        });
        scheduleReconnect();
      },
    });
    tcp = client;

    try {
      await client.rpc('updateProfile', {
        name: 'NanoClaw',
        account: config.account,
      });
    } catch {
      log.debug('Signal: could not set profile name');
    }

    try {
      // PAT: enable both typing indicators AND read receipts so the
      // user sees Pat's double-filled bubble when messages are read.
      // signal-cli persists these flags in the identity state on the
      // Fly volume, so the call is idempotent across daemon restarts.
      await client.rpc('updateConfiguration', {
        typingIndicators: true,
        readReceipts: true,
        account: config.account,
      });
    } catch {
      log.debug('Signal: could not enable typing indicators / read receipts');
    }

    // PAT: per-client receive subscription. signal-cli's `--receive-mode
    // on-start` opens the receive stream against Signal's relay servers
    // (so envelopes accumulate daemon-side), but each JSON-RPC client
    // STILL has to call `subscribeReceive` to get `receive` notifications
    // pushed to its socket. Without this call, the adapter sits silent
    // forever — verified empirically against signal-cli 0.14.3 on 2026-05-12.
    // In single-account mode (--receive-mode on-start with -a flag),
    // subscribeReceive takes NO params; passing `{account}` errors out.
    try {
      const subId = await client.rpc<number>('subscribeReceive');
      log.info('Signal: subscribeReceive ok', { subscriptionId: subId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn('Signal: subscribeReceive failed', { error: msg });
    }

    connected = true;
    reconnectAttempt = 0;
    log.info('Signal channel connected', {
      account: config.account,
      host: config.tcpHost,
      port: config.tcpPort,
    });
  }

  // PAT 2026-06-25: capped exponential-backoff reconnect. The daemon may take
  // tens of seconds to come back (Fly machine restart + receive-stream
  // re-establish), so we keep retrying until it answers. Single in-flight timer
  // (guarded) so overlapping onClose calls don't stack reconnect loops.
  function scheduleReconnect(): void {
    if (stopped) return;
    if (reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
    reconnectAttempt += 1;
    log.info('Signal: scheduling reconnect', { attempt: reconnectAttempt, delayMs: delay });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (stopped) return;
      void (async () => {
        // Wait for the daemon's TCP port to answer before attempting the full
        // connect+subscribe handshake — avoids hammering RPC timeouts while the
        // sibling machine is still booting.
        const reachable = await signalTcpCheck(config.tcpHost, config.tcpPort);
        if (stopped) return;
        if (!reachable) {
          scheduleReconnect();
          return;
        }
        try {
          await connectAndSubscribe();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn('Signal: reconnect attempt failed', { attempt: reconnectAttempt, error: msg });
          scheduleReconnect();
        }
      })();
    }, delay);
  }

  // -- adapter --

  const adapter: ChannelAdapter = {
    name: 'signal',
    channelType: 'signal',
    supportsThreads: false,

    async setup(cfg: ChannelSetup): Promise<void> {
      setup = cfg;

      if (config.manageDaemon) {
        daemon = spawnSignalDaemon(config.cliPath, config.account, config.tcpHost, config.tcpPort);
        const ready = await waitForDaemon();
        if (!ready) {
          daemon.stop();
          throw new Error('Signal daemon failed to start. Is signal-cli installed and your account linked?');
        }
      } else {
        const ok = await signalTcpCheck(config.tcpHost, config.tcpPort);
        if (!ok) {
          const err = new Error(
            `Signal daemon not reachable at ${config.tcpHost}:${config.tcpPort}. Start it manually or set SIGNAL_MANAGE_DAEMON=true`,
          );
          (err as any).name = 'NetworkError';
          throw err;
        }
      }

      await connectAndSubscribe();
    },

    async teardown(): Promise<void> {
      // PAT: flip the reconnect gate FIRST so an in-flight onClose (fired by
      // tcp.close() below) doesn't schedule a fresh reconnect against a
      // tearing-down adapter.
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      connected = false;
      tcp?.close();
      tcp = null;
      if (daemon && config.manageDaemon) {
        daemon.stop();
        await daemon.exited;
      }
      daemon = null;
      log.info('Signal channel disconnected');
    },

    isConnected(): boolean {
      return connected;
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      const content = message.content as Record<string, unknown> | string | undefined;
      let text: string | null = null;
      if (typeof content === 'string') {
        text = content;
      } else if (content && typeof content === 'object' && typeof content.text === 'string') {
        text = content.text;
      }

      const files = message.files ?? [];

      // Send accompanying text first so it lands above the attachment(s) in
      // the recipient's chat. Both branches no-op cleanly if their input is
      // empty, so any combination of (text, files) works.
      // PAT tradeoff: if text sends but the attachment throws, delivery.ts
      // retries the whole deliver() and the caption text is re-sent. We accept
      // the rare duplicate caption over silently dropping the attachment — the
      // attachment failure is the thing we must not swallow (see 2.1).
      if (text) await sendText(platformId, text);
      if (files.length > 0) await sendAttachments(platformId, files);
      return undefined;
    },

    async setTyping(platformId: string, _threadId: string | null): Promise<void> {
      if (!connected || !tcp) return;
      if (platformId.startsWith('group:')) return;

      try {
        const params: Record<string, unknown> = { recipient: [platformId] };
        if (config.account) params.account = config.account;
        await tcp.rpc('sendTyping', params);
      } catch (err) {
        log.debug('Signal: typing indicator failed', { platformId, err });
      }
    },

    // PAT: openDM is deliberately NOT implemented. Signal is a
    // direct-addressable channel — the recipient address (E164 or UUID)
    // IS the DM chat id, with no separate platform-side handshake to
    // open. user-dm.ts:124-126 detects the absence of openDM and falls
    // through to using the handle directly as messaging_groups.platform_id.
    // Wave 2.B's outbound.initiate({platformId: "signal:+E164"}) routes
    // through ensureUserDm → adapter.deliver(handle, null, msg). Adding
    // an openDM stub here would be wrong (Signal has no "open DM" API).
  };

  // PAT (task #15): attach a Signal-specific `sendVoiceMemo` method as
  // an extension property. Host-side voice-memo action handler casts to
  // SignalChannelAdapter to reach it (see src/modules/voice-memo.ts).
  // Kept off the ChannelAdapter interface because it's truly
  // Signal-specific — Slack/Discord don't have a voice-note primitive.
  // Falls back to a text send_message of the same content on any
  // failure (Cartesia 4xx, ffmpeg failure, RPC failure), so the user
  // always receives the content one way or another.
  const adapterWithVoice = adapter as ChannelAdapter & {
    sendVoiceMemo: (platformId: string, text: string, voiceId?: string) => Promise<boolean>;
  };
  adapterWithVoice.sendVoiceMemo = async (platformId, text, voiceId) => {
    const oggPath = await synthesizeVoiceMemoOptional(text, voiceId);
    if (!oggPath) {
      log.warn('Signal: synthesizeVoiceMemo failed, falling back to text', { platformId });
      await sendText(platformId, text);
      return false;
    }
    const ok = await sendVoiceNote(platformId, oggPath);
    if (!ok) {
      log.warn('Signal: sendVoiceNote failed, falling back to text', { platformId });
      await sendText(platformId, text);
      return false;
    }
    return true;
  };

  return adapterWithVoice;
}

// PAT (task #15): structural type exported for the host-side voice-memo
// action handler. Captures the Signal-specific `sendVoiceMemo` extension
// in a way that lets src/modules/voice-memo.ts type-narrow the adapter
// returned from getChannelAdapter('signal') without leaking
// Signal-specific concerns into the generic ChannelAdapter interface.
export interface SignalChannelAdapter extends ChannelAdapter {
  sendVoiceMemo(platformId: string, text: string, voiceId?: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Self-registration
// ---------------------------------------------------------------------------

// PAT: defaults below match upstream single-host installs (signal-cli
// spawned in-process on localhost). For PAT's split deployment, the env
// must set SIGNAL_TCP_HOST=pat-transports.internal and
// SIGNAL_MANAGE_DAEMON=false — see transports/signal-cli/ for the
// daemon process group, and add-signal SKILL.md for the Fly install path.
const DEFAULT_TCP_HOST = '127.0.0.1';
const DEFAULT_TCP_PORT = 7583;

registerChannelAdapter('signal', {
  factory: () => {
    // PAT: in capture mode the simulated-signal adapter (signal-sim.ts) owns
    // the `signal` key; stand down so the real signal-cli daemon path is not
    // used. Flip PAT_TEST_OUTBOUND_ADAPTER off + restart to restore.
    if (process.env.PAT_TEST_OUTBOUND_ADAPTER === '1') {
      log.debug('Signal: PAT_TEST_OUTBOUND_ADAPTER=1 — yielding to signal-sim capture adapter');
      return null;
    }
    const envVars = readEnvFile([
      'SIGNAL_ACCOUNT',
      'SIGNAL_TCP_HOST',
      'SIGNAL_TCP_PORT',
      'SIGNAL_CLI_PATH',
      'SIGNAL_MANAGE_DAEMON',
      'SIGNAL_DATA_DIR',
    ]);

    const account = process.env.SIGNAL_ACCOUNT || envVars.SIGNAL_ACCOUNT || '';
    if (!account) {
      log.debug('Signal: SIGNAL_ACCOUNT not set, skipping channel');
      return null;
    }

    const cliPath = process.env.SIGNAL_CLI_PATH || envVars.SIGNAL_CLI_PATH || 'signal-cli';
    const tcpHost = process.env.SIGNAL_TCP_HOST || envVars.SIGNAL_TCP_HOST || DEFAULT_TCP_HOST;
    const tcpPort = parseInt(process.env.SIGNAL_TCP_PORT || envVars.SIGNAL_TCP_PORT || String(DEFAULT_TCP_PORT), 10);
    const manageDaemon = (process.env.SIGNAL_MANAGE_DAEMON || envVars.SIGNAL_MANAGE_DAEMON || 'true') === 'true';

    const signalDataDir =
      process.env.SIGNAL_DATA_DIR || envVars.SIGNAL_DATA_DIR || join(homedir(), '.local', 'share', 'signal-cli');

    // Only check for `signal-cli` on PATH when the operator left cliPath at
    // the default AND asked us to manage the daemon. A custom absolute path
    // is treated as an explicit promise and spawn will surface its own ENOENT.
    if (manageDaemon && cliPath === 'signal-cli') {
      try {
        execFileSync('which', ['signal-cli'], { stdio: 'ignore' });
      } catch {
        log.debug('Signal: signal-cli binary not found, skipping channel');
        return null;
      }
    }

    return createSignalAdapter({
      cliPath,
      account,
      tcpHost,
      tcpPort,
      manageDaemon,
      signalDataDir,
    });
  },
});
