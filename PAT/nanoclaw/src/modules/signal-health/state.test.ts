/**
 * PAT 2026-06-25: Signal health state-machine tests.
 *
 * The dedup + alert-threshold logic is the whole point of the module (page on
 * state CHANGE, not every tick), so it's the part worth pinning. I/O lives in
 * probe.ts and is exercised by the staging degraded-daemon simulation.
 */
import { describe, expect, it } from 'vitest';

import { foldProbeOutcome, initialHealthState, type HealthState, type ProbeOutcome } from './state.js';

const ok = (probeMs = 5): ProbeOutcome => ({ healthy: true, probeMs });
const down = (detail = 'refused'): ProbeOutcome => ({
  healthy: false,
  reason: 'daemon-unreachable',
  detail,
});
const lapsed = (): ProbeOutcome => ({
  healthy: false,
  reason: 'account-unregistered',
  detail: 'not in listAccounts',
});

/** Drive a sequence of outcomes through the fold; return the per-tick decisions. */
function run(outcomes: ProbeOutcome[], threshold: number) {
  let state: HealthState = initialHealthState();
  return outcomes.map((o) => {
    const d = foldProbeOutcome(state, o, threshold);
    state = d.next;
    return d;
  });
}

describe('foldProbeOutcome', () => {
  it('first healthy tick emits health-ok, no alert', () => {
    const [d] = run([ok()], 2);
    expect(d.emitOk).toBe(true);
    expect(d.recovered).toBe(false);
    expect(d.alert).toBeNull();
    expect(d.next.healthy).toBe(true);
  });

  it('does not alert on a single degraded tick when threshold=2', () => {
    const [d] = run([down()], 2);
    expect(d.emitDegraded).toBe(true);
    expect(d.alert).toBeNull(); // below threshold — watching, not paging
    expect(d.next.consecutive).toBe(1);
    expect(d.next.alerted).toBe(false);
  });

  it('alerts exactly once on the tick the streak reaches threshold', () => {
    const ds = run([down(), down(), down(), down()], 2);
    expect(ds.map((d) => d.alert)).toEqual([null, 'degraded', null, null]);
    expect(ds[3].next.consecutive).toBe(4);
    expect(ds[3].next.alerted).toBe(true); // stays alerted through the streak
  });

  it('threshold=1 pages on the first degraded tick', () => {
    const [d] = run([down()], 1);
    expect(d.alert).toBe('degraded');
  });

  it('recovers + alerts recovery after a paged outage', () => {
    const ds = run([down(), down(), ok()], 2); // page on tick 2, recover on tick 3
    expect(ds[1].alert).toBe('degraded');
    const rec = ds[2];
    expect(rec.emitOk).toBe(true);
    expect(rec.recovered).toBe(true);
    expect(rec.alert).toBe('recovered');
    expect(rec.next.healthy).toBe(true);
    expect(rec.next.consecutive).toBe(0);
  });

  it('does NOT announce recovery from a blip nobody was paged for', () => {
    // One degraded tick (below threshold) then healthy — no page, so no
    // recovery announcement, but health-ok still emits with recovered=true.
    const ds = run([down(), ok()], 2);
    expect(ds[0].alert).toBeNull();
    const rec = ds[1];
    expect(rec.emitOk).toBe(true);
    expect(rec.recovered).toBe(true); // dashboard still sees the bounce
    expect(rec.alert).toBeNull(); // but no admin DM for a blip
  });

  it('a new failure reason mid-streak restarts the streak and re-evaluates', () => {
    // daemon-unreachable reaches threshold + pages, then the reason switches
    // to account-unregistered: the new reason restarts consecutive=1 and can
    // page again once it crosses the threshold.
    const ds = run([down(), down(), lapsed(), lapsed()], 2);
    expect(ds[1].alert).toBe('degraded'); // daemon-unreachable paged
    expect(ds[2].next.reason).toBe('account-unregistered');
    expect(ds[2].next.consecutive).toBe(1); // streak restarted on new reason
    expect(ds[2].alert).toBeNull();
    expect(ds[3].alert).toBe('degraded'); // new reason crosses threshold → pages
  });

  it('sustained outage pages once, not every tick (dedup)', () => {
    const ds = run(
      Array.from({ length: 10 }, () => down()),
      3,
    );
    const pages = ds.filter((d) => d.alert === 'degraded').length;
    expect(pages).toBe(1);
  });
});
