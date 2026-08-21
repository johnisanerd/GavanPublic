/**
 * Structured-log assertion helper for `check` steps.
 *
 * The plan's highest-leverage primitive (smoke-coverage-plan.md §"next-build"):
 * assert that a specific structured event appeared, rather than scraping chat
 * text or (for call threads) going blind because the /outbound SSE carries no
 * back-mind events. Trace-based testing per AGENTS.md — assert on the same
 * `kind`-discriminated event stream you grep when prod breaks.
 *
 * Source of truth: pat-frontend's public `/api/logs.jsonl` proxy (viewer-token
 * gated, per-env). This is what the scenario RUNTIME can reach over plain
 * HTTPS — the `patobs` MCP is for interactive agent forensics, not the tsx
 * runner. Same assertion vocabulary either way ("event X within Ns").
 *
 * Missing `PAT_VIEWER_TOKEN` → the check SKIPS with a note (ok:true) rather
 * than reddening token-less machines — matches the plan's "skip-with-note,
 * never silently" rule. The skip is always surfaced in the outcome details.
 */
import type { ScenarioContext } from './scenarios/index.js';

const DEFAULT_FRONTEND = 'https://pat-frontend-staging.fly.dev';
const DEFAULT_POLL_MS = 3_000;

export interface LogEvent {
  kind: string;
  ts?: string;
  session_id?: string | null;
  thread_id?: string | null;
  platform_id?: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
}

export interface LogCheckConfig {
  /** pat-frontend base (per-env). Default staging; PAT_FRONTEND_URL overrides. */
  frontendUrl: string;
  /** Viewer token; empty → checks skip-with-note. */
  token: string;
}

export function readLogCheckConfig(): LogCheckConfig {
  return {
    frontendUrl: (process.env.PAT_FRONTEND_URL ?? DEFAULT_FRONTEND).replace(/\/$/, ''),
    token: process.env.PAT_VIEWER_TOKEN ?? '',
  };
}

/** Fetch the structured-log JSONL slice since `sinceMs` (ms epoch). */
export async function fetchLogs(cfg: LogCheckConfig, sinceMs: number, kindFilter?: string): Promise<LogEvent[]> {
  const url = new URL('/api/logs.jsonl', cfg.frontendUrl);
  url.searchParams.set('token', cfg.token);
  url.searchParams.set('since', String(sinceMs));
  if (kindFilter) url.searchParams.set('kind', kindFilter);
  const res = await fetch(url.toString(), { headers: { accept: 'application/x-ndjson' } });
  if (!res.ok) throw new Error(`/api/logs.jsonl → ${res.status}`);
  const body = await res.text();
  const out: LogEvent[] = [];
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const p = JSON.parse(t) as LogEvent;
      if (p.kind) out.push(p);
    } catch {
      /* skip unparseable */
    }
  }
  return out;
}

/** Poll the log proxy until `predicate` matches, or timeout → null. */
export async function awaitLogEvent(
  cfg: LogCheckConfig,
  opts: { sinceMs: number; predicate: (e: LogEvent) => boolean; timeoutMs: number; pollMs?: number; kindFilter?: string },
): Promise<LogEvent | null> {
  const deadline = Date.now() + opts.timeoutMs;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  for (;;) {
    try {
      const events = await fetchLogs(cfg, opts.sinceMs, opts.kindFilter);
      const hit = events.find(opts.predicate);
      if (hit) return hit;
    } catch {
      /* transient; retry until deadline */
    }
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * Build a `check`-step `fn` that waits for a matching structured-log event.
 * The window floor is the scenario's most-recent turn (ctx.lastTurnAt),
 * backdated 5s for clock skew, so it only matches events caused by THIS turn.
 */
export function logEventCheck(opts: {
  predicate: (e: LogEvent) => boolean;
  timeoutMs: number;
  /** Human description for the failure message. */
  describe: string;
  /** Optional server-side kind filter to shrink the payload. */
  kindFilter?: string;
}): (ctx: ScenarioContext) => Promise<{ ok: boolean; details?: string }> {
  return async (ctx: ScenarioContext) => {
    const cfg = readLogCheckConfig();
    if (!cfg.token) {
      return { ok: true, details: `SKIPPED (no PAT_VIEWER_TOKEN): ${opts.describe}` };
    }
    const sinceMs = (ctx.lastTurnAt?.ms ?? Date.now()) - 5_000;
    const ev = await awaitLogEvent(cfg, {
      sinceMs,
      predicate: opts.predicate,
      timeoutMs: opts.timeoutMs,
      kindFilter: opts.kindFilter,
    });
    return ev
      ? { ok: true, details: `matched ${ev.kind}: ${JSON.stringify(ev.data ?? {}).slice(0, 140)}` }
      : { ok: false, details: `no event within ${opts.timeoutMs}ms — ${opts.describe}` };
  };
}
