import type { Scenario } from './index.js';

/**
 * Barge-in: cancel.
 *
 * User asks A, then mid-think says "never mind, forget it" with NO
 * replacement directive. Expected behaviour:
 *   - Agent does NOT deliver the answer to A.
 *   - Agent acknowledges the cancellation in some way (Pat-voice).
 *
 * Today's known failure: A's reply lands as the chat response
 * regardless. Once cancel plumbing is in place, this passes.
 */
export const bargeInCancel: Scenario = {
  name: 'barge-in-cancel',
  description: 'A → "never mind, forget it" → expect ack of cancel, NO answer to A.',
  steps: [
    { kind: 'turn', text: 'tell me about the planet jupiter in some detail' },
    { kind: 'wait-utterance', within: 8000, label: 'ack for A' },
    { kind: 'sleep', ms: 2000 },
    { kind: 'turn', text: 'actually never mind, forget it' },
    { kind: 'wait-utterance', within: 8000, label: 'ack for cancel' },
    { kind: 'wait-chat', within: 90000, label: 'final chat (the cancel ack)' },
    {
      kind: 'judge',
      label: 'cancel was honored, no Jupiter answer',
      rubric:
        'The user asked about Jupiter, then immediately cancelled with "never mind, forget it". Did the agent\'s most recent AGENT-CHAT entry: (a) acknowledge the cancellation (e.g. "no problem", "okay, dropped it", "moving on") AND (b) NOT contain a substantive answer about Jupiter (no facts about gas giants, moons, Great Red Spot, composition, etc.)? PASS only if both are true.',
    },
  ],
  acceptanceMs: 150000,
};
