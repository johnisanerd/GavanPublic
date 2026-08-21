/**
 * PAT: boot-time env prefix router — Pillar B Phase 4
 * (plans/deployment-and-credentials.md).
 *
 * Fly secrets are named by trust tier: HOST_<NAME> (host process),
 * AGENT_<NAME> (OneCLI vault egress injection), PUBLIC_<NAME>
 * (pat-frontend browser injection — not this process's concern).
 * Code keeps reading canonical names; this module strips the HOST_
 * prefix into process.env before anything else reads it.
 *
 * MUST be the FIRST import in src/index.ts — config.ts and the
 * realtime library read process.env at module-import time, and ES
 * module evaluation is depth-first in source order, so only the
 * first import slot runs ahead of them.
 *
 * Rules:
 *  - HOST_X → process.env.X. The prefixed value WINS over a
 *    pre-existing unprefixed X: the prefix is the declared intent,
 *    and during a rename transition both exist with the new value
 *    authoritative.
 *  - AGENT_X is left untouched — consumed by-name by the credential
 *    reconcile (src/modules/credentials/) which derives the OneCLI
 *    vault from it. It is never mapped to a canonical name here;
 *    host code has no business reading agent-tier values.
 *  - No imports (esp. not log.ts) — nothing may read env before us.
 *    index.ts logs the returned summary once the logger is up.
 *
 * The .env-file half of the router lives in scripts/fly-entrypoint.sh
 * (readEnvFile consumers get canonical names written to /app/nanoclaw/.env
 * from the same HOST_ secrets). Keep the two in sync conceptually:
 * prefix in the secret store, canonical everywhere downstream.
 */

export interface PrefixRouterSummary {
  /** canonical names set from a HOST_ var */
  mapped: string[];
  /** subset of `mapped` where an unprefixed var already existed (and was overwritten) */
  shadowed: string[];
}

export function applyEnvPrefixRouter(env: NodeJS.ProcessEnv): PrefixRouterSummary {
  const mapped: string[] = [];
  const shadowed: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith('HOST_') || name.length <= 5 || value === undefined) continue;
    const canonical = name.slice(5);
    if (env[canonical] !== undefined && env[canonical] !== value) shadowed.push(canonical);
    env[canonical] = value;
    mapped.push(canonical);
  }
  mapped.sort();
  shadowed.sort();
  return { mapped, shadowed };
}

// Side effect on import — see the header comment for why.
export const prefixRouterResult = applyEnvPrefixRouter(process.env);
