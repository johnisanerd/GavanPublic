/**
 * Tier 2 — narration brain against the real model API.
 *
 * Gated on ANTHROPIC_API_KEY. Validates that the prompt yields parseable,
 * usable utterances across a few realistic detail-event sequences. Catches
 * prompt drift that unit tests (which mock the API) wouldn't notice.
 *
 * Run:   pnpm run test:live
 */
import { describe, it, expect } from 'vitest';

import { Narrator, type DetailEvent } from './narration.js';

const liveIt = process.env.ANTHROPIC_API_KEY ? it : it.skip;

async function runScenario(events: DetailEvent[], settleMs = 2500) {
  const utterances: string[] = [];
  const brain = new Narrator({
    onUtterance: (t) => utterances.push(t),
    autoTick: false,
  });
  // PAT: brain only ticks while isProcessing=true, which the
  // container-side `query-start` lifecycle event flips on. Tests that
  // simulate a back-mind work stretch must emit it explicitly.
  brain.observe({ type: 'query-start' });
  for (const ev of events) brain.observe(ev);
  await new Promise((r) => setTimeout(r, settleMs));
  await brain.tickOnce();
  brain.stop();
  return utterances;
}

function assertHumanish(utterance: string) {
  expect(utterance.length).toBeGreaterThan(0);
  expect(utterance.length).toBeLessThan(200);
  expect(utterance).not.toMatch(/```/); // no markdown fences leaked
  expect(utterance).not.toMatch(/^\{/); // not a raw JSON object
  expect(utterance).not.toMatch(/^["']?(utterance|kind)["']?\s*:/i); // no leaked field name
}

describe('live narration brain (live)', () => {
  liveIt(
    'tool-pre on read_file produces a single, humanish utterance',
    async () => {
      const out = await runScenario([
        { type: 'tool-pre', tool: 'read_file', input: { path: '/etc/hosts' } },
      ]);
      expect(out.length).toBe(1);
      assertHumanish(out[0]!);
    },
    15000,
  );

  liveIt(
    'multi-tool sequence (search → read) narrates without leaking JSON',
    async () => {
      const out = await runScenario([
        { type: 'tool-pre', tool: 'glob', input: { pattern: '**/*.ts' } },
        { type: 'tool-post', tool: 'glob', result: ['a.ts', 'b.ts', 'c.ts'] },
        { type: 'tool-pre', tool: 'read_file', input: { path: 'a.ts' } },
      ]);
      // At least one substantive utterance landed; final one must be humanish.
      expect(out.length).toBeGreaterThanOrEqual(1);
      assertHumanish(out[out.length - 1]!);
    },
    20000,
  );

  liveIt(
    'tool-failed event yields a failure-acknowledging narration',
    async () => {
      const out = await runScenario([
        { type: 'tool-pre', tool: 'install_packages', input: { pkg: 'python3' } },
        { type: 'tool-failed', tool: 'install_packages', error: 'no admin configured' },
      ]);
      expect(out.length).toBeGreaterThanOrEqual(1);
      const last = out[out.length - 1]!;
      assertHumanish(last);
      // The narration shouldn't pretend success — at least loosely allude to
      // trouble. Cheap heuristic: utterance is shorter than 200 chars and
      // doesn't claim done-ness.
      expect(last).not.toMatch(/^(done|all set|success)\b/i);
    },
    20000,
  );
});
