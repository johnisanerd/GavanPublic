/**
 * PAT: in-memory per-thread cursor for tag-stream scenarios. Replaces
 * the on-disk `.cursor` round-trip for tag-stream packets (legacy
 * packets still use disk via the `present_advance` MCP tool).
 *
 * Keyed by `conversationKey(threadId, platformId)` from the realtime
 * library — fresh per anam-web session id, so two parallel visitors
 * to the same scenario slug each advance their own deck independently.
 * Default value 1 on first read (matches `readCursor`'s legacy
 * default and the on-disk seed `provision.ts` writes at packet
 * creation time).
 *
 * Cleared on session end via `clearScenarioCursor` — the anam-web
 * adapter calls this from `handleSessionEnded`. The map is a few
 * bytes per session; leaking on crash is harmless.
 */

const cursorByThread = new Map<string, number>();

/** Read the current slide cursor for a thread. Default 1 — matches
 *  the legacy on-disk default. */
export function getScenarioCursor(threadKey: string): number {
  return cursorByThread.get(threadKey) ?? 1;
}

/** Set the cursor for a thread to an absolute 1-indexed slide
 *  number. Clamps to >=1. */
export function setScenarioCursor(threadKey: string, n: number): void {
  if (!Number.isFinite(n)) return;
  cursorByThread.set(threadKey, Math.max(1, Math.floor(n)));
}

/** Drop the cursor for a thread (session end / barge-in reset). */
export function clearScenarioCursor(threadKey: string): void {
  cursorByThread.delete(threadKey);
}

/** Debug: snapshot of all active cursors. Not load-bearing. */
export function _snapshotScenarioCursors(): Record<string, number> {
  return Object.fromEntries(cursorByThread.entries());
}
