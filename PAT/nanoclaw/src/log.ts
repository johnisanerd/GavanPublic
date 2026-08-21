import fs from 'fs';
import path from 'path';

const LEVELS = { debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;
type Level = keyof typeof LEVELS;

const COLORS: Record<Level, string> = {
  debug: '\x1b[34m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  fatal: '\x1b[41m\x1b[37m',
};
const KEY_COLOR = '\x1b[35m';
const MSG_COLOR = '\x1b[36m';
const RESET = '\x1b[39m';
const FULL_RESET = '\x1b[0m';

// PAT: default to 'debug' so kind:'llm.call' traces (the full prompt +
// response forensic stream) always land in the daily log file. Without
// this default, post-mortem on a weird call ("what did the model
// actually see?") needs a re-run with LOG_LEVEL=debug — which is
// useless when the bad call already happened. Volume cost is bounded
// because most debug-level kinds (llm.call in particular) are gated
// behind `?include_debug=1` on the read side, so casual /admin/logs
// readers don't see them unless they ask. Override with LOG_LEVEL=info
// in env if a deploy truly needs less noise on disk.
const threshold = LEVELS[(process.env.LOG_LEVEL as Level) || 'debug'] ?? LEVELS.debug;

// PAT: persistent host-log sink. Fly's `flyctl logs` buffer rolls every
// ~7-10 minutes, so any forensic log analysis on past calls hits a
// data wall. We tee every emit() to a JSONL file on the data volume —
// survives container restarts, deploys, anything short of volume loss.
//
// Path: $DATA_DIR/logs/host-YYYY-MM-DD.jsonl (rotated daily so a single
// day's troubleshooting fits in one file but the working set stays
// bounded). Created lazily; misconfigured-disk failures degrade
// silently to console-only logging.
//
// Off-by-default for unit tests via PAT_DISABLE_HOST_LOG=1.
const PERSISTENT_LOG_DISABLED = process.env.PAT_DISABLE_HOST_LOG === '1';
const LOG_DIR_FROM_ENV = process.env.PAT_HOST_LOG_DIR;

let _persistentSinkInitialized = false;
let _persistentSinkPath: string | null = null;
let _persistentSinkErrored = false;

function ensurePersistentSink(): string | null {
  if (PERSISTENT_LOG_DISABLED || _persistentSinkErrored) return null;
  // Resolve path lazily so config.DATA_DIR is initialized first. Read at
  // emit() time avoids an import cycle: log.ts ← config.ts ← log.ts.
  const resolvedDir = LOG_DIR_FROM_ENV ?? path.resolve(process.cwd(), 'data', 'logs');
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  const candidatePath = path.join(resolvedDir, `host-${today}.jsonl`);
  if (_persistentSinkInitialized && _persistentSinkPath === candidatePath) {
    return _persistentSinkPath;
  }
  try {
    fs.mkdirSync(resolvedDir, { recursive: true });
    _persistentSinkPath = candidatePath;
    _persistentSinkInitialized = true;
    return _persistentSinkPath;
  } catch (err) {
    // Bail once; don't keep retrying. Console-only fallback.
    _persistentSinkErrored = true;
    process.stderr.write(`[log] persistent sink disabled: ${(err as Error).message}\n`);
    return null;
  }
}

function appendPersistent(line: object): void {
  const sinkPath = ensurePersistentSink();
  if (!sinkPath) return;
  try {
    fs.appendFileSync(sinkPath, JSON.stringify(line) + '\n');
  } catch (err) {
    // First write failure → disable sink so we don't spam.
    _persistentSinkErrored = true;
    process.stderr.write(`[log] persistent sink write failed: ${(err as Error).message}\n`);
  }
}

function formatErr(err: unknown): string {
  if (err instanceof Error) {
    return `{ type: "${err.constructor.name}", message: "${err.message}", stack: ${err.stack} }`;
  }
  return JSON.stringify(err);
}

function formatData(data: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    parts.push(`${KEY_COLOR}${k}${RESET}=${k === 'err' ? formatErr(v) : JSON.stringify(v)}`);
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

function ts(): string {
  // ISO 8601 UTC, matching SQLite session DBs and voice-transport.log.
  // Forensics across the realtime pipeline (host log + vt log +
  // outbound.db.timestamp) all share one timezone — sort works.
  return new Date().toISOString();
}

// PAT: default source for emit() calls — see log.event() for the
// structured form. Override at module-load time if a different process
// (agent-runner, etc.) reuses this logger.
const DEFAULT_SOURCE = process.env.PAT_LOG_SOURCE ?? 'nanoclaw-host';

// PAT: stable per-event id, stamped at emit. Format:
//   "<source-prefix>-<process-start-ms>-<counter>"
// Combining process-start-ms with a monotonic counter makes the id
// globally unique across restarts (counter resets to 0 on each boot,
// but the start-ms differs). Persisted to the JSONL file so consumers
// (dashboard, fly-call-log) can dedupe replays exactly.
const _SOURCE_PREFIX = DEFAULT_SOURCE === 'nanoclaw-host' ? 'nch' : DEFAULT_SOURCE.slice(0, 4);
const _PROCESS_START_MS = Date.now();
let _eventCounter = 0;
function nextEventId(): string {
  _eventCounter += 1;
  return `${_SOURCE_PREFIX}-${_PROCESS_START_MS}-${_eventCounter}`;
}

interface StructuredEventLine {
  ts: string;
  source: string;
  id: string;
  kind: string;
  level: Level;
  thread_id?: string | null;
  session_id?: string | null;
  platform_id?: string | null;
  data: Record<string, unknown>;
}

function emit(level: Level, msg: string, data?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const tag = `${COLORS[level]}${level.toUpperCase()}${level === 'fatal' ? FULL_RESET : RESET}`;
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  const tsStr = ts();
  stream.write(`[${tsStr}] ${tag} ${MSG_COLOR}${msg}${RESET}${data ? formatData(data) : ''}\n`);
  // PAT: free-form log.info(msg, fields) calls land as kind='misc' so
  // the persistent JSONL still has a uniform shape. Migrated call
  // sites use log.event({kind: 'banter.called', ...}) directly.
  // Top-level context fields (thread_id / session_id / platform_id)
  // are pulled out of `data` if present so consumers can filter on them
  // without diving into data.
  const { thread_id, session_id, platform_id, ...rest } = (data ?? {}) as Record<string, unknown> & {
    thread_id?: string;
    session_id?: string;
    platform_id?: string;
  };
  const structured: StructuredEventLine = {
    ts: tsStr,
    source: DEFAULT_SOURCE,
    id: nextEventId(),
    kind: 'misc',
    level,
    ...(thread_id ? { thread_id } : {}),
    ...(session_id ? { session_id } : {}),
    ...(platform_id ? { platform_id } : {}),
    data: { msg, ...rest },
  };
  appendPersistent(structured);
}

/**
 * PAT: structured-event emit. Migrated call sites use this instead of
 * log.info('free text', { ...fields }) so consumers can dispatch on
 * `kind` without regex'ing free-form strings. See
 * `realtime/src/log-events.ts` for the canonical schema.
 *
 * Console output reconstructs a one-line representation of the event
 * for human-readable streaming; the JSONL persistent sink gets the
 * structured form verbatim.
 */
export interface EventEmitArgs {
  kind: string;
  level?: Level;
  thread_id?: string | null;
  session_id?: string | null;
  platform_id?: string | null;
  /** Override the emitting source. Used by `/admin/log-event` to keep
   *  forwarded peer events tagged with their actual source (e.g.
   *  `voice-transport`) instead of the host's DEFAULT_SOURCE. Most
   *  call sites should leave this unset. */
  source?: string;
  /** Override the stamped event id. Used by `/admin/log-event` to
   *  preserve the forwarded peer's own monotonic id so dashboards can
   *  dedupe across the boundary. Most call sites should leave unset. */
  id?: string;
  data: Record<string, unknown>;
}

function emitEvent(args: EventEmitArgs): void {
  const level: Level = args.level ?? 'info';
  if (LEVELS[level] < threshold) return;
  const tag = `${COLORS[level]}${level.toUpperCase()}${level === 'fatal' ? FULL_RESET : RESET}`;
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  const tsStr = ts();
  // Console: short kind-prefixed line for human eyes. Includes top-
  // level context if present.
  const ctxParts: string[] = [];
  if (args.thread_id) ctxParts.push(`thread=${args.thread_id}`);
  if (args.session_id) ctxParts.push(`session=${args.session_id.slice(0, 16)}`);
  if (args.platform_id) ctxParts.push(`platform=${args.platform_id}`);
  const ctxStr = ctxParts.length ? ` [${ctxParts.join(' ')}]` : '';
  stream.write(`[${tsStr}] ${tag} ${MSG_COLOR}${args.kind}${RESET}${ctxStr}${formatData(args.data)}\n`);
  const structured: StructuredEventLine = {
    ts: tsStr,
    source: args.source ?? DEFAULT_SOURCE,
    id: args.id ?? nextEventId(),
    kind: args.kind,
    level,
    ...(args.thread_id ? { thread_id: args.thread_id } : {}),
    ...(args.session_id ? { session_id: args.session_id } : {}),
    ...(args.platform_id ? { platform_id: args.platform_id } : {}),
    data: args.data,
  };
  appendPersistent(structured);
}

export const log = {
  debug: (msg: string, data?: Record<string, unknown>) => emit('debug', msg, data),
  info: (msg: string, data?: Record<string, unknown>) => emit('info', msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => emit('warn', msg, data),
  error: (msg: string, data?: Record<string, unknown>) => emit('error', msg, data),
  fatal: (msg: string, data?: Record<string, unknown>) => emit('fatal', msg, data),
  event: (args: EventEmitArgs) => emitEvent(args),
};

process.on('uncaughtException', (err) => {
  log.fatal('Uncaught exception', { err });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection', { err: reason });
});
