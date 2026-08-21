import { useQuery, type UseQueryOptions } from '@tanstack/react-query';

/** Append the viewer token to a URL (matches the server's ?token= auth). */
export function appendToken(url: string, token: string | null): string {
  if (!token) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}

async function fetchJson<T>(path: string, token: string | null): Promise<T> {
  const res = await fetch(appendToken(path, token));
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/**
 * POST JSON to a dashboard endpoint (token appended like the GETs). Throws on
 * non-2xx OR on a `{ error }` payload, so callers can surface a message. Used by
 * the People tab's link/unlink mutations; pair with react-query's useMutation.
 */
export async function postJson<T = unknown>(
  path: string,
  body: unknown,
  token: string | null,
): Promise<T> {
  const res = await fetch(appendToken(path, token), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text().catch(() => '');
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  if (!res.ok) {
    const msg = (json as { error?: string }).error ?? `${res.status} ${res.statusText}: ${text.slice(0, 200)}`;
    throw new Error(msg);
  }
  if (json && typeof json === 'object' && 'error' in json && (json as { error?: string }).error) {
    throw new Error((json as { error: string }).error);
  }
  return json as T;
}

/**
 * react-query wrapper for the dashboard's GET endpoints. Loop-safe by design:
 * react-query owns fetching/dedup/caching and caps retries (default 3) — no
 * hand-rolled effect that can churn. Disabled until `path` is non-null.
 */
export function useApiData<T>(
  path: string | null,
  token: string | null,
  opts?: Omit<UseQueryOptions<T, Error>, 'queryKey' | 'queryFn'>,
) {
  return useQuery<T, Error>({
    queryKey: ['api', path, token],
    queryFn: () => fetchJson<T>(path!, token),
    enabled: !!path,
    ...opts,
  });
}
