/**
 * Request-layer live tests — real Sonnet, gated on ANTHROPIC_API_KEY.
 *
 * The unit tests in `request-layer.test.ts` mock the SDK and verify
 * code wiring. These tests verify *prompt quality* — that the actual
 * Sonnet model behaves correctly given realistic inputs.
 *
 * Each scenario is one production call we've actually observed (or a
 * close cousin). If a regression sneaks into the prompt we should see
 * it here before it ships.
 *
 * Run: `ANTHROPIC_API_KEY=… pnpm run test:live` (gates via .live.test.ts
 * filename — excluded from default `pnpm test`).
 */
import { describe, it, expect, beforeAll } from 'vitest';

import { requestLayerOnUserMessage, type RequestLayerRequest } from './request-layer.js';
import type { BanterHistoryEntry } from './banter.js';
import { emptyBackMindState } from './state.js';

const liveIt = process.env.ANTHROPIC_API_KEY ? it : it.skip;

beforeAll(() => {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('ANTHROPIC_API_KEY not set — skipping live request-layer tests');
  }
});

function makeRequest(overrides: Partial<RequestLayerRequest> = {}): RequestLayerRequest {
  return {
    userText: 'placeholder',
    backMindState: emptyBackMindState(),
    banterResponse: '(silent)',
    history: [],
    isProcessing: false,
    ...overrides,
  };
}

describe('request-layer LIVE — Sonnet trusts the back-mind-processing flag', () => {
  // Reproduction of the bug observed in call call-c5a3561d5c51 (2026-05-07
  // ~00:11). User's first turn was a greeting (noop), second turn was a
  // genuine actionable question. Sonnet hallucinated that work was already
  // in flight ("the back-mind is already working on it") and noop'd —
  // even though no [→ back-mind] marker existed in history. Banter saying
  // "lemme pull that up" tricked it into believing a forward had occurred.
  liveIt(
    'forwards an actionable question after a prior banter promise that did NOT result in a forward',
    async () => {
      const history: BanterHistoryEntry[] = [
        { role: 'user', text: 'How are you doing today?' },
        { role: 'pat', text: 'Doing pretty well, thanks for asking. What\'s on your mind?' },
      ];
      const out = await requestLayerOnUserMessage(
        makeRequest({
          history,
          userText: 'Can you check to see if I have an admin approval?',
          banterResponse: 'Yeah, lemme pull that up for you.',
          isProcessing: false,
        }),
      );
      // The bug was decision=noop with a hallucinated "already in flight" reason.
      // With isProcessing=false the prompt should force a forward.
      expect(out.decision).toBe('forward');
      if (out.decision === 'forward') {
        expect(out.invokeText.toLowerCase()).toMatch(/admin/);
      }
    },
    20_000,
  );

  liveIt(
    'noops a follow-up that trails the same in-flight task when isProcessing=true',
    async () => {
      const history: BanterHistoryEntry[] = [
        { role: 'user', text: 'Can you find the address of Palisade Research?' },
        { role: 'pat', text: 'Sure, looking it up now.' },
        { role: 'forwarded', text: 'Find the address of Palisade Research.' },
      ];
      const out = await requestLayerOnUserMessage(
        makeRequest({
          history,
          userText: 'work here.',
          banterResponse: 'still on it',
          isProcessing: true,
        }),
      );
      // Trailing words on the same in-flight task — should noop.
      expect(out.decision).toBe('noop');
    },
    20_000,
  );

  liveIt(
    'forwards a fresh question even when an OLD forward exists in history but back-mind is now idle',
    async () => {
      const history: BanterHistoryEntry[] = [
        { role: 'user', text: 'What\'s the latest Node.js version?' },
        { role: 'pat', text: 'Lemme check.' },
        { role: 'forwarded', text: 'What is the latest Node.js LTS version?' },
        { role: 'pat', text: 'Latest LTS is 22.x.' },
      ];
      const out = await requestLayerOnUserMessage(
        makeRequest({
          history,
          userText: 'And what about Python?',
          banterResponse: 'Lemme grab that one too.',
          isProcessing: false,
        }),
      );
      // Old forward is done (isProcessing=false). New question is genuinely
      // new. Should forward.
      expect(out.decision).toBe('forward');
    },
    20_000,
  );

  liveIt('still noops on simple greetings even with isProcessing=false', async () => {
    const out = await requestLayerOnUserMessage(
      makeRequest({
        userText: 'How are you doing today?',
        banterResponse: 'Doing well, thanks. What\'s up?',
        isProcessing: false,
      }),
    );
    expect(out.decision).toBe('noop');
  }, 20_000);
});
