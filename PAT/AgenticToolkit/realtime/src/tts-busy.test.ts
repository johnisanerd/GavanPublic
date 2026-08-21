/**
 * Tests for TtsBusyTracker — focused on the `waitForEnded` async
 * resolver added so the timeline sequencer can bind say-completion to
 * actual TTS end-of-audio instead of a length-estimate setTimeout.
 */
import { describe, it, expect } from 'vitest';
import { TtsBusyTracker } from './tts-busy.js';

describe('TtsBusyTracker.waitForEnded', () => {
  it('resolves immediately when no markStarted is in flight', async () => {
    const tts = new TtsBusyTracker();
    const t0 = Date.now();
    await tts.waitForEnded('thread-x');
    expect(Date.now() - t0).toBeLessThan(20);
  });

  it('resolves when markEnded fires (back-channel signal)', async () => {
    const tts = new TtsBusyTracker();
    tts.markStarted('thread-x', 5000);
    const waitP = tts.waitForEnded('thread-x', { fallbackMs: 5000 });
    // Fire the back-channel signal as if the browser had returned
    // endOfSpeech. Should resolve waitP.
    setTimeout(() => tts.markEnded('thread-x', 'hello'), 10);
    const t0 = Date.now();
    await waitP;
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(5);
    expect(elapsed).toBeLessThan(200);
  });

  it('pairs N markEnded calls with N waiters in FIFO order', async () => {
    const tts = new TtsBusyTracker();
    const settled: number[] = [];
    tts.markStarted('thread-x', 5000);
    const w0 = tts.waitForEnded('thread-x', { fallbackMs: 5000 }).then(() => settled.push(0));
    tts.markStarted('thread-x', 5000);
    const w1 = tts.waitForEnded('thread-x', { fallbackMs: 5000 }).then(() => settled.push(1));
    tts.markStarted('thread-x', 5000);
    const w2 = tts.waitForEnded('thread-x', { fallbackMs: 5000 }).then(() => settled.push(2));

    // First markEnded settles w0.
    tts.markEnded('thread-x', 'a');
    await w0;
    expect(settled).toEqual([0]);

    // Second settles w1.
    tts.markStarted('thread-x', 5000); // re-mark busy so next waitForEnded would queue
    tts.markEnded('thread-x', 'b');
    await w1;
    expect(settled).toEqual([0, 1]);

    // Third settles w2.
    tts.markStarted('thread-x', 5000);
    tts.markEnded('thread-x', 'c');
    await w2;
    expect(settled).toEqual([0, 1, 2]);
  });

  it('resolves via the fallback timer if markEnded never fires', async () => {
    const tts = new TtsBusyTracker();
    tts.markStarted('thread-x', 5000);
    const t0 = Date.now();
    await tts.waitForEnded('thread-x', { fallbackMs: 100 });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(300);
    // After fallback, the tracker treats the thread as ended.
    expect(tts.isBusy('thread-x')).toBe(false);
  });

  it('rejects with AbortError when the signal aborts', async () => {
    const tts = new TtsBusyTracker();
    tts.markStarted('thread-x', 5000);
    const ctrl = new AbortController();
    const waitP = tts.waitForEnded('thread-x', { signal: ctrl.signal, fallbackMs: 5000 });
    setTimeout(() => ctrl.abort(), 10);
    let caught: Error | null = null;
    try {
      await waitP;
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.name).toBe('AbortError');
  });

  it('rejects immediately if the signal is already aborted', async () => {
    const tts = new TtsBusyTracker();
    tts.markStarted('thread-x', 5000);
    const ctrl = new AbortController();
    ctrl.abort();
    let caught: Error | null = null;
    try {
      await tts.waitForEnded('thread-x', { signal: ctrl.signal });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.name).toBe('AbortError');
  });

  it('aborted waiter does not consume a subsequent markEnded', async () => {
    const tts = new TtsBusyTracker();
    tts.markStarted('thread-x', 5000);
    const settled: string[] = [];
    const ctrlA = new AbortController();
    // Waiter A will abort
    const wA = tts.waitForEnded('thread-x', { signal: ctrlA.signal, fallbackMs: 5000 })
      .then(() => settled.push('A:resolved'))
      .catch((err) => settled.push(`A:${(err as Error).name}`));
    // Waiter B (also queued)
    tts.markStarted('thread-x', 5000);
    const wB = tts.waitForEnded('thread-x', { fallbackMs: 5000 })
      .then(() => settled.push('B:resolved'));

    ctrlA.abort();
    await wA;
    expect(settled).toEqual(['A:AbortError']);

    // Now fire markEnded — it should land on B, not the (already-rejected) A.
    tts.markEnded('thread-x', 'payload');
    await wB;
    expect(settled).toEqual(['A:AbortError', 'B:resolved']);
  });
});
