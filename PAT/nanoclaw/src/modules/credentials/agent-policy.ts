/**
 * PAT: secret-scoping policy for NEWLY-created OneCLI agents.
 *
 * A OneCLI "agent" is 1:1 with a nanoclaw AGENT GROUP — the identifier is
 * always agent_group_id (container-runner.ts, ensureAgent at first spawn).
 * So this policy fires exactly once per new agent group, and the scoping it
 * sets is group-wide (every session/person on that group shares it).
 *
 * The gateway's default for auto-created agents is secretMode 'all' — every
 * vault secret whose host matches injects into that agent's containers. With
 * one agent group that's harmless; the footgun is that any FUTURE group would
 * silently inherit every credential in the vault. Operator decision
 * (2026-07-02): new agents default to 'selective', assigned only the baseline
 * needed to function at all. Everything else is an explicit grant (OneCLI
 * UI/CLI, or a future ncl verb).
 *
 * Baseline: the anthropic entry only — without it the container's own Claude
 * API calls (which ride the same vault injection) fail and the group is born
 * broken. Vendor credentials (exa, firecrawl, openrouter, …) are opt-in.
 *
 * EXISTING agents are never touched — palisade-internal deliberately runs
 * 'all'. The policy applies exactly when ensureAgent reports created:true.
 */
import { log } from '../../log.js';
import { listAgents, listSecrets, setAgentSecretMode, setAgentSecrets } from './onecli-vault.js';

/** Vault entry names every new agent needs just to function. */
const BASELINE_SECRET_NAMES = ['anthropic-prod'];

/**
 * Flip a just-created gateway agent to selective mode with the baseline
 * assignment. Throws on failure — callers treat it like the rest of the
 * gateway spawn wiring (refuse to spawn; host-sweep retries). Edge: if this
 * throws after creation, the retry's ensureAgent reports created:false and
 * the agent stays 'all' — vanishingly rare (localhost PATCH right after a
 * successful POST), and loud (the throw aborts the spawn and logs).
 */
export async function applyNewAgentSecretPolicy(identifier: string): Promise<void> {
  const agent = (await listAgents()).find((a) => a.identifier === identifier);
  if (!agent) throw new Error(`new agent "${identifier}" not found in gateway`);

  const secrets = await listSecrets();
  const baseline = secrets.filter((s) => BASELINE_SECRET_NAMES.includes(s.name)).map((s) => s.id);
  if (baseline.length < BASELINE_SECRET_NAMES.length) {
    log.warn('Agent policy: baseline secret(s) missing from vault — new agent may not reach the model API', {
      identifier,
      expected: BASELINE_SECRET_NAMES,
      found: baseline.length,
    });
  }

  await setAgentSecretMode(agent.id, 'selective');
  await setAgentSecrets(agent.id, baseline);
  log.info('New OneCLI agent scoped to selective mode', {
    identifier,
    agentId: agent.id,
    baseline: BASELINE_SECRET_NAMES,
  });
}
