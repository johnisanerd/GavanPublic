/**
 * Back-mind state synthesizer — folds the back-mind's detail-row stream
 * (tool-pre / tool-post / tool-failed / token-delta / compact) into a
 * snapshot of what the back-mind has been doing.
 *
 * Per design doc §"State as a derived view": deterministic, idempotent
 * fold over the event log. The in-memory snapshot is a cache; the log
 * is authoritative.
 */
import type { DetailRow } from './nanoclaw-client.js';

/**
 * One tool the back-mind started. `finishedAt: null` means still
 * running. `result` is set on tool-post; `error` is set on tool-failed.
 */
export interface ToolHistoryEntry {
  tool: string;
  input: Record<string, unknown>;
  startedAt: string;
  /** ISO 8601 UTC timestamp when the tool finished. `null` while in progress. */
  finishedAt: string | null;
  /** Result returned on success (tool-post). Undefined while in progress or on failure. */
  result?: unknown;
  /** Error message if the tool failed (tool-failed). Undefined otherwise. */
  error?: string;
}

/**
 * Snapshot of what the back-mind has been doing on the current query.
 *
 * - `toolHistory` is the ordered list of tools the back-mind has run
 *   or is running. The entry with `finishedAt: null` is the in-flight
 *   one (at most one at a time).
 * - `streamingTail` is token-delta text accumulated since the last
 *   completed tool — for "looks like X" narration grounding.
 */
export interface BackMindState {
  toolHistory: ToolHistoryEntry[];
  streamingTail: string;
}

export function emptyBackMindState(): BackMindState {
  return {
    toolHistory: [],
    streamingTail: '',
  };
}

/**
 * Apply a single detail row. Returns a new state (does not mutate).
 *
 * tool-pre appends an in-progress entry (finishedAt = null) and resets
 * the streamingTail. tool-post / tool-failed close the most recent
 * in-progress entry by setting finishedAt + result/error. token-delta
 * appends to the streamingTail. compact is a no-op for now.
 */
export function applyDetailRow(state: BackMindState, row: DetailRow): BackMindState {
  const c = row.content;
  switch (c.type) {
    case 'tool-pre':
      return {
        ...state,
        toolHistory: [
          ...state.toolHistory,
          { tool: c.tool, input: c.input, startedAt: row.timestamp, finishedAt: null },
        ],
        streamingTail: '',
      };
    case 'tool-post':
      return {
        ...state,
        toolHistory: closeInFlight(state.toolHistory, (entry) => ({
          ...entry,
          finishedAt: row.timestamp,
          result: c.result,
        })),
        streamingTail: '',
      };
    case 'tool-failed':
      return {
        ...state,
        toolHistory: closeInFlight(state.toolHistory, (entry) => ({
          ...entry,
          finishedAt: row.timestamp,
          error: c.error,
        })),
      };
    case 'token-delta':
      return { ...state, streamingTail: state.streamingTail + c.text };
    case 'compact':
      // Pre-compact rows lose granular fidelity in the back-mind's view, but
      // our state is the front-mind's own log fold — we keep our own history.
      return state;
    default:
      return state;
  }
}

/** Close the most-recent in-progress tool. If none, append a synthetic
 *  completed entry from the patch — keeps the fold robust to out-of-order
 *  rows (a tool-post without a preceding tool-pre). */
function closeInFlight(
  history: ToolHistoryEntry[],
  patch: (entry: ToolHistoryEntry) => ToolHistoryEntry,
): ToolHistoryEntry[] {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.finishedAt === null) {
      const next = [...history];
      next[i] = patch(history[i]!);
      return next;
    }
  }
  // No in-progress entry to close — emit a synthetic closed entry.
  return [
    ...history,
    patch({ tool: 'unknown', input: {}, startedAt: '', finishedAt: null }),
  ];
}

/** Fold an entire detail-row stream into a fresh state. */
export function rebuildBackMindState(rows: DetailRow[]): BackMindState {
  let state = emptyBackMindState();
  for (const row of rows) {
    state = applyDetailRow(state, row);
  }
  return state;
}

/**
 * Render a compact prompt-friendly textual snapshot of back-mind state.
 * This is what gets interpolated into <back_mind_state> slots in the
 * LLM prompts.
 */
export function renderBackMindState(state: BackMindState): string {
  const lines: string[] = [];

  if (state.toolHistory.length > 0) {
    lines.push('tools:');
    for (const entry of state.toolHistory) {
      const status = entry.finishedAt === null ? 'in progress' : 'done';
      const outcome =
        entry.error !== undefined
          ? ` — error: ${entry.error}`
          : entry.result !== undefined
            ? ` — ${summarizeResult(entry.result)}`
            : '';
      lines.push(`- ${entry.tool}(${summarizeInput(entry.input)}) [${status}]${outcome}`);
    }
  }

  if (state.streamingTail) {
    lines.push(`streaming-tail: ${state.streamingTail.slice(-200)}`);
  }

  return lines.join('\n');
}

/** Compact one-line summary of tool input — keeps the rendered state cheap. */
function summarizeInput(input: Record<string, unknown>): string {
  const entries = Object.entries(input);
  if (entries.length === 0) return '';
  return entries
    .map(([k, v]) => {
      if (typeof v === 'string') {
        const trimmed = v.length > 60 ? v.slice(0, 60) + '…' : v;
        return `${k}="${trimmed}"`;
      }
      if (typeof v === 'number' || typeof v === 'boolean') return `${k}=${v}`;
      return `${k}=…`;
    })
    .join(', ');
}

/** Compact one-line summary of tool result. */
function summarizeResult(result: unknown): string {
  if (typeof result === 'string') {
    return result.length > 60 ? `"${result.slice(0, 60)}…"` : `"${result}"`;
  }
  if (typeof result === 'number' || typeof result === 'boolean') return String(result);
  if (result === null) return 'null';
  if (Array.isArray(result)) return `array(${result.length})`;
  if (typeof result === 'object') return 'object';
  return String(result);
}
