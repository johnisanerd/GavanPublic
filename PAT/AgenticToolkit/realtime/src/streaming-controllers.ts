/**
 * Per-thread AbortControllers for in-flight streaming model calls
 * (banter-ack, banter-rendition, banter-narration). On barge-in /
 * session-ended, the orchestrator iterates and aborts every in-flight
 * stream on the affected thread so the user doesn't keep hearing
 * audio against a directive they've already pivoted away from.
 *
 * Each entry is removed by the stream-end / stream-cancel path so the
 * map doesn't accumulate stale entries across calls.
 *
 * Key shape
 * ---------
 * Caller-supplied composite key (typically `platformId:threadId`).
 * The library doesn't construct keys — channel adapters know their
 * thread-key conventions and pass them in.
 */

import type { BanterUtteranceSource } from './banter.js';

export interface BanterStreamSlot {
  ack?: AbortController;
  rendition?: AbortController;
  narration?: AbortController;
}

export class StreamingControllers {
  private slots = new Map<string, BanterStreamSlot>();

  /** Get-or-create the slot for a thread key. Caller stashes the
   *  AbortController under the right source field. */
  getOrCreate(key: string): BanterStreamSlot {
    let entry = this.slots.get(key);
    if (!entry) {
      entry = {};
      this.slots.set(key, entry);
    }
    return entry;
  }

  /** Mark one source's controller cleared. Removes the slot entirely
   *  when no source remains in-flight. */
  clear(key: string, source: BanterUtteranceSource): void {
    const entry = this.slots.get(key);
    if (!entry) return;
    if (source === 'banter-ack') entry.ack = undefined;
    else if (source === 'banter-rendition') entry.rendition = undefined;
    else if (source === 'banter-narration') entry.narration = undefined;
    if (!entry.ack && !entry.rendition && !entry.narration) {
      this.slots.delete(key);
    }
  }

  /** Abort every in-flight controller on this thread. Returns the
   *  count of streams that were actually aborted (already-aborted
   *  controllers don't count). Used by barge-in / session-ended. */
  abortAll(key: string): number {
    const entry = this.slots.get(key);
    if (!entry) return 0;
    let aborted = 0;
    for (const k of ['ack', 'rendition', 'narration'] as const) {
      const c = entry[k];
      if (c && !c.signal.aborted) {
        try {
          c.abort();
          aborted += 1;
        } catch {
          /* ignore — best-effort */
        }
      }
    }
    this.slots.delete(key);
    return aborted;
  }
}
