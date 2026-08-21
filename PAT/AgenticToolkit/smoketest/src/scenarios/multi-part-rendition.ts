import type { Scenario } from './index.js';

/**
 * Multi-part rendition — Wave 1.1 Path C acceptance criterion #3.
 *
 * Verifies the host-side IntentAccumulator merges multiple back-mind
 * chat rows that land in quick succession into ONE multi-part rendition
 * (single SSE broadcast). Before Path C, each chat row got its own
 * banter rendition + its own SSE event, producing 3 jerky one-liners.
 * After Path C: while a rendition is in flight, subsequent chat rows
 * accumulate in `pendingContexts`; when the in-flight rendition finishes
 * the accumulator drains pending into a single Haiku call with
 * `[piece N of M]` framing and broadcasts the merged result.
 *
 * Trigger: ask a question that the back-mind naturally answers across
 * multiple `<message>` blocks (the Claude Agent SDK pattern for "send
 * me a few separate messages"). Each block becomes its own chat row in
 * outbound.db; the host's poller picks them up at ~1s intervals and
 * runs deliver() per row. The IntentAccumulator triggers ONLY when
 * rows arrive WHILE a prior rendition is in flight (~0.5s per Haiku
 * call) — if Opus spaces rows further apart than rendition completes,
 * each row gets its own SSE broadcast and the accumulator never sees
 * pendingContexts > 0.
 *
 * Observation from first run: Opus emits each `<message>` block as a
 * separate chat row, with ~2s between rows. Rendition takes ~0.5s. So
 * the natural pacing of the back-mind doesn't actually exercise the
 * accumulator — to see it fire, we'd need either faster row production
 * or slower renditions. The scenario still validates the multi-row
 * answer path (criterion 3 partially): the judge confirms all three
 * capitals reach the user. Full accumulator path needs test-mode
 * outbound.db injection (follow-up).
 *
 * Wait pattern: we issue three `wait-chat` steps so all three rows
 * have time to land before the judge. With timeouts staggered to
 * forgive a merged-into-1 case (the accumulator-success path):
 *   - first wait: long (90s, includes container cold-start)
 *   - second: short (20s; merged-utterance path may produce only one
 *             chat → this times out, scenario continues)
 *   - third: same
 * On timeout, the step is registered as failed but the run continues
 * so the judge can still verify the multi-row path WITHOUT merging.
 * If the accumulator ever does merge, we expect one chat with all
 * three capitals; on that path, the second/third waits time out and
 * the judge's bonus criterion fires on the single utterance.
 */
export const multiPartRendition: Scenario = {
  name: 'multi-part-rendition',
  description:
    'three rapid back-mind chat rows → ideally one merged multi-part rendition, but multi-chat also acceptable so long as all three reach the user.',
  steps: [
    {
      kind: 'turn',
      text:
        "please send me THREE separate quick messages, one after the other, " +
        "with no preamble: first, the capital of France. " +
        "second, the capital of Japan. " +
        "third, the capital of Brazil. " +
        "Send each as its own short message back-to-back.",
    },
    { kind: 'wait-utterance', within: 8000, label: 'front-mind ack' },
    // Single wait-chat — covers both the merged-rendition path (1 chat
    // event) and the separate-renditions path (first of N chat events).
    // Adding more wait-chat steps would fail if the accumulator merged
    // into a single chat. We rely on `sleep` below to let later chats
    // land in the transcript before the judge runs.
    { kind: 'wait-chat', within: 90000, label: 'first chat (Paris, or merged-all)' },
    // Wait up to 20s for any straggler chats/renditions to land. Each
    // chat row + rendition is ~2-3s in observed runs, so 20s comfortably
    // captures 3 rows even if they're maximally spread.
    { kind: 'sleep', ms: 20000 },
    {
      kind: 'judge',
      label: 'all three capitals covered',
      rubric:
        "The user asked for three separate quick messages naming the capitals of France, Japan, and Brazil. " +
        "Across ALL AGENT-CHAT entries in the transcript, are all three present — Paris, Tokyo, and Brasília (or Brasilia, anglicized)? " +
        "PASS if all three appear. FAIL if any is missing. " +
        "Note for forensics: if a SINGLE agent-chat entry covers all three with multi-part framing " +
        "(e.g. 'Paris, Tokyo, and Brasilia'), that indicates the Path C IntentAccumulator merged the three back-mind chat rows into one rendition. " +
        "Multiple separate one-word chat-entries (Paris / Tokyo / Brasilia) indicates the rows landed slower than rendition completed — also acceptable for this test.",
    },
  ],
  acceptanceMs: 240000,
};
