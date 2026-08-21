import type { ResearchStreamEvent } from "../types/agent";
import type { DeepDiveStreamEvent } from "../types/deep-dive";

/** Any event that can flow through the bus */
export type BusEvent = ResearchStreamEvent | DeepDiveStreamEvent;

type Listener = (event: BusEvent) => void;

class EventBus {
  private events: BusEvent[] = [];
  private listeners = new Set<Listener>();

  emit(event: BusEvent): void {
    this.events.push(event);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Don't let one listener break others
      }
    }
  }

  subscribe(listener: Listener, fromIndex = 0): () => void {
    this.listeners.add(listener);
    // Replay missed events
    for (let i = fromIndex; i < this.events.length; i++) {
      try {
        listener(this.events[i]);
      } catch {
        // Skip
      }
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  getEventCount(): number {
    return this.events.length;
  }
}

// Use globalThis to ensure a single shared bus map across all Next.js
// module instances (dev mode / hot reload can create separate scopes)
const globalKey = "__aisle_crosser_event_buses__";

function getBusMap(): Map<string, EventBus> {
  const g = globalThis as Record<string, unknown>;
  if (!g[globalKey]) {
    g[globalKey] = new Map<string, EventBus>();
  }
  return g[globalKey] as Map<string, EventBus>;
}

export function getEventBus(id: string): EventBus {
  const buses = getBusMap();
  if (!buses.has(id)) {
    buses.set(id, new EventBus());
  }
  return buses.get(id)!;
}

export function cleanupEventBus(id: string): void {
  getBusMap().delete(id);
}
