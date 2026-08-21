import type { Scenario } from './index.js';

/**
 * Barge-in: new-task (additive).
 *
 * User asks A, then mid-think says "while you're at it, also do B" —
 * NOT a cancel, NOT a refinement of A, but an additional independent
 * task that should run in parallel with (or after) A. Expected
 * behaviour:
 *   - Agent addresses both A and B.
 *   - Neither is dropped.
 *
 * Today's known behaviour: B is appended to A's prompt as a follow-up;
 * agent may answer just A, just B, or both depending on prompt mood.
 */
export const bargeInNewTask: Scenario = {
  name: 'barge-in-new-task',
  description: 'A → "while you\'re at it, also B" → expect both A and B addressed.',
  steps: [
    { kind: 'turn', text: 'whats the capital of france' },
    { kind: 'wait-utterance', within: 8000, label: 'ack for A' },
    { kind: 'sleep', ms: 2000 },
    { kind: 'turn', text: "while you're at it, also tell me the largest country in south america" },
    { kind: 'wait-utterance', within: 8000, label: 'ack for B' },
    // The back-mind answers each question in its own chat row. Wait for both
    // before judging — otherwise judge fires after the first chat lands and
    // misses the second.
    { kind: 'wait-chat', within: 120000, label: 'first chat' },
    { kind: 'wait-chat', within: 120000, label: 'second chat (the other answer)' },
    {
      kind: 'judge',
      label: 'both A and B addressed',
      rubric:
        'The user asked two questions: (1) capital of France (Paris), (2) largest country in South America (Brazil). Look across ALL AGENT-CHAT entries in the transcript. Are BOTH answered? PASS only if both Paris/France-capital AND Brazil/largest-South-American-country appear. FAIL if either is missing or only one is answered.',
    },
  ],
  acceptanceMs: 180000,
};
