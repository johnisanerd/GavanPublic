/**
 * Central model config per ~/.claude/AGENTS.md.
 *
 * Never hardcode model IDs in scenarios or driver code — go through here.
 * Two env-var overrides:
 *   AI_MODEL          override every model with this single ID (test/iteration)
 *   SIM_USER_MODEL    override only the simulated user model
 *   JUDGE_MODEL       override only the judge model
 *
 * Effort levels are not parameterised here — smoketest scenarios only need
 * the model. Effort lives on the agent under test (NanoClaw container) via
 * EFFORT env, separate concern.
 */
export type ModelRole = 'sim-user' | 'judge';

const DEFAULTS: Record<ModelRole, string> = {
  // Simulated user — Haiku is cheap + fast and the user driver doesn't need
  // cleverness; the agent under test is what we're stressing.
  'sim-user': 'claude-haiku-4-5-20251001',
  // Judge — Sonnet is more reliable for transcript-rubric judgment than
  // Haiku without burning Opus tokens per scenario.
  'judge': 'claude-sonnet-4-6',
};

export function getModel(role: ModelRole): string {
  if (process.env.AI_MODEL) return process.env.AI_MODEL;
  if (role === 'sim-user' && process.env.SIM_USER_MODEL) return process.env.SIM_USER_MODEL;
  if (role === 'judge' && process.env.JUDGE_MODEL) return process.env.JUDGE_MODEL;
  return DEFAULTS[role];
}
