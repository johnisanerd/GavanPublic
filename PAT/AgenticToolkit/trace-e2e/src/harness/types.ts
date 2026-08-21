/**
 * Local types for the trace-e2e harness.
 *
 * We deliberately don't import `LogEvent` from `realtime/src/log-events.ts`
 * because that package isn't part of any workspace this package depends
 * on. Instead we mirror the small subset of fields we need on the wire.
 * The schema source of truth is still that file — drift between this
 * and the wire is caught at assertion time when a predicate references
 * a field that doesn't exist.
 *
 * If we later want full type safety, the right move is to lift
 * `log-events.ts` into a `@pat/log-events` workspace package consumed by
 * both `realtime/` and `trace-e2e/`. Until then, this duck-type is enough.
 */

export interface LogEvent {
  ts: string;
  source?: string;
  id?: string;
  level?: 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  thread_id?: string | null;
  platform_id?: string | null;
  session_id?: string | null;
  /** Structured kind discriminator (e.g. `'scenario.tag-stream-started'`). */
  kind: string;
  /** Per-kind payload. Use a type guard on `kind` before reading fields. */
  data: Record<string, unknown>;
}

/** Convenience: narrow data field access without losing TS happiness. */
export function dataField<T = unknown>(rec: LogEvent, name: string): T | undefined {
  return rec.data?.[name] as T | undefined;
}
