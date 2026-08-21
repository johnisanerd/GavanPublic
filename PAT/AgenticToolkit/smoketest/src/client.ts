/**
 * RealtimeClient — POSTs user turns to NanoClaw's `/inbound` and consumes
 * the `/outbound` SSE stream.
 *
 * Mirrors the bridge wait-for-chat pattern from transports/main.py:
 *   - front-mind ack arrives sub-second as kind='realtime-utterance'
 *   - back-mind reply arrives later as kind='chat'
 *
 * The harness explicitly does NOT collapse those two kinds; scenarios assert
 * on both. (The Cartesia bridge collapses them into AgentSendText for TTS,
 * but we want to see the structure here.)
 */
import http from 'node:http';

export type SseKind = 'realtime-utterance' | 'chat' | string;

export interface SseEvent {
  /** Event kind from the server. */
  kind: SseKind;
  /** Body text (extracted from `content.text` in the JSON payload). */
  text: string;
  /** Sender, when present. */
  sender?: string;
  /** Wall-clock receive time on the harness side. */
  receivedAt: number;
  /** Original parsed payload, for tests that want full fidelity. */
  raw: unknown;
}

export interface InboundResponse {
  accepted?: boolean;
  classification?: string;
  spoke?: boolean;
  [k: string]: unknown;
}

export interface RealtimeClientOptions {
  baseUrl?: string;
  /** Called for every SSE event. Use waitFor* helpers for typical scenarios. */
  onEvent?: (ev: SseEvent) => void;
}

export class RealtimeClient {
  private readonly baseUrl: string;
  private readonly onEvent?: (ev: SseEvent) => void;
  private sseReq: http.ClientRequest | null = null;
  private buffered: SseEvent[] = [];
  private waiters: Array<{
    predicate: (ev: SseEvent) => boolean;
    resolve: (ev: SseEvent) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  private closed = false;
  private connectPromise: Promise<void> | null = null;

  constructor(opts: RealtimeClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? process.env.REALTIME_BASE_URL ?? 'http://127.0.0.1:8765';
    this.onEvent = opts.onEvent;
  }

  /** Open the SSE connection. Resolves once the server has acknowledged the open. */
  async connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const url = new URL('/outbound', this.baseUrl);
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'GET',
          headers: { Accept: 'text/event-stream' },
        },
        (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`SSE connect failed: HTTP ${res.statusCode}`));
            return;
          }
          let buf = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            buf += chunk;
            // SSE record boundary is a blank line.
            let idx: number;
            while ((idx = buf.indexOf('\n\n')) !== -1) {
              const record = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              const ev = parseSseRecord(record);
              if (!ev) continue;
              if (ev.event === 'open') {
                resolve();
                continue;
              }
              const parsed = safeParse(ev.data);
              if (parsed === null) continue;
              const text = extractText(parsed);
              const evt: SseEvent = {
                kind: typeof parsed === 'object' && parsed && 'kind' in parsed ? String((parsed as Record<string, unknown>).kind) : 'unknown',
                text,
                sender: extractSender(parsed),
                receivedAt: Date.now(),
                raw: parsed,
              };
              this.dispatch(evt);
            }
          });
          res.on('end', () => {
            if (!this.closed) this.failWaiters(new Error('SSE stream ended'));
          });
          res.on('error', (err) => {
            if (!this.closed) this.failWaiters(err);
          });
        },
      );
      req.on('error', reject);
      req.end();
      this.sseReq = req;
    });
    return this.connectPromise;
  }

  /**
   * POST a synthetic user turn to /inbound.
   *
   * `threadId` is the key the realtime adapter routes on (when the wiring is
   * `session_mode='per-thread'`). Pass a stable per-scenario id like
   * `smoke-baseline` so each scenario gets its own session = its own
   * container = isolated back-mind memory. Reusing the same threadId across
   * runs of the same scenario reuses the warm container.
   *
   * `platformId` selects the messaging group. Defaults to `'smoketest'` so
   * traffic lands on the dedicated test wiring (session_mode='per-thread'),
   * keeping smoke isolation orthogonal to phone-call routing on `'local'`.
   */
  async postTurn(
    text: string,
    sender = 'smoke-test',
    threadId?: string,
    platformId: string = 'smoketest',
  ): Promise<InboundResponse> {
    const body: Record<string, unknown> = { text, sender, platform_id: platformId };
    if (threadId) body.thread_id = threadId;
    const payload = JSON.stringify(body);
    const url = new URL('/inbound', this.baseUrl);
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload).toString(),
          },
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => (body += c));
          res.on('end', () => {
            if (res.statusCode !== 200) {
              reject(new Error(`/inbound HTTP ${res.statusCode}: ${body}`));
              return;
            }
            try {
              resolve(JSON.parse(body));
            } catch {
              resolve({ raw: body });
            }
          });
        },
      );
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  /**
   * Wait for the next event matching the predicate. Throws on timeout.
   *
   * `sinceMs` (default `Date.now()`) gates which events count: only events
   * with `receivedAt >= sinceMs` can satisfy the wait. Important for
   * correctness across scenario steps: a stale chat from a previous turn
   * that's still buffered in the SSE channel must NOT auto-satisfy a fresh
   * `wait-chat` registered against the current turn. Callers usually want
   * the default; pass an earlier `sinceMs` only when intentionally looking
   * back (e.g. retroactive assertions).
   */
  waitFor(
    predicate: (ev: SseEvent) => boolean,
    timeoutMs: number,
    label = 'event',
    sinceMs: number = Date.now(),
  ): Promise<SseEvent> {
    // Drain buffered events that arrived AT OR AFTER the gate.
    for (let i = 0; i < this.buffered.length; i++) {
      const ev = this.buffered[i]!;
      if (ev.receivedAt < sinceMs) continue;
      if (predicate(ev)) {
        this.buffered.splice(i, 1);
        return Promise.resolve(ev);
      }
    }
    return new Promise<SseEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error(`timeout (${timeoutMs}ms) waiting for ${label}`));
      }, timeoutMs);
      this.waiters.push({
        predicate: (ev) => ev.receivedAt >= sinceMs && predicate(ev),
        resolve,
        reject,
        timer,
      });
    });
  }

  /** Wait for the next event with a given kind. */
  waitForKind(kind: SseKind, timeoutMs: number): Promise<SseEvent> {
    return this.waitFor((e) => e.kind === kind, timeoutMs, `kind=${kind}`);
  }

  /** Drop all buffered events. Useful between scenario steps that share a connection. */
  clearBuffer(): void {
    this.buffered = [];
  }

  /** Close the SSE stream. */
  close(): void {
    this.closed = true;
    this.failWaiters(new Error('client closed'));
    if (this.sseReq) {
      try {
        this.sseReq.destroy();
      } catch {
        // ignore
      }
      this.sseReq = null;
    }
  }

  private dispatch(evt: SseEvent): void {
    this.onEvent?.(evt);
    // Try to satisfy a waiter first.
    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i]!;
      if (w.predicate(evt)) {
        clearTimeout(w.timer);
        this.waiters.splice(i, 1);
        w.resolve(evt);
        return;
      }
    }
    // Otherwise buffer.
    this.buffered.push(evt);
    // Cap buffer at 200 to avoid unbounded growth on long runs.
    if (this.buffered.length > 200) this.buffered.shift();
  }

  private failWaiters(err: Error): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  }
}

function parseSseRecord(record: string): { event: string; data: string } | null {
  const lines = record.split('\n');
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0 && event === 'message') return null;
  return { event, data: dataLines.join('\n') };
}

function safeParse(s: string): unknown | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * PAT: is this SSE event the back-mind's substantive reply?
 * Two wire shapes exist:
 *  - kind='chat' — non-streaming deployments (PAT_STREAMING_BANTER unset)
 *  - kind='utterance-end' with content.source='banter-rendition' — the
 *    streaming rendition path (staging + prod today): the chat row is
 *    re-spoken as a streamed utterance and no kind='chat' event is emitted.
 * Scenario steps that mean "the agent's actual answer" must accept both.
 */
export function isBackMindReply(e: SseEvent): boolean {
  if (e.kind === 'chat') return true;
  if (e.kind !== 'utterance-end') return false;
  const content = (e.raw as { content?: { source?: string } } | null)?.content;
  return content?.source === 'banter-rendition';
}

function extractText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const o = payload as Record<string, unknown>;
  let content = o.content;
  if (typeof content === 'string') {
    const parsed = safeParse(content);
    if (parsed && typeof parsed === 'object') content = parsed;
    else return content;
  }
  if (content && typeof content === 'object') {
    const t = (content as Record<string, unknown>).text;
    if (typeof t === 'string') return t;
    // PAT: streaming-banter rendition (PAT_STREAMING_BANTER=1 — staging +
    // prod) delivers the back-mind reply as utterance-end with `full_text`
    // instead of a kind='chat' row with `text`. Without this, wait-chat /
    // matching steps are blind to the agent's actual reply on any
    // streaming-enabled deployment (found live: publish-file smoke saw the
    // published URL land in utterance-end.full_text and still timed out).
    const ft = (content as Record<string, unknown>).full_text;
    if (typeof ft === 'string') return ft;
  }
  return '';
}

function extractSender(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const o = payload as Record<string, unknown>;
  let content = o.content;
  if (typeof content === 'string') {
    const parsed = safeParse(content);
    if (parsed && typeof parsed === 'object') content = parsed;
  }
  if (content && typeof content === 'object') {
    const s = (content as Record<string, unknown>).sender;
    if (typeof s === 'string') return s;
  }
  return undefined;
}
