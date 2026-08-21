/**
 * Live SSE event subscriber + in-memory buffer.
 *
 * Subscribes to `${base}/anam-web/events?session=<sid>&platform_id=<pid>&since=<ms>`
 * and parses each `data:` line into a `LogEvent`. Every event is:
 *   1. Pushed to an in-memory ring buffer (the `EventLog`).
 *   2. Dispatched to any pending `waitFor` predicates.
 *
 * The buffer is unbounded for the duration of a test — tests are
 * minutes-long and the volume is well under a thousand events. We
 * could ring-buffer later if needed.
 */
import type { LogEvent } from './types.js';

export type EventListener = (rec: LogEvent) => void;

export interface EventStream {
  events: LogEvent[];
  onEach(listener: EventListener): () => void;
  close(): void;
  /** Resolves when the underlying fetch has returned a response (so
   *  callers can be sure the subscription is wired before sending
   *  the first message). */
  ready: Promise<void>;
}

export interface OpenStreamOpts {
  base: string;
  sessionId: string;
  platformId: string;
  /** Optional ms epoch; events with `ts < since` are excluded by the
   *  upstream. Defaults to now (no replay of historical events). */
  since?: number;
}

export function openEventStream(opts: OpenStreamOpts): EventStream {
  const url = new URL(`${opts.base}/anam-web/events`);
  url.searchParams.set('session', opts.sessionId);
  url.searchParams.set('platform_id', opts.platformId);
  url.searchParams.set('since', String(opts.since ?? Date.now()));

  const events: LogEvent[] = [];
  const listeners = new Set<EventListener>();
  const abort = new AbortController();
  let closed = false;

  let resolveReady: () => void = () => {};
  let rejectReady: (e: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const dispatch = (rec: LogEvent): void => {
    events.push(rec);
    for (const l of listeners) l(rec);
  };

  (async () => {
    let res: Response;
    try {
      res = await fetch(url.toString(), { signal: abort.signal });
    } catch (e) {
      if (closed) return;
      rejectReady(e as Error);
      return;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      rejectReady(new Error(`SSE subscribe ${res.status}: ${detail.slice(0, 200)}`));
      return;
    }
    if (!res.body) {
      rejectReady(new Error('SSE subscribe: no response body'));
      return;
    }
    resolveReady();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (!closed) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (e) {
        if (closed) return;
        if ((e as Error).name === 'AbortError') return;
        throw e;
      }
      if (chunk.done) return;
      buf += decoder.decode(chunk.value);
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (!data || data.startsWith(':')) continue;
        try {
          const parsed = JSON.parse(data) as LogEvent;
          dispatch(parsed);
        } catch {
          // ignore malformed line — SSE keep-alives etc.
        }
      }
    }
  })().catch((e) => {
    if (closed) return;
    rejectReady(e as Error);
  });

  return {
    events,
    onEach(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      closed = true;
      try {
        abort.abort();
      } catch {
        // ignore
      }
      listeners.clear();
    },
    ready,
  };
}
