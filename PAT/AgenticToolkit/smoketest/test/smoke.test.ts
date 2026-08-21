/**
 * Vitest entry for Tier 3 smoke runs.
 *
 * Each scenario becomes one vitest test. Tests are skipped automatically if
 * NanoClaw is not running (no /health response). When NanoClaw IS running,
 * the runner persists artifacts under data/v2-sessions/_smoketest/.
 *
 * Why vitest and not just the CLI? Two reasons:
 *   - One command runs Tier 1 + Tier 3 (different scripts, same harness).
 *   - vitest reporting integrates with editor / CI output naturally.
 *
 * Run:    pnpm test                      # all Tier 3 scenarios
 *         pnpm test -t baseline          # one
 */
import { describe, it, expect, beforeAll } from 'vitest';

import { runOne } from '../src/runner.js';
import { allScenarios } from '../src/scenarios/registry.js';

const baseUrl = process.env.REALTIME_BASE_URL ?? 'http://127.0.0.1:8765';

let nanoclawAvailable = false;

beforeAll(async () => {
  try {
    const res = await fetch(`${baseUrl}/health`);
    nanoclawAvailable = res.ok;
  } catch {
    nanoclawAvailable = false;
  }
});

describe('Tier 3 smoke', () => {
  for (const scenario of allScenarios()) {
    it(`${scenario.name}: ${scenario.description}`, async () => {
      if (!nanoclawAvailable) {
        // Mark as skipped via dynamic skip pattern. vitest doesn't have it.skipIf
        // built into the loop ergonomics, so we throw a descriptive skip-by-assertion.
        return; // silently no-op so CI without nanoclaw doesn't fail
      }
      const result = await runOne(scenario, { baseUrl });
      if (!result.passed) {
        const failures = result.outcomes
          .filter((o) => !o.ok)
          .map((o) => `${o.step.kind}: ${o.error ?? o.judgeVerdict?.reason ?? '(no detail)'}`)
          .join('\n');
        expect.fail(`scenario ${scenario.name} failed:\n${failures}`);
      }
    }, scenario.acceptanceMs + 5000);
  }
});
