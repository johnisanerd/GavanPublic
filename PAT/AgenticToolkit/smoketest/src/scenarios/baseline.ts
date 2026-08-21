import type { Scenario } from './index.js';

/**
 * Baseline — single Q, expect ack-then-chat, judge that the chat answered.
 *
 * Smallest possible smoke. If this fails, nothing else will pass.
 */
export const baseline: Scenario = {
  name: 'baseline',
  description: 'single straightforward question; expect ack within 5s, chat within 90s, on-topic answer.',
  steps: [
    { kind: 'turn', text: 'whats two plus two' },
    { kind: 'wait-utterance', within: 8000, label: 'front-mind ack' },
    { kind: 'wait-chat', within: 90000, label: 'back-mind reply' },
    {
      kind: 'judge',
      label: 'answered the math question',
      rubric:
        'Did the agent\'s back-mind reply contain a clear answer of "four" (or "4") to the question "what is two plus two"? Front-mind fillers do not count — the answer must be in an AGENT-CHAT entry.',
    },
  ],
  acceptanceMs: 120000,
};
