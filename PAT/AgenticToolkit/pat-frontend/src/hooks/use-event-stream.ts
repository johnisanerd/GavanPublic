import { useEffect, useRef, useState } from 'react';
import type { LogEvent } from '@/types/log-events';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export interface EventStreamOpts {
  /** Receives every parsed event in arrival order. */
  onEvent: (ev: LogEvent) => void;
  /** Token from the page query string, forwarded to the SSE endpoint. */
  token?: string | null;
  /** Override the SSE URL. Default: `/api/logs.tail`. */
  url?: string;
  /** Optional wall-clock ms cutoff. When set, only events with
   *  `ts >= sinceMs` are streamed — useful for advanced users who want
   *  to skip a long backlog. Default: undefined (replay everything;
   *  the frontend's id-based dedupe handles replays correctly). */
  sinceMs?: number;
}

/**
 * EventSource subscription with auto-reconnect, surfaced as a connection-
 * status pill. The browser's EventSource already retries on disconnect,
 * but we track the open/error edges to drive the UI.
 *
 * Anti-flap: the upstream Hono SSE proxy + nanoclaw connection drops
 * every few seconds under HTTP/2 protocol errors and immediately
 * reconnects. Without dampening, the status pill flickers
 * "live → offline → live" continuously even though a steady stream of
 * bytes is arriving.
 *
 * Strategy: only show 'disconnected' after BOTH (a) the EventSource has
 * fired `onerror`, AND (b) DISCONNECT_GRACE_MS have passed since the
 * last byte. Any onmessage / onopen during the grace window cancels
 * the pending transition. This means a 200ms flap registers as nothing
 * at all, which is what the user wants.
 *
 * Fail-safe reconnect (PAT): we do NOT lean on EventSource's native
 * auto-retry — it retries forever at a fixed cadence and we can't see
 * the cause (a `401` from a missing token or a dead upstream looks like
 * any other error). With nothing to connect to that becomes a hammer
 * that can lock the tab. Instead, on every error we CLOSE the source and
 * reconnect ourselves with exponential backoff capped at MAX_RECONNECT_MS,
 * so the worst case is one slow retry every 30s — never a tight loop. Any
 * healthy byte resets the backoff, so it self-heals the instant the
 * upstream (or auth) comes back.
 */
const DISCONNECT_GRACE_MS = 5_000;
const BASE_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;

export function useEventStream({
  onEvent,
  token,
  url = '/api/logs.tail',
  sinceMs,
}: EventStreamOpts) {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  // Lock `since` to first mount so reconnect doesn't keep advancing it.
  const sinceRef = useRef<number | undefined>(sinceMs);

  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let disconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    let stopped = false; // set on cleanup so no straggler reconnect fires

    const clearDisconnectTimer = () => {
      if (disconnectTimer !== null) {
        clearTimeout(disconnectTimer);
        disconnectTimer = null;
      }
    };

    const connect = () => {
      if (stopped) return;
      let errored = false; // handle at most one error per connection attempt

      const qs = new URLSearchParams();
      if (token) qs.set('token', token);
      if (sinceRef.current !== undefined) qs.set('since', String(sinceRef.current));
      const fullUrl = qs.toString() ? `${url}?${qs.toString()}` : url;
      es = new EventSource(fullUrl);
      setStatus((s) => (s === 'connected' ? s : 'connecting'));

      const markConnected = () => {
        clearDisconnectTimer();
        failures = 0; // any healthy byte resets the backoff
        setStatus('connected');
      };

      es.onopen = () => markConnected();
      es.onmessage = (e) => {
        // Any byte (even a keepalive comment) proves the link is healthy.
        markConnected();
        try {
          const rec = JSON.parse(e.data) as LogEvent;
          onEventRef.current(rec);
        } catch {
          /* ignore malformed line */
        }
      };
      es.onerror = () => {
        if (errored || stopped) return;
        errored = true;
        // Take over reconnection: close this source (stops native retry)
        // and schedule our own backed-off reconnect.
        es?.close();
        es = null;
        failures += 1;
        // Anti-flap: surface 'disconnected' only after the grace window,
        // so a sub-5s blip that recovers never flickers the pill.
        if (disconnectTimer === null) {
          disconnectTimer = setTimeout(() => {
            disconnectTimer = null;
            setStatus('disconnected');
          }, DISCONNECT_GRACE_MS);
        }
        const delay = Math.min(BASE_RECONNECT_MS * 2 ** (failures - 1), MAX_RECONNECT_MS);
        if (reconnectTimer !== null) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      stopped = true;
      clearDisconnectTimer();
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      es?.close();
    };
  }, [url, token]);

  return status;
}
