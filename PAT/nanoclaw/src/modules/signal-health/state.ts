/**
 * PAT 2026-06-25: Signal health probe — pure state machine.
 *
 * Separated from the I/O (probe.ts) and the host loop (index.ts) so the
 * dedup + alert-threshold logic is unit-testable without a live daemon.
 *
 * The probe runs on nanoclaw — the only observer EXTERNAL to the signal-cli
 * daemon machine (pat-transports), which is the load-bearing requirement: a
 * health check that runs ON the daemon box can't report the box's own death.
 *
 * Motivation: PAT's Signal account (+15550100003) once lapsed after ~a month,
 * almost certainly because the daemon was DOWN that whole month with no
 * keep-alive and no alerting — the failure was completely silent. This state
 * machine turns each raw probe outcome into an ALERT decision, deduped so we
 * page admins on state CHANGE (healthy→degraded and recovery), not every tick.
 */

/** Raw outcome of one probe tick (computed by probe.ts from RPC results). */
export type ProbeOutcome =
  | { healthy: true; probeMs: number }
  | {
      healthy: false;
      reason: 'daemon-unreachable' | 'account-unregistered' | 'receive-wedged' | 'probe-error';
      detail: string;
    };

/** Persistent health state carried across ticks. */
export interface HealthState {
  /** Current health as of the last tick. null = no tick yet (boot). */
  healthy: boolean | null;
  /** The reason of the current degraded streak (null when healthy). */
  reason: string | null;
  /** Consecutive ticks in the current degraded streak (0 when healthy). A
   *  fresh reason resets this to 1 so a *different* failure mode re-alerts. */
  consecutive: number;
  /** Whether an alert has already been dispatched for the current degraded
   *  streak. Gates re-paging on every tick of a sustained outage. */
  alerted: boolean;
}

export function initialHealthState(): HealthState {
  return { healthy: null, reason: null, consecutive: 0, alerted: false };
}

/** What the host loop should do after folding a probe outcome into state. */
export interface HealthDecision {
  /** Next state to persist. */
  next: HealthState;
  /** Emit a `signal.health-ok` event this tick. */
  emitOk: boolean;
  /** True when emitOk and the prior state was degraded (recovery). */
  recovered: boolean;
  /** Emit a `signal.health-degraded` event this tick (every degraded tick,
   *  for the dashboard's continuous signal). */
  emitDegraded: boolean;
  /** DM admins this tick — only on the threshold crossing or a recovery. */
  alert: 'degraded' | 'recovered' | null;
  /** The degraded reason/detail/consecutive carried for event + alert text. */
  degraded?: { reason: string; detail: string; consecutive: number };
}

/**
 * Fold one probe outcome into the health state.
 *
 * Alert policy (state-change dedup):
 *   - Healthy tick after a degraded streak → emit health-ok{recovered:true}
 *     AND alert 'recovered' (but only if we'd actually alerted on the way
 *     down — no point announcing recovery from a blip nobody was paged for).
 *   - Degraded tick: increment the streak. Alert 'degraded' exactly once,
 *     on the tick where `consecutive` first reaches `alertThreshold`. A
 *     different reason mid-streak resets the streak (consecutive=1, alerted
 *     cleared) so a new failure mode gets its own evaluation.
 *
 * @param alertThreshold consecutive degraded ticks before paging (≥1). A
 *   value >1 absorbs the transient blip while a daemon restarts.
 */
export function foldProbeOutcome(prev: HealthState, outcome: ProbeOutcome, alertThreshold: number): HealthDecision {
  const threshold = Math.max(1, alertThreshold);

  if (outcome.healthy) {
    const wasDegraded = prev.healthy === false;
    const recovered = wasDegraded;
    // Only announce recovery if the down-streak had actually paged someone.
    const alert: HealthDecision['alert'] = wasDegraded && prev.alerted ? 'recovered' : null;
    return {
      next: { healthy: true, reason: null, consecutive: 0, alerted: false },
      emitOk: true,
      recovered,
      emitDegraded: false,
      alert,
    };
  }

  // Degraded. Same reason continues the streak; a new reason restarts it.
  const sameReason = prev.healthy === false && prev.reason === outcome.reason;
  const consecutive = sameReason ? prev.consecutive + 1 : 1;
  const alreadyAlerted = sameReason ? prev.alerted : false;

  // Page exactly on the tick the streak first reaches the threshold.
  const crossing = !alreadyAlerted && consecutive >= threshold;
  const alerted = alreadyAlerted || crossing;

  return {
    next: { healthy: false, reason: outcome.reason, consecutive, alerted },
    emitOk: false,
    recovered: false,
    emitDegraded: true,
    alert: crossing ? 'degraded' : null,
    degraded: { reason: outcome.reason, detail: outcome.detail, consecutive },
  };
}
