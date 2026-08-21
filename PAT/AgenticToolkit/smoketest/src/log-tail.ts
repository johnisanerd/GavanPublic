/**
 * Structured-log tail subscriber + tiny assertion DSL.
 *
 * Per AGENTS.md "Trace-based end-to-end tests" + `docs/log-schema.md`:
 * trace-based scenarios assert against the same `kind`-discriminated
 * structured log stream the host emits in production — not against
 * scraped chat strings, regex-matched message text, or front-mind SSE
 * payloads.
 *
 * Wraps NanoClaw's `/admin/logs.tail` SSE endpoint into a tiny
 * predicate-based subscriber:
 *
 *   const tail = await openLogTail({ baseUrl, sinceMs: Date.now() - 500 });
 *   const ev = await tail.waitFor(
 *     (e) => e.kind === 'chat.row-received' && e.thread_id === threadId,
 *     30_000,
 *     'first chat row',
 *   );
 *   tail.close();
 *
 * Domain-specific by design — the predicates we want to write (`kind ===
 * X && data.foo === Y && thread_id === Z`) are small enough that wrapping
 * them in a general assertion library would be more noise than signal.
 *
 * Auth: if PAT_ADMIN_TOKEN is set, it's threaded into the URL as
 * `?token=...` (the host's bridge also accepts the Authorization header,
 * but URL token is friendlier to flyctl proxy + curl pasta).
 */
import http from 'node:http';

/** Top-level structured-log event shape. Mirrors `BaseLogEvent` from
 *  `realtime/src/log-events.ts` — kept loose here so any new kind shows
 *  up without a schema update. Per-kind `data` payloads are
 *  per-kind-typed; consumers MUST dispatch on `.kind` before reading
 *  `.data.field` (see AGENTS.md Logging rules). */
export interface LogEvent {
  ts: string;
  kind: string;
  level?: 'info' | 'warn' | 'error' | 'fatal';
  source?: string;
  thread_id?: string | null;
  session_id?: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
}

export interface LogTailWatcher {
  /** Block until a log event matches `predicate`. Throws on timeout. */
  waitFor(predicate: (ev: LogEvent) => boolean, timeoutMs: number, label?: string): Promise<LogEvent>;
  /** Collect all matching events that have arrived since open / last
   *  collect call. Removes them from the buffer. Non-blocking. */
  collect(predicate: (ev: LogEvent) => boolean): LogEvent[];
  /** Find the most recent buffered event matching `predicate` WITHOUT
   *  removing it. Returns null when none matches. Useful for events that
   *  persist across probes (e.g. boot-time `capability.install-resolved`
   *  snapshots — same install state applies to every inbound). */
  findRecent(predicate: (ev: LogEvent) => boolean): LogEvent | null;
  /** Close the SSE connection and reject any in-flight waiters. */
  close(): void;
}

export interface OpenLogTailOptions {
  /** NanoClaw host URL (defaults to REALTIME_BASE_URL or 127.0.0.1:8765). */
  baseUrl?: string;
  /** Earliest event ts to consider (ms since epoch). Defaults to "now"
   *  so the tail is live-only. Set to e.g. `Date.now() - 500` to catch
   *  events that race the SSE open. */
  sinceMs?: number;
  /** Override for PAT_ADMIN_TOKEN. */
  adminToken?: string;
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:8765';
const MAX_BUFFERED = 1000;

export async function openLogTail(opts: OpenLogTailOptions = {}): Promise<LogTailWatcher> {
  const baseUrl = opts.baseUrl ?? process.env.REALTIME_BASE_URL ?? DEFAULT_BASE_URL;
  const url = new URL('/admin/logs.tail', baseUrl);
  if (typeof opts.sinceMs === 'number') {
    url.searchParams.set('since', String(opts.sinceMs));
  }
  const token = opts.adminToken ?? process.env.PAT_ADMIN_TOKEN;
  if (token) url.searchParams.set('token', token);

  const buffered: LogEvent[] = [];
  type Waiter = {
    predicate: (ev: LogEvent) => boolean;
    resolve: (ev: LogEvent) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  };
  const waiters: Waiter[] = [];
  let req: http.ClientRequest | null = null;
  let closed = false;

  await new Promise<void>((resolve, reject) => {
    req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'GET',
        headers: { Accept: 'text/event-stream' },
      },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`/admin/logs.tail HTTP ${res.statusCode}`));
          return;
        }
        resolve();
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buf += chunk;
          // The tail emits each JSONL line as its own SSE `data:` field
          // (no event:* prefix). Boundaries are single newlines, not the
          // SSE-spec blank-line — match the host's actual emit shape.
          let idx: number;
          while ((idx = buf.indexOf('\n')) !== -1) {
            const rawLine = buf.slice(0, idx);
            buf = buf.slice(idx + 1);
            const line = rawLine.startsWith('data:') ? rawLine.slice(5).trim() : rawLine.trim();
            if (!line || line.startsWith(':')) continue;
            let parsed: LogEvent;
            try {
              parsed = JSON.parse(line) as LogEvent;
            } catch {
              continue;
            }
            if (!parsed.kind) continue;
            dispatch(parsed);
          }
        });
        res.on('end', () => {
          if (!closed) failAll(new Error('logs.tail stream ended'));
        });
        res.on('error', (err) => {
          if (!closed) failAll(err);
        });
      },
    );
    req.on('error', reject);
    req.end();
  });

  function dispatch(ev: LogEvent): void {
    // Try to satisfy a waiter before buffering, so a long-buffered
    // event from a previous predicate doesn't block a fresh predicate
    // looking at the very next event.
    for (let i = 0; i < waiters.length; i++) {
      const w = waiters[i]!;
      if (w.predicate(ev)) {
        clearTimeout(w.timer);
        waiters.splice(i, 1);
        w.resolve(ev);
        return;
      }
    }
    buffered.push(ev);
    if (buffered.length > MAX_BUFFERED) buffered.shift();
  }

  function failAll(err: Error): void {
    const ws = waiters.splice(0);
    for (const w of ws) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  return {
    waitFor(predicate, timeoutMs, label = 'event') {
      // Drain backlog first — events that arrived while no waiter was
      // registered can still satisfy a fresh waitFor (matches the
      // RealtimeClient semantics in client.ts).
      for (let i = 0; i < buffered.length; i++) {
        const ev = buffered[i]!;
        if (predicate(ev)) {
          buffered.splice(i, 1);
          return Promise.resolve(ev);
        }
      }
      return new Promise<LogEvent>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.timer === timer);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(new Error(`timeout (${timeoutMs}ms) waiting for ${label}`));
        }, timeoutMs);
        waiters.push({ predicate, resolve, reject, timer });
      });
    },
    collect(predicate) {
      const hits: LogEvent[] = [];
      for (let i = buffered.length - 1; i >= 0; i--) {
        const ev = buffered[i]!;
        if (predicate(ev)) {
          hits.unshift(ev);
          buffered.splice(i, 1);
        }
      }
      return hits;
    },
    findRecent(predicate) {
      // Walk newest-first — most consumers want the latest snapshot.
      for (let i = buffered.length - 1; i >= 0; i--) {
        const ev = buffered[i]!;
        if (predicate(ev)) return ev;
      }
      return null;
    },
    close() {
      closed = true;
      failAll(new Error('watcher closed'));
      try {
        req?.destroy();
      } catch {
        /* ignore */
      }
    },
  };
}

// ─── Tiny predicate helpers — readable inline for the common shapes ────

/** `ev.kind === kind`. */
export const isKind =
  (kind: string) =>
  (ev: LogEvent): boolean =>
    ev.kind === kind;

/** `ev.kind === kind && ev.thread_id === threadId`. */
export const isKindForThread =
  (kind: string, threadId: string) =>
  (ev: LogEvent): boolean =>
    ev.kind === kind && ev.thread_id === threadId;

/** Combine multiple predicates with logical AND. */
export const allOf =
  (...preds: Array<(ev: LogEvent) => boolean>) =>
  (ev: LogEvent): boolean =>
    preds.every((p) => p(ev));
