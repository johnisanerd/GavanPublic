/**
 * The minimal surface the ChannelOrchestrator asks of its host.
 *
 * Every method on this interface represents a coupling between the
 * realtime library and the host application (nanoclaw, today). We keep
 * the surface small on purpose — every new method is one more thing
 * the orchestrator can't be tested without a fake.
 *
 * The orchestrator never imports `nanoclaw/*`; everything host-side
 * goes through this interface.
 */

/** Structured-log emit. Matches the shape nanoclaw's `log.event(...)`
 *  uses; adapters can pass that function directly when constructing an
 *  orchestrator.
 *
 *  `data` is required (not optional). Every emit should carry queryable
 *  fields under data — leaving it out means the consumer has to inspect
 *  `kind` alone to decide what happened, which defeats the structured-
 *  log model. Pass `data: {}` if there's truly nothing to attach. */
export interface StructuredLogEvent {
  kind: string;
  level?: 'debug' | 'info' | 'warn' | 'error';
  session_id?: string | null;
  thread_id?: string | null;
  platform_id?: string | null;
  source?: string;
  id?: string;
  data: Record<string, unknown>;
}

export interface StructuredLogger {
  event(args: StructuredLogEvent): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export interface HostAdapter {
  /** Structured-log sink. Used for `utterance.stream-*`,
   *  `tts.turn-ended`, `bargein.propagated`, etc. */
  log: StructuredLogger;
}
