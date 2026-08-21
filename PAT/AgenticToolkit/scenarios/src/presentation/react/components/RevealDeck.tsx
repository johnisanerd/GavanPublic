/**
 * RevealDeck — pat-web's wrapper around `@revealjs/react`'s Deck.
 *
 * Responsibilities:
 *  - Deck config (4:3, embedded, scroll-view fallback for narrow panes)
 *  - Maps a packet (PacketManifest + SlideSpec[]) to <Slide> children
 *    via `compileVisual`
 *  - Exposes a `deckApi` ref to the parent so MCP-tool-driven
 *    commands (`advance(n)`, `inject(spec)`) can fire imperatively
 *  - Listens for slidechanged events to mirror cursor state back to
 *    the parent via `onCursorChange`
 *
 * The "slide bus" (the surface MCP tools push commands into) is NOT
 * owned by RevealDeck — it's wired in the parent (DeckPage), which
 * uses `useReveal`-style refs to translate bus messages into
 * imperative calls. RevealDeck stays declarative.
 */
import { Deck } from '@revealjs/react';
import type { RevealApi } from 'reveal.js';
import { cloneElement, useEffect, useMemo, useRef } from 'react';
import type { PacketManifest, SlideSpec } from '../../slide-spec.js';
import { compileVisual } from './slide-layouts/index.js';

/** Load Palisade brand fonts (DM Sans + DM Mono) on demand. Idempotent
 *  via a sentinel `<link data-pat-fonts>` element. Falls back to
 *  system fonts if Google Fonts is unreachable. */
function ensureBrandFonts(): void {
  if (typeof document === 'undefined') return;
  if (document.querySelector('link[data-pat-fonts]')) return;
  const preconnect1 = document.createElement('link');
  preconnect1.rel = 'preconnect';
  preconnect1.href = 'https://fonts.googleapis.com';
  preconnect1.setAttribute('data-pat-fonts', 'pc1');
  const preconnect2 = document.createElement('link');
  preconnect2.rel = 'preconnect';
  preconnect2.href = 'https://fonts.gstatic.com';
  preconnect2.crossOrigin = 'anonymous';
  preconnect2.setAttribute('data-pat-fonts', 'pc2');
  const stylesheet = document.createElement('link');
  stylesheet.rel = 'stylesheet';
  stylesheet.href =
    'https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&display=swap';
  stylesheet.setAttribute('data-pat-fonts', 'css');
  document.head.appendChild(preconnect1);
  document.head.appendChild(preconnect2);
  document.head.appendChild(stylesheet);
}

export interface RevealDeckProps {
  manifest: PacketManifest;
  slides: SlideSpec[];
  /** When true (or unset), reveal renders in standard deck mode.
   *  When false, switches to `view: 'scroll'` — useful for narrow
   *  embed panes where deck mode looks cramped. */
  deckView?: boolean;
  /** Initial slide index (0-based). Subsequent navigation is
   *  driven by the deck or by the parent calling `api.slide()`. */
  initialIndex?: number;
  /** Fires whenever the deck advances/regresses. h is 0-based. */
  onCursorChange?: (h: number, v: number) => void;
  /** Receives the RevealApi once initialization completes. Parent
   *  uses this for imperative `slide(n)`, `next()`, `prev()`. */
  onReady?: (api: RevealApi) => void;
  /** Enable keyboard navigation + on-screen arrow controls.
   *  Default false (presenter mode — the agent drives via MCP tools,
   *  audience shouldn't advance via stray keypresses). Set true in
   *  dev / preview routes so a human can step through with arrow
   *  keys or click. */
  interactive?: boolean;
}

export function RevealDeck({
  manifest,
  slides,
  deckView = true,
  initialIndex = 0,
  onCursorChange,
  onReady,
  interactive = false,
}: RevealDeckProps) {
  const apiRef = useRef<RevealApi | null>(null);

  useEffect(() => {
    ensureBrandFonts();
  }, []);

  const config = useMemo(
    () => ({
      // 4:3 — safer for phone safe-area + narrow embeds than 16:9.
      // Compile step gives aspect-ratio flexibility per channel if it
      // ever bites.
      width: 1440,
      height: 1080,
      margin: 0.05,
      minScale: 0.2,
      maxScale: 1.5,
      // Scale to host element, not viewport. Critical for iframe
      // mounting + side-pane composition.
      embedded: true,
      // reveal's `view` is `null | 'print' | 'scroll'`; null = default
      // deck view, 'scroll' = scroll-view (5.0+), 'print' = PDF mode.
      view: deckView ? null : ('scroll' as const),
      // PAT: disable Reveal's auto scroll-view activation. Default
      // (435px) auto-flips narrow embedded iframes into scroll-view
      // mode where `api.slide()`, `nextFragment()`, and the rest of
      // the agent-driven dispatch are silent no-ops. Our presenter
      // side-pane is ~300px wide on purpose — we want deck-view at
      // every size, with the deck scaling down via Reveal's standard
      // scale path. 0 disables the auto-activation entirely (source
      // checks `presentationWidth > 0 && presentationWidth <=
      // scrollActivationWidth`, so 0 never matches). Explicit opt-in
      // to scroll-view via deckView=false still works.
      scrollActivationWidth: 0,
      hash: false,
      controls: interactive,
      progress: true,
      // PAT: per `plans/presenter-tag-stream.md` Phase C — convex
      // transition globally. Looks polished in tandem with fragment
      // reveals synced to speech.
      transition: 'convex' as const,
      autoAnimate: true,
      // Keyboard nav off in presenter mode (agent drives, audience
      // doesn't have a way to advance accidentally). On for dev /
      // preview routes where a human steps through with arrows.
      keyboard: interactive,
      slideNumber: (interactive ? 'c/t' : false) as 'c/t' | false,
    }),
    [deckView, interactive],
  );

  // Wire slide-change events back to the parent. RevealApi.on takes a
  // generic event-handler shape that we lean on rather than typing
  // our own.
  useEffect(() => {
    const api = apiRef.current;
    if (!api || !onCursorChange) return;
    const handler = (event: unknown) => {
      // event shape from reveal: { indexh, indexv, ... }
      const e = event as { indexh?: number; indexv?: number };
      onCursorChange(e.indexh ?? 0, e.indexv ?? 0);
    };
    api.on('slidechanged', handler);
    api.on('ready', handler);
    return () => {
      api.off('slidechanged', handler);
      api.off('ready', handler);
    };
  }, [onCursorChange]);

  const handleReady = (api: RevealApi) => {
    apiRef.current = api;
    if (initialIndex > 0) {
      api.slide(initialIndex, 0);
    }
    onReady?.(api);
  };

  return (
    <Deck
      config={config}
      deckRef={apiRef}
      onReady={handleReady}
      className="pat-deck"
      style={{ width: '100%', height: '100%' }}
    >
      {slides.map((spec) =>
        cloneElement(compileVisual(spec), {
          key: `${manifest.slug}-${spec.slide}`,
        }),
      )}
    </Deck>
  );
}
