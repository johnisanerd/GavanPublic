import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  query as sdkQuery,
  type HookCallback,
  type PostToolUseFailureHookInput,
  type PostToolUseHookInput,
  type PreCompactHookInput,
  type PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';

import { clearContainerToolInFlight, setContainerToolInFlight } from '../db/connection.js';
import { writeMessageOut } from '../db/messages-out.js'; // PAT: detail-row firehose for front-mind narration
import { buildPromptChain, renderChain } from '../prompt-snapshot.js';
import { registerProvider } from './provider-registry.js';
import type {
  AgentProvider,
  AgentQuery,
  McpServerConfig,
  ProviderEvent,
  ProviderOptions,
  QueryInput,
} from './types.js';

// PAT: translate our discriminated `McpServerConfig` (transport-tagged)
// into the SDK's shape (type-tagged). Stdio entries map to `type:
// 'stdio'`; http entries map to the SDK's `McpHttpServerConfig` which
// IS the streamable-HTTP variant despite the bare `'http'` name. The
// SDK has no separate `'streamable-http'` constant.
// Exported for the contract test in toSdkMcpServers.test.ts — keeps
// the translation regression-tested without exercising the full query
// path.
export function toSdkMcpServers(
  servers: Record<string, McpServerConfig>,
): Record<
  string,
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> }
> {
  const out: Record<
    string,
    | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
    | { type: 'http'; url: string; headers?: Record<string, string> }
  > = {};
  for (const [name, cfg] of Object.entries(servers)) {
    if (cfg.transport === 'http') {
      out[name] = { type: 'http', url: cfg.url, headers: cfg.headers };
    } else {
      out[name] = { type: 'stdio', command: cfg.command, args: cfg.args, env: cfg.env };
    }
  }
  return out;
}

// PAT: detail-row helper — writes kind='detail' rows to outbound.db for the
// realtime library to tail-read. Routing fields are null because detail rows
// are consumed by the host-side realtime library, not delivered via channel
// adapters (delivery.ts short-circuits kind='detail').
function writeDetail(content: Record<string, unknown>): void {
  try {
    writeMessageOut({
      id: crypto.randomUUID(),
      kind: 'detail',
      content: JSON.stringify(content),
    });
  } catch (err) {
    log(`writeDetail failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// PAT: tool-result truncation cap. Read tool can return multi-MB file
// contents; without a cap we'd bloat outbound.db and the dashboard SSE
// stream. Head + tail elision keeps the most-likely-useful chunks
// (start of output for context, end for the result/error tail).
const TOOL_RESULT_HEAD_CHARS = 4000;
const TOOL_RESULT_TAIL_CHARS = 1000;
const TOOL_RESULT_MAX_CHARS = TOOL_RESULT_HEAD_CHARS + TOOL_RESULT_TAIL_CHARS;

/** Stringify and (if oversize) head+tail-truncate a tool-call result.
 *  Returns { preview, truncated, total_chars } so the consumer can
 *  show "showing N of M chars" + the actual preview. */
function previewToolResult(result: unknown): {
  preview: string;
  truncated: boolean;
  total_chars: number;
} {
  let s: string;
  if (result == null) s = '';
  else if (typeof result === 'string') s = result;
  else {
    try {
      s = JSON.stringify(result, null, 2);
    } catch {
      s = String(result);
    }
  }
  const total = s.length;
  if (total <= TOOL_RESULT_MAX_CHARS) {
    return { preview: s, truncated: false, total_chars: total };
  }
  const head = s.slice(0, TOOL_RESULT_HEAD_CHARS);
  const tail = s.slice(total - TOOL_RESULT_TAIL_CHARS);
  const elided = total - TOOL_RESULT_HEAD_CHARS - TOOL_RESULT_TAIL_CHARS;
  return {
    preview: `${head}\n\n…[${elided} chars elided]…\n\n${tail}`,
    truncated: true,
    total_chars: total,
  };
}

function log(msg: string): void {
  console.error(`[claude-provider] ${msg}`);
}

// PAT: structured-event sentinel. The agent-runner runs inside a Claude Code
// container that CANNOT reach the log forwarder directly (6PN / egress
// lockdown). The one transport seam that already exists is the host teeing
// the container's stderr (`nanoclaw/src/container-runner.ts`). We piggyback
// on it: write a recognizable, greppable JSONL line to stderr; the host
// matches this prefix, parses the JSON, and re-emits it into its OWN shipped
// structured-log stream (kind 'agent.tool_use') with authoritative
// session/thread/agent_group ids. Keep the payload cheap + bounded — never
// dump full tool inputs / secrets. Mirror constant: PAT_EVENT_STDERR_SENTINEL
// in container-runner.ts.
const PAT_EVENT_SENTINEL = '@@PATEVENT@@';
// PAT: single-line summary cap for structured tool-call events (input + output).
// ~2KB ("a couple KB") — bounded so secrets / multi-MB payloads (e.g. a Read of a
// big file) can't bloat pat_events; the full result still goes to the per-session
// container.stderr.log + the tool-post detail row (capped separately at ~5KB).
const EVENT_SUMMARY_MAX_CHARS = 2048;

/** Single-line, truncated summary of a tool input OR output (string or object),
 *  for the agent.tool_use / agent.tool_result sentinel events. Collapses
 *  whitespace so the sentinel stays one stderr line; bounded to ~2KB. */
function summarizeForEvent(value: unknown): string {
  if (value == null) return '';
  let s: string;
  if (typeof value === 'string') s = value;
  else {
    try {
      s = JSON.stringify(value);
    } catch {
      s = String(value);
    }
  }
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length <= EVENT_SUMMARY_MAX_CHARS) return s;
  return s.slice(0, EVENT_SUMMARY_MAX_CHARS) + `…[${s.length - EVENT_SUMMARY_MAX_CHARS} more chars]`;
}

/** Emit a structured event onto stderr for the host tee to re-emit. Best
 *  effort — observability must never break the agent loop. */
function emitPatStderrEvent(kind: string, data: Record<string, unknown>): void {
  try {
    process.stderr.write(`${PAT_EVENT_SENTINEL} ${JSON.stringify({ kind, data })}\n`);
  } catch {
    /* swallow — never let logging throw into the SDK loop */
  }
}

// PAT: last init-time MCP connect statuses (per claude subprocess spawn).
// 'failed' / 'needs-auth' are definitive; 'pending' just means still
// connecting at snapshot time and is NOT reported.
let lastMcpStatuses: Array<{ name: string; status: string }> = [];

/** One-line system note about dead MCP servers, or null when all is well. */
export function buildMcpStatusNote(): string | null {
  const dead = lastMcpStatuses.filter((s) => s.status === 'failed' || s.status === 'needs-auth');
  if (dead.length === 0) return null;
  const list = dead.map((s) => `"${s.name}" (${s.status})`).join(', ');
  return (
    `[system note: MCP server(s) ${list} did not connect this session — their tools are unavailable. ` +
    `Likely a wrong URL or missing/invalid credential; a container restart alone will not fix it. ` +
    `Tell the user what failed rather than guessing.]`
  );
}

// Deferred SDK builtins that either sidestep nanoclaw's own scheduling or
// don't fit our async message-passing model (they're designed for Claude
// Code's interactive UI and would hang here).
//
// - CronCreate / CronDelete / CronList / ScheduleWakeup: we have durable
//   scheduling via mcp__nanoclaw__schedule_task.
// - AskUserQuestion: SDK returns a placeholder instead of blocking on a
//   real answer — we have mcp__nanoclaw__ask_user_question that persists
//   the question and blocks on the real reply.
// - EnterPlanMode / ExitPlanMode / EnterWorktree / ExitWorktree: Claude
//   Code UI affordances; in a headless container they'd appear stuck.
const SDK_DISALLOWED_TOOLS = [
  'Agent',
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
];

// Tool allowlist for NanoClaw agent containers. MCP-tool entries are derived
// at the call site from the registered `mcpServers` map so that any server
// added via `add_mcp_server` (or wired in container.json directly) is
// reachable to the agent — without this, the SDK's allowedTools filter
// silently drops every MCP namespace not listed here.
const TOOL_ALLOWLIST = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'TodoWrite',
  'ToolSearch',
  'Skill',
  'NotebookEdit',
];

// MCP server names are sanitized by the SDK when forming tool prefixes:
// any character outside [A-Za-z0-9_-] becomes '_'. Mirror that here so our
// allowlist patterns match what the SDK actually exposes.
function mcpAllowPattern(serverName: string): string {
  return `mcp__${serverName.replace(/[^a-zA-Z0-9_-]/g, '_')}__*`;
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

/**
 * Push-based async iterable for streaming user messages to the Claude SDK.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

// ── Transcript archiving (PreCompact hook) ──

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      /* skip unparseable lines */
    }
  }
  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const dateStr = now.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const lines = [`# ${title || 'Conversation'}`, '', `Archived: ${dateStr}`, '', '---', ''];
  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content = msg.content.length > 2000 ? msg.content.slice(0, 2000) + '...' : msg.content;
    lines.push(`**${sender}**: ${content}`, '');
  }
  return lines.join('\n');
}

/**
 * PreToolUse hook: record the current tool + its declared timeout so the host
 * sweep can widen its stuck tolerance while Bash is running a long-declared
 * script. Defense-in-depth: if SDK_DISALLOWED_TOOLS slips through somehow,
 * block the call here instead of letting the agent hang.
 */
const preToolUseHook: HookCallback = async (input) => {
  const i = input as PreToolUseHookInput;
  const toolName = i.tool_name ?? '';
  if (SDK_DISALLOWED_TOOLS.includes(toolName)) {
    return {
      decision: 'block',
      stopReason: `Tool '${toolName}' is not available in this environment — use the nanoclaw equivalent.`,
    } as unknown as ReturnType<HookCallback>;
  }
  const toolInput = i.tool_input as Record<string, unknown> | undefined;
  // Bash exposes its timeout via the tool_input.timeout field (ms). Any other
  // tool: no declared timeout.
  const declaredTimeoutMs =
    toolName === 'Bash' && typeof toolInput?.timeout === 'number' ? (toolInput.timeout as number) : null;
  try {
    setContainerToolInFlight(toolName, declaredTimeoutMs);
  } catch (err) {
    log(`PreToolUse: failed to record container_state: ${err instanceof Error ? err.message : String(err)}`);
  }
  // PAT: emit detail row for front-mind narration consumption.
  writeDetail({ type: 'tool-pre', tool: toolName, input: toolInput ?? {}, toolUseId: i.tool_use_id });
  // PAT: structured tool-call observability for back-mind/text turns. The
  // container can't reach the forwarder (egress lockdown), so this rides the
  // host stderr tee and is re-emitted as kind 'agent.tool_use' into the
  // shipped log stream. See realtime/src/log-events.ts (AgentToolUseEvent).
  emitPatStderrEvent('agent.tool_use', {
    tool: toolName,
    input_summary: summarizeForEvent(toolInput),
    ...(i.tool_use_id ? { tool_use_id: i.tool_use_id } : {}),
  });
  return { continue: true };
};

/** Clear in-flight tool on PostToolUse / PostToolUseFailure. */
const postToolUseHook: HookCallback = async (input) => {
  const i = input as PostToolUseHookInput | PostToolUseFailureHookInput;
  try {
    clearContainerToolInFlight();
  } catch (err) {
    log(`PostToolUse: failed to clear container_state: ${err instanceof Error ? err.message : String(err)}`);
  }
  // PAT: emit detail row for front-mind narration consumption + dashboard
  // forensic view. Both branches stringify+truncate any oversized
  // result/error so we don't ship multi-MB Read-tool payloads through
  // the SSE bus.
  if (i.hook_event_name === 'PostToolUseFailure') {
    const errVal = (i as PostToolUseFailureHookInput).error;
    const errPreview = previewToolResult(errVal);
    writeDetail({
      type: 'tool-failed',
      tool: i.tool_name,
      toolUseId: i.tool_use_id,
      error: errPreview.preview,
      result_truncated: errPreview.truncated,
      result_total_chars: errPreview.total_chars,
    });
    // PAT: tool OUTPUT observability — re-emitted as kind 'agent.tool_result'
    // into the shipped log stream (see realtime/src/log-events.ts). Correlate to
    // the agent.tool_use (input) by tool_use_id.
    emitPatStderrEvent('agent.tool_result', {
      tool: i.tool_name,
      ok: false,
      output_summary: summarizeForEvent(errVal),
      ...(i.tool_use_id ? { tool_use_id: i.tool_use_id } : {}),
    });
  } else {
    const resVal = (i as PostToolUseHookInput).tool_response;
    const resPreview = previewToolResult(resVal);
    writeDetail({
      type: 'tool-post',
      tool: i.tool_name,
      toolUseId: i.tool_use_id,
      result_preview: resPreview.preview,
      result_truncated: resPreview.truncated,
      result_total_chars: resPreview.total_chars,
    });
    emitPatStderrEvent('agent.tool_result', {
      tool: i.tool_name,
      ok: true,
      output_summary: summarizeForEvent(resVal),
      ...(i.tool_use_id ? { tool_use_id: i.tool_use_id } : {}),
    });
  }
  return { continue: true };
};

/**
 * Read a Claude transcript .jsonl, render a markdown summary, and drop it into
 * the agent's `conversations/` folder so context survives a compaction or a
 * session rotation. Best-effort: returns false (and logs) on any failure.
 */
function archiveTranscriptFile(
  transcriptPath: string | undefined,
  sessionId: string | undefined,
  assistantName?: string,
): boolean {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    log('No transcript found for archiving');
    return false;
  }

  try {
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    const messages = parseTranscript(content);
    if (messages.length === 0) return false;

    // Try to get summary from sessions index
    let summary: string | undefined;
    const indexPath = path.join(path.dirname(transcriptPath), 'sessions-index.json');
    if (fs.existsSync(indexPath)) {
      try {
        const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        summary = index.entries?.find(
          (e: { sessionId: string; summary?: string }) => e.sessionId === sessionId,
        )?.summary;
      } catch {
        /* ignore */
      }
    }

    const name = summary
      ? summary
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 50)
      : `conversation-${new Date().getHours().toString().padStart(2, '0')}${new Date().getMinutes().toString().padStart(2, '0')}`;

    const conversationsDir = process.env.NANOCLAW_CONVERSATIONS_DIR || '/workspace/agent/conversations';
    fs.mkdirSync(conversationsDir, { recursive: true });
    const filename = `${new Date().toISOString().split('T')[0]}-${name}.md`;
    fs.writeFileSync(path.join(conversationsDir, filename), formatTranscriptMarkdown(messages, summary, assistantName));
    log(`Archived conversation to ${filename}`);
    return true;
  } catch (err) {
    log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input) => {
    const preCompact = input as PreCompactHookInput;
    // PAT: emit detail row so the realtime library knows the back-mind's
    // SDK context is being summarized — fine-grained recall of pre-compact
    // events is no longer reliable on the back-mind side.
    writeDetail({ type: 'compact', sessionId: preCompact.session_id });

    archiveTranscriptFile(preCompact.transcript_path, preCompact.session_id, assistantName);
    return {};
  };
}

// ── Continuation rotation (cold-resume guard) ──

/**
 * Resume cost is dominated by transcript size. Past this many bytes a fresh
 * cold container can't reload the .jsonl before the host's 30-min idle ceiling
 * fires, so the session is dropped and started clean. Operator-overridable.
 */
function transcriptRotateBytes(): number {
  return Number(process.env.CLAUDE_TRANSCRIPT_ROTATE_BYTES) || 12 * 1024 * 1024;
}

/**
 * Secondary age trigger, measured from the transcript's first entry. 0 (or a
 * non-positive value) disables the age check; size alone then governs.
 */
function transcriptRotateAgeMs(): number {
  const raw = process.env.CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS;
  if (raw === undefined || raw.trim() === '') return 14 * 86_400_000;
  const days = Number(raw);
  if (!Number.isFinite(days)) return 14 * 86_400_000;
  // Explicit non-positive override disables the age check; size alone governs.
  return days > 0 ? days * 86_400_000 : Infinity;
}

function claudeProjectsDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || os.homedir(), '.claude');
  return path.join(base, 'projects');
}

/**
 * Locate the .jsonl backing a session id. The SDK names project dirs by a
 * mangled cwd; rather than reproduce that convention we scan project dirs for
 * `<sessionId>.jsonl` (session ids are UUIDs, so this is unambiguous).
 */
function findTranscriptPath(sessionId: string): string | null {
  const projects = claudeProjectsDir();
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = path.join(projects, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Epoch-ms of the first transcript entry, or null if unreadable. */
function transcriptStartMs(transcriptPath: string): number | null {
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const firstLine = buf.toString('utf-8', 0, n).split('\n', 1)[0];
      const ts = JSON.parse(firstLine)?.timestamp;
      const ms = ts ? Date.parse(ts) : NaN;
      return Number.isNaN(ms) ? null : ms;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

// ── Provider ──

/**
 * Claude Code auto-compacts context at this window (tokens). Kept here so
 * the generic bootstrap doesn't need to know about Claude-specific env vars.
 *
 * Operator override: set CLAUDE_CODE_AUTO_COMPACT_WINDOW in the host env to
 * raise or lower the threshold without editing source — useful when running
 * with a 1M-context model variant or when emergency-tuning a deployment.
 */
const CLAUDE_CODE_AUTO_COMPACT_WINDOW = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || '165000';

// PAT: pin model + effort so the realtime use case has predictable latency.
// NANOCLAW_MODEL defaults to Sonnet 4.6 (latest Sonnet, confirmed
// 2026-05-19 via docs.claude.com — the back-mind's job is delivering an
// authored timeline + handling audience Q&A from packet content; Opus's
// reasoning density isn't needed for that and Sonnet is meaningfully
// faster + cheaper on the round-trip). Override per-deploy via
// NANOCLAW_MODEL; future per-agent-group override goes through
// container.json (when env support lands there). EFFORT defaults to
// 'medium' for snappier voice-call turn times.
const NANOCLAW_MODEL = process.env.NANOCLAW_MODEL || 'claude-sonnet-4-6';
type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const DEFAULT_EFFORT: EffortLevel = 'medium';
function effortFromEnv(): EffortLevel {
  const raw = process.env.EFFORT?.toLowerCase();
  if (raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'xhigh' || raw === 'max') {
    return raw;
  }
  return DEFAULT_EFFORT;
}

/**
 * Stale-session detection. Matches Claude Code's error text when a
 * resumed session can't be found — missing transcript .jsonl, unknown
 * session ID, etc.
 */
const STALE_SESSION_RE = /no conversation found|ENOENT.*\.jsonl|session.*not found/i;

export class ClaudeProvider implements AgentProvider {
  // PAT: see AgentProvider.mcpStatusNote — surfaces dead MCP servers to the agent.
  mcpStatusNote(): string | null {
    return buildMcpStatusNote();
  }

  readonly supportsNativeSlashCommands = true;

  private assistantName?: string;
  private mcpServers: Record<string, McpServerConfig>;
  private env: Record<string, string | undefined>;
  private additionalDirectories?: string[];
  private model?: string;
  private effort?: string;

  constructor(options: ProviderOptions = {}) {
    this.assistantName = options.assistantName;
    this.mcpServers = options.mcpServers ?? {};
    this.additionalDirectories = options.additionalDirectories;
    this.model = options.model;
    this.effort = options.effort;
    this.env = {
      ...(options.env ?? {}),
      CLAUDE_CODE_AUTO_COMPACT_WINDOW,
    };
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  maybeRotateContinuation(continuation: string): string | null {
    const transcriptPath = findTranscriptPath(continuation);
    if (!transcriptPath) return null;

    let size: number;
    try {
      size = fs.statSync(transcriptPath).size;
    } catch {
      return null;
    }

    const maxBytes = transcriptRotateBytes();
    const startMs = transcriptStartMs(transcriptPath);
    const ageMs = startMs === null ? 0 : Date.now() - startMs;
    const maxAgeMs = transcriptRotateAgeMs();

    let reason: string | null = null;
    if (size > maxBytes) {
      reason = `transcript ${(size / 1_048_576).toFixed(1)}MB > ${(maxBytes / 1_048_576).toFixed(0)}MB cap`;
    } else if (startMs !== null && ageMs > maxAgeMs) {
      reason = `transcript ${(ageMs / 86_400_000).toFixed(1)}d old > ${(maxAgeMs / 86_400_000).toFixed(0)}d cap`;
    }
    if (!reason) return null;

    // Preserve a readable summary, then move the heavy .jsonl out of the
    // resume path so the SDK starts a fresh session and the disk is reclaimed.
    archiveTranscriptFile(transcriptPath, continuation, this.assistantName);
    try {
      fs.renameSync(transcriptPath, `${transcriptPath}.rotated-${Date.now()}`);
    } catch (err) {
      log(`Failed to move rotated transcript aside: ${err instanceof Error ? err.message : String(err)}`);
    }
    return reason;
  }

  query(input: QueryInput): AgentQuery {
    const stream = new MessageStream();
    stream.push(input.prompt);

    const instructions = input.systemContext?.instructions;

    // PAT: emit the full materialized prompt chain ONCE per query open
    // when DEBUG_DUMP_PROMPT=1. Captures runtime addendum + composed
    // CLAUDE.md + recursive @-imports + CLAUDE.local.md. SDK preset is
    // opaque (marked as such in the chain). Fires here (not at
    // back-mind-completion) because the system prompt is fixed for the
    // life of the query; back-mind-completion only fires at session end,
    // missing per-turn sessions that the host kills before close.
    if (process.env.DEBUG_DUMP_PROMPT === '1') {
      const chain = buildPromptChain(instructions ?? '', input.cwd, input.cwd);
      writeDetail({
        type: 'back-mind-prompt-snapshot',
        layer: 'back-mind',
        model: NANOCLAW_MODEL,
        cwd: input.cwd,
        system_prompt: renderChain(chain),
        chain_summary: chain.map((e) => ({
          source: e.source,
          path: e.path,
          status: e.status,
          chars: e.content.length,
        })),
      });
    }

    // PAT: back-mind llm.call trace — capture the system-prompt addendum
    // (the `instructions`, i.e. destinations + assistant identity) plus
    // the full user message and the final completion text. Latency is
    // measured from query open to the SDK `result` event. Emitted as a
    // detail row of type='back-mind-completion'; the host promotes it to
    // a structured `llm.call` event at level='debug'.
    const llmCallStartMs = Date.now();
    let llmCallResponse: string | null = null;
    let llmCallError: string | undefined;

    const sdkResult = sdkQuery({
      prompt: stream,
      options: {
        cwd: input.cwd,
        additionalDirectories: this.additionalDirectories,
        resume: input.continuation,
        // PAT (2026-06-25): do NOT override pathToClaudeCodeExecutable. The
        // v2.1.19 claude-agent-sdk ships its OWN matching native binary as a
        // platform optional dep (@anthropic-ai/claude-agent-sdk-linux-x64 /
        // -x64-musl, both present in the agent image) and self-resolves the
        // correct libc variant at runtime. The old '/pnpm/claude' override
        // pointed at the separately-pnpm-installed claude-code *shim*, which this
        // SDK rejects with "Claude Code native binary not found at /pnpm/claude"
        // — every agent turn died and the error got delivered as Pat's reply.
        // Letting the SDK use its bundled binary is the intended path.
        // PAT: pin Opus 4.7 + EFFORT-controlled thinking depth.
        model: NANOCLAW_MODEL,
        effort: effortFromEnv(),
        systemPrompt: instructions
          ? { type: 'preset' as const, preset: 'claude_code' as const, append: instructions }
          : undefined,
        allowedTools: [...TOOL_ALLOWLIST, ...Object.keys(this.mcpServers).map(mcpAllowPattern)],
        disallowedTools: SDK_DISALLOWED_TOOLS,
        env: this.env,
        // PAT: 'auto' is the new Claude-only mode that signals "execute
        // autonomously, minimize interruptions, prefer action over
        // planning". Behaves like bypass for tool permissions but adds
        // the autonomy framing. Trying it on the back-mind 2026-05-05;
        // revert to 'bypassPermissions' if anything regresses.
        permissionMode: 'auto',
        allowDangerouslySkipPermissions: true,
        // 'local' added from upstream — lets a group's local settings apply.
        settingSources: ['project', 'user', 'local'],
        // PAT: McpServerConfig is a discriminated union (stdio|http); translate
        // to the SDK's shape. model/effort are env-pinned above (NANOCLAW_MODEL
        // + effortFromEnv) rather than constructor-injected like upstream.
        mcpServers: toSdkMcpServers(this.mcpServers),
        // PAT: enable partial-message stream events so the realtime layer can
        // see back-mind output as it's being generated, not just at tool
        // boundaries / final result.
        includePartialMessages: true,
        hooks: {
          PreToolUse: [{ hooks: [preToolUseHook] }],
          PostToolUse: [{ hooks: [postToolUseHook] }],
          PostToolUseFailure: [{ hooks: [postToolUseHook] }],
          PreCompact: [{ hooks: [createPreCompactHook(this.assistantName)] }],
        },
      },
    });

    let aborted = false;

    // PAT: token-delta + reasoning-delta buffers + chunk timer. Buffered
    // text is flushed to a kind='detail' row at TOKEN_DELTA_CHUNK_MS
    // cadence (≈ half the follow-up poll interval) once the buffer has
    // TOKEN_DELTA_MIN_CHARS; an explicit flush at end-of-generation
    // guarantees the tail isn't lost. Reasoning streams reuse the same
    // cadence so they don't lag a turn behind the visible output.
    // PAT: dropped from 250/30 → 20/5. With poll-loop now at 25ms, the
    // old 250ms / 30-char gate held back token deltas an order of
    // magnitude longer than the host can deliver them. 20ms cadence with
    // a 5-char floor lets streaming text reach the user as fast as the
    // provider emits it without spamming sub-token rows.
    const TOKEN_DELTA_CHUNK_MS = 20;
    const TOKEN_DELTA_MIN_CHARS = 5;
    let tokenBuffer = '';
    let reasoningBuffer = '';
    let chunkTimer: ReturnType<typeof setInterval> | null = null;
    const flushTokenBuffer = (force: boolean): void => {
      if (tokenBuffer.length === 0) return;
      if (!force && tokenBuffer.length < TOKEN_DELTA_MIN_CHARS) return;
      const text = tokenBuffer;
      tokenBuffer = '';
      writeDetail({ type: 'token-delta', text });
    };
    const flushReasoningBuffer = (force: boolean): void => {
      if (reasoningBuffer.length === 0) return;
      if (!force && reasoningBuffer.length < TOKEN_DELTA_MIN_CHARS) return;
      const text = reasoningBuffer;
      reasoningBuffer = '';
      writeDetail({ type: 'reasoning-streamed', text });
    };
    const startChunkTimer = (): void => {
      if (chunkTimer) return;
      chunkTimer = setInterval(() => {
        flushTokenBuffer(false);
        flushReasoningBuffer(false);
      }, TOKEN_DELTA_CHUNK_MS);
    };
    const stopChunkTimer = (): void => {
      if (chunkTimer) {
        clearInterval(chunkTimer);
        chunkTimer = null;
      }
      flushTokenBuffer(true);
      flushReasoningBuffer(true);
    };

    // PAT: per-API-call instrumentation for `back-mind.llm-call`. The
    // back-mind's Claude Agent SDK loop fans out into multiple Anthropic
    // API calls within a single `query()` open (initial call, plus one
    // per tool-result followup). `apiCallIndex` is the zero-based count
    // of *completed* API calls seen so far (incremented after each
    // assistant message lands, so the next call gets the next index).
    // `apiCallStartMs` is set on the SSE `message_start` event for the
    // current API call and consumed when the assistant message lands —
    // giving us wall time of the actual HTTP call without depending on
    // SDK internals. Both reset between API calls; if a call ends
    // without a recorded start (shouldn't happen with
    // `includePartialMessages: true`), duration is omitted from the
    // event.
    let apiCallIndex = 0;
    let apiCallStartMs: number | null = null;

    async function* translateEvents(): AsyncGenerator<ProviderEvent> {
      let messageCount = 0;
      try {
        for await (const message of sdkResult) {
          if (aborted) return;
          messageCount++;

          // Yield activity for every SDK event so the poll loop knows the agent is working
          yield { type: 'activity' };

          if (message.type === 'system' && message.subtype === 'init') {
            // PAT: surface MCP server connect statuses. The SDK spawns the
            // claude subprocess with its stderr discarded, so a failed MCP
            // handshake (e.g. 401 — credential missing from the vault) was
            // previously invisible everywhere. One event per query() open;
            // statuses: connected | failed | needs-auth | pending | disabled.
            const mcps = (message as { mcp_servers?: Array<{ name: string; status: string }> }).mcp_servers;
            if (mcps && mcps.length > 0) {
              emitPatStderrEvent('agent.mcp-servers', {
                servers: mcps.map((s) => ({ name: s.name, status: s.status })),
              });
              // PAT: remember for mcpStatusNote() — lets the poll-loop tell
              // the agent about dead servers instead of leaving it to guess.
              lastMcpStatuses = mcps.map((s) => ({ name: s.name, status: s.status }));
            }
            yield { type: 'init', continuation: message.session_id };
          } else if (message.type === 'result') {
            // upstream: `result` text exists only on subtype:"success"; error
            // subtypes (e.g. a non-retryable 403 billing_error) carry their
            // message in `errors[]`. Surface either so the poll-loop can
            // deliver a billing/quota notice rather than dropping the turn.
            // PAT: also mark the back-mind-completion trace failed on is_error.
            const m = message as { result?: string; is_error?: boolean; errors?: string[] };
            const text = m.result ?? (m.errors && m.errors.length > 0 ? m.errors.join('\n') : null);
            llmCallResponse = text;
            if (m.is_error === true) {
              llmCallError = llmCallError ?? text ?? 'result error';
            }
            yield { type: 'result', text, isError: m.is_error === true };
          } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'api_retry') {
            llmCallError = llmCallError ?? 'API retry';
            yield { type: 'error', message: 'API retry', retryable: true };
          } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'rate_limit_event') {
            llmCallError = 'Rate limit';
            yield { type: 'error', message: 'Rate limit', retryable: false, classification: 'quota' };
          } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary') {
            const meta = (message as { compact_metadata?: { pre_tokens?: number } }).compact_metadata;
            const detail = meta?.pre_tokens ? ` (${meta.pre_tokens.toLocaleString()} tokens compacted)` : '';
            yield { type: 'result', text: `Context compacted${detail}.` };
          } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
            const tn = message as { summary?: string };
            yield { type: 'progress', message: tn.summary || 'Task notification' };
          } else if ((message as { type?: string }).type === 'assistant') {
            // PAT: end-of-API-call boundary. SDKAssistantMessage carries
            // the BetaMessage with billing usage + stop_reason + id (the
            // Anthropic request identifier). Emit a back-mind-llm-call
            // detail row so the host-side narration-manager can promote
            // it to a structured `back-mind.llm-call` event. Skip
            // sub-agent assistant messages (`parent_tool_use_id` set) so
            // the count reflects only the main loop iterations the user
            // is asking about — sub-agents have their own LLM-call
            // economics worth tracking separately if/when we need it.
            const assistantMsg = message as {
              type: 'assistant';
              parent_tool_use_id: string | null;
              session_id?: string;
              message?: {
                id?: string;
                model?: string;
                stop_reason?: string | null;
                usage?: {
                  input_tokens?: number;
                  output_tokens?: number;
                  cache_read_input_tokens?: number;
                  cache_creation_input_tokens?: number;
                };
              };
            };
            if (assistantMsg.parent_tool_use_id === null) {
              const usage = assistantMsg.message?.usage ?? {};
              const durationMs = apiCallStartMs !== null ? Date.now() - apiCallStartMs : undefined;
              writeDetail({
                type: 'back-mind-llm-call',
                model: assistantMsg.message?.model ?? NANOCLAW_MODEL,
                turn_index: apiCallIndex,
                input_tokens: usage.input_tokens ?? 0,
                output_tokens: usage.output_tokens ?? 0,
                cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
                cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
                stop_reason: assistantMsg.message?.stop_reason ?? null,
                ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
                ...(assistantMsg.message?.id ? { request_id: assistantMsg.message.id } : {}),
                ...(assistantMsg.session_id ? { sdk_session_id: assistantMsg.session_id } : {}),
              });
              apiCallIndex += 1;
              apiCallStartMs = null;
            }
          } else if ((message as { type?: string }).type === 'stream_event') {
            // PAT: partial-message stream — accumulate text deltas + thinking
            // deltas, flush on chunk timer or end-of-generation. Tool
            // boundaries are covered by the hook fork.
            startChunkTimer();
            const evt = (
              message as {
                event?: {
                  type?: string;
                  delta?: { type?: string; text?: string; thinking?: string };
                };
                parent_tool_use_id?: string | null;
              }
            ).event;
            // PAT: mark the start of a new API call on `message_start`
            // (only when this stream belongs to the main loop, not a
            // sub-agent — sub-agent streams carry `parent_tool_use_id`).
            // The first stream_event after message_start is the earliest
            // signal we have that the HTTP request has hit the wire and
            // the server has begun responding; close enough to wall time
            // of the API call for forensics.
            const parentToolUseId = (message as { parent_tool_use_id?: string | null }).parent_tool_use_id;
            if (evt?.type === 'message_start' && parentToolUseId === null && apiCallStartMs === null) {
              apiCallStartMs = Date.now();
            }
            if (evt?.type === 'content_block_delta') {
              if (evt.delta?.type === 'text_delta' && typeof evt.delta.text === 'string') {
                tokenBuffer += evt.delta.text;
              } else if (evt.delta?.type === 'thinking_delta' && typeof evt.delta.thinking === 'string') {
                reasoningBuffer += evt.delta.thinking;
              }
            }
          }
        }
      } finally {
        stopChunkTimer();
        // PAT: back-mind llm.call trace — emit once per query at end-of-stream.
        // Captured fields are large (full user_message + response can be tens
        // of KB) so consumers must opt in via `include_debug=1`.
        writeDetail({
          type: 'back-mind-completion',
          layer: 'back-mind',
          model: NANOCLAW_MODEL,
          system_prompt: instructions ?? '',
          user_message: input.prompt,
          response: llmCallResponse,
          latency_ms: Date.now() - llmCallStartMs,
          ok: llmCallError === undefined && llmCallResponse !== null && llmCallResponse.length > 0,
          ...(llmCallError !== undefined ? { error: llmCallError } : {}),
        });
      }
      log(`Query completed after ${messageCount} SDK messages`);
    }

    return {
      push: (msg) => stream.push(msg),
      end: () => stream.end(),
      events: translateEvents(),
      abort: () => {
        aborted = true;
        stopChunkTimer();
        stream.end();
      },
    };
  }
}

registerProvider('claude', (opts) => new ClaudeProvider(opts));
