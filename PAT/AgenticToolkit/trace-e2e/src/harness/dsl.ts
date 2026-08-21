/**
 * Trace-test assertion DSL.
 *
 * Four primitives, all built on the EventStream from `stream.ts`:
 *
 *   - `waitFor(kind, predicate?, opts)` — bounded wait. Throws
 *     `TraceTimeoutError` with structured failure context on timeout.
 *   - `expectSequence([{kind, predicate?}, ...], opts)` — ordered
 *     waiting; allows arbitrary interleaving between steps.
 *   - `between(start, end).count(kind, predicate?)` — retrospective
 *     query over already-captured events.
 *   - `assertNot(kind, predicate?, within)` — negative window assertion.
 *
 * All `waitFor`-shape primitives serve future events relative to the
 * call site. `between` queries past events. `assertNot` waits for the
 * window to elapse then asserts nothing matched.
 *
 * Failure messages always include:
 *   - what we were waiting for (kind + predicate description if given)
 *   - elapsed time before throw
 *   - the last 20 events observed (kind, ts, thread)
 *   - if the kind we were waiting for has a known "family" (see
 *     `RELATED_KINDS`), the most recent event of any sibling kind —
 *     so a hung `query-end` shows the most recent `chat.row-received`,
 *     etc.
 */
import type { LogEvent } from './types.js';
import type { EventStream } from './stream.js';

export type EventPredicate = (rec: LogEvent) => boolean;

export interface WaitForOpts {
  /** Max wait in ms. Required — no implicit infinite waits. */
  within: number;
  /** Optional anchor event: only consider events with `ts > since.ts`. */
  since?: LogEvent | null;
  /** Optional human-readable description of the predicate for failure
   *  messages. Defaults to `predicate ? '(custom predicate)' : ''`. */
  describe?: string;
}

export class TraceTimeoutError extends Error {
  constructor(
    message: string,
    public readonly waitingFor: string,
    public readonly elapsedMs: number,
    public readonly tail: LogEvent[],
    public readonly relatedMostRecent: Record<string, LogEvent | undefined>,
  ) {
    super(message);
    this.name = 'TraceTimeoutError';
  }
}

/**
 * For a given kind, the related kinds whose most-recent event provides
 * context when the wait times out. E.g. a hung `query-end` benefits
 * from seeing the most recent `chat.row-received` or `detail.row-received`.
 */
const RELATED_KINDS: Record<string, string[]> = {
  'detail.row-received': ['chat.row-received', 'utterance.stream-ended', 'container.spawned', 'container.exited'],
  'chat.row-received': ['detail.row-received', 'utterance.stream-ended', 'container.exited'],
  'scenario.tag-stream-started': ['chat.row-received', 'detail.row-received', 'container.spawned'],
  'scenario.tag-stream-ended': ['scenario.action', 'scenario.tag-stream-started'],
  'scenario.action': ['scenario.tag-stream-started', 'chat.row-received'],
  'timeline.started': ['scenario.tag-stream-started', 'chat.row-received'],
  'timeline.finished': ['timeline.started', 'scenario.action', 'detail.row-received'],
  'request-layer.decided': ['inbound.received', 'banter.called'],
  'bargein.propagated': ['bargein.received', 'back-mind.cancelled'],
  'back-mind.cancelled': ['bargein.received', 'bargein.propagated'],
};

function parseTs(rec: LogEvent): number {
  return rec.ts ? Date.parse(rec.ts) : 0;
}

function summarizeEvent(rec: LogEvent): string {
  const ts = rec.ts ? rec.ts.slice(11, 23) : '????????????';
  const thread = rec.thread_id ? ` t=${rec.thread_id.slice(-12)}` : '';
  const dataStr = JSON.stringify(rec.data ?? {});
  const trimmed = dataStr.length > 100 ? `${dataStr.slice(0, 97)}…` : dataStr;
  return `${ts} ${rec.kind}${thread} ${trimmed}`;
}

export interface BetweenQuery {
  count(kind: string, predicate?: EventPredicate): number;
  all(kind: string, predicate?: EventPredicate): LogEvent[];
  first(kind: string, predicate?: EventPredicate): LogEvent | undefined;
}

export interface TraceLog {
  /** The live in-memory event buffer (for retrospective `all`/`first`). */
  readonly events: LogEvent[];

  /** Wait for the next event matching kind (+ optional predicate). */
  waitFor(kind: string, predicate: EventPredicate | null, opts: WaitForOpts): Promise<LogEvent>;
  waitFor(kind: string, opts: WaitForOpts): Promise<LogEvent>;

  /** Wait for an ordered sequence. Each step blocks until matched.
   *  Interleaving of other kinds between steps is allowed. */
  expectSequence(
    steps: Array<{ kind: string; predicate?: EventPredicate; describe?: string }>,
    opts: { within: number; since?: LogEvent | null },
  ): Promise<LogEvent[]>;

  /** Bracket query over already-captured events. */
  between(startInclusive: LogEvent, endInclusive: LogEvent): BetweenQuery;

  /** Wait `within` ms; throw if any event matches kind (+ predicate) in
   *  that window. */
  assertNot(kind: string, predicate: EventPredicate | null, opts: { within: number; since?: LogEvent | null; describe?: string }): Promise<void>;

  /** All historical events matching kind (+ predicate). */
  all(kind: string, predicate?: EventPredicate): LogEvent[];

  /** First historical event matching kind (+ predicate). */
  first(kind: string, predicate?: EventPredicate): LogEvent | undefined;
}

export function createTraceLog(stream: EventStream): TraceLog {
  const events = stream.events;

  function waitForImpl(
    kind: string,
    predicate: EventPredicate | null,
    opts: WaitForOpts,
  ): Promise<LogEvent> {
    const startedAt = Date.now();
    // PAT: default sinceTs=0 — all captured events are eligible.
    // The previous default (`Date.now()`) filtered out events that
    // arrived during the user-action call (e.g. sendUser's SSE
    // drain), causing false-negative timeouts for any event that
    // landed before the waitFor was scheduled. Tests anchor
    // downstream waits with `since: prevEvent` for ordering.
    const sinceTs = opts.since ? parseTs(opts.since) : 0;
    const describe = opts.describe ?? (predicate ? '(predicate)' : '');
    const waitingFor = `${kind}${describe ? ` ${describe}` : ''}`;

    // Check already-captured events first (since `since`).
    for (const rec of events) {
      if (rec.kind !== kind) continue;
      if (parseTs(rec) <= sinceTs) continue;
      if (predicate && !predicate(rec)) continue;
      return Promise.resolve(rec);
    }

    return new Promise<LogEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        const tail = events.slice(-20);
        const related: Record<string, LogEvent | undefined> = {};
        for (const relKind of RELATED_KINDS[kind] ?? []) {
          related[relKind] = [...events].reverse().find((e) => e.kind === relKind);
        }
        const elapsedMs = Date.now() - startedAt;
        const lines: string[] = [];
        lines.push(`Timed out after ${elapsedMs}ms waiting for: ${waitingFor}`);
        const relevantTail = tail.filter((e) => parseTs(e) > sinceTs);
        if (relevantTail.length === 0) {
          lines.push(`  (no events arrived since the wait began)`);
        } else {
          lines.push(`  Last ${relevantTail.length} events seen:`);
          for (const e of relevantTail) lines.push(`    ${summarizeEvent(e)}`);
        }
        if (Object.keys(related).length > 0) {
          lines.push(`  Most recent of related kinds:`);
          for (const [rk, rev] of Object.entries(related)) {
            if (!rev) lines.push(`    ${rk}: (never observed)`);
            else lines.push(`    ${rk}: ${summarizeEvent(rev)}`);
          }
        }
        // Side-channel: harness/index.ts attaches `__traceLogPath` to
        // the stream when startSession() wires durable log dumping.
        // Surface it in the error message so failures point at the
        // forensic artifact.
        const path = (stream as unknown as { __traceLogPath?: string }).__traceLogPath;
        if (path) {
          lines.push(`  Full event log will be dumped at session end: ${path}`);
        }
        reject(new TraceTimeoutError(lines.join('\n'), waitingFor, elapsedMs, relevantTail, related));
      }, opts.within);

      const unsub = stream.onEach((rec) => {
        if (rec.kind !== kind) return;
        if (parseTs(rec) <= sinceTs) return;
        if (predicate && !predicate(rec)) return;
        clearTimeout(timer);
        unsub();
        resolve(rec);
      });
    });
  }

  function waitFor(
    kind: string,
    a: EventPredicate | null | WaitForOpts,
    b?: WaitForOpts,
  ): Promise<LogEvent> {
    if (b) return waitForImpl(kind, a as EventPredicate | null, b);
    return waitForImpl(kind, null, a as WaitForOpts);
  }

  async function expectSequence(
    steps: Array<{ kind: string; predicate?: EventPredicate; describe?: string }>,
    opts: { within: number; since?: LogEvent | null },
  ): Promise<LogEvent[]> {
    const out: LogEvent[] = [];
    const deadline = Date.now() + opts.within;
    let since: LogEvent | null = opts.since ?? null;
    for (const step of steps) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        const tail = events.slice(-20);
        throw new TraceTimeoutError(
          `expectSequence: budget exhausted before step kind=${step.kind}; events so far: ${out.length}`,
          step.kind,
          opts.within,
          tail,
          {},
        );
      }
      const rec = await waitForImpl(step.kind, step.predicate ?? null, {
        within: remaining,
        since,
        describe: step.describe,
      });
      out.push(rec);
      since = rec;
    }
    return out;
  }

  function between(startInclusive: LogEvent, endInclusive: LogEvent): BetweenQuery {
    const startTs = parseTs(startInclusive);
    const endTs = parseTs(endInclusive);
    const slice = events.filter((e) => {
      const t = parseTs(e);
      return t >= startTs && t <= endTs;
    });
    return {
      count(kind, predicate) {
        return slice.filter((e) => e.kind === kind && (!predicate || predicate(e))).length;
      },
      all(kind, predicate) {
        return slice.filter((e) => e.kind === kind && (!predicate || predicate(e)));
      },
      first(kind, predicate) {
        return slice.find((e) => e.kind === kind && (!predicate || predicate(e)));
      },
    };
  }

  function assertNot(
    kind: string,
    predicate: EventPredicate | null,
    opts: { within: number; since?: LogEvent | null; describe?: string },
  ): Promise<void> {
    const sinceTs = opts.since ? parseTs(opts.since) : Date.now();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        resolve();
      }, opts.within);
      const unsub = stream.onEach((rec) => {
        if (rec.kind !== kind) return;
        if (parseTs(rec) <= sinceTs) return;
        if (predicate && !predicate(rec)) return;
        clearTimeout(timer);
        unsub();
        const describe = opts.describe ?? (predicate ? '(predicate)' : '');
        const waitingFor = `${kind}${describe ? ` ${describe}` : ''}`;
        reject(new Error(`assertNot violated: matched ${waitingFor}\n  matched event: ${summarizeEvent(rec)}`));
      });
    });
  }

  function all(kind: string, predicate?: EventPredicate): LogEvent[] {
    return events.filter((e) => e.kind === kind && (!predicate || predicate(e)));
  }
  function first(kind: string, predicate?: EventPredicate): LogEvent | undefined {
    return events.find((e) => e.kind === kind && (!predicate || predicate(e)));
  }

  return {
    events,
    waitFor: waitFor as TraceLog['waitFor'],
    expectSequence,
    between,
    assertNot,
    all,
    first,
  };
}
