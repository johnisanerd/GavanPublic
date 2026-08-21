import { useEffect, useState, useRef } from 'react';

/**
 * useState clone that also syncs to localStorage. Use a stable key
 * per slot so two different state slots never collide.
 *
 * For object-shaped state we shallow-merge the stored value into the
 * default so adding a new field in code doesn't blow up an old
 * persisted blob — the new field just inherits its default until the
 * user touches it.
 *
 * Writes are not debounced. A slider firing at 60Hz writes ~60 small
 * JSON blobs per second to localStorage — that's well within the
 * synchronous-write budget for any modern browser. If we ever stick
 * something genuinely bulky in here we can revisit.
 */
export function usePersistedState<T>(
  key: string,
  initial: T,
  options: { merge?: boolean } = {},
): [T, (v: T | ((prev: T) => T)) => void] {
  const merge = options.merge ?? (typeof initial === 'object' && initial !== null && !Array.isArray(initial));

  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return initial;
      const parsed = JSON.parse(raw) as T;
      if (merge && typeof initial === 'object' && initial !== null && !Array.isArray(initial)) {
        return { ...(initial as object), ...(parsed as object) } as T;
      }
      return parsed;
    } catch {
      return initial;
    }
  });

  // Only write after first commit to avoid churning during HMR.
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
