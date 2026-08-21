/**
 * PAT 2026-06-25: Signal health probe — host loop + admin alerting.
 *
 * The EXTERNAL observer for the Signal channel. Runs in the nanoclaw host
 * process (pat-nanoclaw), which is on a different Fly machine from the
 * signal-cli daemon (pat-transports) — so it can detect and report the
 * daemon's death, which an on-machine check structurally cannot.
 *
 * Catches the two failure modes that silently lapsed PAT's Signal account
 * once before (daemon down for ~a month, no alert):
 *   - daemon / machine DOWN          → reason 'daemon-unreachable'
 *   - account lapsed / unregistered  → reason 'account-unregistered'
 * (Receive-loop wedge is owned by the transports-side watchdog; see probe.ts.)
 *
 * On a degraded→healthy or healthy→degraded transition it DMs admins (resolved
 * via the same `pickApprover` ladder the approvals module uses: scoped admins →
 * global admins → owners) and emits `signal.health-ok` / `signal.health-degraded`
 * structured events for the dashboard. Alerting is state-change-deduped (see
 * state.ts) so a sustained outage pages once, not every tick.
 *
 * Lifecycle: started from src/index.ts after the delivery adapter is set; the
 * loop is a single self-rescheduling timer (like host-sweep). Disabled cleanly
 * when SIGNAL_ACCOUNT is unset (no Signal channel) or SIGNAL_HEALTH=false.
 *
 * Env (all optional except SIGNAL_ACCOUNT, which also gates the channel):
 *   SIGNAL_ACCOUNT             E164 of the linked identity (required)
 *   SIGNAL_TCP_HOST            daemon host (default 127.0.0.1; PAT prod sets
 *                              signal.process.pat-transports.internal)
 *   SIGNAL_TCP_PORT            daemon port (default 7583)
 *   SIGNAL_HEALTH              'false' to disable (default: enabled)
 *   SIGNAL_HEALTH_INTERVAL_MS  ms between probes (default 86400000 = daily)
 *   SIGNAL_HEALTH_GRACE_MS     ms after boot before first probe
 *                              (default 60000 — let adapters settle)
 *   SIGNAL_HEALTH_ALERT_THRESHOLD consecutive degraded probes before paging
 *                              (default 2 — absorbs a single restart blip)
 *   SIGNAL_HEALTH_ALERT_USER_ID  override the alert recipient (a `<channel>:
 *                              <handle>` user id). Default: pickApprover ladder.
 */
import { getDeliveryAdapter } from '../../delivery.js';
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import { pickApprover } from '../approvals/primitive.js';
import { ensureUserDm } from '../permissions/user-dm.js';

import { probeSignalHealth, type ProbeConfig } from './probe.js';
import { foldProbeOutcome, initialHealthState, type HealthState } from './state.js';

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const DEFAULT_GRACE_MS = 60_000;
const DEFAULT_ALERT_THRESHOLD = 2;

interface LoopConfig extends ProbeConfig {
  intervalMs: number;
  graceMs: number;
  alertThreshold: number;
  alertUserId: string | null;
}

let state: HealthState = initialHealthState();
let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

function resolveConfig(): LoopConfig | null {
  const env = readEnvFile([
    'SIGNAL_ACCOUNT',
    'SIGNAL_TCP_HOST',
    'SIGNAL_TCP_PORT',
    'SIGNAL_HEALTH',
    'SIGNAL_HEALTH_INTERVAL_MS',
    'SIGNAL_HEALTH_GRACE_MS',
    'SIGNAL_HEALTH_ALERT_THRESHOLD',
    'SIGNAL_HEALTH_ALERT_USER_ID',
  ]);
  const get = (k: string): string => process.env[k] || env[k] || '';

  const account = get('SIGNAL_ACCOUNT');
  if (!account) return null; // no Signal channel — nothing to watch
  if ((get('SIGNAL_HEALTH') || 'true') === 'false') return null;

  const host = get('SIGNAL_TCP_HOST') || '127.0.0.1';
  const port = parseInt(get('SIGNAL_TCP_PORT') || '7583', 10);
  const intervalMs = parseInt(get('SIGNAL_HEALTH_INTERVAL_MS') || String(DEFAULT_INTERVAL_MS), 10);
  const graceMs = parseInt(get('SIGNAL_HEALTH_GRACE_MS') || String(DEFAULT_GRACE_MS), 10);
  const alertThreshold = parseInt(get('SIGNAL_HEALTH_ALERT_THRESHOLD') || String(DEFAULT_ALERT_THRESHOLD), 10);
  const alertUserId = get('SIGNAL_HEALTH_ALERT_USER_ID') || null;

  return { account, host, port, intervalMs, graceMs, alertThreshold, alertUserId };
}

/** Deliver a plain-text alert to admins. Best-effort: a delivery failure is
 *  logged but never throws (we don't want the probe loop to die on it). */
async function deliverAlert(text: string, alertUserId: string | null): Promise<void> {
  const adapter = getDeliveryAdapter();
  if (!adapter) {
    log.warn('Signal health: no delivery adapter; cannot alert admins', { text });
    return;
  }

  // Resolve recipients: explicit override, else the approver ladder (scoped
  // admins → global admins → owners). agentGroupId=null → global scope.
  const candidates = alertUserId ? [alertUserId] : pickApprover(null);
  if (candidates.length === 0) {
    log.warn('Signal health: no admin/owner configured to alert', { text });
    return;
  }

  for (const userId of candidates) {
    // PAT: deliberately do NOT alert over Signal — if Signal is degraded, a
    // Signal-channel alert would never arrive. ensureUserDm resolves whatever
    // DM channel the admin has (Slack/Telegram). Skip Signal-only admins.
    try {
      const mg = await ensureUserDm(userId);
      if (!mg) continue;
      if (mg.channel_type === 'signal') {
        log.debug('Signal health: skipping signal-channel admin for signal alert', { userId });
        continue;
      }
      await adapter.deliver(mg.channel_type, mg.platform_id, null, 'chat', text);
      log.info('Signal health: alert delivered', { userId, channel: mg.channel_type });
      return; // one successful delivery is enough
    } catch (err) {
      log.warn('Signal health: alert delivery failed for candidate', { userId, err });
    }
  }
  log.warn('Signal health: could not deliver alert to any admin', { text });
}

async function tick(cfg: LoopConfig): Promise<void> {
  const outcome = await probeSignalHealth(cfg);
  const decision = foldProbeOutcome(state, outcome, cfg.alertThreshold);
  state = decision.next;

  if (decision.emitOk) {
    log.event({
      kind: 'signal.health-ok',
      data: {
        account: cfg.account,
        probe_ms: outcome.healthy ? outcome.probeMs : 0,
        ...(decision.recovered ? { recovered: true } : {}),
      },
    });
  }

  if (decision.emitDegraded && decision.degraded) {
    log.event({
      kind: 'signal.health-degraded',
      level: 'error',
      data: {
        account: cfg.account,
        reason: decision.degraded.reason,
        detail: decision.degraded.detail,
        consecutive: decision.degraded.consecutive,
        ...(decision.alert === 'degraded' ? { alerted: true } : {}),
      },
    });
  }

  if (decision.alert === 'degraded' && decision.degraded) {
    const { reason, detail, consecutive } = decision.degraded;
    await deliverAlert(
      `🔴 *Signal channel DEGRADED* — account ${cfg.account}\n` +
        `reason: \`${reason}\`\n` +
        `detail: ${detail}\n` +
        `(${consecutive} consecutive failed probe${consecutive === 1 ? '' : 's'}; probing ${cfg.host}:${cfg.port})`,
      cfg.alertUserId,
    );
  } else if (decision.alert === 'recovered') {
    await deliverAlert(
      `🟢 *Signal channel RECOVERED* — account ${cfg.account} is reachable and registered again.`,
      cfg.alertUserId,
    );
  }
}

function scheduleNext(cfg: LoopConfig, delayMs: number): void {
  if (stopped) return;
  timer = setTimeout(() => {
    void (async () => {
      try {
        await tick(cfg);
      } catch (err) {
        // tick() shouldn't throw (probe never throws), but guard the loop.
        log.error('Signal health: probe tick threw', { err });
      }
      scheduleNext(cfg, cfg.intervalMs);
    })();
  }, delayMs);
}

/** Start the periodic Signal health probe. No-op if no Signal channel /
 *  disabled. Called once from src/index.ts after the delivery adapter is set. */
export function startSignalHealthProbe(): void {
  if (timer) return; // already running
  stopped = false;
  const cfg = resolveConfig();
  if (!cfg) {
    log.debug('Signal health probe disabled (no SIGNAL_ACCOUNT or SIGNAL_HEALTH=false)');
    return;
  }
  state = initialHealthState();
  log.info('Signal health probe started', {
    account: cfg.account,
    host: cfg.host,
    port: cfg.port,
    intervalMs: cfg.intervalMs,
    alertThreshold: cfg.alertThreshold,
  });
  scheduleNext(cfg, cfg.graceMs);
}

export function stopSignalHealthProbe(): void {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

// PAT: test seam — drive a single fold without the timer/I/O. Used by
// state.test.ts callers that want to assert the module wiring; the pure
// machine lives in state.ts.
export { foldProbeOutcome, initialHealthState } from './state.js';
