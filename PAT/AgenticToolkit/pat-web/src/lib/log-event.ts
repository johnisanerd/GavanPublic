/**
 * Browser-side structured-log emit helper.
 *
 * Ships browser-originated structured events to nanoclaw's
 * `/admin/log-event` ingress (the same endpoint voice-transport uses)
 * via pat-web's own Hono server proxy at `/api/log-event`. The proxy
 * exists so we never expose nanoclaw's admin URL or token to the
 * browser; pat-web already holds the network position to reach
 * nanoclaw, so it's a trivial forward.
 *
 * Wire format mirrors `LogEvent` in `realtime/src/log-events.ts`:
 *   { source, kind, level?, thread_id?, session_id?, platform_id?, data }
 *
 * Source is fixed to 'pat-web-browser' — added as a valid `LogSource`
 * variant in the canonical schema. Errors are swallowed (`fire-and-
 * forget`): instrumentation should never break the call.
 */

import { patWebHeaders } from './pat-web-token';

const ENDPOINT = '/api/log-event';

export interface LogEventInput {
  /** Dotted '<area>.<event>' — must be one of the kinds declared in
   *  `realtime/src/log-events.ts` (drift test enforces this). */
  kind: string;
  /** Kind-specific payload. */
  data: Record<string, unknown>;
  level?: 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  thread_id?: string | null;
  session_id?: string | null;
  platform_id?: string | null;
}

/** Fire-and-forget. Never throws. */
export function logEvent(input: LogEventInput): void {
  try {
    const payload = {
      source: 'pat-web-browser',
      kind: input.kind,
      level: input.level ?? 'info',
      data: input.data,
      thread_id: input.thread_id ?? null,
      session_id: input.session_id ?? null,
      platform_id: input.platform_id ?? null,
    };
    // No await — UI-critical paths can't pause on instrumentation. The
    // browser keeps the request alive even if the caller's component
    // unmounts (HTTP/2 stream stays open until response).
    void fetch(ENDPOINT, {
      method: 'POST',
      headers: patWebHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {
      /* instrumentation failure must not propagate */
    });
  } catch {
    /* never throw from instrumentation */
  }
}

/** Fresh correlation id. Used to pair `inbound.sent` with the
 *  `utterance.delta-received` rows it eventually drives. */
export function newCorrelationId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    // Old browser fallback.
    return `corr-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  }
}
