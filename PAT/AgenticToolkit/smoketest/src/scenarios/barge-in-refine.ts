import type { Scenario } from './index.js';

/**
 * Barge-in: refine.
 *
 * User asks A broadly, then mid-think narrows the scope. The original
 * task isn't cancelled; it's refined. Expected behaviour:
 *   - Agent's final answer reflects the refinement.
 *   - The refinement isn't dropped silently.
 *
 * Today's known failure: refinement gets queued behind the broad answer
 * to A; agent answers A then maybe addresses refinement separately, OR
 * answers A only and ignores the refinement entirely.
 */
export const bargeInRefine: Scenario = {
  name: 'barge-in-refine',
  description: 'broad ask → mid-think narrowing → expect final answer reflects the narrowed scope.',
  steps: [
    { kind: 'turn', text: 'tell me about ai trends' },
    { kind: 'wait-utterance', within: 8000, label: 'ack for broad ask' },
    { kind: 'sleep', ms: 2000 },
    { kind: 'turn', text: 'actually, focus specifically on agentic systems' },
    { kind: 'wait-utterance', within: 8000, label: 'ack for refinement' },
    { kind: 'wait-chat', within: 120000, label: 'final chat' },
    {
      kind: 'judge',
      label: 'refinement was incorporated',
      rubric:
        'The user first asked broadly about AI trends, then refined to "focus specifically on agentic systems". Does the agent\'s final AGENT-CHAT entry primarily address agentic systems specifically — i.e. talks about agents, tool use, reasoning, autonomy, multi-agent setups, or related topics — rather than a generic survey of AI trends (e.g. "image generation, LLMs, robotics, etc.")? PASS if the answer is narrowed to agentic systems. FAIL if it\'s a broad AI survey that ignores the refinement.',
    },
  ],
  acceptanceMs: 180000,
};
