import type { Scenario } from './index.js';

/**
 * Install-failure-recovery — exercises the known `install_packages` admin
 * gap. Active sprint task says "decide after storage tee work"; in the
 * meantime, the smoke test pins the user-visible behaviour: the agent
 * should NARRATE the failure rather than stalling silently.
 *
 * Note: this scenario depends on the realtime:local agent group not having
 * admin assigned. If admin is later granted, the rubric should be flipped
 * to "agent successfully installed Python".
 */
export const installFailureRecovery: Scenario = {
  name: 'install-failure-recovery',
  description: 'request install_packages → fails → agent narrates failure rather than stalling.',
  steps: [
    { kind: 'turn', text: 'can you install the python3 package on your container so you can run scripts' },
    { kind: 'wait-utterance', within: 8000, label: 'ack' },
    { kind: 'wait-chat', within: 90000, label: 'final chat' },
    {
      kind: 'judge',
      label: 'failure narrated, not silent',
      rubric:
        'The user asked the agent to install python3. We expect this to fail because admin isn\'t configured. Did the agent\'s final AGENT-CHAT entry communicate the failure (e.g., "I can\'t do that", "I don\'t have permission", "no admin", "this requires approval") AS OPPOSED TO either falsely claiming success or going silent? Front-mind fillers do not count.',
    },
  ],
  acceptanceMs: 150000,
};
