/**
 * PAT: operator domain-gate tests (Phase 0). The Clerk session plumbing needs
 * keys + a browser to exercise; the GATE decision (which emails are operators)
 * is pure and is what must never regress.
 */
import { describe, it, expect } from 'vitest';

import { isOperatorEmail } from './auth';

describe('isOperatorEmail', () => {
  it('accepts @palisaderesearch.org (case-insensitive)', () => {
    expect(isOperatorEmail('gavan@palisaderesearch.org')).toBe(true);
    expect(isOperatorEmail('Gavan@Palisaderesearch.ORG')).toBe(true);
  });

  it('rejects other domains and malformed input', () => {
    expect(isOperatorEmail('someone@gmail.com')).toBe(false);
    expect(isOperatorEmail('attacker@palisaderesearch.org.evil.com')).toBe(false);
    expect(isOperatorEmail('palisaderesearch.org')).toBe(false); // no @
    expect(isOperatorEmail('')).toBe(false);
    expect(isOperatorEmail(null)).toBe(false);
    expect(isOperatorEmail(undefined)).toBe(false);
  });

  it('rejects multiple-@ smuggling', () => {
    expect(isOperatorEmail('a@b@palisaderesearch.org')).toBe(false);
    expect(isOperatorEmail('attacker@evil.com@palisaderesearch.org')).toBe(false);
    expect(isOperatorEmail('@palisaderesearch.org')).toBe(false); // empty local part
  });
});
