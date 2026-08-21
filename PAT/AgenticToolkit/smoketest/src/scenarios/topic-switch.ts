import type { Scenario } from './index.js';

/**
 * Topic-switch — user starts on topic A, gets a chat reply, then asks a
 * completely different topic B. Verify the agent doesn't bleed memory of A
 * into its B answer.
 *
 * Tier 1 narration tests cover the resetTurn-clears-events case in unit
 * scope. This is the integration check.
 */
export const topicSwitch: Scenario = {
  name: 'topic-switch',
  description: 'A → chat → B (unrelated) → chat. B\'s reply should not reference A.',
  steps: [
    { kind: 'turn', text: 'whats the capital of france' },
    { kind: 'wait-utterance', within: 8000 },
    { kind: 'wait-chat', within: 90000, label: 'chat for A' },
    { kind: 'sleep', ms: 1000 },
    { kind: 'turn', text: 'what color is the sky on a clear day' },
    { kind: 'wait-utterance', within: 8000 },
    { kind: 'wait-chat', within: 90000, label: 'chat for B' },
    {
      kind: 'judge',
      label: 'B did not bleed A\'s topic',
      rubric:
        'After answering "capital of France" (Paris), the user asked about sky color. Did the most recent AGENT-CHAT answer the sky-color question (blue) without referencing France, Paris, or capitals?',
    },
  ],
  acceptanceMs: 200000,
};
