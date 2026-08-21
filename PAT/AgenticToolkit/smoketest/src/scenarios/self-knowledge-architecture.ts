import type { Scenario } from './index.js';

/**
 * self-knowledge-architecture — ask the back-mind to describe its own
 * architecture and judge that the reply names the key load-bearing
 * concepts. Trace-based: judge runs over the actual outbound chat row
 * (AGENT-CHAT in the transcript), not over front-mind banter or
 * transient narration.
 *
 * Asserts that at least 3 of {front-mind, back-mind, dashboard,
 * log.event, channels} appear in the back-mind's answer — that's the
 * minimum bar for a non-hallucinated architectural self-description.
 *
 * Wired up after task #2 (a2-self-knowledge) added
 * `groups/palisade-internal/PAT-ARCHITECTURE.md` and @-imported it
 * from CLAUDE.local.md.
 */
export const selfKnowledgeArchitecture: Scenario = {
  name: 'self-knowledge-architecture',
  description:
    'ask "describe how you work / architecture" and judge that the back-mind reply names at least 3 of {front-mind, back-mind, dashboard, log.event, channels}.',
  steps: [
    {
      kind: 'turn',
      text: 'describe how you work — what is your architecture, front-mind versus back-mind, how do you stream logs?',
    },
    { kind: 'wait-utterance', within: 8000, label: 'front-mind ack' },
    { kind: 'wait-chat', within: 120000, label: 'back-mind architectural reply' },
    {
      kind: 'judge',
      label: 'names load-bearing architecture terms',
      rubric:
        'Look ONLY at the most recent AGENT-CHAT entry (the back-mind reply, not front-mind banter). ' +
        'Does it explicitly mention at least 3 of these load-bearing terms from PAT\'s architecture: ' +
        '"front-mind", "back-mind", "dashboard" (or "pat-frontend"), ' +
        '"log.event" (or "log_event" or "structured log" or "/admin/logs"), ' +
        '"channels" (or "channel adapter")? ' +
        'PASS if 3+ named explicitly. FAIL if only 2 or fewer, or if the answer is generic ' +
        '("I\'m an AI assistant", "I help with tasks") without naming the actual architecture pieces.',
    },
    {
      kind: 'judge',
      label: 'no major hallucinations',
      rubric:
        'Look ONLY at the most recent AGENT-CHAT entry. Does it contain any obviously fabricated ' +
        'architectural claims that contradict PAT\'s real design? Red flags: claims of being a ' +
        'single monolithic model, claims of running on AWS/GCP infra not mentioned in the doc, ' +
        'invented component names, or claims of features not actually wired (e.g., "I run on ' +
        'Kubernetes" or "I use Kafka"). PASS if no such fabrications. FAIL if any clear ' +
        'fabricated infrastructure claims are present.',
    },
  ],
  acceptanceMs: 180000,
};
