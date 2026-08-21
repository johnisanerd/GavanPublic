/**
 * Trace-e2e harness — barrel export.
 *
 * Typical use:
 *
 *   import { startSession, createTraceLog } from '@harness/index';
 *
 *   const s = await startSession({ scenario: 'smoke-test' });
 *   const log = createTraceLog(s.stream);
 *   await s.driver.sendUser('begin');
 *   const fwd = await log.waitFor('request-layer.decided',
 *     e => e.data.decision === 'forward', { within: 3000 });
 *   ...
 *   await s.end();
 */
export type { LogEvent } from './types.js';
export type { Identity } from './ids.js';
export type { Driver, DriverConfig } from './driver.js';
export type { EventStream, EventListener, OpenStreamOpts } from './stream.js';
export type { TraceLog, BetweenQuery, EventPredicate, WaitForOpts } from './dsl.js';
export type { JudgeResult, JudgeOpts } from './judge.js';

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mintIdentity } from './ids.js';
import { createDriver, type DriverConfig } from './driver.js';
import { openEventStream } from './stream.js';
import { createTraceLog, TraceTimeoutError } from './dsl.js';

export { mintIdentity } from './ids.js';
export { createDriver } from './driver.js';
export { openEventStream } from './stream.js';
export { createTraceLog, TraceTimeoutError } from './dsl.js';
export { judge } from './judge.js';

export interface Session {
  driver: ReturnType<typeof createDriver>;
  stream: ReturnType<typeof openEventStream>;
  log: ReturnType<typeof createTraceLog>;
  /** Absolute path where this session's full event log will be dumped
   *  on `end()`. Use in test failure messages so the operator has a
   *  forensic artifact to inspect. */
  logFilePath: string;
  end: () => Promise<void>;
}

export interface StartSessionOpts {
  scenario: string;
  driverConfig?: DriverConfig;
  /** Override the directory where event-log JSONL files land. Defaults
   *  to `<trace-e2e-root>/test-logs/`. */
  logDir?: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOG_DIR = join(__dirname, '..', '..', 'test-logs');

/** One-shot bootstrap: mint identity, preflight, open the event stream,
 *  build a trace log. Returns a `Session` whose `end()` closes the
 *  stream AND dumps the full event buffer to a JSONL file under
 *  `trace-e2e/test-logs/<thread_id>.jsonl` for forensics. */
export async function startSession(opts: StartSessionOpts): Promise<Session> {
  const identity = mintIdentity(opts.scenario);
  const driver = createDriver(identity, opts.driverConfig);
  await driver.preflight();
  const stream = openEventStream({
    base: driver.base,
    sessionId: identity.sessionId,
    platformId: identity.platformId,
    // Set `since` slightly in the past so we don't race the first
    // POST. Events with ts < now-50ms are filtered out by upstream.
    since: Date.now() - 50,
  });
  await stream.ready;
  const log = createTraceLog(stream);

  const logDir = opts.logDir ?? DEFAULT_LOG_DIR;
  const logFilePath = join(logDir, `${identity.threadId}.jsonl`);

  // Patch the dsl's TraceTimeoutError so failures point at the artifact.
  // We patch by wrapping the underlying waitFor — see `attachLogPath`.
  attachLogPath(stream, logFilePath);

  return {
    driver,
    stream,
    log,
    logFilePath,
    async end() {
      await driver.sessionEnded();
      stream.close();
      // Dump the captured buffer to a durable JSONL artifact.
      try {
        mkdirSync(logDir, { recursive: true });
        const body = stream.events.map((e) => JSON.stringify(e)).join('\n') + '\n';
        writeFileSync(logFilePath, body, 'utf8');
        // Print the path so vitest's stdout capture lands a clickable
        // file path next to each test's pass/fail line.
        // eslint-disable-next-line no-console
        console.log(`[trace-e2e] log dumped: ${logFilePath} (${stream.events.length} events)`);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[trace-e2e] failed to dump log to ${logFilePath}: ${(e as Error).message}`);
      }
    },
  };
}

/** Bolt the log-file path onto any `TraceTimeoutError` that fires for
 *  this stream. We can't pass it into the dsl factory cleanly without
 *  threading it through every waitFor call; this side-channel works
 *  because Node throws a new Error per timeout and we listen for it. */
function attachLogPath(stream: ReturnType<typeof openEventStream>, logFilePath: string): void {
  // Wrap by monkey-patching the prototype's message getter once.
  // Simpler than refactoring: catch in tests via `try/catch` and
  // re-throw with the path appended. We instead set a side-channel
  // on the stream itself; the dsl reads it.
  (stream as unknown as { __traceLogPath?: string }).__traceLogPath = logFilePath;
}
