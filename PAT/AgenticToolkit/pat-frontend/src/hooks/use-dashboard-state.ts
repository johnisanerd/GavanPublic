import { useCallback, useReducer } from 'react';
import type { LogEvent } from '@/types/log-events';

/**
 * State derived from the live event stream — what the cards render.
 * Mirrors the field set the original vanilla impl maintained on the
 * page, but kept as immutable React state for easy extension.
 */
export interface DashboardState {
  // Front-mind
  threadId: string | null;
  caller: string | null;
  isProcessingNarration: boolean;
  isTtsBusy: boolean;
  banterBufferCount: number;
  sseClients: number;

  // Back-mind
  sessionId: string | null;
  containerRunning: boolean;
  containerExitCode: number | null;
  lastChatSeq: number | null;
  lastChatPreview: string | null;

  // Filter affordances
  knownThreads: string[];          // thread_ids seen, in arrival order
  latestThread: string | null;     // thread with the largest event timestamp
  // Per-thread metadata so the UI / debug surface can reason about which
  // thread is "latest" without re-scanning the event buffer.
  threadMeta: Record<string, ThreadMeta>;
}

export interface ThreadMeta {
  /** Largest `ts` (ISO 8601) seen for this thread. */
  lastTs: string;
  /** Total events ingested for this thread (across all kinds). */
  count: number;
  /** Whether we ever observed a `call.started` for this thread. */
  hasCallStarted: boolean;
}

const initialState: DashboardState = {
  threadId: null,
  caller: null,
  isProcessingNarration: false,
  isTtsBusy: false,
  banterBufferCount: 0,
  sseClients: 0,

  sessionId: null,
  containerRunning: false,
  containerExitCode: null,
  lastChatSeq: null,
  lastChatPreview: null,

  knownThreads: [],
  latestThread: null,
  threadMeta: {},
};

type Action =
  | { type: 'event'; rec: LogEvent }
  | { type: 'reset' };

/** Apply a single event to a state slice, returning a new slice.
 *  Pure — used both by the global reducer and by `deriveThreadScopedState`
 *  for rebuilding a thread-filtered status view from the buffer. */
export function applyEvent(state: DashboardState, rec: LogEvent): DashboardState {
  let next = state;
  return foldEventInto(next, rec);
}

/** Rebuild the thread-scoped subset of state from a filtered buffer.
 *  Used by the back-mind status block so a thread that has no
 *  chat/container events shows "—" instead of leftover state from a
 *  previously-displayed thread. The thread-meta / latest tracking is
 *  intentionally NOT recomputed here — that stays in the global hook. */
export function deriveThreadScopedState(
  buffer: LogEvent[],
  threadId: string | null,
): DashboardState {
  if (!threadId) return initialState;
  let s = initialState;
  for (const rec of buffer) {
    if (rec.thread_id !== threadId) continue;
    s = foldEventInto(s, rec, /*skipThreadMeta=*/ true);
  }
  return s;
}

function reduce(state: DashboardState, action: Action): DashboardState {
  if (action.type === 'reset') return initialState;
  return foldEventInto(state, action.rec);
}

function foldEventInto(state: DashboardState, rec: LogEvent, skipThreadMeta = false): DashboardState {
  let next = state;

  // Per-thread metadata: max(ts), count, hasCallStarted. The "latest"
  // thread is the one with the largest event timestamp — NOT the order
  // events arrive in the SSE stream, since the persistent log is
  // replayed at startup and may not preserve strict chronological order
  // across calls.
  if (!skipThreadMeta && rec.thread_id && rec.ts) {
    const tid = rec.thread_id;
    const prev = state.threadMeta[tid];
    const isNewer = !prev || rec.ts > prev.lastTs;
    const nextMeta: ThreadMeta = {
      lastTs: prev && prev.lastTs > rec.ts ? prev.lastTs : rec.ts,
      count: (prev?.count ?? 0) + 1,
      hasCallStarted: (prev?.hasCallStarted ?? false) || rec.kind === 'call.started',
    };
    let nextLatest = next.latestThread;
    if (isNewer) {
      // Recompute latest if this thread's bumped lastTs surpasses the
      // current latest. Compare against the current map entry for the
      // existing latest thread.
      const currentLatestTs = nextLatest ? state.threadMeta[nextLatest]?.lastTs ?? '' : '';
      if (!nextLatest || nextMeta.lastTs > currentLatestTs) {
        nextLatest = tid;
      }
    }
    next = {
      ...next,
      knownThreads: state.knownThreads.includes(tid)
        ? state.knownThreads
        : [...state.knownThreads, tid],
      latestThread: nextLatest,
      threadMeta: { ...state.threadMeta, [tid]: nextMeta },
    };
  }

  switch (rec.kind) {
    case 'inbound.received':
      next = {
        ...next,
        threadId: rec.thread_id ?? next.threadId,
        caller: rec.data.sender_id ?? next.caller,
      };
      break;

    case 'session.created':
      next = {
        ...next,
        sessionId: rec.session_id ?? next.sessionId,
        threadId: rec.thread_id ?? next.threadId,
      };
      break;

    case 'session.closed':
      next = {
        ...next,
        isProcessingNarration: false,
        isTtsBusy: false,
        containerRunning: false,
      };
      break;

    case 'container.spawned':
      next = { ...next, containerRunning: true, containerExitCode: null };
      break;

    case 'container.exited':
      next = {
        ...next,
        containerRunning: false,
        containerExitCode: rec.data.exit_code,
      };
      break;

    case 'state.transitioned': {
      const to = rec.data.to;
      if (rec.data.state === 'isProcessingNarration') {
        next = { ...next, isProcessingNarration: !!to };
      } else if (rec.data.state === 'isTtsBusy') {
        next = { ...next, isTtsBusy: !!to };
      } else if (rec.data.state === 'banter-buffer') {
        next = { ...next, banterBufferCount: typeof to === 'number' ? to : next.banterBufferCount };
      }
      break;
    }

    case 'tts.busy-marked':
      next = { ...next, isTtsBusy: true };
      break;

    case 'tts.turn-ended':
      next = { ...next, isTtsBusy: false };
      break;

    case 'sse.client-changed':
      next = { ...next, sseClients: rec.data.total_clients };
      break;

    case 'chat.row-received':
      next = {
        ...next,
        lastChatSeq: rec.data.seq,
        lastChatPreview: rec.data.preview || null,
      };
      break;

    case 'call.started':
      // Already covered by the generic "latest seen" tracking above; kept
      // as a no-op for clarity of intent.
      break;

    case 'call.ended':
      // Don't clear thread/caller — leave them showing the last call.
      break;

    default:
      break;
  }
  return next;
}

export function useDashboardState() {
  const [state, dispatch] = useReducer(reduce, initialState);
  const ingest = useCallback((rec: LogEvent) => dispatch({ type: 'event', rec }), []);
  const reset = useCallback(() => dispatch({ type: 'reset' }), []);
  return { state, ingest, reset };
}
