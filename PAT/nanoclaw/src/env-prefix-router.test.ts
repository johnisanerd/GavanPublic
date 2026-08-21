// PAT: tests for the boot-time HOST_ prefix router (Pillar B Phase 4).
import { describe, expect, it } from 'vitest';

import { applyEnvPrefixRouter } from './env-prefix-router.js';

describe('applyEnvPrefixRouter', () => {
  it('strips HOST_ into the canonical name', () => {
    const env: NodeJS.ProcessEnv = { HOST_TELEGRAM_BOT_TOKEN: 'tok' };
    const result = applyEnvPrefixRouter(env);
    expect(env.TELEGRAM_BOT_TOKEN).toBe('tok');
    expect(result.mapped).toEqual(['TELEGRAM_BOT_TOKEN']);
    expect(result.shadowed).toEqual([]);
  });

  it('prefixed value wins over a pre-existing unprefixed one (transition state)', () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'old', HOST_ANTHROPIC_API_KEY: 'new' };
    const result = applyEnvPrefixRouter(env);
    expect(env.ANTHROPIC_API_KEY).toBe('new');
    expect(result.shadowed).toEqual(['ANTHROPIC_API_KEY']);
  });

  it('identical duplicate is mapped but not reported as shadowed', () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'same', HOST_ANTHROPIC_API_KEY: 'same' };
    const result = applyEnvPrefixRouter(env);
    expect(result.mapped).toEqual(['ANTHROPIC_API_KEY']);
    expect(result.shadowed).toEqual([]);
  });

  it('leaves AGENT_ and PUBLIC_ vars untouched — they are other tiers, not host env', () => {
    const env: NodeJS.ProcessEnv = { AGENT_FIRECRAWL_API_KEY: 'fc', PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk' };
    const result = applyEnvPrefixRouter(env);
    expect(result.mapped).toEqual([]);
    expect(env.FIRECRAWL_API_KEY).toBeUndefined();
    expect(env.CLERK_PUBLISHABLE_KEY).toBeUndefined();
    expect(env.AGENT_FIRECRAWL_API_KEY).toBe('fc');
  });

  it('ignores lookalikes: HOSTNAME, bare HOST_, non-HOST vars', () => {
    const env: NodeJS.ProcessEnv = { HOSTNAME: 'vm1', HOST_: 'x', PATH: '/bin' };
    const result = applyEnvPrefixRouter(env);
    expect(result.mapped).toEqual([]);
    expect(env.NAME).toBeUndefined();
  });
});
