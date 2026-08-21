/**
 * Per-thread TTS-busy state, fed by transport-side "agent finished
 * speaking" notifications. The narration brain consults this in place
 * of the `len(text) / TTS_CHARS_PER_SEC` projection so follow-up
 * narrations don't talk over still-playing TTS.
 *
 * Model
 * -----
 * - `markStarted(thread, estDurMs)` — call when transport begins
 *   playback. Sets a busy flag with a fallback expiry; if the real
 *   "ended" signal never arrives (transport dropped, post failed,
 *   etc.) the flag clears automatically after `FALLBACK_TIMEOUT_MS`.
 * - `markEnded(thread, spoken)` — call when transport observes actual
 *   end of audio (Cartesia AgentTurnEnded for PSTN; Anam
 *   `endOfSpeech || interrupted` for anam-web). Clears the busy flag
 *   and stamps `lastEndedAt` so the narrator can time its cadence off
 *   real end-of-speech rather than a length projection.
 * - `isBusy(thread)` — narrator gate. Returns true if a `markStarted`
 *   is in flight and the fallback expiry hasn't fired yet.
 * - `getLastEndedAt(thread)` — narrator cadence calculation. Wall-clock
 *   ms of the most recent `markEnded`, or 0 if no utterance has
 *   completed on this thread yet.
 *
 * Thread key
 * ----------
 * Channels use whatever thread key is globally unique in their
 * platform — PSTN uses Cartesia call ids, anam-web uses
 * `anam-web-call-<sessionId>`. Pass `null` for the unscoped/legacy
 * session and the tracker stores it under a `__null__` sentinel.
 */

interface PendingWaiter {
  resolve: () => void;
  reject: (err: Error) => void;
}

/** Error.name='AbortError' so the timeline sequencer's `isAbortError()`
 *  picks it up by duck-type without importing the runtime's AbortError
 *  class (kept module-local; tts-busy stays foundational). */
function makeAbortError(message: string): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

export class TtsBusyTracker {
  // Map key: thread_id or '__null__' for the null-thread session.
  private busy = new Map<string, { until: number }>();
  // Wall-clock timestamp of the most recent `markEnded` per thread.
  private lastEndedAt = new Map<string, number>();
  // FIFO of waiters per thread. `waitForEnded` enqueues; `markEnded` /
  // fallback / abort dequeues + settles. One markEnded resolves the
  // single oldest waiter so concurrent per-say awaits stay paired with
  // their utterances.
  private waiters = new Map<string, PendingWaiter[]>();
  // Never let a stuck "busy" wedge a session forever — clear after
  // 30s even without an explicit end signal.
  private static FALLBACK_TIMEOUT_MS = 30_000;

  private key(threadId: string | null): string {
    return threadId ?? '__null__';
  }

  markStarted(threadId: string | null, estimatedDurationMs: number): void {
    const fallback = Math.max(estimatedDurationMs, 1500);
    this.busy.set(this.key(threadId), {
      until: Date.now() + Math.min(fallback, TtsBusyTracker.FALLBACK_TIMEOUT_MS),
    });
  }

  markEnded(threadId: string | null, _spoken: string): void {
    const k = this.key(threadId);
    this.busy.delete(k);
    this.lastEndedAt.set(k, Date.now());
    // Settle the oldest pending waiter — channels emit one `markEnded`
    // per finished utterance, so FIFO order pairs with per-say awaits.
    const arr = this.waiters.get(k);
    if (arr && arr.length > 0) {
      const w = arr.shift()!;
      if (arr.length === 0) this.waiters.delete(k);
      w.resolve();
    }
  }

  isBusy(threadId: string | null): boolean {
    const e = this.busy.get(this.key(threadId));
    if (!e) return false;
    if (Date.now() > e.until) {
      // Fallback timeout fired — treat as ended for cadence purposes
      // too so a missing signal doesn't wedge the narrator.
      this.busy.delete(this.key(threadId));
      this.lastEndedAt.set(this.key(threadId), Date.now());
      return false;
    }
    return true;
  }

  /** Wall-clock ms of the most recent `markEnded` for this thread, or
   *  0 if no utterance has finished yet on this thread. */
  getLastEndedAt(threadId: string | null): number {
    return this.lastEndedAt.get(this.key(threadId)) ?? 0;
  }

  /**
   * PAT: Wait for the next `markEnded` on this thread — i.e. the
   * transport observed actual end-of-audio. Used by the timeline
   * sequencer's `onSay` to bind the linear contract to real TTS
   * completion instead of a length-estimate setTimeout.
   *
   * Resolves on:
   *  - the next `markEnded(threadId, ...)` call
   *  - `opts.fallbackMs` (default 30s) elapsing — safety net for a
   *    transport that dropped the signal so the timeline never wedges
   *
   * Rejects with `Error('aborted')` if `opts.signal` aborts before
   * settle. Caller is expected to catch + emit utterance.stream-cancelled
   * via the existing barge-in path.
   *
   * If no `markStarted` is in flight, resolves immediately — there's
   * no audio to await.
   */
  waitForEnded(
    threadId: string | null,
    opts?: { signal?: AbortSignal; fallbackMs?: number },
  ): Promise<void> {
    if (!this.busy.has(this.key(threadId))) {
      return Promise.resolve();
    }
    const k = this.key(threadId);
    const fallbackMs = Math.max(opts?.fallbackMs ?? TtsBusyTracker.FALLBACK_TIMEOUT_MS, 100);
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        timer = null;
        if (opts?.signal) opts.signal.removeEventListener('abort', onAbort);
        const arr = this.waiters.get(k);
        if (arr) {
          const idx = arr.indexOf(waiter);
          if (idx >= 0) arr.splice(idx, 1);
          if (arr.length === 0) this.waiters.delete(k);
        }
      };
      const onAbort = (): void => {
        cleanup();
        reject(makeAbortError('aborted'));
      };
      const waiter: PendingWaiter = {
        resolve: () => {
          cleanup();
          resolve();
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
      };
      if (opts?.signal) {
        if (opts.signal.aborted) {
          reject(makeAbortError('aborted'));
          return;
        }
        opts.signal.addEventListener('abort', onAbort);
      }
      timer = setTimeout(() => {
        // Safety net — clears as if the transport had signaled end.
        // Mirrors `isBusy`'s passive expiry behavior so the sequencer
        // sees consistent state.
        const k2 = this.key(threadId);
        this.busy.delete(k2);
        this.lastEndedAt.set(k2, Date.now());
        waiter.resolve();
      }, fallbackMs);
      let arr = this.waiters.get(k);
      if (!arr) {
        arr = [];
        this.waiters.set(k, arr);
      }
      arr.push(waiter);
    });
  }
}
