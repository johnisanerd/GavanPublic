import type { Scenario } from './index.js';

/**
 * Ambiguity — vague user request. The simulated user clarifies on follow-up.
 * Verify the agent actually answers the clarified question (not the vague
 * version) and didn't lock in early.
 */
export const ambiguity: Scenario = {
  name: 'ambiguity',
  description: 'vague request → expect ack/clarification → user clarifies → expect on-target answer.',
  user: {
    persona: 'a curious user testing an AI assistant; happy to clarify when asked.',
    goal:
      'You want to know the boiling point of water in Fahrenheit. You will start with a deliberately vague question, then clarify when the agent asks, then end the conversation once you get the right answer.',
    maxTurns: 5,
  },
  steps: [
    { kind: 'sim-turn' },                                     // first vague turn from sim user
    { kind: 'wait-utterance', within: 8000 },
    { kind: 'wait-chat', within: 90000, label: 'first chat (might be a clarifying question)' },
    { kind: 'sim-turn' },                                     // user clarifies
    { kind: 'wait-utterance', within: 8000 },
    { kind: 'wait-chat', within: 90000, label: 'second chat (should be the actual answer)' },
    {
      kind: 'judge',
      label: 'answered the clarified question',
      rubric:
        'The user (eventually) wanted the boiling point of water in Fahrenheit (212°F). Did the agent ultimately deliver an AGENT-CHAT entry that gave that figure (or a clearly-correct equivalent like "212 degrees")? It is OK if the agent first asked a clarifying question.',
    },
  ],
  acceptanceMs: 240000,
};
