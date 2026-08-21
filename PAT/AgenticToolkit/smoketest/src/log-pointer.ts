/**
 * Agentic log pointers.
 *
 * The smoke runner is used to hunt issues WHILE shipping features, so every
 * scenario result must hand back the exact command to inspect what actually
 * happened in PAT's structured logs — no guessing at thread ids or time
 * windows. We emit a ready-to-run `patobs` query (the canonical store,
 * AGENTS.md forensics rule) scoped to the run's env + time window (+ the
 * correlation token when the scenario stamped one).
 *
 * Output is a shell one-liner the operator or a sub-agent can paste. The
 * harness does NOT run patobs itself (that needs scripts/proxy.sh + secrets);
 * emitting the precise query keeps the harness dependency-free and composes
 * with the /pat-logs skill.
 */
import type { ScenarioResult } from './scenarios/index.js';

export interface LogPointerOpts {
  /** patobs env column value for this run's target. */
  env: 'staging' | 'prod';
}

/** ms → OpenObserve micros (patobs _timestamp is Int64 micros). */
function toMicros(ms: number): number {
  return Math.floor(ms) * 1000;
}

/**
 * A `patobs` SQL query that pulls the full structured event trace for one
 * scenario run — from just before it started, in its env, newest last.
 * Adds a correlation `LIKE` when the scenario stamped a token.
 */
export function patobsQueryForResult(r: ScenarioResult, opts: LogPointerOpts): string {
  const start = r.startedAtMs ? toMicros(r.startedAtMs - 3_000) : undefined;
  const clauses = [`env='${opts.env}'`];
  if (start !== undefined) clauses.push(`_timestamp >= ${start}`);
  const where = clauses.join(' AND ');
  const corrNote = r.corr
    ? `  # this run's correlation token: ${r.corr} — add: AND str_match(message,'${r.corr}') on pat_raw, or grep the output`
    : '';
  const sql = `SELECT ts,kind,thread_id,session_id,level FROM pat_events WHERE ${where} ORDER BY _timestamp`;
  return `../pat-observability/scripts/patobs "${sql}" --since 15m${corrNote}`;
}

/** One-line human/agent summary line for a result, incl. the log pointer. */
export function resultPointerLine(r: ScenarioResult, opts: LogPointerOpts): string {
  return `  ↳ inspect: ${patobsQueryForResult(r, opts)}`;
}
