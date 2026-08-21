import type { Scenario } from './index.js';

/**
 * Task-stack — user gives task A, then before A finishes, gives a related
 * follow-up B that elaborates on A. Verify the back-mind addresses both
 * (or at minimum doesn't drop B silently).
 *
 * Different from barge-in: the second turn is a REFINEMENT not a TOPIC
 * SWITCH, which the design doc says should ride into the active query as
 * a follow-up rather than abort it.
 */
export const taskStack: Scenario = {
  name: 'task-stack',
  description: 'A then a refinement of A before A\'s chat lands; chat should address both.',
  steps: [
    { kind: 'turn', text: 'tell me about the planet jupiter' },
    { kind: 'wait-utterance', within: 8000, label: 'ack for A' },
    { kind: 'sleep', ms: 1500 },
    { kind: 'turn', text: 'and specifically how many moons does it have' },
    { kind: 'wait-utterance', within: 8000, label: 'ack for follow-up' },
    { kind: 'wait-chat', within: 90000, label: 'first chat' },
    // Some configurations may emit a second chat; allow either pattern.
    {
      kind: 'judge',
      label: 'addressed both task and refinement',
      rubric:
        'The user asked about Jupiter, then refined with "how many moons does it have". Across the AGENT-CHAT entries, did the agent (a) address Jupiter at all, AND (b) address the moon count (or acknowledge the refinement)? It is OK if both are covered in a single chat or if the refinement gets its own follow-up. It is NOT OK if only Jupiter generally is addressed and the moons question is dropped.',
    },
  ],
  acceptanceMs: 200000,
};
