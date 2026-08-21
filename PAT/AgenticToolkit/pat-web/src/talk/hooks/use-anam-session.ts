import { useCallback, useEffect, useRef, useState } from 'react';
import { createClient, AnamEvent } from '@anam-ai/js-sdk';
import type { AnamMessage, AnamMessageStreamEvent, SessionMode } from '@/types/anam';
import { patWebHeaders } from '@/lib/pat-web-token';
import type { PatEvent } from '@/types/log-events';
import { getDebugNamespace } from '@/lib/debug-surface';
import { logEvent } from '@/lib/log-event';
import { getLatestCorrelationId } from './rtt-correlation';
import type { RealtimeFrameListener } from './use-pat-realtime-ws';

export type SessionStatus =
  | 'idle'
  | 'fetching-token'
  | 'connecting'
  | 'connected'
  | 'error';

/** Avatar background preset slugs. The server resolves these to real
 *  Anam avatar ids — keep them stable: persisted in localStorage. */
export type AvatarBackground = 'green-screen' | 'office';

/** Server response from POST /api/anam/session-token. The bearer is
 *  only populated in 'pat' mode (demo mode has no realtime WS). */
export interface SessionTokenResponse {
  sessionToken: string;
  sessionId: string;
  bearer: string | null;
}

export interface UseAnamSessionResult {
  status: SessionStatus;
  error: string | null;
  history: AnamMessage[];
  live: { user: string; persona: string };
  /** Subscribe to structured events from nanoclaw. Returns an unsubscribe. */
  subscribeEvents: (handler: (ev: PatEvent) => void) => () => void;
  /** Start a session. The video element must already be in the DOM.
   *  `background` selects a server-side avatar preset
   *  ('green-screen' | 'office'); omitted = server default. Returns
   *  the session-token response so the caller (App.tsx) can hand off
   *  `sessionId` + `bearer` to `usePatRealtimeWs.openSession`. */
  start: (opts: {
    mode: SessionMode;
    videoEl: HTMLVideoElement;
    background?: AvatarBackground;
  }) => Promise<SessionTokenResponse | null>;
  stop: () => void;
  /** Programmatic "speak this" — bypasses STT/LLM, useful for greetings. */
  speak: (text: string) => Promise<void>;
  /** Raw client handle for advanced callers (banter driver). */
  client: ReturnType<typeof createClient> | null;
}

export interface UseAnamSessionOptions {
  /** Stable platform id (`anam-web:<uuid>` or `anam-web:scenario-<slug>`).
   *  Owned by `usePatRealtimeWs` — passed in so the hook can pre-warm
   *  with the right id and stamp it on outbound `turn-ended` events. */
  platformId: string;
  /** Subscribe to realtime-WS banter frames. Owned by `usePatRealtimeWs`;
   *  passed in so the Anam SDK consumer can pipe banter deltas into the
   *  avatar's talk stream without ref-indirection. */
  addRealtimeListener: (handler: RealtimeFrameListener) => () => void;
  /** Notify the realtime WS hook that a TTS turn has just ended (Anam's
   *  `MESSAGE_STREAM_EVENT_RECEIVED` with `endOfSpeech || interrupted`).
   *  The WS hook forwards this to nanoclaw's TtsBusyTracker. */
  sendTurnEnded: (input: { text: string; threadId: string; interrupted: boolean }) => void;
  /** Notify the realtime WS hook that the call is ending. Best-effort:
   *  even if the WS is closed by then, the session-ended frame can ride
   *  the same socket if still open. */
  sendSessionEnded: (input: { sessionId: string }) => void;
}

/**
 * Anam SDK lifecycle hook.
 *
 * Mode controls how the session token is requested:
 *   - 'demo' → server attaches Anam's default brain + a small system prompt.
 *   - 'pat'  → server attaches `llmId: CUSTOMER_CLIENT_V1`, the banter
 *              driver hook drives the realtime WS on every fresh user
 *              turn, AND we open an EventSource on
 *              /api/anam/events?session=<id> for out-of-band utterances
 *              (rendition / narration deltas) + tool-call detail rows.
 *
 * Identity / threading:
 *   - `platformId = "anam-web:<localStorage uuid>"` — owned by
 *     `usePatRealtimeWs`, passed into this hook.
 *   - `sessionId  = <uuid>` minted by the server on
 *     /api/anam/session-token; this hook returns it from `start()` so
 *     the caller can wire it into the WS hook.
 *     One per page load. Maps to thread_id = `anam-web-call-<sessionId>`
 *     on the backend.
 */
export function useAnamSession(opts: UseAnamSessionOptions): UseAnamSessionResult {
  const { platformId, addRealtimeListener, sendTurnEnded, sendSessionEnded } = opts;
  // Keep callbacks in refs so identity changes don't re-run start().
  const addRealtimeRef = useRef(addRealtimeListener);
  addRealtimeRef.current = addRealtimeListener;
  const sendTurnEndedRef = useRef(sendTurnEnded);
  sendTurnEndedRef.current = sendTurnEnded;
  const sendSessionEndedRef = useRef(sendSessionEnded);
  sendSessionEndedRef.current = sendSessionEnded;

  const [status, setStatus] = useState<SessionStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<AnamMessage[]>([]);
  const [live, setLive] = useState<{ user: string; persona: string }>({ user: '', persona: '' });

  const clientRef = useRef<ReturnType<typeof createClient> | null>(null);
  // PAT: mirror the client into state so consumers (useBanterDriver) get
  // a stable dep that updates on (re-)connection. A bare ref doesn't
  // trigger re-renders, and consumers' useEffect deps don't see ref
  // mutations.
  const [clientState, setClientState] = useState<ReturnType<typeof createClient> | null>(null);
  const setClient = useCallback((c: ReturnType<typeof createClient> | null) => {
    clientRef.current = c;
    setClientState(c);
  }, []);
  // Tracks the pagehide/beforeunload listener so stop() can remove it.
  const unloadListenerRef = useRef<(() => void) | null>(null);
  // The sessionId minted by the most recent start(). Lives in a ref so
  // stop() can read it without a stale closure.
  const sessionIdRef = useRef<string | null>(null);
  // EventSource for /api/anam/events. Opened on each start(), closed on stop().
  const eventSourceRef = useRef<EventSource | null>(null);
  // Realtime-WS banter unsubscriber — installed at start(), called from stop().
  const banterUnsubRef = useRef<(() => void) | null>(null);
  // Per-call event subscribers — driven from EventSource onmessage.
  const eventHandlersRef = useRef<Set<(ev: PatEvent) => void>>(new Set());

  const subscribeEvents = useCallback<UseAnamSessionResult['subscribeEvents']>((handler) => {
    eventHandlersRef.current.add(handler);
    return () => {
      eventHandlersRef.current.delete(handler);
    };
  }, []);

  const stop = useCallback(() => {
    if (unloadListenerRef.current) {
      window.removeEventListener('pagehide', unloadListenerRef.current);
      window.removeEventListener('beforeunload', unloadListenerRef.current);
      unloadListenerRef.current = null;
    }
    if (eventSourceRef.current) {
      try {
        eventSourceRef.current.close();
      } catch {
        /* noop */
      }
      eventSourceRef.current = null;
    }
    if (banterUnsubRef.current) {
      try {
        banterUnsubRef.current();
      } catch {
        /* noop */
      }
      banterUnsubRef.current = null;
    }
    const c = clientRef.current;
    // PAT: drop the React client handle synchronously so consumers
    // flip back to idle immediately. The Anam SDK's `stopStreaming()`
    // is async — fire without awaiting but keep the promise alive so
    // it can release tracks.
    if (c) {
      console.log('[pat-web] stop(): tearing down anam streaming');
      Promise.resolve()
        .then(() => c.stopStreaming())
        .then(() => {
          console.log('[pat-web] stop(): anam streaming torn down');
        })
        .catch((err) => {
          console.warn('[pat-web] stop(): stopStreaming threw', err);
        });
      setClient(null);
    }
    // Tell the backend so it can close the session DB and stop polling.
    // PAT: read the LATEST sessionId off the ref. We send via the
    // realtime WS frame AND a fire-and-forget HTTP POST as a belt-and-
    // braces — the WS may already be closed by the time stop() runs.
    const sid = sessionIdRef.current;
    if (sid) {
      try {
        sendSessionEndedRef.current({ sessionId: sid });
      } catch {
        /* WS may have closed already; fall back to HTTP */
      }
      void fetch('/api/anam/session-ended', {
        method: 'POST',
        headers: patWebHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ sessionId: sid }),
      }).catch(() => {
        /* best effort — server will GC eventually */
      });
    }
    setStatus('idle');
    setLive({ user: '', persona: '' });
    sessionIdRef.current = null;
  }, [setClient]);

  const start = useCallback<UseAnamSessionResult['start']>(
    async ({ mode, videoEl, background }) => {
      if (clientRef.current) {
        stop();
      }
      setError(null);
      setHistory([]);
      setLive({ user: '', persona: '' });
      setStatus('fetching-token');

      let tokenResponse: SessionTokenResponse;
      try {
        console.log('[pat-web] fetching session token, mode=%s background=%s', mode, background ?? '(default)');
        const res = await fetch('/api/anam/session-token', {
          method: 'POST',
          headers: patWebHeaders({ 'content-type': 'application/json' }),
          // PAT: send platformId so the server can mint a bearer bound
          // to this (sessionId, platformId) AND fire a fire-and-forget
          // container pre-warm before the first user utterance.
          body: JSON.stringify({ mode, background, platformId }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`session-token ${res.status}: ${body || res.statusText}`);
        }
        const json = (await res.json()) as SessionTokenResponse;
        tokenResponse = json;
        sessionIdRef.current = json.sessionId;
        console.log(
          '[pat-web] session token received (len=%d) sessionId=%s platformId=%s bearer=%s',
          json.sessionToken?.length ?? 0,
          json.sessionId,
          platformId,
          json.bearer ? '(present)' : '(absent)',
        );
      } catch (e) {
        console.error('[pat-web] session token failed:', e);
        setError((e as Error).message);
        setStatus('error');
        return null;
      }

      const freshSessionId = tokenResponse.sessionId;

      // Open the per-session events SSE channel. Only in 'pat' mode —
      // demo mode runs entirely Anam-side and has no events to surface.
      if (mode === 'pat') {
        try {
          const qs = new URLSearchParams();
          qs.set('session', freshSessionId);
          qs.set('platform_id', platformId);
          // PAT: skip backlog. Without `since`, nanoclaw's
          // handleEventsSse re-tails the whole day's host log filtered
          // by platform_id — which surfaces ghost tool-call banners
          // from the visitor's PRIOR sessions on the same browser
          // (uuid stays in localStorage). Anchoring to now means we
          // only see events from this session forward.
          qs.set('since', String(Date.now()));
          const es = new EventSource(`/api/anam/events?${qs.toString()}`);
          eventSourceRef.current = es;
          // PAT: dedupe replayed events. nanoclaw's /anam-web/events
          // re-tails the entire day's host log on every reconnect, and
          // the SSE flaps every few seconds under HTTP/2 protocol
          // errors. Without this guard, utterance.stream-delta lines
          // from earlier in the call get re-fired into talkStreams.
          const seenEventIds = new Set<string>();
          es.onmessage = (msg) => {
            let parsed: PatEvent;
            try {
              parsed = JSON.parse(msg.data) as PatEvent;
            } catch {
              return;
            }
            if (parsed.id) {
              if (seenEventIds.has(parsed.id)) return;
              seenEventIds.add(parsed.id);
              if (seenEventIds.size > 5000) seenEventIds.clear();
            }
            for (const h of eventHandlersRef.current) {
              try {
                h(parsed);
              } catch (err) {
                console.warn('[pat-web] event handler threw', err);
              }
            }
          };
          es.onerror = () => {
            console.warn('[pat-web] events SSE error (will auto-reconnect)');
          };
        } catch (err) {
          console.warn('[pat-web] failed to open events SSE', err);
        }
      }

      setStatus('connecting');
      // PAT: tune endOfSpeechSensitivity above Anam's default 0.5.
      // Per Anam docs: 0 = patient (waits for confidence), 1 = jumps in
      // sooner. 0.7 trades a tiny mid-pause cut-off risk for ~100-200ms
      // less endpointing dead-air. This is the dominant remaining
      // latency after the 2026-05-24 dispatcher-fix landed the
      // front-mind LLM win.
      const client = createClient(tokenResponse.sessionToken, {
        voiceDetection: { endOfSpeechSensitivity: 0.7 },
      });
      setClient(client);

      // Tear down on unload so Anam doesn't keep the session open until
      // its idle timeout.
      const unloadListener = () => {
        try {
          client.stopStreaming();
        } catch {
          /* page is dying, swallow */
        }
      };
      unloadListenerRef.current = unloadListener;
      window.addEventListener('pagehide', unloadListener);
      window.addEventListener('beforeunload', unloadListener);

      // The SDK fires CONNECTION_CLOSED once per internal track/channel
      // tearing down on shutdown — collapse with a once-guard.
      let closeHandled = false;

      // PAT DEBUG: install a global instrumentation surface so we can
      // diagnose silent SDK behavior from the browser console.
      try {
        const dbg = getDebugNamespace<{
          client?: unknown;
          AnamEvent?: typeof AnamEvent;
          events: Array<{ ts: number; name: string; payload: unknown }>;
          history?: unknown;
        }>('pat');
        dbg.client = client;
        dbg.AnamEvent = AnamEvent;
        dbg.events = [];
        for (const evName of Object.values(AnamEvent)) {
          client.addListener(evName as never, ((payload: unknown) => {
            const entry = { ts: Date.now(), name: evName as string, payload };
            dbg.events.push(entry);
            if (dbg.events.length > 500) dbg.events.shift();
            if (evName !== AnamEvent.MESSAGE_STREAM_EVENT_RECEIVED) {
              console.log('[pat-web] anam-event:', evName, payload);
            }
          }) as never);
        }
      } catch (err) {
        console.warn('[pat-web] __pat instrumentation failed', err);
      }

      client.addListener(AnamEvent.SESSION_READY, () => {
        console.log('[pat-web] SESSION_READY');
        setStatus('connected');
      });
      client.addListener(AnamEvent.CONNECTION_ESTABLISHED, () => {
        console.log('[pat-web] CONNECTION_ESTABLISHED');
      });
      client.addListener(AnamEvent.CONNECTION_CLOSED, (reason: unknown) => {
        if (closeHandled) return;
        closeHandled = true;
        console.warn('[pat-web] CONNECTION_CLOSED', reason);
        stop();
      });
      client.addListener(AnamEvent.VIDEO_PLAY_STARTED, () => {
        console.log('[pat-web] VIDEO_PLAY_STARTED');
      });
      client.addListener(AnamEvent.MIC_PERMISSION_DENIED, () => {
        console.error('[pat-web] MIC_PERMISSION_DENIED');
        setError('Microphone permission denied. Allow mic access and start again.');
        setStatus('error');
      });
      client.addListener(AnamEvent.SERVER_WARNING, (w: unknown) => {
        console.warn('[pat-web] SERVER_WARNING', w);
      });
      client.addListener(AnamEvent.MESSAGE_HISTORY_UPDATED, (messages: AnamMessage[]) => {
        setHistory(messages.map((m) => ({ role: m.role, content: m.content })));
        const last = messages[messages.length - 1];
        if (last) {
          setLive((prev) => ({
            ...prev,
            [last.role]: '',
          }));
        }
      });
      // PAT: per-delta accumulator for the live partial display PLUS
      // per-role buffer used at end-of-speech to send pat-nanoclaw the
      // full text Anam actually voiced. `endOfSpeech || interrupted`
      // on the persona role is Anam's "I finished this turn" signal —
      // equivalent to Cartesia's AgentTurnEnded on the PSTN path. We
      // send it over the realtime WS so the orchestrator's
      // TtsBusyTracker can clear the busy flag and the narrator can
      // gate its cadence off the real end-of-audio.
      let personaBuffer = '';
      client.addListener(AnamEvent.MESSAGE_STREAM_EVENT_RECEIVED, (ev: AnamMessageStreamEvent) => {
        setLive((prev) => ({
          ...prev,
          [ev.role]: (prev[ev.role] ?? '') + ev.content,
        }));
        if (ev.role === 'persona') {
          personaBuffer += ev.content;
          if (ev.endOfSpeech || ev.interrupted) {
            const text = personaBuffer;
            personaBuffer = '';
            const threadId = `anam-web-call-${freshSessionId}`;
            try {
              sendTurnEndedRef.current({ text, threadId, interrupted: Boolean(ev.interrupted) });
            } catch (err) {
              console.warn('[pat-web] turn-ended send failed', err);
            }
          }
        }
      });

      // Dedicated banter voice channel (PAT 2026-05-23 refactor).
      // All banter (ack + rendition + narration) flows down ONE realtime
      // WebSocket (provided via `addRealtimeListener`) and pipes into a
      // SINGLE talkStream pointer regardless of source.
      type TalkStream = ReturnType<typeof client.createTalkMessageStream>;
      let currentStream: TalkStream | null = null;
      const closeCurrent = (): void => {
        if (currentStream?.isActive()) {
          try {
            currentStream.endMessage();
          } catch {
            /* ignore */
          }
        }
        currentStream = null;
      };
      // PAT RTT instrumentation: track the current utterance id (set
      // on stream-started) so utterance.delta-received rows can be
      // grouped server-side without re-deriving from sequence + source.
      let currentUtteranceId = '';
      const handleBanterFrame: RealtimeFrameListener = (evt) => {
        if (!client.isStreaming()) return;
        const data = (evt.data ?? {}) as {
          source?: string;
          text_delta?: string;
          seq?: number;
          utterance_id?: string;
        };
        if (evt.kind === 'utterance.stream-started') {
          currentUtteranceId = typeof data.utterance_id === 'string' ? data.utterance_id : '';
          // New utterance — close any prior stream first (no-op unless
          // a previous utterance was cancelled mid-stream).
          closeCurrent();
          try {
            currentStream = client.createTalkMessageStream();
          } catch (err) {
            console.warn('[pat-web] banter createTalkMessageStream threw', err);
          }
          return;
        }
        if (evt.kind === 'utterance.stream-delta') {
          // Lazy-recover the stream if started arrived before the
          // session was ready (rare but possible during boot).
          if (!currentStream || !currentStream.isActive()) {
            try {
              currentStream = client.createTalkMessageStream();
            } catch (err) {
              console.warn('[pat-web] banter lazy createTalkMessageStream threw', err);
              return;
            }
          }
          const chunk = data.text_delta ?? '';
          if (chunk) {
            try {
              currentStream.streamMessageChunk(chunk, false);
            } catch (err) {
              console.warn('[pat-web] banter streamMessageChunk failed', err);
            }
          }
          // PAT RTT instrumentation: emit per-chunk receipt so we can
          // measure browser→server→browser round-trip from the matching
          // inbound.sent.
          const sourceLayer = (data.source ?? 'banter-ack') as
            | 'banter-ack'
            | 'banter-rendition'
            | 'banter-narration';
          const sequence = typeof data.seq === 'number' ? data.seq : -1;
          logEvent({
            kind: 'utterance.delta-received',
            thread_id: `anam-web-call-${freshSessionId}`,
            platform_id: platformId,
            session_id: freshSessionId,
            data: {
              utterance_id: currentUtteranceId,
              source_layer: sourceLayer,
              sequence,
              chars: chunk.length,
              correlation_id: getLatestCorrelationId(),
            },
          });
          return;
        }
        if (evt.kind === 'utterance.stream-ended' || evt.kind === 'utterance.stream-cancelled') {
          currentUtteranceId = '';
          closeCurrent();
          return;
        }
      };

      banterUnsubRef.current = addRealtimeRef.current(handleBanterFrame);

      try {
        const id = videoEl.id;
        if (!id) throw new Error('video element has no id; cannot stream');
        console.log('[pat-web] streamToVideoElement(%s)', id);
        await client.streamToVideoElement(id);
        console.log('[pat-web] streamToVideoElement resolved');
      } catch (e) {
        console.error('[pat-web] streamToVideoElement failed:', e);
        setError((e as Error).message);
        setStatus('error');
        stop();
        return null;
      }

      return tokenResponse;
    },
    [stop, platformId, setClient],
  );

  const speak = useCallback(async (text: string) => {
    const c = clientRef.current;
    if (!c) return;
    try {
      await c.talk(text);
    } catch (e) {
      console.warn('talk() failed:', e);
    }
  }, []);

  // PAT FIX: keep the unmount cleanup pinned to mount/unmount only.
  const stopRef = useRef(stop);
  stopRef.current = stop;
  useEffect(() => {
    return () => {
      stopRef.current();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    status,
    error,
    history,
    live,
    subscribeEvents,
    start,
    stop,
    speak,
    client: clientState,
  };
}
