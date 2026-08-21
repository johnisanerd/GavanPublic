/**
 * PAT: credential watcher — the "watch" half of the request → watch →
 * activate flow. A single self-rescheduling setTimeout loop (the same shape
 * as host-sweep / signal-health — never setInterval, so ticks can't overlap)
 * that polls the SOURCE-FREE credential existence check (seam 2: one local
 * gateway listSecrets() per tick, never the credential's own service) against
 * the pending_mcp_activations table and activates parked MCPs the moment
 * their credential exists.
 *
 * Cadence is self-adjusting:
 *   - any row inside its fast window (5 min from enqueue) → 4s ticks
 *   - only stale rows / no rows → 60s ticks (a no-row tick is one SQL count,
 *     no vault call — an idle watcher costs nothing)
 * A row crossing its fast deadline gets ONE "still waiting" notice
 * (notified_slow) and keeps being checked at idle cadence forever — a
 * credential added days later still activates. kickCredentialWatcher()
 * (called on enqueue) forces an immediate tick so the "operator already added
 * the key before approving" case activates instantly.
 *
 * Boot rehydration is free: the loop reads the table each tick, so rows
 * enqueued before a host restart (e.g. the flyctl-secret path, where setting
 * AGENT_<X> restarts the machine → boot reconcile creates the vault entry)
 * are picked up on the first tick after startup.
 */
import { listPendingMcpActivations, markPendingMcpActivationSlow } from '../../db/pending-mcp-activations.js';
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { notifyAgent } from '../approvals/index.js';
import { activatePendingMcp } from './activation.js';
import { hostHasCredential } from './sources.js';
import { listSecrets, vaultConfigured } from './onecli-vault.js';

const FAST_POLL_MS = 4_000;
const IDLE_POLL_MS = 60_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = true;
// Re-entrancy guard: a kickCredentialWatcher() landing mid-tick could
// otherwise fire a second tick concurrently with the awaited first one and
// double-activate a row (two kill/respawn cycles). Overlapping ticks skip.
let ticking = false;

async function tick(): Promise<void> {
  const rows = listPendingMcpActivations();
  if (rows.length === 0 || !vaultConfigured()) return;

  let secrets;
  try {
    secrets = await listSecrets(); // one local gateway read for ALL rows
  } catch (err) {
    log.debug('Credential watcher: vault unreachable this tick', { err });
    return;
  }

  const now = Date.now();
  for (const row of rows) {
    try {
      if (hostHasCredential(row.host_pattern, secrets)) {
        await activatePendingMcp(row);
        continue;
      }
      if (!row.notified_slow && now > Date.parse(row.fast_deadline)) {
        markPendingMcpActivationSlow(row.agent_group_id, row.name);
        log.event({
          kind: 'mcp.activation-slow',
          session_id: row.session_id,
          data: {
            name: row.name,
            host_pattern: row.host_pattern,
            secret_name: row.secret_name,
            agent_group_id: row.agent_group_id,
            waited_ms: now - Date.parse(row.created_at),
          },
        });
        const session = getSession(row.session_id);
        if (session) {
          notifyAgent(
            session,
            `MCP server "${row.name}" is still waiting for its credential` +
              (row.secret_name ? ` (\`AGENT_${row.secret_name}\`)` : '') +
              `. I'll keep checking about once a minute and activate it automatically when the credential is added.`,
          );
        }
      }
    } catch (err) {
      // One bad row must not block the others.
      log.error('Credential watcher: row failed', { name: row.name, agentGroupId: row.agent_group_id, err });
    }
  }
}

function nextDelayMs(): number {
  const rows = listPendingMcpActivations();
  if (rows.length === 0) return IDLE_POLL_MS;
  const now = Date.now();
  return rows.some((r) => now < Date.parse(r.fast_deadline)) ? FAST_POLL_MS : IDLE_POLL_MS;
}

function scheduleNext(delayMs: number): void {
  if (stopped) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    void (async () => {
      if (ticking) {
        scheduleNext(FAST_POLL_MS);
        return;
      }
      ticking = true;
      try {
        await tick();
      } catch (err) {
        log.error('Credential watcher: tick threw', { err });
      } finally {
        ticking = false;
      }
      scheduleNext(nextDelayMs());
    })();
  }, delayMs);
}

/** Start the watcher loop. Called once from src/index.ts after the container
 *  runtime is up (activation may spawn containers). Idempotent. */
export function startCredentialWatcher(): void {
  if (!stopped) return;
  stopped = false;
  scheduleNext(nextDelayMs());
  log.info('Credential watcher started');
}

export function stopCredentialWatcher(): void {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/** Force an immediate tick (called right after an enqueue so the
 *  already-present-credential case activates without waiting a cycle). */
export function kickCredentialWatcher(): void {
  if (stopped) return;
  scheduleNext(0);
}
