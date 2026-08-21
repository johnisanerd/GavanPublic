import { useEffect, useState, useRef } from 'react';

/**
 * useState clone that mirrors its value to localStorage. Reads on first
 * render, writes after every commit (except the very first, to avoid
 * HMR churn). On parse failure or quota error we silently fall back to
 * the in-memory value — persistence is a nice-to-have here, not a
 * correctness boundary.
 *
 * For object-shaped state we shallow-merge the stored blob over the
 * default, so adding a new field in code doesn't blow up an old
 * persisted shape — the new field inherits its default until touched.
 *
 * Mirror of pat-web/src/talk/hooks/use-persisted-state.ts. The two apps
 * ship as separate Fly services and can't share a workspace import; if
 * you touch the semantics here, mirror it there.
 */
export function usePersistedState<T>(
  key: string,
  initial: T,
  options: { merge?: boolean } = {},
): [T, (v: T | ((prev: T) => T)) => void] {
  const merge =
    options.merge ??
    (typeof initial === 'object' && initial !== null && !Array.isArray(initial));

  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return initial;
      const parsed = JSON.parse(raw) as T;
      if (
        merge &&
        typeof initial === 'object' &&
        initial !== null &&
        !Array.isArray(initial)
      ) {
        return { ...(initial as object), ...(parsed as object) } as T;
      }
      return parsed;
    } catch {
      return initial;
    }
  });

  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* quota or private-mode — silently skip */
    }
  }, [key, value]);

  return [value, setValue];
}
