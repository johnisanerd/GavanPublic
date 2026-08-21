/**
 * TimelineQueue + Sequencer — the linear-contract heart of the timeline
 * runtime.
 *
 * - `TimelineQueue` is a per-thread FIFO of `TimelineAction`. The parser
 *   fills it; the sequencer drains it.
 * - `Sequencer.run()` loops: peek → dispatch (await) → dequeue. The
 *   contract is N+1 doesn't start until N's completion signal fires.
 * - Cancellation: `Sequencer.abort(reason)` calls the in-flight
 *   AbortController. The dispatcher should observe the signal and
 *   reject with AbortError; the sequencer catches it, records the
 *   action as partial, and exits the loop.
 *
 * The sequencer is intentionally minimal: it does not know about
 * scenarios, slides, tools. It just consumes actions and awaits a
 * dispatcher that knows how to fire them. Domain knowledge lives in
 * the dispatcher (which itself can delegate to registered extensions).
 */

import type {
  CompletedActionRecord,
  DispatchContext,
  DispatchFn,
  TimelineAction,
} from './types.js';

/** FIFO queue of timeline actions, per-thread. */
export class TimelineQueue {
  private readonly items: TimelineAction[] = [];

  /** Add an action to the back of the queue. */
  enqueue(action: TimelineAction): void {
    this.items.push(action);
  }

  /** Add many actions in order. Useful for `<timeline_span/>` hydration. */
  enqueueMany(actions: readonly TimelineAction[]): void {
    for (const a of actions) this.items.push(a);
  }

  /** Look at the next action without removing it. */
  peek(): TimelineAction | undefined {
    return this.items[0];
  }

  /** Remove and return the next action. */
  dequeue(): TimelineAction | undefined {
    return this.items.shift();
  }

  /** Drain the queue. Returns the discarded actions in original order
   *  so the caller can emit `timeline.action-cancelled` for each. */
  flush(): TimelineAction[] {
    const discarded = this.items.slice();
    this.items.length = 0;
    return discarded;
  }

  /** Snapshot of pending actions in queue order (read-only copy). */
  snapshot(): readonly TimelineAction[] {
    return this.items.slice();
  }

  get size(): number {
    return this.items.length;
  }

  get isEmpty(): boolean {
    return this.items.length === 0;
  }
}

/** Observer hooks for the sequencer loop — caller plugs in log emission
 *  + per-action telemetry. All hooks are best-effort (thrown errors
 *  are swallowed); the sequencer treats them as fire-and-forget. */
export interface SequencerHooks {
  /** Fires immediately before `dispatch` is awaited. */
  onActionStart?: (action: TimelineAction, ctx: DispatchContext, tsStart: number) => void;
  /** Fires after `dispatch` resolves successfully. */
  onActionComplete?: (record: CompletedActionRecord) => void;
  /** Fires after `dispatch` rejects with AbortError or the in-flight
   *  action is cancelled mid-flight. */
  onActionCancelled?: (record: CompletedActionRecord) => void;
  /** Fires for actions that were never started because abort happened
   *  while they sat in the queue. */
  onActionDropped?: (action: TimelineAction, seq: number, reason: string) => void;
}

export interface SequencerOpts {
  /** Stable id of the timeline being played. Threaded into
   *  `DispatchContext` so dispatchers and hooks see the same id. */
  timelineId: string;
  /** The dispatcher — usually a function that resolves the action's
   *  domain extension and calls its `dispatch`. */
  dispatch: DispatchFn;
  /** Optional channel-shaped identifiers — propagated to context. */
  threadId?: string | null;
  sessionId?: string | null;
  platformId?: string | null;
  /** Free-form host extras forwarded to `DispatchContext.host`. */
  host?: Record<string, unknown>;
  /** Telemetry/log hooks. */
  hooks?: SequencerHooks;
  /** Clock injector — Date.now() by default. Tests substitute a
   *  controllable clock to assert exact ts_start/ts_end. */
  now?: () => number;
}

/** Outcome of a sequencer run. */
export interface SequencerRunResult {
  reason: 'completed' | 'aborted';
  records: CompletedActionRecord[];
  /** Actions that were still in the queue when abort fired and got
   *  dropped without starting. */
  dropped: { action: TimelineAction; seq: number }[];
}

/** Linear-contract sequencer. One per timeline. */
export class Sequencer {
  private readonly queue: TimelineQueue;
  private readonly opts: SequencerOpts;
  private readonly records: CompletedActionRecord[] = [];
  private readonly dropped: { action: TimelineAction; seq: number }[] = [];
  private readonly now: () => number;

  /** Sequence index for the next dispatched action. Monotonic across
   *  the full lifetime of this sequencer (NOT reset on abort). */
  private nextSeq = 0;
  /** AbortController for the in-flight action. Recreated per action. */
  private currentAbort: AbortController | null = null;
  /** Snapshot of the in-flight action's record so abort can finalize it. */
  private currentRecord: CompletedActionRecord | null = null;
  /** External-abort reason captured by `abort()`; null when running. */
  private abortReason: string | null = null;
  private started = false;
  private finished = false;
  /** Hook to capture mid-flight partial state (e.g. partial TTS text)
   *  set by the dispatcher just before it rejects. */
  partialTextForCurrent: string | null = null;

  constructor(queue: TimelineQueue, opts: SequencerOpts) {
    this.queue = queue;
    this.opts = opts;
    this.now = opts.now ?? Date.now;
  }

  /** Drain the queue, dispatching one action at a time and awaiting
   *  each one's completion. Resolves when the queue is empty OR an
   *  abort fires. The result records every action that started + the
   *  partials of any that didn't get to start.
   *
   *  Safe to call exactly once per sequencer instance. */
  async run(): Promise<SequencerRunResult> {
    if (this.started) {
      throw new Error('Sequencer.run() may only be called once per instance');
    }
    this.started = true;

    while (!this.queue.isEmpty) {
      if (this.abortReason !== null) break;
      const action = this.queue.peek()!;
      const seq = this.nextSeq++;
      const abortController = new AbortController();
      this.currentAbort = abortController;
      this.partialTextForCurrent = null;

      const tsStart = this.now();
      const ctx: DispatchContext = {
        timelineId: this.opts.timelineId,
        seq,
        signal: abortController.signal,
        threadId: this.opts.threadId ?? null,
        sessionId: this.opts.sessionId ?? null,
        platformId: this.opts.platformId ?? null,
        host: this.opts.host,
        capturePartialText: (text: string) => {
          // Only meaningful for the currently-dispatching action.
          // A stale closure (e.g. dispatch resolved before the
          // caller's callback ran) lands in `partialTextForCurrent`
          // for the NEXT action, so guard via the in-flight record.
          if (this.currentRecord === record) {
            this.partialTextForCurrent = text;
          }
        },
      };

      const record: CompletedActionRecord = {
        action,
        seq,
        tsStart,
        tsEnd: null,
        partial: false,
      };
      this.currentRecord = record;
      safeFire(() => this.opts.hooks?.onActionStart?.(action, ctx, tsStart));

      try {
        await this.opts.dispatch(action, ctx);
        record.tsEnd = this.now();
        record.partial = false;
        this.records.push(record);
        this.queue.dequeue();
        safeFire(() => this.opts.hooks?.onActionComplete?.(record));
      } catch (err) {
        record.tsEnd = this.now();
        record.partial = true;
        if (this.partialTextForCurrent !== null) {
          record.partialText = this.partialTextForCurrent;
        }
        record.reason = this.abortReason ?? errMessage(err);
        this.records.push(record);
        // Drop the partially-played action — sequencer abort always
        // means we're done with this timeline.
        this.queue.dequeue();
        safeFire(() => this.opts.hooks?.onActionCancelled?.(record));
        if (isAbortError(err) || this.abortReason !== null) {
          // Abort propagates: drain remaining queue as dropped + break.
          break;
        }
        // Non-abort dispatcher error — same handling for now: log,
        // stop the timeline. (Could be relaxed to "continue on
        // non-terminal errors" later if needed.)
        break;
      } finally {
        this.currentAbort = null;
        this.currentRecord = null;
        this.partialTextForCurrent = null;
      }
    }

    // Drain leftovers as `dropped` records — these never started.
    while (!this.queue.isEmpty) {
      const action = this.queue.dequeue()!;
      const seq = this.nextSeq++;
      this.dropped.push({ action, seq });
      safeFire(() =>
        this.opts.hooks?.onActionDropped?.(
          action,
          seq,
          this.abortReason ?? 'sequencer-stopped',
        ),
      );
    }

    this.finished = true;
    return {
      reason: this.abortReason !== null ? 'aborted' : 'completed',
      records: this.records.slice(),
      dropped: this.dropped.slice(),
    };
  }

  /** Cancel the in-flight action (if any) and stop the loop. Safe to
   *  call from outside the sequencer's own promise chain (e.g. from a
   *  barge-in handler). Idempotent; subsequent calls are no-ops. */
  abort(reason: string): void {
    if (this.finished) return;
    if (this.abortReason !== null) return;
    this.abortReason = reason;
    if (this.currentAbort) {
      this.currentAbort.abort(new AbortError(reason));
    }
  }

  /** Dispatcher-side hook: capture a partial-text snapshot (used by
   *  `say` mid-cancel for the completed-actions block). Effective only
   *  during the lifetime of the current dispatch. */
  capturePartialText(text: string): void {
    this.partialTextForCurrent = text;
  }

  get records_snapshot(): readonly CompletedActionRecord[] {
    return this.records.slice();
  }

  get dropped_snapshot(): readonly { action: TimelineAction; seq: number }[] {
    return this.dropped.slice();
  }

  get isFinished(): boolean {
    return this.finished;
  }
}

/** AbortError mirror — Node's standard error w/ `.name === 'AbortError'`.
 *  Defined locally so we don't depend on `node:util` or DOM AbortError. */
export class AbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AbortError';
  }
}

function isAbortError(err: unknown): boolean {
  if (err instanceof AbortError) return true;
  if (err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError') {
    return true;
  }
  return false;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

function safeFire(fn: () => void): void {
  try {
    fn();
  } catch {
    // Hooks are best-effort; never let a hook crash the sequencer.
  }
}
