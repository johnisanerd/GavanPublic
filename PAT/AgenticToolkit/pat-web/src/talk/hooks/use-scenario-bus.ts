/**
 * useScenarioBus — pat-web's listener for slide-bus events that
 * affect the avatar app (not the deck iframe itself).
 *
 * Reads `?scenario=<slug>` from the URL once on mount. If present,
 * subscribes to `/api/slide-bus/<slug>/events` (SSE) and tracks two
 * pieces of state:
 *   - deckOpen — toggled by `{cmd: 'open' | 'close'}` events
 *   - audienceReady — toggled by `{cmd: 'audience-ready'}`
 *
 * The deck pane consumer reads deckOpen to mount/unmount the iframe.
 * Other consumers (banter rendering hints, presenter-mode banners)
 * can read audienceReady.
 *
 * Returns null when no `?scenario=` is in the URL — pat-web operates
 * exactly as before for non-presenter sessions.
 */
import { useEffect, useState } from 'react';

export interface ScenarioBusState {
  /** Slug from the URL — stable for the page's lifetime. */
  slug: string;
  /** Deck pane should be visible. */
  deckOpen: boolean;
  /** Operator has confirmed the audience is ready. */
  audienceReady: boolean;
  /** Imperatively open or close the deck pane (operator-driven —
   *  the agent's start_presentation also fires this via the bus). */
  setDeckOpen: (open: boolean) => void;
}

function readSlugFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  return params.get('scenario');
}

/** @param threadId — call/session thread for thread-keyed bus state.
 *  Pass null/undefined while no call is active; the hook re-subscribes
 *  when threadId materializes so the agent's POSTs (which include
 *  thread) reach the correct (slug,thread) bucket. */
export function useScenarioBus(threadId?: string | null): ScenarioBusState | null {
  const [slug] = useState(() => readSlugFromUrl());
  const [deckOpen, setDeckOpen] = useState(false);
  const [audienceReady, setAudienceReady] = useState(false);

  useEffect(() => {
    if (!slug) return;
    // PAT: watchdog + auto-reopen. EventSource auto-recovers from
    // network blips but not from CLOSED-state transitions (Vite HMR,
    // server restart, unhandled error). Poll readyState every 3s
    // and re-open on CLOSED. Critical for live demo: this
    // subscription drives `deckOpen` (iframe visibility) +
    // `audienceReady` flags.
    let source: EventSource | null = null;
    let watchdog: number | null = null;
    let cancelled = false;
    let reopens = 0;

    const handleMessage = (evt: MessageEvent) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.cmd === 'open') setDeckOpen(true);
        else if (msg.cmd === 'close') setDeckOpen(false);
        else if (msg.cmd === 'audience-ready') setAudienceReady(true);
      } catch (e) {
        console.warn('[scenario-bus] bad message', e);
      }
    };

    const open = () => {
      if (cancelled) return;
      reopens += 1;
      const base = `/api/slide-bus/${encodeURIComponent(slug)}/events`;
      const params = new URLSearchParams();
      if (threadId) params.set('thread', threadId);
      if (reopens > 1) params.set('_t', String(Date.now()));
      const qs = params.toString();
      const url = qs ? `${base}?${qs}` : base;
      source = new EventSource(url);
      source.addEventListener('message', handleMessage);
      source.addEventListener('error', () => {
        console.warn('[scenario-bus] error event readyState=', source?.readyState);
      });
    };

    const tickWatchdog = () => {
      if (cancelled) return;
      if (!source || source.readyState === 2) {
        console.warn('[scenario-bus] watchdog: re-opening');
        try { source?.close(); } catch { /* noop */ }
        open();
      }
    };

    open();
    watchdog = window.setInterval(tickWatchdog, 3000);

    return () => {
      cancelled = true;
      if (watchdog !== null) window.clearInterval(watchdog);
      try { source?.close(); } catch { /* noop */ }
    };
  }, [slug, threadId]);

  if (!slug) return null;
  return { slug, deckOpen, audienceReady, setDeckOpen };
}
