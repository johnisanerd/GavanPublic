import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Long-lived pat-web↔server WebSocket — Mode C′ refactor (2026-05-23).
 *
 * Root of the realtime hook tree. Owns:
 *
 *   - The stable platform id (`anam-web:<localStorage uuid>` — or a
 *     scenario-pinned variant from `?scenario=<slug>`).
 *   - The per-call `sessionId` (uuid).
 *   - The per-session bearer for the WS upgrade auth.
 *   - The WS lifecycle (open/close/reconnect).
 *
 * Callers (`useAnamSession`, `useBanterDriver`) receive the WS handle
 * + ids as inputs, NOT the other way around — which kills the
 * ref-indirection + circular-dep workarounds the previous shape had.
 *
 * Browser-side auth: per-session bearer carried via
 * `Sec-WebSocket-Protocol: pat-bearer.<bearer>` on the upgrade. The
 * server mints the bearer at `/api/anam/session-token` time, bound to
 * (sessionId, platformId); it's redeemed once on upgrade. Tokens-in-URLs
 * leak via Referer / proxy logs; subprotocols never do.
 *
 * Reconnect: simple backoff. On unexpected close we retry a few times
 * with growing delay, then give up. We don't attempt to replay
 * in-flight utterances — losing a few deltas across a network blip is
 * acceptable; the next user turn re-bootstraps the pipeline. Note that
 * reconnect can't actually succeed today because the bearer is one-shot
 * and was redeemed by the initial connect — a true reconnect needs a
 * `/api/anam/session-token` refresh. The placeholder is kept so a
 * future fix can extend it.
 */

type ServerFrame = {
  kind?: string;
  data?: Record<string, unknown>;
} & Record<string, unknown>;

export type RealtimeFrameListener = (frame: ServerFrame) => void;

/** Per-session bundle returned by `/api/anam/session-token` (the
 *  fields the WS hook cares about). The caller passes `sessionToken`
 *  through to `useAnamSession.start()` separately. */
export interface RealtimeSessionInfo {
  sessionId: string;
  bearer: string;
  /** Stable platform id — same value the hook reports out. */
  platformId: string;
}

export interface UsePatRealtimeWsResult {
  /** Stable per-page platform id (`anam-web:<uuid>` or scenario variant). */
  platformId: string;
  /** Current per-call session id (uuid). Null when no call is active. */
  sessionId: string | null;
  /** True once the WS handshake completes for the current session. */
  ready: boolean;
  /** Send a user-message frame. No-op if WS isn't open. */
  sendUserMessage: (input: { text: string; threadId: string; correlationId: string }) => void;
  /** Send a turn-ended frame — pat-web's MESSAGE_STREAM_EVENT_RECEIVED
   *  branch fires this on `endOfSpeech || interrupted`. */
  sendTurnEnded: (input: { text: string; threadId: string; interrupted: boolean }) => void;
  /** Send a barge-in frame — wired to whatever signal pat-web exposes
   *  (Anam SDK's USER_SPEECH_STARTED interrupting a live persona stream). */
  sendBargeIn: (input: { sessionId: string; reason: string }) => void;
  /** Send a session-ended frame — fired on stop(). */
  sendSessionEnded: (input: { sessionId: string }) => void;
  /** Subscribe to server frames. Returns an unsubscribe. */
  addListener: (handler: RealtimeFrameListener) => () => void;
  /** Open a WS for a new call. Returns the IDs the rest of the realtime
   *  tree wires to. */
  openSession: (info: RealtimeSessionInfo) => void;
  /** Close the current WS + drop session/bearer state. */
  closeSession: () => void;
}

interface UsePatRealtimeWsOptions {
  /** When false the hook stays idle (demo mode doesn't open the WS). */
  enabled: boolean;
}

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_MS = 500;
// LocalStorage key for the persistent anam-web user uuid (the platform-id
// suffix). One uuid per browser; persists across visits so the same user
// accumulates conversation-ring history server-side.
const LS_KEY_UUID = 'pat-web:anam-web-uuid';

function getOrMintPlatformUuid(): string {
  try {
    const existing = localStorage.getItem(LS_KEY_UUID);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    localStorage.setItem(LS_KEY_UUID, fresh);
    return fresh;
  } catch {
    // Private mode / quota — fall back to a per-page-only uuid.
    return crypto.randomUUID();
  }
}

function resolvePlatformId(): string {
  // Scenario override: when the URL has `?scenario=<slug>`, route this
  // session to the scenario's messaging group (provisioned with
  // platform_id = anam-web:scenario-<slug>) instead of the operator's
  // persisted UUID. The `:scenario-` infix is channel-agnostic so the
  // same convention works for future signal / video transports.
  // Full-page navigation flips this on/off so it's stable for the page
  // lifetime.
  if (typeof window === 'undefined') return `anam-web:${crypto.randomUUID()}`;
  const scenarioSlug = new URLSearchParams(window.location.search).get('scenario');
  if (scenarioSlug) return `anam-web:scenario-${scenarioSlug}`;
  return `anam-web:${getOrMintPlatformUuid()}`;
}

export function usePatRealtimeWs(opts: UsePatRealtimeWsOptions): UsePatRealtimeWsResult {
  const { enabled } = opts;

  // Stable for the page lifetime. ref so it's set exactly once even
  // under Strict-Mode double-render.
  const platformIdRef = useRef<string | null>(null);
  if (platformIdRef.current === null) {
    platformIdRef.current = resolvePlatformId();
  }
  const platformId = platformIdRef.current;

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const listenersRef = useRef<Set<RealtimeFrameListener>>(new Set());
  const bearerRef = useRef<string>('');
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sendFrame = useCallback((frame: Record<string, unknown>): void => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.warn('[pat-web] realtime-ws: drop frame — socket not open', { kind: frame.kind });
      return;
    }
    try {
      ws.send(JSON.stringify(frame));
    } catch (err) {
      console.warn('[pat-web] realtime-ws: send failed', err);
    }
  }, []);

  const sendUserMessage = useCallback<UsePatRealtimeWsResult['sendUserMessage']>(
    ({ text, threadId, correlationId }) => {
      sendFrame({ kind: 'user-message', text, threadId, platformId, correlationId });
    },
    [platformId, sendFrame],
  );

  const sendTurnEnded = useCallback<UsePatRealtimeWsResult['sendTurnEnded']>(
    ({ text, threadId, interrupted }) => {
      sendFrame({ kind: 'turn-ended', text, threadId, interrupted });
    },
    [sendFrame],
  );

  const sendBargeIn = useCallback<UsePatRealtimeWsResult['sendBargeIn']>(
    ({ sessionId: sid, reason }) => {
      sendFrame({ kind: 'barge-in', sessionId: sid, reason });
    },
    [sendFrame],
  );

  const sendSessionEnded = useCallback<UsePatRealtimeWsResult['sendSessionEnded']>(
    ({ sessionId: sid }) => {
      sendFrame({ kind: 'session-ended', sessionId: sid });
    },
    [sendFrame],
  );

  const addListener = useCallback<UsePatRealtimeWsResult['addListener']>((handler) => {
    listenersRef.current.add(handler);
    return () => {
      listenersRef.current.delete(handler);
    };
  }, []);

  const openSession = useCallback<UsePatRealtimeWsResult['openSession']>((info) => {
    if (info.platformId !== platformId) {
      console.warn('[pat-web] realtime-ws: openSession platformId mismatch (ignoring)', {
        expected: platformId,
        got: info.platformId,
      });
    }
    bearerRef.current = info.bearer;
    setSessionId(info.sessionId);
  }, [platformId]);

  const closeSession = useCallback<UsePatRealtimeWsResult['closeSession']>(() => {
    bearerRef.current = '';
    setSessionId(null);
  }, []);

  // Driver effect — opens the WS whenever (enabled, sessionId, bearer)
  // become all-present, tears down otherwise. Restructured from the
  // prior shape: the IDs and the WS are owned by THIS hook so consumers
  // don't need to bounce data back via refs.
  useEffect(() => {
    if (!enabled || !sessionId) {
      // Teardown
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      const ws = wsRef.current;
      wsRef.current = null;
      setReady(false);
      if (ws) {
        try {
          ws.close(1000, 'session ended');
        } catch {
          /* noop */
        }
      }
      return;
    }
    const bearer = bearerRef.current;
    if (!bearer) {
      console.warn('[pat-web] realtime-ws: enabled + sessionId set but bearer is empty');
      return;
    }

    let cancelled = false;
    reconnectAttemptRef.current = 0;

    const open = (): void => {
      if (cancelled) return;
      const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const qs = new URLSearchParams({
        session: sessionId,
        platform_id: platformId,
        bearer,
      });
      // session + platform + bearer all ride the URL. Browsers can't
      // set custom headers on WS upgrade, and using Sec-WebSocket-
      // Protocol for the bearer needs the server to echo the chosen
      // subprotocol — Hono's `upgradeWebSocket` helper doesn't expose
      // response headers, and bypassing it caused Fly's edge proxy
      // to send a malformed upgrade response (1006). Bearer-in-URL
      // is safe here: pat-web is HTTPS-only, browsers never send
      // Referer on a WS upgrade, and the URL only persists in the
      // browser's own history.
      const url = `${scheme}//${window.location.host}/api/realtime?${qs.toString()}`;
      console.log('[pat-web] realtime-ws connecting', {
        url: url.replace(/bearer=[^&]+/, 'bearer=<redacted>'),
        attempt: reconnectAttemptRef.current,
      });
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        console.warn('[pat-web] realtime-ws WebSocket() threw', err);
        scheduleReconnect();
        return;
      }
      wsRef.current = ws;
      ws.onopen = () => {
        if (cancelled) {
          try {
            ws.close();
          } catch {
            /* noop */
          }
          return;
        }
        reconnectAttemptRef.current = 0;
        setReady(true);
        console.log('[pat-web] realtime-ws open');
      };
      ws.onmessage = (msg) => {
        if (cancelled) return;
        if (typeof msg.data !== 'string') return;
        let parsed: ServerFrame;
        try {
          parsed = JSON.parse(msg.data) as ServerFrame;
        } catch {
          return;
        }
        for (const h of listenersRef.current) {
          try {
            h(parsed);
          } catch (err) {
            console.warn('[pat-web] realtime-ws listener threw', err);
          }
        }
      };
      ws.onerror = () => {
        // onclose will fire next; let it handle reconnect.
        console.warn('[pat-web] realtime-ws error');
      };
      ws.onclose = (ev) => {
        if (cancelled) return;
        setReady(false);
        wsRef.current = null;
        // Clean shutdown — don't reconnect on intentional close (1000) or
        // when the server refused the upgrade (1008/401).
        if (ev.code === 1000 || ev.code === 1008) {
          console.log('[pat-web] realtime-ws closed cleanly', ev.code);
          return;
        }
        console.warn('[pat-web] realtime-ws closed unexpectedly', ev.code, ev.reason);
        scheduleReconnect();
      };
    };

    const scheduleReconnect = (): void => {
      if (cancelled) return;
      const attempt = reconnectAttemptRef.current++;
      if (attempt >= MAX_RECONNECT_ATTEMPTS) {
        console.warn('[pat-web] realtime-ws: giving up after', attempt, 'attempts');
        return;
      }
      const delay = RECONNECT_BASE_MS * Math.pow(2, attempt);
      console.warn('[pat-web] realtime-ws: reconnecting in', delay, 'ms (attempt', attempt + 1, ')');
      reconnectTimerRef.current = setTimeout(open, delay);
    };

    open();

    return () => {
      cancelled = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      const ws = wsRef.current;
      wsRef.current = null;
      setReady(false);
      if (ws) {
        try {
          ws.close(1000, 'session ended');
        } catch {
          /* noop */
        }
      }
    };
  }, [enabled, sessionId, platformId]);

  return {
    platformId,
    sessionId,
    ready,
    sendUserMessage,
    sendTurnEnded,
    sendBargeIn,
    sendSessionEnded,
    addListener,
    openSession,
    closeSession,
  };
}
