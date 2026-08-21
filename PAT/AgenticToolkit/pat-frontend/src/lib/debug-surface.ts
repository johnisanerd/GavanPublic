/**
 * Helpers for attaching debug state to the browser `window` object so
 * power users can inspect it from the devtools / Chrome js tool. Wraps
 * the otherwise-repeated `(window as unknown as { __x?: T }).__x = v`
 * cast-and-assign idiom in a single typed helper.
 *
 * Conventions:
 *   - Namespaces are prefixed with `__` (window globals; rare enough
 *     not to collide).
 *   - `setDebugSurface` overwrites the whole slot; use when one call
 *     site owns the namespace.
 *   - `getDebugNamespace` returns a stable mutable object; use when
 *     several call sites contribute to the same namespace.
 *
 * Mirror of pat-web/src/lib/debug-surface.ts. The two apps ship
 * separately; if you change semantics here, mirror it there.
 */

type DebugWindow = Window & Record<string, unknown>;

function debugWindow(): DebugWindow | null {
  if (typeof window === 'undefined') return null;
  return window as unknown as DebugWindow;
}

/** Overwrite `window.__<name>` with `value`. Use for slots a single
 *  call site owns. Silently no-ops in non-browser contexts. */
export function setDebugSurface<T>(name: string, value: T): void {
  const w = debugWindow();
  if (!w) return;
  w[`__${name}`] = value;
}

/** Return a stable mutable object stored at `window.__<name>`,
 *  creating it on first call. Use when several call sites mutate the
 *  same debug namespace (e.g. a ring buffer one site pushes into and
 *  another site reads from). */
export function getDebugNamespace<T extends Record<string, unknown>>(
  name: string,
): T {
  const w = debugWindow();
  if (!w) return {} as T;
  const key = `__${name}`;
  let v = w[key] as T | undefined;
  if (!v || typeof v !== 'object') {
    v = {} as T;
    w[key] = v;
  }
  return v;
}
