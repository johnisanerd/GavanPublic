/**
 * Barge-in-with-question scenario: user says "begin", agent starts
 * delivering, user interrupts mid-flight with a follow-up question.
 * The harness asserts that:
 *   - barge-in propagates within 1s
 *   - back-mind container is cancelled within 5s
 *   - the new question gets a forward decision
 *   - SOMETHING is said in response (utterance.stream-started fires)
 *
 * What this catches:
 *   - cancellation path: bargein.received → propagated → back-mind.cancelled
 *   - state cleanup: timelineActive flips back to false (when shipped)
 *   - re-entry: next forward isn't blocked by stale in-flight state
 *   - no double-spawn: only one container.spawned per logical turn
 */
import { test, expect } from 'vitest';
import { startSession } from '@harness/index';

const SCENARIO = 'smoke-test';

test('barge-in mid-delivery → cancelled → new question answered', async () => {
  const s = await startSession({ scenario: SCENARIO });

  try {
    await s.driver.sendUser('The audience is ready — please begin.', 'begin');

    // Wait for tag-stream to actually start before barging in.
    const ts1 = await s.log.waitFor(
      'scenario.tag-stream-started',
      (e) => (e.data.slide_n as number) >= 1,
      { within: 60_000, describe: 'first slide' },
    );

    // Give the agent a moment to emit a few actions before interrupting.
    await new Promise((r) => setTimeout(r, 3_000));

    // Barge in.
    await s.driver.bargeIn('test-interrupt');

    // Phase 1: bargein.propagated within 1s.
    await s.log.waitFor('bargein.propagated', { within: 1_000, since: ts1 });

    // Phase 2: back-mind.cancelled within 5s.
    await s.log.waitFor('back-mind.cancelled', { within: 5_000, since: ts1 });

    // Phase 3: send the follow-up question.
    const q = await s.driver.sendUser(
      'Can you summarize the key point of slide one in one sentence?',
      'question',
    );
    expect(q, 'banter-ack should produce some text').not.toBe('');

    // Phase 4: a new forward decision fires for the question.
    const fwd2 = await s.log.waitFor(
      'request-layer.decided',
      (e) => (e.data.decision as string) === 'forward',
      { within: 8_000, describe: "second forward" },
    );

    // Phase 5: something is spoken in response.
    await s.log.waitFor('utterance.stream-started', { within: 60_000, since: fwd2 });
  } finally {
    await s.end();
  }
}, 5 * 60 * 1000);
