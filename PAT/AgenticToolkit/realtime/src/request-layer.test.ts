/**
 * Request layer tests — Anthropic SDK mocked.
 *
 * Covers each of the three decisions (noop / forward / silent), JSON
 * repair quirks, validation (forward must have invokeText), and the
 * circuit breaker.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const messagesCreate = vi.fn();

// The provider abstraction routes everything through messages.stream().
// The stream mock translates by calling messagesCreate internally so
// tests retain the same arming + arg-inspection patterns.
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

import {
  requestLayerOnUserMessage,
  resetRequestLayerFailures,
  type RequestLayerRequest,
} from './request-layer.js';
import { emptyBackMindState } from './state.js';

function makeRequest(overrides: Partial<RequestLayerRequest> = {}): RequestLayerRequest {
  return {
    userText: 'whats up',
    backMindState: emptyBackMindState(),
    banterResponse: 'hey, not much.',
    ...overrides,
  };
}

function textBlock(text: string) {
  return { content: [{ type: 'text', text }] };
}

const ORIGINAL_API_KEY = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  messagesCreate.mockReset();
  resetRequestLayerFailures();
  process.env.ANTHROPIC_API_KEY = 'sk-test-stub';
});

describe('requestLayerOnUserMessage — system prompt content', () => {
  // Drift guard: the recall-queries-always-forward rule is what keeps
  // cross-session wiki lookups from being mis-classified as noop. PAT
  // (task #13). After the 2026-05-22 banter-contract tightening the
  // phrasing changed (RECALL QUERIES — ... — ALWAYS forward); check the
  // load-bearing keywords rather than a fixed phrase.
  it('contains the recall-queries-always-forward rule', async () => {
    messagesCreate.mockResolvedValueOnce(textBlock('{"decision":"noop","reason":"x"}'));
    await requestLayerOnUserMessage(makeRequest());
    const call = messagesCreate.mock.calls[0]![0] as { system: string };
    expect(call.system).toMatch(/RECALL QUERIES/);
    expect(call.system).toMatch(/ALWAYS forward/);
  });
});

describe('requestLayerOnUserMessage — happy paths', () => {
  it('parses noop', async () => {
    messagesCreate.mockResolvedValueOnce(textBlock('{"decision":"noop","reason":"social"}'));
    const out = await requestLayerOnUserMessage(makeRequest());
    expect(out).toEqual({ decision: 'noop', reason: 'social' });
  });

  it('parses forward', async () => {
    messagesCreate.mockResolvedValueOnce(
      textBlock('{"decision":"forward","invokeText":"whats two plus two","reason":"math request"}'),
    );
    const out = await requestLayerOnUserMessage(
      makeRequest({ userText: 'whats two plus two', banterResponse: 'okay let me work that out.' }),
    );
    expect(out).toEqual({
      decision: 'forward',
      invokeText: 'whats two plus two',
      reason: 'math request',
    });
  });

  it('parses silent', async () => {
    messagesCreate.mockResolvedValueOnce(textBlock('{"decision":"silent","reason":"unintelligible noise"}'));
    const out = await requestLayerOnUserMessage(makeRequest({ userText: 'aksjdhf' }));
    expect(out.decision).toBe('silent');
  });
});

describe('requestLayerOnUserMessage — back-mind processing flag wiring', () => {
  it('passes "back-mind processing: false" into the user message when isProcessing is false/undefined', async () => {
    messagesCreate.mockResolvedValueOnce(textBlock('{"decision":"noop"}'));
    await requestLayerOnUserMessage(makeRequest({ isProcessing: false }));
    const args = messagesCreate.mock.calls[0]?.[0] as { messages: { role: string; content: string }[] };
    const userContent = args.messages.find((m) => m.role === 'user')?.content ?? '';
    expect(userContent).toContain('<back_mind_processing>false</back_mind_processing>');
  });

  it('passes "back-mind processing: true" when isProcessing is true', async () => {
    messagesCreate.mockResolvedValueOnce(textBlock('{"decision":"noop"}'));
    await requestLayerOnUserMessage(makeRequest({ isProcessing: true }));
    const args = messagesCreate.mock.calls[0]?.[0] as { messages: { role: string; content: string }[] };
    const userContent = args.messages.find((m) => m.role === 'user')?.content ?? '';
    expect(userContent).toContain('<back_mind_processing>true</back_mind_processing>');
  });

  it('defaults to false when isProcessing is omitted (safer than the prior infer-from-prose path)', async () => {
    messagesCreate.mockResolvedValueOnce(textBlock('{"decision":"noop"}'));
    await requestLayerOnUserMessage(makeRequest());
    const args = messagesCreate.mock.calls[0]?.[0] as { messages: { role: string; content: string }[] };
    const userContent = args.messages.find((m) => m.role === 'user')?.content ?? '';
    expect(userContent).toContain('<back_mind_processing>false</back_mind_processing>');
  });
});

describe('requestLayerOnUserMessage — JSON repair', () => {
  it('strips ```json fences', async () => {
    messagesCreate.mockResolvedValueOnce(textBlock('```json\n{"decision":"noop"}\n```'));
    expect((await requestLayerOnUserMessage(makeRequest())).decision).toBe('noop');
  });

  it('repairs trailing commas', async () => {
    messagesCreate.mockResolvedValueOnce(
      textBlock('{"decision":"forward","invokeText":"check the weather",}'),
    );
    const out = await requestLayerOnUserMessage(makeRequest());
    expect(out.decision).toBe('forward');
  });

  it('extracts JSON from surrounding prose', async () => {
    messagesCreate.mockResolvedValueOnce(textBlock('Sure: {"decision":"noop"} that\'s my call'));
    expect((await requestLayerOnUserMessage(makeRequest())).decision).toBe('noop');
  });
});

describe('requestLayerOnUserMessage — validation + silent fallbacks', () => {
  it('returns silent when forward is missing invokeText', async () => {
    messagesCreate.mockResolvedValueOnce(textBlock('{"decision":"forward"}'));
    const out = await requestLayerOnUserMessage(makeRequest());
    expect(out.decision).toBe('silent');
  });

  it('returns silent on unknown decision kind', async () => {
    messagesCreate.mockResolvedValueOnce(textBlock('{"decision":"frobnicate"}'));
    const out = await requestLayerOnUserMessage(makeRequest());
    expect(out.decision).toBe('silent');
  });

  it('returns silent on unparseable model output', async () => {
    messagesCreate.mockResolvedValueOnce(textBlock('not json at all'));
    const out = await requestLayerOnUserMessage(makeRequest());
    expect(out.decision).toBe('silent');
  });

  it('returns silent when ANTHROPIC_API_KEY missing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const out = await requestLayerOnUserMessage(makeRequest());
    expect(out.decision).toBe('silent');
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('returns silent on SDK error', async () => {
    messagesCreate.mockRejectedValueOnce(new Error('rate-limited'));
    const out = await requestLayerOnUserMessage(makeRequest());
    expect(out.decision).toBe('silent');
  });
});

describe('requestLayerOnUserMessage — circuit breaker', () => {
  it('short-circuits to silent after 3 consecutive failures', async () => {
    messagesCreate
      .mockRejectedValueOnce(new Error('1'))
      .mockRejectedValueOnce(new Error('2'))
      .mockRejectedValueOnce(new Error('3'));
    await requestLayerOnUserMessage(makeRequest());
    await requestLayerOnUserMessage(makeRequest());
    await requestLayerOnUserMessage(makeRequest());
    expect(messagesCreate).toHaveBeenCalledTimes(3);
    // 4th short-circuits.
    expect((await requestLayerOnUserMessage(makeRequest())).decision).toBe('silent');
    expect(messagesCreate).toHaveBeenCalledTimes(3);
  });
});

afterAll(() => {
  if (ORIGINAL_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ORIGINAL_API_KEY;
});
