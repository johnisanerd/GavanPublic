/**
 * Banter-dispatch tests — Anthropic SDK mocked.
 *
 * Covers:
 *   - Happy-path rewrite returns ok=true + rewritten string
 *   - Authored input echoed back as `raw` for traceability
 *   - latency_ms is populated and non-negative
 *   - emotion / break tags pass through the cleaner unchanged
 *   - onCall trace hook fires with layer='banter:dispatch'
 *   - History + target threaded into the user message
 *   - Scenario context lands in the system prompt
 *   - Missing API key → ok=false, raw fallback, no SDK call
 *   - SDK error → ok=false, raw fallback, error reason captured
 *   - Empty model output → ok=false
 *   - Circuit breaker opens after 3 consecutive failures
 *   - AbortSignal (pre-call) → ok=false with reason='aborted', no SDK call
 *
 * Mocking idiom matches `banter.test.ts` — intercept `@anthropic-ai/sdk`
 * at module-load time. The `messages.create` mock receives the second
 * positional arg (request options) so we can assert signal forwarding.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const messagesCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: messagesCreate };
  },
}));

import {
  banterDispatch,
  resetBanterDispatchFailures,
  type BanterDispatchInput,
} from './banter-dispatch.js';
import type { LlmCallTrace } from './banter.js';
import type { ScenarioContext } from './prompts/_scenario-context.js';

function textBlock(text: string) {
  return { content: [{ type: 'text', text }] };
}

function makeInput(overrides: Partial<BanterDispatchInput> = {}): BanterDispatchInput {
  return {
    say: { text: 'A single AI agent. One written instruction. Four machines on three continents.' },
    ...overrides,
  };
}

const ORIGINAL_API_KEY = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  messagesCreate.mockReset();
  resetBanterDispatchFailures();
  process.env.ANTHROPIC_API_KEY = 'sk-test-stub';
});

describe('banterDispatch — happy paths', () => {
  it('returns ok=true and the model output as rewritten', async () => {
    messagesCreate.mockResolvedValueOnce(
      textBlock('A single AI agent. One written instruction. Four machines on three continents.'),
    );
    const out = await banterDispatch(makeInput());
    expect(out.ok).toBe(true);
    expect(out.rewritten).toBe(
      'A single AI agent. One written instruction. Four machines on three continents.',
    );
    expect(out.error).toBeUndefined();
  });

  it('preserves emotion and break voice tags in the rewrite', async () => {
    // Critical: the cleaner must not strip the inline tags. The TTS
    // layer downstream depends on them surviving end-to-end.
    messagesCreate.mockResolvedValueOnce(
      textBlock(
        '<emotion value="calm">A single AI agent. One written instruction. <break time="300ms"/>Four machines on three continents.</emotion>',
      ),
    );
    const out = await banterDispatch(makeInput());
    expect(out.ok).toBe(true);
    expect(out.rewritten).toContain('<emotion value="calm">');
    expect(out.rewritten).toContain('<break time="300ms"/>');
    expect(out.rewritten).toContain('</emotion>');
  });

  it('echoes the authored input as `raw` for traceability', async () => {
    messagesCreate.mockResolvedValueOnce(textBlock('Pat-voiced version.'));
    const input = makeInput({ say: { text: 'Original authored line.' } });
    const out = await banterDispatch(input);
    expect(out.raw).toBe('Original authored line.');
    expect(out.rewritten).toBe('Pat-voiced version.');
  });

  it('populates latency_ms with a non-negative value', async () => {
    messagesCreate.mockResolvedValueOnce(textBlock('rewritten.'));
    const out = await banterDispatch(makeInput());
    expect(out.latency_ms).toBeGreaterThanOrEqual(0);
    expect(typeof out.latency_ms).toBe('number');
  });

  it('strips wrapping code fences without touching inner tags', async () => {
    messagesCreate.mockResolvedValueOnce(
      textBlock('```\n<emotion value="warm">welcome back</emotion>\n```'),
    );
    const out = await banterDispatch(makeInput());
    expect(out.ok).toBe(true);
    expect(out.rewritten).toBe('<emotion value="warm">welcome back</emotion>');
  });

  it('strips wrapping straight quotes without touching apostrophes', async () => {
    messagesCreate.mockResolvedValueOnce(textBlock('"that\'s the headline number."'));
    const out = await banterDispatch(makeInput());
    expect(out.ok).toBe(true);
    expect(out.rewritten).toBe("that's the headline number.");
  });
});

describe('banterDispatch — onCall trace hook', () => {
  it('fires onCall with layer="banter:dispatch" on success', async () => {
    messagesCreate.mockResolvedValueOnce(textBlock('hi'));
    const traces: LlmCallTrace[] = [];
    await banterDispatch(makeInput({ onCall: (t) => traces.push(t) }));
    expect(traces).toHaveLength(1);
    expect(traces[0]!.layer).toBe('banter:dispatch');
    expect(traces[0]!.ok).toBe(true);
    expect(traces[0]!.response).toBe('hi');
    expect(traces[0]!.systemPrompt).toContain('BANTER-DISPATCH');
  });

  it('fires onCall with ok=false and error reason on SDK throw', async () => {
    messagesCreate.mockRejectedValueOnce(new Error('rate-limited'));
    const traces: LlmCallTrace[] = [];
    const out = await banterDispatch(makeInput({ onCall: (t) => traces.push(t) }));
    expect(out.ok).toBe(false);
    expect(traces).toHaveLength(1);
    expect(traces[0]!.ok).toBe(false);
    expect(traces[0]!.error).toContain('rate-limited');
  });
});

describe('banterDispatch — prompt threading', () => {
  it('threads history, target, and authored text into the user message', async () => {
    messagesCreate.mockResolvedValueOnce(textBlock('ok.'));
    await banterDispatch(
      makeInput({
        say: { text: 'Two hours, forty-one minutes later.', target: 'two_hours' },
        recentHistory: [
          { role: 'user', text: 'hey' },
          { role: 'pat', text: 'hey, what is up' },
        ],
      }),
    );
    const callArgs = messagesCreate.mock.calls[0]![0] as { system: string; messages: Array<{ content: string }> };
    const userMsg = callArgs.messages[0]!.content;
    expect(userMsg).toContain('<history>');
    expect(userMsg).toContain('[user] hey');
    expect(userMsg).toContain('[you] hey, what is up');
    expect(userMsg).toContain('<about_target>two_hours</about_target>');
    expect(userMsg).toContain('<authored_say>');
    expect(userMsg).toContain('Two hours, forty-one minutes later.');
  });

  it('appends the scenario block to the system prompt when scenario is set', async () => {
    messagesCreate.mockResolvedValueOnce(textBlock('ok.'));
    const scenario: ScenarioContext = {
      slug: 'palisade-replication',
      kind: 'presentation',
      title: 'Self-replication demo',
      audience: 'Senate staffer',
      tone: 'Sober. No hype.',
      delivery_started: true,
    };
    await banterDispatch(makeInput({ scenario }));
    const callArgs = messagesCreate.mock.calls[0]![0] as { system: string };
    expect(callArgs.system).toContain('BANTER-DISPATCH');
    expect(callArgs.system).toContain('<scenario>');
    expect(callArgs.system).toContain('palisade-replication');
    expect(callArgs.system).toContain('<scenario_tone>');
    expect(callArgs.system).toContain('Sober. No hype.');
  });

  it('omits <history> and <about_target> when not provided', async () => {
    messagesCreate.mockResolvedValueOnce(textBlock('ok.'));
    await banterDispatch(makeInput());
    const callArgs = messagesCreate.mock.calls[0]![0] as { messages: Array<{ content: string }> };
    const userMsg = callArgs.messages[0]!.content;
    expect(userMsg).not.toContain('<history>');
    expect(userMsg).not.toContain('<about_target>');
    expect(userMsg).toContain('<authored_say>');
  });
});

describe('banterDispatch — failure fallbacks', () => {
  it('returns ok=false with raw fallback when API key missing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const out = await banterDispatch(makeInput({ say: { text: 'authored line.' } }));
    expect(out.ok).toBe(false);
    expect(out.rewritten).toBe('authored line.'); // fallback to raw
    expect(out.raw).toBe('authored line.');
    expect(out.error).toContain('no API key');
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('returns ok=false with raw fallback on SDK error', async () => {
    messagesCreate.mockRejectedValueOnce(new Error('boom'));
    const out = await banterDispatch(makeInput({ say: { text: 'authored line.' } }));
    expect(out.ok).toBe(false);
    expect(out.rewritten).toBe('authored line.');
    expect(out.error).toContain('boom');
  });

  it('returns ok=false on empty model output', async () => {
    messagesCreate.mockResolvedValueOnce(textBlock(''));
    const out = await banterDispatch(makeInput());
    expect(out.ok).toBe(false);
    expect(out.error).toContain('cleaned to empty');
  });

  it('returns ok=false when no text block in response', async () => {
    messagesCreate.mockResolvedValueOnce({ content: [] });
    const out = await banterDispatch(makeInput());
    expect(out.ok).toBe(false);
    expect(out.error).toContain('no text block');
  });
});

describe('banterDispatch — circuit breaker', () => {
  it('short-circuits to failure after 3 consecutive errors', async () => {
    messagesCreate
      .mockRejectedValueOnce(new Error('1'))
      .mockRejectedValueOnce(new Error('2'))
      .mockRejectedValueOnce(new Error('3'));
    expect((await banterDispatch(makeInput())).ok).toBe(false);
    expect((await banterDispatch(makeInput())).ok).toBe(false);
    expect((await banterDispatch(makeInput())).ok).toBe(false);
    expect(messagesCreate).toHaveBeenCalledTimes(3);
    // 4th call short-circuits — SDK NOT invoked.
    const out = await banterDispatch(makeInput());
    expect(out.ok).toBe(false);
    expect(out.error).toContain('circuit-breaker');
    expect(messagesCreate).toHaveBeenCalledTimes(3);
  });

  it('resets the failure counter on success', async () => {
    messagesCreate
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(textBlock('back online.'));
    expect((await banterDispatch(makeInput())).ok).toBe(false);
    const out = await banterDispatch(makeInput());
    expect(out.ok).toBe(true);
    expect(out.rewritten).toBe('back online.');
  });
});

describe('banterDispatch — cancellation', () => {
  it('returns ok=false with reason=aborted when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const out = await banterDispatch(makeInput({ signal: controller.signal }));
    expect(out.ok).toBe(false);
    expect(out.error).toBe('aborted');
    expect(out.rewritten).toBe(out.raw); // fallback to authored
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('does not count caller-cancels toward the circuit breaker', async () => {
    const controller = new AbortController();
    controller.abort();
    // Three caller-cancels in a row should NOT open the breaker — the
    // failure counter only ticks on actual model/SDK failures.
    await banterDispatch(makeInput({ signal: controller.signal }));
    await banterDispatch(makeInput({ signal: controller.signal }));
    await banterDispatch(makeInput({ signal: controller.signal }));
    // After three aborts, a real call should still hit the SDK.
    messagesCreate.mockResolvedValueOnce(textBlock('healthy.'));
    const out = await banterDispatch(makeInput());
    expect(out.ok).toBe(true);
    expect(messagesCreate).toHaveBeenCalledTimes(1);
  });
});

afterAll(() => {
  if (ORIGINAL_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ORIGINAL_API_KEY;
});
