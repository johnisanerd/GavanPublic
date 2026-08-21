/**
 * Identity minting for harness sessions. Mirrors the convention used
 * by `nanoclaw/scripts/e2e-anam-scenario.mjs` and by the anam-web
 * channel adapter — keep these in sync.
 *
 *   PLATFORM_ID = `anam-web:scenario-<slug>`           (per-scenario, stable)
 *   SESSION_ID  = `e2e-<ms>-<rand>`                    (per-test, fresh)
 *   THREAD_ID   = `anam-web-call-<SESSION_ID>`         (per-test, derived)
 *
 * A fresh SESSION_ID per test means a fresh per-thread cursor, fresh
 * timelineActiveByThread state, and a fresh container session — no
 * cross-test contamination.
 */
import { randomUUID } from 'node:crypto';

export interface Identity {
  platformId: string;
  sessionId: string;
  threadId: string;
  scenarioSlug: string;
}

export function mintIdentity(scenarioSlug: string): Identity {
  const sessionId = `e2e-${Date.now()}-${randomUUID().slice(0, 8)}`;
  return {
    platformId: `anam-web:scenario-${scenarioSlug}`,
    sessionId,
    threadId: `anam-web-call-${sessionId}`,
    scenarioSlug,
  };
}
