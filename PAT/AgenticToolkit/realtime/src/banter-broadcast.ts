/**
 * In-memory banter-event fanout for streaming channels.
 *
 * The browser (or any subscriber) tails an SSE stream of
 * `utterance.stream-{started,delta,ended,cancelled}` events to drive
 * a TTS stream in real time. We don't tail the structured log file —
 * that adds latency and replay complexity. Instead each adapter
 * broadcasts to a session-scoped subscriber set and keeps a bounded
 * backlog for reconnect-replay (Last-Event-Id).
 *
 * State per session id:
 *   - A bounded backlog (default 500 events) — read on reconnect.
 *   - A live subscriber set; `broadcast` fans out to each subscriber.
 *
 * Cleanup is explicit (`clear(sessionId)` on barge-in / session-ended).
 * Adapters can layer their own idle-eviction on top.
 */

export type BanterEventKind =
  | 'utterance.stream-started'
  | 'utterance.stream-delta'
  | 'utterance.stream-ended'
  | 'utterance.stream-cancelled';

export interface BanterEvent {
  /** Per-session monotonic id, e.g. `banter-<sessionId>-<counter>`. */
  id: string;
  ts: string;
  kind: BanterEventKind;
  thread_id: string | null;
  platform_id: string;
  data: Record<string, unknown>;
}

export type BanterSubscriber = (e: BanterEvent) => void;

/** Default backlog cap per session. ~500 events covers a multi-minute
 *  reconnect window without unbounded memory growth. */
export const BANTER_BACKLOG_MAX_DEFAULT = 500;

export class BanterBroadcast {
  private subscribers = new Map<string, Set<BanterSubscriber>>();
  private backlog = new Map<string, BanterEvent[]>();
  private counter = new Map<string, number>();
  private readonly backlogMax: number;
  private readonly onSubscriberError: (err: unknown) => void;

  constructor(opts: {
    backlogMax?: number;
    /** Called when a subscriber throws during a broadcast. Default:
     *  swallow. Adapters typically pass `(err) => log.warn(...)`. */
    onSubscriberError?: (err: unknown) => void;
  } = {}) {
    this.backlogMax = opts.backlogMax ?? BANTER_BACKLOG_MAX_DEFAULT;
    this.onSubscriberError = opts.onSubscriberError ?? (() => {});
  }

  /** Mint the next per-session id. Adapters typically only need
   *  `broadcast()`; this is exposed for callers that want to stamp an
   *  event with a known id before fanout. */
  nextId(sessionId: string): string {
    const n = (this.counter.get(sessionId) ?? 0) + 1;
    this.counter.set(sessionId, n);
    return `banter-${sessionId}-${n}`;
  }

  broadcast(
    sessionId: string | null,
    kind: BanterEventKind,
    threadId: string | null,
    platformId: string,
    data: Record<string, unknown>,
  ): void {
    if (!sessionId) return;
    const evt: BanterEvent = {
      id: this.nextId(sessionId),
      ts: new Date().toISOString(),
      kind,
      thread_id: threadId,
      platform_id: platformId,
      data,
    };
    const backlog = this.backlog.get(sessionId) ?? [];
    backlog.push(evt);
    while (backlog.length > this.backlogMax) backlog.shift();
    this.backlog.set(sessionId, backlog);

    const subs = this.subscribers.get(sessionId);
    if (subs) {
      for (const fn of subs) {
        try {
          fn(evt);
        } catch (err) {
          this.onSubscriberError(err);
        }
      }
    }
  }

  /** Subscribe to a session. Replays backlog entries newer than
   *  `sinceId` (set via `Last-Event-Id` header on reconnect) before
   *  attaching the live subscriber. Returns an unsubscribe fn. */
  subscribe(sessionId: string, fn: BanterSubscriber, sinceId: string | null): () => void {
    const backlog = this.backlog.get(sessionId) ?? [];
    let startIdx = 0;
    if (sinceId) {
      const i = backlog.findIndex((e) => e.id === sinceId);
      if (i >= 0) startIdx = i + 1;
    }
    for (let i = startIdx; i < backlog.length; i++) {
      try {
        fn(backlog[i]!);
      } catch {
        /* swallow replay errors — adapter saw onSubscriberError on
         * original broadcast already. */
      }
    }
    let subs = this.subscribers.get(sessionId);
    if (!subs) {
      subs = new Set();
      this.subscribers.set(sessionId, subs);
    }
    subs.add(fn);
    return () => {
      const set = this.subscribers.get(sessionId);
      if (!set) return;
      set.delete(fn);
      if (set.size === 0) this.subscribers.delete(sessionId);
    };
  }

  /** Drop everything for one session. Adapters call on barge-in /
   *  session-ended so a returning browser starts clean. */
  clear(sessionId: string | null): void {
    if (!sessionId) return;
    this.subscribers.delete(sessionId);
    this.backlog.delete(sessionId);
    this.counter.delete(sessionId);
  }
}
