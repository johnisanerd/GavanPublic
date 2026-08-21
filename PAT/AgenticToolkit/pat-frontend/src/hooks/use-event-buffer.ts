/**
 * PAT: the dashboard's realtime data layer, extracted verbatim out of the old
 * App.tsx so it survives the shell/router rewrite and keeps feeding the
 * Timeline + Logs views unchanged. SSE stream → rolling dedup'd buffer →
 * thread selection → front/back split. Call ONCE high in the tree; pass the
 * result down to the route elements.
 *
 * Nothing here is "look" — do not fold it into a view component.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { type DisplayRow } from '@/components/EventStream';
import {
  useDashboardState,
  deriveThreadScopedState,
  type DashboardState,
} from '@/hooks/use-dashboard-state';
import { useEventStream, type ConnectionStatus } from '@/hooks/use-event-stream';
import { setDebugSurface } from '@/lib/debug-surface';
import { columnFor, type LogEvent } from '@/types/log-events';

const MAX_BUFFER = 4000;
const MAX_SEEN_KEYS = 250_000;

/** Smoketest threads use `smoke-<scenario>` ids; real calls use `call-<hex>`. */
function isTestThread(tid: string): boolean {
  return tid.startsWith('smoke-');
}

export interface ThreadEntry {
  tid: string;
  lastTs: string;
  isTest: boolean;
}

export interface EventBuffer {
  token: string | null;
  buffer: LogEvent[];
  status: ConnectionStatus;
  displayedThread: string | null;
  isFollowingLatest: boolean;
  threadsByRecency: ThreadEntry[];
  onPickThread: (tid: string) => void;
  threadScopedState: DashboardState;
  front: DisplayRow[];
  back: DisplayRow[];
  onClear: () => void;
}

export function useEventBuffer(): EventBuffer {
  const { token, initialThread } = useMemo(() => {
    const qs = new URLSearchParams(window.location.search);
    return { token: qs.get('token'), initialThread: qs.get('thread') };
  }, []);

  const { state, ingest, reset } = useDashboardState();
  const [buffer, setBuffer] = useState<LogEvent[]>([]);
  const [pinnedThread, setPinnedThread] = useState<string | null>(initialThread);

  const seenKeysRef = useRef<Set<string>>(new Set());

  const onEvent = useCallback(
    (rec: LogEvent) => {
      let key: string;
      if (rec.id) {
        key = rec.id;
      } else {
        try {
          key = `__nokey__:${JSON.stringify(rec)}`;
        } catch {
          key = `${rec.ts}|${rec.source ?? ''}|${rec.kind}|${rec.thread_id ?? ''}|${rec.session_id ?? ''}`;
        }
      }
      if (seenKeysRef.current.has(key)) return;
      seenKeysRef.current.add(key);
      if (seenKeysRef.current.size > MAX_SEEN_KEYS) {
        seenKeysRef.current = new Set();
      }
      ingest(rec);
      if (rec.kind === 'misc') return;
      setBuffer((prev) => {
        // Coalesce cumulative cartesia text-sent events: each arrival REPLACES
        // the previous in-flight one for the same thread.
        if (rec.kind === 'cartesia.agent-text-sent' || rec.kind === 'cartesia.user-text-sent') {
          for (let i = prev.length - 1; i >= 0; i--) {
            const r = prev[i]!;
            if (r.thread_id !== rec.thread_id) continue;
            const boundaryKind: string =
              rec.kind === 'cartesia.agent-text-sent'
                ? 'cartesia.agent-turn-boundary'
                : 'cartesia.user-turn-boundary';
            if (r.kind === boundaryKind && (r.data as { edge?: string }).edge === 'stop') {
              break;
            }
            if (r.kind === rec.kind) {
              const next = [...prev];
              next[i] = rec;
              return next;
            }
          }
        }
        const overflow = prev.length + 1 - MAX_BUFFER;
        return overflow > 0 ? [...prev.slice(overflow), rec] : [...prev, rec];
      });
    },
    [ingest],
  );

  const status = useEventStream({ onEvent, token });

  const threadsByRecency = useMemo<ThreadEntry[]>(
    () =>
      Object.entries(state.threadMeta)
        .map(([tid, m]) => ({ tid, lastTs: m.lastTs, isTest: isTestThread(tid) }))
        .sort((a, b) => (a.lastTs < b.lastTs ? 1 : a.lastTs > b.lastTs ? -1 : 0)),
    [state.threadMeta],
  );

  const visibleLatestThread = useMemo(() => {
    if (state.latestThread && !isTestThread(state.latestThread)) return state.latestThread;
    const firstReal = threadsByRecency.find((t) => !t.isTest);
    return firstReal?.tid ?? state.latestThread ?? threadsByRecency[0]?.tid ?? null;
  }, [state.latestThread, threadsByRecency]);

  const displayedThread = pinnedThread ?? visibleLatestThread;
  const isFollowingLatest = pinnedThread === null;

  const threadScopedState = useMemo<DashboardState>(() => {
    const t = deriveThreadScopedState(buffer, displayedThread);
    return {
      ...t,
      knownThreads: state.knownThreads,
      latestThread: state.latestThread,
      threadMeta: state.threadMeta,
      sseClients: state.sseClients,
    };
  }, [buffer, displayedThread, state.knownThreads, state.latestThread, state.threadMeta, state.sseClients]);

  const { front, back } = useMemo(() => {
    const f: DisplayRow[] = [];
    const b: DisplayRow[] = [];
    if (!displayedThread) return { front: f, back: b };
    const counts = new Map<string, number>();
    for (const rec of buffer) {
      if (rec.thread_id !== displayedThread) continue;
      let id: string;
      if (rec.id) {
        id = rec.id;
      } else {
        const base = `${rec.ts}|${rec.source ?? ''}|${rec.kind}|${rec.thread_id ?? ''}`;
        const n = counts.get(base) ?? 0;
        counts.set(base, n + 1);
        id = n === 0 ? base : `${base}#${n}`;
      }
      const row: DisplayRow = { id, rec };
      if (columnFor(rec.kind) === 'back') b.push(row);
      else f.push(row);
    }
    return { front: f, back: b };
  }, [buffer, displayedThread]);

  const onPickThread = useCallback(
    (tid: string) => {
      setPinnedThread(tid === visibleLatestThread ? null : tid);
    },
    [visibleLatestThread],
  );

  const onClear = useCallback(() => {
    setBuffer([]);
    setPinnedThread(null);
    seenKeysRef.current.clear();
    reset();
  }, [reset]);

  useEffect(() => {
    setDebugSurface('patClear', onClear);
  }, [onClear]);

  useEffect(() => {
    setDebugSurface('pat', {
      pinnedThread,
      latestThread: state.latestThread,
      displayedThread,
      isFollowingLatest,
      threadsByRecency,
      bufferLength: buffer.length,
      frontRowCount: front.length,
      backRowCount: back.length,
      state,
    });
  });

  return {
    token,
    buffer,
    status,
    displayedThread,
    isFollowingLatest,
    threadsByRecency,
    onPickThread,
    threadScopedState,
    front,
    back,
    onClear,
  };
}
