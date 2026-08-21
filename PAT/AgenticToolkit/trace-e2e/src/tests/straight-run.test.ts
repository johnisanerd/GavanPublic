/**
 * Straight-run scenario: user says "begin", agent delivers all slides,
 * cursor reaches the final slide, no errors.
 *
 * Uses the `smoke-test` packet (2 slides) so the test stays under 90s.
 * For full Palisade-deck coverage, see `straight-run-palisade.test.ts`
 * (slower, ~3-5 minutes — gated behind PAT_RUN_LONG=1).
 *
 * What this catches:
 *   - request-layer decides 'forward' on "begin" (scenario context wired)
 *   - container spawns successfully (OneCLI cert + API auth healthy)
 *   - back-mind emits scenario-mode chat rows
 *   - tag-stream parser fires actions in order
 *   - cursor progression touches every slide
 *   - utterance.stream events fire (TTS broadcast wired)
 *   - no error.surfaced events fire mid-run
 */
import { test, expect } from 'vitest';
import { startSession } from '@harness/index';

const SCENARIO = 'smoke-test';
const EXPECTED_FINAL_SLIDE = 2;

test('straight-run: begin → tag-stream → final slide reached', async () => {
  const s = await startSession({ scenario: SCENARIO });

  try {
    await s.driver.sendUser('The audience is ready — please begin.', 'begin');

    // Phase 1: request-layer forwards within 8s. (banter-ack runs first
    // and is non-deterministic — we leave room for one retry's worth.)
    const fwd = await s.log.waitFor(
      'request-layer.decided',
      (e) => (e.data.decision as string) === 'forward',
      { within: 8_000, describe: "decision='forward'" },
    );

    // Phase 2: back-mind starts processing within 20s of forward. We
    // assert on query-start (fires per turn) rather than container.spawned
    // (fires only on cold spawn) so the test is robust to container
    // reuse from a previous test in the same run.
    await s.log.waitFor(
      'detail.row-received',
      (e) => (e.data.type as string) === 'query-start',
      { within: 20_000, since: fwd, describe: "type='query-start'" },
    );

    // Phase 3: first tag-stream begins for slide 1 within 60s.
    const ts1 = await s.log.waitFor(
      'scenario.tag-stream-started',
      (e) => (e.data.slide_n as number) === 1,
      { within: 60_000, since: fwd, describe: 'slide_n=1' },
    );

    // Phase 4: that tag-stream completes with at least one action.
    const ts1End = await s.log.waitFor(
      'scenario.tag-stream-ended',
      (e) => (e.data.slide_n as number) === 1,
      { within: 60_000, since: ts1, describe: 'slide_n=1' },
    );
    expect(ts1End.data.action_count as number).toBeGreaterThan(0);

    // Phase 5: at least one utterance.stream-started fired between
    // tag-stream open and close (proves the broadcast path is wired).
    expect(
      s.log.between(ts1, ts1End).count('utterance.stream-started'),
    ).toBeGreaterThan(0);

    // Phase 6: prompt the agent through remaining slides. Per SKILL.md,
    // the agent emits ONE timeline per turn then STOPS. We have to send
    // an inbound to prompt each subsequent slide.
    let lastEnd = ts1End;
    for (let n = 2; n <= EXPECTED_FINAL_SLIDE; n++) {
      await s.driver.sendUser('continue', `prompt-slide-${n}`);
      lastEnd = await s.log.waitFor(
        'scenario.tag-stream-ended',
        (e) => (e.data.slide_n as number) >= n,
        { within: 90_000, since: lastEnd, describe: `slide_n>=${n}` },
      );
    }

    // Phase 7: no error.surfaced events during the entire run.
    const errors = s.log.all('error.surfaced');
    expect(
      errors,
      `unexpected errors: ${errors.map((e) => JSON.stringify(e.data)).join('; ')}`,
    ).toHaveLength(0);
  } finally {
    await s.end();
  }
}, 5 * 60 * 1000);
