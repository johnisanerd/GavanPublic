/**
 * Banter layer tests — Anthropic SDK mocked.
 *
 * Banter is now a plain-text-out layer (no JSON to parse, no
 * classification). Tests cover the cleaning logic + circuit breaker
 * + the no-API-key / SDK-error fallbacks.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const messagesCreate = vi.fn();

// The provider abstraction (PAT Phase 1, 2026-05-22) routes everything
// through messages.stream() — even "wait till complete" callers via
// awaitFullResponse(). Tests still arm responses via messagesCreate's
// mock; the stream mock translates by calling messagesCreate internally,
// emitting one text delta with the full string, and resolving
// finalMessage().
function makeStreamMock(args: unknown) {
  const callbacks: { text?: (delta: string) => void } = {};
  return {
    on: (event: string, cb: (delta: string) => void) => {
      if (event === 'text') callbacks.text = cb;
    },
    finalMessage: async () => {
      const result = await messagesCreate(args);
      const block = result?.content?.find((b: { type: string }) => b.type === 'text');
      if (block && callbacks.text) callbacks.text(block.text);
      return result;
    },
    // No-op — tests don't exercise mid-stream abort. The mock's `abort()`
    // exists only to satisfy the MessageStream interface shape.
    abort: () => {},
    closed: false,
  };
}

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = {
      create: messagesCreate,
      stream: (args: unknown) => makeStreamMock(args),
    };
  },
}));

import { runBanterAck, resetBanterFailures, type BanterRequest } from './banter.js';
import { emptyBackMindState } from './state.js';

function makeRequest(overrides: Partial<BanterRequest> = {}): BanterRequest {
  return {
    userText: 'whats up',
    backMindState: emptyBackMindState(),
    ...overrides,
  };
}

function textBlock(text: string) {
  return { content: [{ type: 'text', text }] };
}

const ORIGINAL_API_KEY = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  messagesCreate.mockReset();
  resetBanterFailures();
  process.env.ANTHROPIC_API_KEY = 'sk-test-stub';
});

describe('runBanterAck — happy paths', () => {
  it('returns the model output as plain text', async () => {
    messagesCreate.mockResolvedValueOnce(textBlock("yeah, lemme grab that for you."));
    const out = await runBanterAck(makeRequest());
    expect(out.text).toBe('yeah, lemme grab that for you.');
  });

  it('strips leading/trailing markdown fences', async () => {
    messagesCreate.mockResolvedValueOnce(textBlock("```\nokay, let me work on that.\n```"));
    const out = await runBanterAck(makeRequest());
    expect(out.text).toBe('okay, let me work on that.');
  });

  it('strips wrapping quotes', async () => {
    messagesCreate.mockResolvedValueOnce(textBlock('"sure, on it."'));
    const out = await runBanterAck(makeRequest());
    expect(out.text).toBe('sure, on it.');
  });

  it('preserves multi-line output (banter and rendition both)', async () => {
    // The LLM legitimately wants multi-line output sometimes — bulleted
    // lists, paragraph breaks, two-sentence answers split by a blank line.
    // Don't collapse to firstLine; downstream layers can decide what to
    // do with newlines.
    messagesCreate.mockResolvedValueOnce(textBlock("yeah, on it.\n\nthis'll take a sec."));
    const out = await runBanterAck(makeRequest());
    expect(out.text).toBe("yeah, on it.\n\nthis'll take a sec.");
  });

});

describe('runBanterAck — system prompt content', () => {
  // Lightweight drift guards: the prompt rules that other layers and the
  // back-mind rely on shouldn't silently disappear. If you intentionally
  // remove a rule, update the assertion (or delete it).
  //
  // PAT (task #38): the cross-session "NEVER claim to remember" rule
  // added by task #13 was removed. It overcorrected — banter would
  // refuse to acknowledge things it had said one turn earlier in the
  // same call (working memory is fair game). The load-bearing wiki
  // deferral lives in request-layer's "Recall queries always forward"
  // rule, not here. If you find yourself wanting the NEVER-claim rule
  // back, prefer narrowing the request-layer's keyword set instead.

  it('contains the no-direct-factual-answer rule', async () => {
    messagesCreate.mockResolvedValueOnce(textBlock('hi'));
    await runBanterAck(makeRequest());
    const call = messagesCreate.mock.calls[0]![0] as { system: string };
    expect(call.system).toContain('NEVER answer a factual or computational question');
  });
});

describe('runBanterAck — silent fallbacks', () => {
  it('returns null when ANTHROPIC_API_KEY missing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const out = await runBanterAck(makeRequest());
    expect(out.text).toBeNull();
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('returns null on SDK error', async () => {
    messagesCreate.mockRejectedValueOnce(new Error('rate-limited'));
    const out = await runBanterAck(makeRequest());
    expect(out.text).toBeNull();
  });

  it('passes the literal <silent> string through as text (sentinel logic removed)', async () => {
    // The legacy <silent> sentinel was removed from the banter pipeline
    // (PAT 2026-05-12); system prompts disallow it. If the model somehow
    // still emits it, it's treated as literal text — not a silent signal.
    messagesCreate.mockResolvedValueOnce(textBlock('<silent>'));
    const out = await runBanterAck(makeRequest());
    expect(out.text).toBe('<silent>');
  });

  it('returns null on empty model output', async () => {
    messagesCreate.mockResolvedValueOnce(textBlock(''));
    const out = await runBanterAck(makeRequest());
    expect(out.text).toBeNull();
  });
});

describe('runBanterAck — circuit breaker', () => {
  it('short-circuits to silent after 3 consecutive failures', async () => {
    messagesCreate
      .mockRejectedValueOnce(new Error('1'))
      .mockRejectedValueOnce(new Error('2'))
      .mockRejectedValueOnce(new Error('3'));
    expect((await runBanterAck(makeRequest())).text).toBeNull();
    expect((await runBanterAck(makeRequest())).text).toBeNull();
    expect((await runBanterAck(makeRequest())).text).toBeNull();
    expect(messagesCreate).toHaveBeenCalledTimes(3);
    // 4th call short-circuits.
    expect((await runBanterAck(makeRequest())).text).toBeNull();
    expect(messagesCreate).toHaveBeenCalledTimes(3);
  });

  it('resets the failure counter on success', async () => {
    messagesCreate
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(textBlock('hey there.'));
    expect((await runBanterAck(makeRequest())).text).toBeNull();
    expect((await runBanterAck(makeRequest())).text).toBe('hey there.');
  });
});

afterAll(() => {
  if (ORIGINAL_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ORIGINAL_API_KEY;
});
