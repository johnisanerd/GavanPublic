import { useEffect, useRef } from 'react';
import { AnamEvent, type createClient } from '@anam-ai/js-sdk';
import type { AnamMessage, SessionMode } from '@/types/anam';
import { getDebugNamespace } from '@/lib/debug-surface';
import { logEvent, newCorrelationId } from '@/lib/log-event';
import { setLatestCorrelationId } from './rtt-correlation';

type AnamClient = ReturnType<typeof createClient>;

/**
 * PAT-mode driver. Watches MESSAGE_HISTORY_UPDATED + USER_SPEECH_ENDED;
 * whenever a fresh user turn lands, sends a `user-message` frame down
 * the long-lived realtime WebSocket (owned by `usePatRealtimeWs`).
 *
 * In demo mode this hook is a no-op — Anam's default brain handles
 * everything server-side so we don't intervene.
 *
 * `sendUserMessage` is passed directly from `usePatRealtimeWs`. The
 * useCallback-stable identity means we don't need ref-indirection here.
 */

interface BanterDriverDeps {
  /** Send a user-message frame down the realtime WS. */
  sendUserMessage: (input: { text: string; threadId: string; correlationId: string }) => void;
}

export function useBanterDriver(
  mode: SessionMode,
  client: AnamClient | null,
  /** Stable across page lifetime; from `usePatRealtimeWs`. */
  platformId: string,
  /** Per-page Anam session id; from `usePatRealtimeWs`. */
  sessionId: string | null,
  deps: BanterDriverDeps,
): void {
  const lastUserAtRef = useRef<number>(0);

  useEffect(() => {
    const entry = { ts: Date.now(), hasClient: !!client, mode, sessionId, platformId };
    console.log('[pat-web] banter-driver effect:', JSON.stringify(entry));
    const ns = getDebugNamespace<{ driverRuns?: unknown[] }>('pat');
    (ns.driverRuns = ns.driverRuns ?? []).push(entry);
    if (!client || mode !== 'pat' || !sessionId) return;

    // PAT: dispatch is driven by USER_SPEECH_ENDED, not a flat timer.
    // STT refines transcripts multiple times per user turn — each refinement
    // fires MESSAGE_HISTORY_UPDATED with progressively-better content.
    // Previously we waited SETTLE_MS=350ms after the LAST history update
    // before dispatching, which added a flat ~350ms to every turn.
    //
    // Now: USER_SPEECH_ENDED (Anam's real end-of-VAD-turn signal) triggers
    // the WS send immediately with whatever transcript we have. If STT lands
    // a refinement AFTER USER_SPEECH_ENDED, we re-send with the refined
    // transcript. The `speechEnded` flag opens the refinement gate.
    let lastMessages: AnamMessage[] | null = null;
    let speechEnded = false;

    const fire = (reason: string) => {
      const messages = lastMessages;
      if (!messages || messages.length === 0) return;
      const last = messages[messages.length - 1]!;
      if (last.role !== 'user') return;

      const sig = messages.length * 131 + (last.content?.length ?? 0);
      if (sig === lastUserAtRef.current) {
        console.log('[pat-web] banter-driver dedupe skip sig=', sig, 'reason=', reason);
        return;
      }
      lastUserAtRef.current = sig;
      console.log('[pat-web] banter-driver dispatching turn (reason=', reason, 'last.len=', last.content?.length, ')');
      dispatchTurn(messages, platformId, sessionId, deps.sendUserMessage);
    };

    const onHistory = (messages: AnamMessage[]) => {
      if (messages.length === 0) return;
      const last = messages[messages.length - 1]!;
      if (last.role !== 'user') {
        // Persona / system role — not a user turn, ignore.
        return;
      }
      lastMessages = messages;
      // If speech has already ended for this turn, this is a post-end STT
      // refinement — re-dispatch with the newer transcript.
      if (speechEnded) {
        fire('history-refined-after-speech-end');
      }
    };

    const onSpeechEnded = () => {
      // USER_SPEECH_ENDED is the SDK's end-of-VAD-turn signal. Fire
      // immediately with the latest known transcript. Any STT refinement
      // that lands after this point will re-fire via onHistory.
      speechEnded = true;
      fire('user-speech-ended');
    };

    const onSpeechStarted = () => {
      // Close the refinement gate at the start of the next turn so
      // pre-end-of-speech history updates don't fire dispatch.
      speechEnded = false;
    };

    client.addListener(AnamEvent.MESSAGE_HISTORY_UPDATED, onHistory);
    client.addListener(AnamEvent.USER_SPEECH_STARTED, onSpeechStarted);
    client.addListener(AnamEvent.USER_SPEECH_ENDED, onSpeechEnded);
    console.log('[pat-web] banter-driver listener installed', JSON.stringify({ ts: Date.now() }));
    return () => {
      console.log('[pat-web] banter-driver cleanup', JSON.stringify({ ts: Date.now() }));
      try {
        client.removeListener(AnamEvent.MESSAGE_HISTORY_UPDATED, onHistory);
        client.removeListener(AnamEvent.USER_SPEECH_STARTED, onSpeechStarted);
        client.removeListener(AnamEvent.USER_SPEECH_ENDED, onSpeechEnded);
      } catch {
        /* SDK versions vary on removeListener semantics */
      }
    };
  }, [mode, client, platformId, sessionId, deps.sendUserMessage]);
}

function dispatchTurn(
  messages: AnamMessage[],
  platformId: string,
  sessionId: string,
  sendUserMessage: BanterDriverDeps['sendUserMessage'],
): void {
  // PAT RTT instrumentation: mint a correlation id per dispatched turn
  // and stash it module-scoped so the banter WS handler (in
  // useAnamSession) can stamp it onto every utterance.delta-received
  // row. Stamped BEFORE the send so the inbound.sent timestamp is the
  // wall-clock dispatch moment — the start of the RTT we want to
  // measure.
  const correlationId = newCorrelationId();
  setLatestCorrelationId(correlationId);
  const threadId = `anam-web-call-${sessionId}`;
  const lastUserText = messages[messages.length - 1]?.content ?? '';
  logEvent({
    kind: 'inbound.sent',
    thread_id: threadId,
    platform_id: platformId,
    session_id: sessionId,
    data: {
      user_text_length: lastUserText.length,
      correlation_id: correlationId,
    },
  });

  sendUserMessage({ text: lastUserText, threadId, correlationId });
}
