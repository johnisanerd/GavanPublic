/**
 * Per-thread rolling conversation history — the unified ring buffer
 * the front-mind reads on every model call. Same shape across all
 * channels.
 *
 * Each entry has a `role` (user | pat) and may carry a
 * `basedOnBackMindProgress` / `basedOnBackMindResults` field that
 * grounds a Pat utterance against the back-mind state at the moment
 * the utterance was minted. The library's `formatHistory()` (banter.ts)
 * truncates these at render time so the prompt body stays bounded.
 *
 * Caller composes the key (typically `platformId:threadId`). Library
 * doesn't construct keys — each channel knows its thread-key
 * convention.
 *
 * The 12-entry cap is the same in every adapter today; if a channel
 * needs a different cap eventually, it can construct its own instance
 * with a different value.
 */

import type { BanterHistoryEntry } from './banter.js';

/** Default max entries retained per thread. Matches the value that
 *  existed inline in both nanoclaw channel adapters before the lift. */
export const CONVERSATION_HISTORY_MAX_DEFAULT = 12;

export class ConversationHistory {
  private buffers = new Map<string, BanterHistoryEntry[]>();
  private readonly maxEntries: number;

  constructor(opts: { maxEntries?: number } = {}) {
    this.maxEntries = opts.maxEntries ?? CONVERSATION_HISTORY_MAX_DEFAULT;
  }

  /** Append an entry, stamping `ts` to now. Evicts oldest when over
   *  the cap. */
  push(key: string, entry: Omit<BanterHistoryEntry, 'ts'>): void {
    const buf = this.buffers.get(key) ?? [];
    buf.push({ ...entry, ts: new Date().toISOString() });
    while (buf.length > this.maxEntries) buf.shift();
    this.buffers.set(key, buf);
  }

  /** Snapshot of the ring buffer for this thread, oldest-first. Empty
   *  array if no history yet. Returns the live buffer reference — do
   *  not mutate; callers should treat it as read-only. */
  get(key: string): BanterHistoryEntry[] {
    return this.buffers.get(key) ?? [];
  }

  /** Drop the buffer for one thread. Useful when a session ends and
   *  the orchestrator wants to free state. */
  clear(key: string): void {
    this.buffers.delete(key);
  }
}
