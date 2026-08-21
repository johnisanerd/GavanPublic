import type { Scenario } from './index.js';

/**
 * Barge-in — user speaks again before the back-mind reply lands.
 *
 * The well-known concurrent-turn risk: turn A's late chat could pollute
 * turn B's context. The fix in NarrationBrain.resetTurn() is unit-tested,
 * but this scenario verifies the channel adapter side handles it cleanly.
 */
export const bargeIn: Scenario = {
  name: 'barge-in',
  description:
    'user asks A → expect ack → user asks B before A\'s chat → expect ack for B → expect chat for B that doesn\'t conflate A.',
  steps: [
    { kind: 'turn', text: 'whats the capital of mongolia' },
    { kind: 'wait-utterance', within: 8000, label: 'ack for turn A' },
    // Don't wait for chat — barge in.
    { kind: 'sleep', ms: 1500 },
    { kind: 'turn', text: 'actually never mind, whats two plus two' },
    { kind: 'wait-utterance', within: 8000, label: 'ack for turn B' },
    { kind: 'wait-chat', within: 90000, label: 'chat for turn B' },
    {
      kind: 'judge',
      label: 'turn B addressed without conflating turn A',
      rubric:
        'The user asked about Mongolia\'s capital, then pivoted to "what is two plus two". Did the agent\'s most recent AGENT-CHAT contain a clear answer to the math question (four / 4) WITHOUT mixing in or referencing Mongolia / Ulaanbaatar / capitals? It is fine if the agent acknowledges the pivot ("ok switching gears") — what matters is the answer is "four" and not a Mongolia reference.',
    },
  ],
  acceptanceMs: 150000,
};
