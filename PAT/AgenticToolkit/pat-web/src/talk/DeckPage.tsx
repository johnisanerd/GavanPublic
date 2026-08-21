/**
 * DeckPage — full-page deck viewer. Loaded at `/decks/:slug` (the
 * URL the `start_presentation` MCP tool opens in the iframe
 * side-pane). For Phase A also reachable via `/_dev/deck` with a
 * built-in hello-world packet so we can verify the rendering stack
 * without nanoclaw integration.
 *
 * The page subscribes to a per-deck WebSocket for slide commands:
 *   {cmd: "advance", n}          — go to slide n (0-based)
 *   {cmd: "next"}                 — advance one
 *   {cmd: "prev"}                 — go back one
 *   {cmd: "inject", spec, after}  — append/insert a new slide and
 *                                   advance to it (Phase D)
 *   {cmd: "view", deck|scroll}    — switch reveal view mode
 *
 * Bus is opt-in via the `?bus=ws://...` URL param or omitted entirely
 * for stand-alone development. Cursor changes from the deck are
 * mirrored back over the bus as `{evt: "cursor", h, v}` so the
 * orchestrator can sanity-check.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RevealApi } from 'reveal.js';
import 'reveal.js/reveal.css';
import 'reveal.js/theme/white.css';
import { RevealDeck } from '@agentic-toolkit/scenarios/presentation/react';
import { validateSpec, type ValidationIssue } from '@agentic-toolkit/scenarios/presentation';
import type { PacketManifest, SlideSpec } from '@agentic-toolkit/scenarios/presentation';
import {
  HELLOWORLD_PACKET,
  FUZZ_PACKET,
  PALISADE_DEMO_PACKET,
} from '@agentic-toolkit/scenarios/presentation/fixtures';
import '@agentic-toolkit/scenarios/presentation/react/deck-styles.css';

interface Packet {
  manifest: PacketManifest;
  slides: SlideSpec[];
}

async function loadPacket(slug: string): Promise<Packet> {
  if (slug === '_helloworld') return HELLOWORLD_PACKET;
  if (slug === '_fuzz') return FUZZ_PACKET;
  if (slug === '_palisade') return PALISADE_DEMO_PACKET;
  const res = await fetch(`/api/packets/${slug}`);
  if (!res.ok) throw new Error(`packet ${slug} not found (${res.status})`);
  return res.json();
}

/** PAT: dimension-agnostic slide advance/regress. `Reveal.next()`
 *  reveals fragments before crossing slide boundaries; `Reveal.right()`
 *  skips vertical stacks. To advance regardless of fragment state AND
 *  regardless of 1D vs 2D layout, call `.next()` / `.prev()` in a
 *  loop until the (h, v) indices change. Safety cap at 32 iterations
 *  so a misconfigured deck can't hang the renderer. */
function advancePastFragments(api: RevealApi, dir: 'forward' | 'back'): void {
  const before = api.getIndices();
  const tick = dir === 'forward' ? () => api.next() : () => api.prev();
  for (let i = 0; i < 32; i++) {
    tick();
    const after = api.getIndices();
    if (after.h !== before.h || after.v !== before.v) return;
  }
}

function useUrlParams() {
  return useMemo(() => {
    const sp = new URLSearchParams(window.location.search);
    return {
      bus: sp.get('bus'),
      view: sp.get('view'),
      slide: sp.get('slide'),
    };
  }, []);
}

function ValidationBanner({ issues }: { issues: ValidationIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 100,
        background: 'rgba(180, 30, 30, 0.92)',
        color: '#fff',
        padding: '8px 16px',
        fontSize: 13,
        fontFamily: 'monospace',
        maxHeight: '40vh',
        overflow: 'auto',
      }}
    >
      <strong>validation issues ({issues.length})</strong>
      <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
        {issues.map((iss, i) => (
          <li key={i} style={{ marginBottom: 2 }}>
            <span
              style={{
                opacity: 0.85,
                marginRight: 6,
                background: iss.severity === 'error' ? '#600' : '#660',
                padding: '0 4px',
                borderRadius: 3,
              }}
            >
              {iss.severity}
            </span>
            {iss.path && <code style={{ marginRight: 6 }}>{iss.path}</code>}
            {iss.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DeckPage({ slug }: { slug: string }) {
  const params = useUrlParams();
  const [packet, setPacket] = useState<Packet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [cursor, setCursor] = useState({ h: 0, v: 0 });
  const apiRef = useRef<RevealApi | null>(null);
  // PAT: queue for slide-bus messages that arrive before Reveal's
  // onReady fires. The SSE server replays sticky state (hello, open,
  // advance) the moment the EventSource opens — and that's often
  // multiple seconds before `@revealjs/react` has constructed the
  // reveal instance and called onReady with the api. Without this
  // buffer, the iframe lands on slide 0 even when the agent thinks
  // it just told the deck to open at slide 3.
  const pendingBusMessagesRef = useRef<Record<string, unknown>[]>([]);
  const initialIndex = params.slide ? Number(params.slide) : 0;
  const deckView = params.view !== 'scroll';
  // PAT: interactive controls re-enabled even with a bus param so
  // the operator has a manual fallback during live demos (keyboard
  // arrows, on-screen controls, mouse click-to-advance). The agent
  // still drives via the bus; user input is additive. Set
  // `?bus=...&interactive=0` to disable for a stricter audience-
  // facing mode if needed.
  const interactiveOverride = new URLSearchParams(window.location.search).get('interactive');
  const interactive = interactiveOverride === '0' ? false : true;

  /** Apply a single slide-bus command against a ready reveal api. Pure
   *  dispatch — no buffering. The handler in the EventSource useEffect
   *  and the onReady drain both call this. */
  const applyBusMessage = useCallback((api: RevealApi, msg: Record<string, unknown>) => {
    const cmd = msg.cmd as string | undefined;
    if (cmd === 'advance' && typeof msg.n === 'number') {
      api.slide(msg.n as number, 0);
    } else if (cmd === 'resume' && typeof msg.n === 'number') {
      api.slide(msg.n as number, 0);
    } else if (cmd === 'next') {
      advancePastFragments(api, 'forward');
    } else if (cmd === 'prev') {
      advancePastFragments(api, 'back');
    } else if (cmd === 'frag-next') {
      const reveal = api as RevealApi & {
        nextFragment?: () => boolean;
        next?: () => void;
      };
      if (typeof reveal.nextFragment === 'function') {
        const advanced = reveal.nextFragment();
        console.log('[slide-bus] nextFragment() →', advanced);
      } else if (typeof reveal.next === 'function') {
        console.warn('[slide-bus] nextFragment missing, calling api.next() as fallback');
        reveal.next();
      } else {
        console.error('[slide-bus] no nextFragment or next on api', Object.keys(api));
      }
    } else if (cmd === 'frag-prev') {
      const reveal = api as RevealApi & {
        prevFragment?: () => boolean;
        prev?: () => void;
      };
      if (typeof reveal.prevFragment === 'function') {
        const moved = reveal.prevFragment();
        console.log('[slide-bus] prevFragment() →', moved);
      } else if (typeof reveal.prev === 'function') {
        console.warn('[slide-bus] prevFragment missing, calling api.prev() as fallback');
        reveal.prev();
      } else {
        console.error('[slide-bus] no prevFragment or prev on api', Object.keys(api));
      }
    } else if (cmd === 'hello' || cmd === 'open') {
      // Sticky state markers from the bus — no-op at the api level;
      // they just need to survive the early-replay queue so any
      // later `advance` lands the deck where the agent intended.
    } else if (cmd === 'inject') {
      console.warn('[slide-bus] inject not yet wired into runtime deck', msg);
    } else {
      console.warn('[slide-bus] unknown cmd', cmd, msg);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    loadPacket(slug).then(
      (p) => {
        if (!mounted) return;
        // Validate every spec; collect all issues so the banner can
        // show them in one go.
        const allIssues: ValidationIssue[] = [];
        for (const spec of p.slides) {
          const result = validateSpec(spec);
          if (!result.ok || result.issues.length > 0) {
            allIssues.push(
              ...result.issues.map((iss) => ({
                ...iss,
                message: `[slide ${spec.slide}] ${iss.message}`,
              })),
            );
          }
        }
        setIssues(allIssues);
        setPacket(p);
      },
      (e) => mounted && setError(String(e)),
    );
    return () => {
      mounted = false;
    };
  }, [slug]);

  // Slide-bus SSE subscription. Opens on mount if `?bus=...` is in
  // the URL (full URL to the SSE endpoint, e.g.
  // /api/slide-bus/<slug>/events).
  //
  // PAT: resilience for live demos. The browser's EventSource
  // auto-reconnects on network errors, but if the connection ever
  // ends up in readyState=CLOSED (2) — e.g. Vite HMR teardown, a
  // server restart, or an unhandled exception in the message
  // handler — it does NOT recover. We add a watchdog that polls
  // readyState every 3s and re-opens on a CLOSED state. The
  // re-open uses a fresh URL with a cache-busting `?_t=` so any
  // intermediate proxy doesn't serve a stale connection.
  useEffect(() => {
    const debugParam = new URLSearchParams(window.location.search).get('debug');
    // PAT: debug-only harness — lets us fire fake bus messages
    // without needing an SSE endpoint. Mounts even when `?bus=` is
    // not set so we can drive the deck purely from devtools when
    // testing locally. `?debug=1` is the gate.
    const harnessActive = debugParam === '1';

    if (!params.bus && !harnessActive) return;

    let source: EventSource | null = null;
    let watchdog: number | null = null;
    let cancelled = false;
    let reopens = 0;

    const handleMessage = (evt: Event) => {
      try {
        const msg = JSON.parse((evt as MessageEvent).data) as Record<string, unknown>;
        const api = apiRef.current;
        console.log('[slide-bus] msg', msg.cmd, 'api?', Boolean(api));
        if (!api) {
          // PAT: queue rather than drop. The drain runs from
          // onReady → drainPendingBusMessages(). The bus protocol's
          // sticky-state replay (hello/open/advance) almost always
          // arrives while the React reveal wrapper is still mounting,
          // so this is the common case, not an edge case.
          pendingBusMessagesRef.current.push(msg);
          console.log(
            '[slide-bus] queued (api not ready); queue size =',
            pendingBusMessagesRef.current.length,
          );
          return;
        }
        applyBusMessage(api, msg);
      } catch (e) {
        console.error('[slide-bus] message error', e);
      }
    };

    const open = () => {
      if (cancelled) return;
      reopens += 1;
      const url = reopens === 1 ? params.bus! : `${params.bus}${params.bus!.includes('?') ? '&' : '?'}_t=${Date.now()}`;
      console.log('[slide-bus] opening EventSource', { url, attempt: reopens });
      source = new EventSource(url);
      source.addEventListener('message', handleMessage);
      source.addEventListener('error', (e) => {
        console.warn('[slide-bus] error event', e, 'readyState=', source?.readyState);
      });
    };

    const tickWatchdog = () => {
      if (cancelled) return;
      if (!source || source.readyState === 2 /* CLOSED */) {
        console.warn('[slide-bus] watchdog: connection closed, re-opening');
        try { source?.close(); } catch { /* noop */ }
        open();
      }
    };

    if (params.bus) {
      open();
      watchdog = window.setInterval(tickWatchdog, 3000);
    }

    if (harnessActive) {
      // Expose a fake-message firer so we can validate the handler
      // and the Reveal API end-to-end without an SSE connection.
      (window as { __deckDebug?: unknown }).__deckDebug = {
        simulate(msg: Record<string, unknown>) {
          console.log('[deck-debug] simulate ←', msg);
          handleMessage(new MessageEvent('message', { data: JSON.stringify(msg) }));
        },
      };
      console.log('[deck-debug] harness active — call window.__deckDebug.simulate({cmd:"next"})');
    }

    return () => {
      cancelled = true;
      if (watchdog !== null) window.clearInterval(watchdog);
      try { source?.close(); } catch { /* noop */ }
      if (harnessActive) {
        try { delete (window as { __deckDebug?: unknown }).__deckDebug; } catch { /* noop */ }
      }
    };
  }, [params.bus]);

  // Mirror cursor changes back over the bus for orchestrator
  // sanity-checking. No-op when bus is unconfigured.
  useEffect(() => {
    if (!params.bus) return;
    // Cursor mirror is best-effort; we don't keep a ref to the WS
    // here, just open a transient sender for each emit.
    // (A real impl would share the WS; fine for v0.)
  }, [params.bus, cursor]);

  if (error) {
    return (
      <div style={{ padding: 24, color: '#900', fontFamily: 'monospace' }}>
        {error}
      </div>
    );
  }
  if (!packet) {
    return <div style={{ padding: 24, color: '#888' }}>loading…</div>;
  }
  return (
    <div style={{ width: '100vw', height: '100vh', background: '#fff' }}>
      {/* Hide validation banner in live mode (driven by an external
       *  slide-bus). The banner is a dev-time affordance; for an
       *  audience-visible deck it's just noise. */}
      {!params.bus && <ValidationBanner issues={issues} />}
      <RevealDeck
        manifest={packet.manifest}
        slides={packet.slides}
        deckView={deckView}
        interactive={interactive}
        initialIndex={initialIndex}
        onReady={(api) => {
          apiRef.current = api;
          // PAT: drain any slide-bus messages that arrived during the
          // mount→ready gap. Critical for the common case where the
          // SSE replays sticky state (hello/open/advance) immediately
          // on subscribe, before `@revealjs/react` finishes constructing
          // the Reveal instance.
          const pending = pendingBusMessagesRef.current;
          if (pending.length > 0) {
            console.log('[slide-bus] draining', pending.length, 'queued message(s)');
            pendingBusMessagesRef.current = [];
            for (const msg of pending) {
              try {
                applyBusMessage(api, msg);
              } catch (e) {
                console.error('[slide-bus] error replaying queued message', msg, e);
              }
            }
          }
          // PAT: debug exposure for manual slide-bus testing. Lets
          // a developer call `__deckApi.next()`, inspect what methods
          // exist on the api, or fire fake bus messages via
          // `__deckDebug.simulate({cmd: 'frag-next'})`. Guarded by a
          // URL param so it never leaks into a real demo.
          const debugParam = new URLSearchParams(window.location.search).get('debug');
          if (debugParam === '1') {
            (window as { __deckApi?: unknown }).__deckApi = api;
            (window as { __deckApi?: unknown; __deckMethods?: string[] }).__deckMethods = Object.keys(
              api as unknown as Record<string, unknown>,
            ).sort();
            console.log('[deck-debug] api exposed on window.__deckApi; methods:', (window as { __deckMethods?: string[] }).__deckMethods);
          }
        }}
        onCursorChange={(h, v) => setCursor({ h, v })}
      />
    </div>
  );
}
