/**
 * @agentic-toolkit/realtime — timeline runtime.
 *
 * Public surface for the timeline primitives. Domain packages
 * (`scenarios/`, future robotics/etc.) import from here when wiring
 * their `ActionDomainExtension` at module load. The orchestrator
 * imports the queue + sequencer for the linear-contract dispatch loop.
 *
 * See plans/timeline-runtime-and-scenarios.md for the design.
 */

export {
  TimelineQueue,
  Sequencer,
  AbortError,
  type SequencerOpts,
  type SequencerHooks,
  type SequencerRunResult,
} from './queue.js';

export {
  registerActionDomain,
  findExtensionFor,
  listExtensions,
  resetRegistry,
  setRegistryConflictHook,
  type ActionDomainExtension,
  type RegistryConflictHook,
} from './registry.js';

export type {
  BaseTimelineAction,
  DomainAction,
  TimelineAction,
  TerminatorReason,
  DispatchContext,
  DispatchFn,
  CompletedActionRecord,
} from './types.js';

export { isBaseAction } from './types.js';

export {
  actionKindLabel,
  buildActionEnqueued,
  buildActionStarted,
  buildActionCompleted,
  buildActionCancelled,
} from './events.js';

export { TagStreamParser, parseTagStream, type TagEvent } from './parser.js';

// Completed-actions inbox emitter — Phase 2 wires this into the
// inbox-forward path so the back-mind sees what actually played on
// the prior turn (vs what it emitted). See plans/timeline-runtime-and-scenarios.md
// §3.6.5 + §3.6.6.
export {
  renderCompletedActions,
  renderInboxWrapper,
  renderInboxWithCompletedActions,
  formatTimeIso8601Short,
  formatDateTimeIso8601,
  type CompletedAction,
  type RenderCompletedActionsArgs,
} from './completed-actions.js';
