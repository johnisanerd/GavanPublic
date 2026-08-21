/**
 * Timeline-runtime log-event helpers.
 *
 * These wrap the new structured-log kinds added in
 * `realtime/src/log-events.ts` for Phase 1:
 *
 *   - `timeline.action-enqueued`   — every action enqueued
 *   - `timeline.action-completed`  — every action whose completion signal fired
 *   - `timeline.action-cancelled`  — every action killed mid-flight or dropped
 *
 * The `timeline.started` / `timeline.finished` events already exist
 * (today's wrapper); their helpers stay where they are. This file just
 * adds the new action-level events.
 *
 * Wire-format guarantees mirror `log-events.ts`: top-level `ts`,
 * `source`, `kind`, `level`, optional thread/session/platform ids, and
 * a kind-specific `data` payload. The drift test
 * (`transports/test_log_events_match.py`) ensures the Python and
 * pat-frontend mirrors agree.
 */

import type {
  TimelineActionEnqueuedEvent,
  TimelineActionStartedEvent,
  TimelineActionCompletedEvent,
  TimelineActionCancelledEvent,
  TimelineStartedEvent,
  TimelineFinishedEvent,
  LogSource,
} from '../log-events.js';
import type { CompletedActionRecord, DispatchContext, TimelineAction } from './types.js';

/** Short, stable string description of an action's kind suitable for
 *  the structured-log `data.kind` slot. For `domain` actions we
 *  promote `domainKind` so dashboards see a usable label. */
export function actionKindLabel(action: TimelineAction): string {
  if (action.kind === 'domain') return action.domainKind;
  if (action.kind === 'terminator') return `terminator:${action.reason}`;
  if (action.kind === 'tool') {
    return action.async ? `tool:${action.name}:async` : `tool:${action.name}`;
  }
  return action.kind;
}

/** Salient per-action fields for the dashboard. Mirrors the optional
 *  `attrs` slot on `TimelineActionEnqueuedEvent.data`. Computed by
 *  default from the action shape; callers can override / extend via
 *  the `attrs` parameter on `buildActionEnqueued`. */
function defaultAttrsForAction(
  action: TimelineAction,
): Record<string, string | number | boolean> | undefined {
  const TEXT_PREVIEW_MAX = 240;
  switch (action.kind) {
    case 'say': {
      const text =
        action.text.length > TEXT_PREVIEW_MAX
          ? `${action.text.slice(0, TEXT_PREVIEW_MAX - 1)}…`
          : action.text;
      const out: Record<string, string | number | boolean> = { text };
      if (action.target) out.target = action.target;
      return out;
    }
    case 'pause':
      return { ms: action.ms };
    case 'tool': {
      const out: Record<string, string | number | boolean> = {
        tool_name: action.name,
      };
      if (action.async) out.async = true;
      // Coerce args into the loose attr shape.
      for (const [k, v] of Object.entries(action.args)) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          out[`arg_${k}`] = v;
        }
      }
      return out;
    }
    case 'wait-for-cue':
      return { cue: action.cue };
    case 'terminator': {
      const out: Record<string, string | number | boolean> = { reason: action.reason };
      if (action.data) {
        for (const [k, v] of Object.entries(action.data)) {
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            out[k] = v;
          }
        }
      }
      return out;
    }
    case 'domain': {
      // Pull direction / n / v / payload fields out so the dashboard
      // can render fragment/slide nav distinguishers without dispatching
      // on domainKind. Loose coercion — non-primitives skipped.
      const out: Record<string, string | number | boolean> = {};
      // Derive a `direction` for fragment + nav variants when the
      // domainKind encodes it (next_fragment / prev_slide / nav_slide_up).
      const dirMatch = /^(?:next|prev)_(?:fragment|slide)$/.exec(action.domainKind);
      if (dirMatch) out.direction = action.domainKind.startsWith('next') ? 'next' : 'prev';
      const navMatch = /^nav_slide_(up|down|left|right)$/.exec(action.domainKind);
      if (navMatch) out.direction = navMatch[1]!;
      if (action.payload) {
        for (const [k, v] of Object.entries(action.payload)) {
          if (k === 'legacy') continue; // internal pre-Phase-2 carrier
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            out[k] = v;
          }
        }
      }
      return Object.keys(out).length > 0 ? out : undefined;
    }
  }
}

/** Build a `timeline.action-enqueued` event. Salient `attrs` are
 *  derived from the action shape by default (see `defaultAttrsForAction`);
 *  pass `attrs` explicitly to override. */
export function buildActionEnqueued(args: {
  timelineId: string;
  action: TimelineAction;
  seq: number;
  threadId?: string | null;
  sessionId?: string | null;
  platformId?: string | null;
  ts?: string;
  source?: LogSource;
  /** Override the per-kind default attrs (rare — usually let the
   *  default deriver pick salient fields). */
  attrs?: Record<string, string | number | boolean>;
}): TimelineActionEnqueuedEvent {
  const attrs = args.attrs ?? defaultAttrsForAction(args.action);
  return {
    ts: args.ts ?? new Date().toISOString(),
    source: args.source ?? 'nanoclaw-host',
    kind: 'timeline.action-enqueued',
    level: 'info',
    thread_id: args.threadId ?? null,
    session_id: args.sessionId ?? null,
    platform_id: args.platformId ?? null,
    data: {
      timeline_id: args.timelineId,
      kind: actionKindLabel(args.action),
      seq: args.seq,
      ...(attrs ? { attrs } : {}),
    },
  };
}

/** Build a `timeline.action-started` event. Fires when the sequencer
 *  peeks the action and begins its dispatch — distinct from
 *  `timeline.action-enqueued` (queue-push) so the dashboard's swimlane
 *  bar can render the actual playback window (started → completed)
 *  rather than the queue-wait window (enqueued → completed). For
 *  terminator actions sitting behind a long say, this is the
 *  difference between a bar that looks like it covers the say's
 *  duration and one that only shows the slide-bus POST. */
export function buildActionStarted(args: {
  timelineId: string;
  action: TimelineAction;
  seq: number;
  tsStart: number;
  threadId?: string | null;
  sessionId?: string | null;
  platformId?: string | null;
  ts?: string;
  source?: LogSource;
}): TimelineActionStartedEvent {
  return {
    ts: args.ts ?? new Date().toISOString(),
    source: args.source ?? 'nanoclaw-host',
    kind: 'timeline.action-started',
    level: 'info',
    thread_id: args.threadId ?? null,
    session_id: args.sessionId ?? null,
    platform_id: args.platformId ?? null,
    data: {
      timeline_id: args.timelineId,
      kind: actionKindLabel(args.action),
      seq: args.seq,
      ts_start: args.tsStart,
    },
  };
}

/** Build a `timeline.action-completed` event from a completed record. */
export function buildActionCompleted(args: {
  timelineId: string;
  record: CompletedActionRecord;
  threadId?: string | null;
  sessionId?: string | null;
  platformId?: string | null;
  ts?: string;
  source?: LogSource;
}): TimelineActionCompletedEvent {
  const { record } = args;
  const tsEnd = record.tsEnd ?? record.tsStart;
  return {
    ts: args.ts ?? new Date().toISOString(),
    source: args.source ?? 'nanoclaw-host',
    kind: 'timeline.action-completed',
    level: 'info',
    thread_id: args.threadId ?? null,
    session_id: args.sessionId ?? null,
    platform_id: args.platformId ?? null,
    data: {
      timeline_id: args.timelineId,
      kind: actionKindLabel(record.action),
      seq: record.seq,
      duration_ms: tsEnd - record.tsStart,
      ts_start: record.tsStart,
      ts_end: tsEnd,
    },
  };
}

/** Build a `timeline.action-cancelled` event. Used for both mid-flight
 *  cancels (partial=true records) and queue-drop drops (action never
 *  started — pass `seq` + `action` directly). */
export function buildActionCancelled(args: {
  timelineId: string;
  action: TimelineAction;
  seq: number;
  reason: string;
  partial?: string;
  threadId?: string | null;
  sessionId?: string | null;
  platformId?: string | null;
  ts?: string;
  source?: LogSource;
}): TimelineActionCancelledEvent {
  return {
    ts: args.ts ?? new Date().toISOString(),
    source: args.source ?? 'nanoclaw-host',
    kind: 'timeline.action-cancelled',
    level: 'info',
    thread_id: args.threadId ?? null,
    session_id: args.sessionId ?? null,
    platform_id: args.platformId ?? null,
    data: {
      timeline_id: args.timelineId,
      kind: actionKindLabel(args.action),
      seq: args.seq,
      reason: args.reason,
      ...(args.partial !== undefined ? { partial: args.partial } : {}),
    },
  };
}

/** Re-export the existing wrapper-lifecycle helpers so consumers can
 *  reach everything timeline-shaped through `timeline/events`. */
export type { TimelineStartedEvent, TimelineFinishedEvent };
