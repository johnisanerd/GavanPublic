import { useEffect, useRef, useState } from 'react';

/**
 * Abstracted event we render in the background layer. Intentionally
 * tiny — the visualizer treats `kind` as the only categorical axis
 * and `label` as the only displayable text. Full event payloads
 * (used for the dashboard log columns) belong to pat-frontend.
 */
export interface AbstractEvent {
  id: string;
  ts: number;
  /** Coarse category. Drives color and column placement. */
  kind: 'reflex' | 'narration' | 'rendition' | 'state' | 'stt' | 'tts' | 'inbound' | 'detail' | 'misc';
  /** Short label — ideally < 24 chars, monospace-friendly. */
  label: string;
}

export type EventsSource = 'simulator' | 'live';

const SIMULATOR_PHRASES: Array<Omit<AbstractEvent, 'id' | 'ts'>> = [
  { kind: 'inbound',   label: 'user.turn.end'        },
  { kind: 'reflex',    label: 'banter.reflex'        },
  { kind: 'tts',       label: 'tts.speaking'         },
  { kind: 'stt',       label: 'stt.partial'          },
  { kind: 'detail',    label: 'detail.observed'      },
  { kind: 'narration', label: 'narration.fired'      },
  { kind: 'rendition', label: 'rendition.spoken'     },
  { kind: 'state',     label: 'state.transition'     },
  { kind: 'inbound',   label: 'route.forward'        },
  { kind: 'misc',      label: 'chat.row'             },
  { kind: 'state',     label: 'think.deepening'      },
  { kind: 'stt',       label: 'voice.activity'       },
];

/**
 * Front-end-only mode emits canned events on a timer. Once the
 * backend is wired we can swap to a real SSE source proxying
 * nanoclaw `/admin/logs.tail`. Either way the renderer sees the
 * same `AbstractEvent` shape so the visualizer doesn't change.
 */
export function useEventsStream(source: EventsSource): AbstractEvent[] {
  const [events, setEvents] = useState<AbstractEvent[]>([]);
  const counterRef = useRef(0);

  useEffect(() => {
    if (source === 'simulator') {
      const tick = () => {
        counterRef.current += 1;
        const phrase = SIMULATOR_PHRASES[counterRef.current % SIMULATOR_PHRASES.length]!;
        const ev: AbstractEvent = {
          id: `sim-${counterRef.current}`,
          ts: Date.now(),
          kind: phrase.kind,
          label: phrase.label,
        };
        setEvents((prev) => {
          const next = [...prev, ev];
          // Keep a rolling window — the visualizer doesn't need history.
          return next.length > 200 ? next.slice(next.length - 200) : next;
        });
      };
      const id = window.setInterval(tick, 380 + Math.random() * 120);
      return () => window.clearInterval(id);
    }

    // 'live' — connect to real SSE once backend is wired. For now
    // this is a placeholder so the surface compiles without a server.
    const url = '/api/events.tail';
    const es = new EventSource(url);
    es.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        const ev: AbstractEvent = {
          id: data.id ?? `live-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          ts: Date.now(),
          kind: (data.kind as AbstractEvent['kind']) ?? 'misc',
          label: data.label ?? data.kind ?? 'event',
        };
        setEvents((prev) => {
          const next = [...prev, ev];
          return next.length > 200 ? next.slice(next.length - 200) : next;
        });
      } catch {
        /* swallow */
      }
    };
    es.onerror = () => {
      // Backend not up yet — fail soft, no console noise loop.
    };
    return () => es.close();
  }, [source]);

  return events;
}
