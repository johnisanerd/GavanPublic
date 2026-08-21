/**
 * Timeline runtime — base types.
 *
 * The timeline is a realtime primitive. A timeline is an ordered
 * sequence of typed actions; the sequencer consumes one at a time and
 * awaits each action's completion signal before consuming the next.
 *
 * Base actions live here in `realtime/`. Domain-specific actions
 * (scenario slide nav, robotics, etc.) live in their owning packages
 * and register themselves via `ActionDomainExtension` at module load.
 *
 * See plans/timeline-runtime-and-scenarios.md §3 for the design context.
 */

/** Terminator reasons — kinds of actions that close out a timeline. */
export type TerminatorReason =
  | 'next_slide'
  | 'prev_slide'
  | 'goto_slide'
  | 'nav_slide_up'
  | 'nav_slide_down'
  | 'nav_slide_left'
  | 'nav_slide_right'
  | 'ask_for_questions'
  | 'end_of_timeline';

/** Base action variants known to realtime. Domain extensions add their
 *  own via the `domain` escape hatch — extension's `parseAction` returns
 *  a `DomainAction` and the extension's `dispatch` consumes it. */
export type BaseTimelineAction =
  | { kind: 'say'; text: string; target?: string }
  | { kind: 'pause'; ms: number }
  | {
      kind: 'tool';
      name: string;
      args: Record<string, unknown>;
      /** When true, sequencer fires the tool but does NOT wait for the
       *  tool-post round-trip before consuming the next action. */
      async?: boolean;
    }
  | { kind: 'wait-for-cue'; cue: string }
  | {
      kind: 'terminator';
      reason: TerminatorReason;
      /** Free-form payload for terminators that carry data
       *  (e.g. `goto_slide` carries `{n, v?}`). */
      data?: Record<string, unknown>;
    };

/** Escape hatch for domain-specific actions. Owning extension is
 *  identified by `domainKind`; the rest of the payload is opaque to the
 *  runtime — the extension's `dispatch` re-narrows it. */
export interface DomainAction {
  kind: 'domain';
  /** Stable identifier of the variant, scoped to the owning extension
   *  (e.g. `'next_fragment'`, `'prev_fragment'`, `'drone_move_to'`). */
  domainKind: string;
  /** Arbitrary payload — extension-defined. */
  payload?: Record<string, unknown>;
}

export type TimelineAction = BaseTimelineAction | DomainAction;

/** Type-narrowing helper for the base discriminator. */
export function isBaseAction(action: TimelineAction): action is BaseTimelineAction {
  return action.kind !== 'domain';
}

/** Per-action runtime context. Passed to dispatchers so they can emit
 *  log events, observe the abort signal, etc. The context is owned by
 *  the orchestrator/sequencer caller; extensions are read-only consumers. */
export interface DispatchContext {
  /** Stable id of the timeline this action belongs to. Matches the
   *  `timeline.started` / `timeline.finished` event pair. */
  timelineId: string;
  /** 0-based sequence index within the timeline. */
  seq: number;
  /** Abort signal — flips when the sequencer is asked to cancel
   *  (barge-in, flush). Dispatchers should observe it and unwind. */
  signal: AbortSignal;
  /** Optional channel-shaped identifiers — propagated to log events. */
  threadId?: string | null;
  sessionId?: string | null;
  platformId?: string | null;
  /** Free-form host extras (slide-bus client, scenario slug, ...).
   *  Domain extensions narrow this via their own typing. */
  host?: Record<string, unknown>;
  /** Capture a partial-text snapshot for the in-flight action. Effective
   *  only during the current dispatch — if the sequencer aborts before
   *  this dispatch resolves, the captured text lands on
   *  `CompletedActionRecord.partialText` and shows up on the
   *  `<completed_actions>` block with `partial="true"`. Typical caller:
   *  the `say` handler sets the broadcast text just before opening the
   *  TTS stream so a mid-rendition barge-in carries the spoken prefix.
   *  No-op when the sequencer isn't actively dispatching this action. */
  capturePartialText?: (text: string) => void;
}

/** Recorded state of an action after it played (for the agent-facing
 *  `<completed_actions>` block). */
export interface CompletedActionRecord {
  action: TimelineAction;
  seq: number;
  /** ms since epoch when dispatch began. */
  tsStart: number;
  /** ms since epoch when dispatch resolved. `null` when the action was
   *  cancelled mid-flight. */
  tsEnd: number | null;
  /** `true` if the action was cancelled mid-flight. */
  partial: boolean;
  /** Optional partial-text capture for `say` actions that were cut off
   *  mid-speech. */
  partialText?: string;
  /** Optional human-readable reason when partial=true. */
  reason?: string;
}

/** Action dispatcher signature — sequencer calls this to fire the
 *  action and awaits the returned promise. The promise resolves when
 *  the action's completion signal has fired (audience-perceptible
 *  completion); rejects with AbortError if cancellation propagates
 *  before completion. */
export type DispatchFn = (action: TimelineAction, ctx: DispatchContext) => Promise<void>;
