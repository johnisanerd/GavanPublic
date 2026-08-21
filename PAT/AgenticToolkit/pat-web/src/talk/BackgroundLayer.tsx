import { useMemo, useRef, useEffect } from 'react';
import type { AbstractEvent } from './hooks/use-events-stream';
import type { BackgroundPreset } from './lib/bg-presets';

interface BackgroundLayerProps {
  preset: BackgroundPreset;
  /** Used by 'events' kind — drives the falling stream. */
  events: AbstractEvent[];
}

/**
 * The bottom-most layer of the stage. Renders different visual modes
 * based on the selected preset. For solid/gradient/image kinds it's
 * just a styled div. For 'events' it's a canvas-based stream
 * visualizer styled like a token rain.
 */
export function BackgroundLayer({ preset, events }: BackgroundLayerProps) {
  if (preset.kind === 'events') {
    return <EventsRain events={events} />;
  }
  if (preset.kind === 'image' && preset.src) {
    return (
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: `url(${preset.src})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        }}
      />
    );
  }
  return (
    <div
      className="absolute inset-0"
      style={{ background: preset.css ?? 'var(--color-bg-base)' }}
    />
  );
}

/**
 * Events rain — each event drops a glyph cluster down a column. Not a
 * literal Matrix-clone; we keep the columns sparse so the chroma-keyed
 * face stays legible. Columns are claimed FIFO so high-throughput
 * stretches still fall on independent tracks.
 */
const KIND_COLORS: Record<AbstractEvent['kind'], string> = {
  reflex:    'oklch(0.78 0.16 350)',  // pink — banter
  narration: 'oklch(0.86 0.13 200)',  // cyan — narration
  rendition: 'oklch(0.86 0.13 190)',  // teal — back-mind rendition
  state:     'oklch(0.85 0.15 75)',   // amber — state transitions
  stt:       'oklch(0.85 0.13 90)',   // ochre — speech-to-text
  tts:       'oklch(0.86 0.005 250)', // bone — text-to-speech
  inbound:   'oklch(0.85 0.18 145)',  // green — inbound routing
  detail:    'oklch(0.62 0.012 250)', // graphite — detail rows
  misc:      'oklch(0.55 0.012 250)',
};

interface DropState {
  column: number;
  y: number;
  speed: number;
  glyphs: string[];
  color: string;
  alphaScale: number;
}

const GLYPH_POOL = '01ABCDEFGH<>=~/\\|+-*ƒΛΣΦΩψεμπ▮▯';

function EventsRain({ events }: { events: AbstractEvent[] }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dropsRef = useRef<DropState[]>([]);
  const lastEventIdRef = useRef<string | null>(null);

  // Push new events into the drops list.
  useEffect(() => {
    if (events.length === 0) return;
    const newest = events[events.length - 1]!;
    if (newest.id === lastEventIdRef.current) return;
    lastEventIdRef.current = newest.id;

    const colCount = Math.max(24, Math.floor((canvasRef.current?.clientWidth ?? 1200) / 24));
    const column = Math.floor(Math.random() * colCount);
    const len = 4 + Math.floor(Math.random() * 8) + (newest.label?.length ?? 0) / 4;
    const glyphs: string[] = [];
    for (let i = 0; i < len; i++) {
      glyphs.push(GLYPH_POOL[Math.floor(Math.random() * GLYPH_POOL.length)]!);
    }
    dropsRef.current.push({
      column,
      y: -len,
      speed: 0.5 + Math.random() * 1.2,
      glyphs,
      color: KIND_COLORS[newest.kind],
      alphaScale: 0.85,
    });
  }, [events]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let rafId = 0;
    const cell = 20;
    const dpr = window.devicePixelRatio || 1;

    const resize = () => {
      canvas.width = Math.floor(canvas.clientWidth * dpr);
      canvas.height = Math.floor(canvas.clientHeight * dpr);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const loop = () => {
      const w = canvas.width;
      const h = canvas.height;

      // Faint trail — semi-transparent black wash retains motion.
      ctx.fillStyle = 'oklch(0.07 0.006 250 / 0.18)';
      ctx.fillRect(0, 0, w, h);

      ctx.font = `${Math.floor(cell * dpr * 0.85)}px var(--font-mono, monospace)`;
      ctx.textBaseline = 'top';

      const drops = dropsRef.current;
      const next: DropState[] = [];
      const cellH = cell * dpr;

      for (const drop of drops) {
        const x = drop.column * cell * dpr;
        let dropAlive = false;
        for (let i = 0; i < drop.glyphs.length; i++) {
          const rowY = (drop.y - i) * cellH;
          if (rowY < -cellH || rowY > h) continue;
          const head = i === 0;
          const a = (head ? 1 : (1 - i / drop.glyphs.length) * 0.75) * drop.alphaScale;
          ctx.fillStyle = head ? 'oklch(0.99 0.005 90)' : drop.color;
          ctx.globalAlpha = a;
          ctx.fillText(drop.glyphs[i]!, x, rowY);
        }
        ctx.globalAlpha = 1;
        // Keep the drop alive until its tail has cleared the bottom.
        if ((drop.y - drop.glyphs.length) * cellH < h) {
          dropAlive = true;
        }
        drop.y += drop.speed;
        if (dropAlive) next.push(drop);
      }
      dropsRef.current = next;

      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
    };
  }, []);

  const placeholder = useMemo(() => events.length === 0, [events.length]);

  return (
    <div className="absolute inset-0 overflow-hidden bg-[var(--color-bg-base)]">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full"
        aria-hidden
      />
      {placeholder && (
        <div className="absolute inset-x-0 bottom-6 text-center text-[11px] uppercase tracking-[0.24em] text-[var(--color-ink-5)]">
          events stream — waiting for activity
        </div>
      )}
    </div>
  );
}
