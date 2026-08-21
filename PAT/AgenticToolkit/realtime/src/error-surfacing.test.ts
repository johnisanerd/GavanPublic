/**
 * Error-surfacing tests.
 *
 * Two layers:
 *   1. Deterministic: `decideAnnounce` + `summarizeForVoice` — debounce,
 *      flag gate, template shape. No LLM.
 *   2. model-phrased: `phraseErrorForVoice` + `phraseErrorAnnounce` —
 *      task #36 reframe. Verbatim error preservation, deterministic
 *      fallback on model failure, circuit breaker, trace hook shape.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const messagesCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: messagesCreate };
  },
}));

import {
  DEBOUNCE_WINDOW_MS,
  decideAnnounce,
  phraseErrorAnnounce,
  phraseErrorForVoice,
  resetDebounce,
  resetErrorSurfacingFailures,
  summarizeForVoice,
} from './error-surfacing.js';
import type { LlmCallTrace } from './banter.js';

function textBlock(text: string) {
  return { content: [{ type: 'text', text }] };
}

const ORIGINAL_API_KEY = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  messagesCreate.mockReset();
  resetDebounce();
  resetErrorSurfacingFailures();
  process.env.ANTHROPIC_API_KEY = 'sk-test-stub';
});

afterEach(() => {
  if (ORIGINAL_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ORIGINAL_API_KEY;
});

// ── Deterministic layer (unchanged from Wave 3.1) ─────────────────────

describe('summarizeForVoice', () => {
  it('back-mind-tool with no error text', () => {
    const out = summarizeForVoice({ source: 'back-mind-tool', tool: 'Read', errorText: '' });
    expect(out).toBe('Hmm, one of my tools just failed (Read).');
  });

  it('back-mind-tool with error text — folds first sentence in', () => {
    const out = summarizeForVoice({
      source: 'back-mind-tool',
      tool: 'Bash',
      errorText: 'Command not found: foo. More context follows.',
    });
    expect(out).toBe('Hmm, one of my tools just failed (Bash) — Command not found: foo');
  });

  it('rendition source is the soft path', () => {
    const out = summarizeForVoice({ source: 'rendition', errorText: 'whatever' });
    expect(out).toBe(`Hmm, I had trouble phrasing my reply — passing it through plain.`);
  });

  it('host-routing folds the error in', () => {
    const out = summarizeForVoice({
      source: 'host-routing',
      errorText: 'session resolution failed',
    });
    expect(out).toBe(`Hmm, I couldn't route your message internally — session resolution failed.`);
  });

  it('back-mind-sandbox without error falls back to "restarting"', () => {
    const out = summarizeForVoice({ source: 'back-mind-sandbox', errorText: '' });
    expect(out).toBe('Hmm, my sandbox just dropped — restarting.');
  });

  it('truncates oversized errorText to a single sentence', () => {
    const long = 'X'.repeat(500);
    const out = summarizeForVoice({ source: 'back-mind-tool', tool: 'WebFetch', errorText: long });
    // No sentence boundary, so it falls back to a 120-char slice.
    expect(out.length).toBeLessThan(200);
    expect(out.startsWith('Hmm, one of my tools just failed (WebFetch) — ')).toBe(true);
  });
});

describe('decideAnnounce', () => {
  it('first error of a source → announces with text', () => {
    const d = decideAnnounce({ source: 'back-mind-tool', tool: 'Read', errorText: 'ENOENT' }, 1_000);
    expect(d.announced).toBe(true);
    expect(d.spokenText).toContain('Read');
    expect(d.debounceSuppressed).toBe(false);
  });

  it('second error of same source within window → debounce-suppressed', () => {
    decideAnnounce({ source: 'back-mind-tool', tool: 'Read', errorText: 'ENOENT' }, 1_000);
    const d = decideAnnounce(
      { source: 'back-mind-tool', tool: 'Read', errorText: 'EPERM' },
      1_000 + 500, // 500ms later
    );
    expect(d.announced).toBe(false);
    expect(d.spokenText).toBe('');
    expect(d.debounceSuppressed).toBe(true);
  });

  it('second error of same source AFTER window → announces again', () => {
    decideAnnounce({ source: 'back-mind-tool', tool: 'Read', errorText: 'ENOENT' }, 1_000);
    const d = decideAnnounce(
      { source: 'back-mind-tool', tool: 'Read', errorText: 'EPERM' },
      1_000 + DEBOUNCE_WINDOW_MS + 1,
    );
    expect(d.announced).toBe(true);
    expect(d.debounceSuppressed).toBe(false);
  });

  it('different sources do not share debounce', () => {
    decideAnnounce({ source: 'back-mind-tool', tool: 'Read', errorText: 'x' }, 1_000);
    const d = decideAnnounce(
      { source: 'rendition', errorText: 'y' },
      1_000 + 100, // same instant, different source
    );
    expect(d.announced).toBe(true);
    expect(d.debounceSuppressed).toBe(false);
  });
});

// ── model phrasing layer (task #36) ──────────────────────────────────

describe('phraseErrorForVoice — model happy path', () => {
  it('returns the model output verbatim (cleaned)', async () => {
    messagesCreate.mockResolvedValueOnce(
      textBlock('Hmm, my Read tool just choked — ENOENT, no such file or directory, /foo/bar.ts.'),
    );
    const out = await phraseErrorForVoice({
      source: 'back-mind-tool',
      tool: 'Read',
      errorText: "ENOENT: no such file or directory, open '/foo/bar.ts'",
    });
    expect(out).toBe('Hmm, my Read tool just choked — ENOENT, no such file or directory, /foo/bar.ts.');
  });

  it('passes the verbatim error into the user message', async () => {
    messagesCreate.mockResolvedValueOnce(textBlock('hmm, it failed'));
    const verbatim = "Actor run failed: timed out after 60 seconds";
    await phraseErrorForVoice({ source: 'back-mind-mcp', tool: 'mcp__apify__call-actor', errorText: verbatim });
    const call = messagesCreate.mock.calls[0]![0] as { messages: { content: string }[]; system: string };
    expect(call.messages[0]!.content).toContain(verbatim);
    expect(call.messages[0]!.content).toContain('<source>back-mind-mcp</source>');
    expect(call.messages[0]!.content).toContain('<tool>mcp__apify__call-actor</tool>');
  });

  it('system prompt instructs the model to surface the error verbatim', async () => {
    messagesCreate.mockResolvedValueOnce(textBlock('hmm, failed'));
    await phraseErrorForVoice({ source: 'rendition', errorText: 'oops' });
    const call = messagesCreate.mock.calls[0]![0] as { system: string };
    expect(call.system).toContain('verbatim');
  });

  it('strips wrapping quotes and fences from model output', async () => {
    messagesCreate.mockResolvedValueOnce(textBlock('"Hmm, network failed — ETIMEDOUT."'));
    const out = await phraseErrorForVoice({ source: 'back-mind-tool', tool: 'WebFetch', errorText: 'ETIMEDOUT' });
    expect(out).toBe('Hmm, network failed — ETIMEDOUT.');
  });

  it('truncates oversized error text but keeps head+tail in the prompt', async () => {
    messagesCreate.mockResolvedValueOnce(textBlock('hmm, big error'));
    const huge = 'A'.repeat(3000);
    await phraseErrorForVoice({ source: 'back-mind-tool', tool: 'Bash', errorText: huge });
    const call = messagesCreate.mock.calls[0]![0] as { messages: { content: string }[] };
    expect(call.messages[0]!.content).toContain('…[truncated]…');
  });

  it('fires the onCall trace hook with layer = error-surfacing:phrase', async () => {
    messagesCreate.mockResolvedValueOnce(textBlock('hmm'));
    const traces: LlmCallTrace[] = [];
    await phraseErrorForVoice(
      { source: 'narration', errorText: 'oops' },
      { onCall: (t) => traces.push(t) },
    );
    expect(traces).toHaveLength(1);
    expect(traces[0]!.layer).toBe('error-surfacing:phrase');
    expect(traces[0]!.ok).toBe(true);
  });
});

describe('phraseErrorForVoice — fallbacks (return deterministic template, no throw)', () => {
  it('no ANTHROPIC_API_KEY → deterministic fallback', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const out = await phraseErrorForVoice({ source: 'back-mind-tool', tool: 'Read', errorText: 'ENOENT' });
    expect(out).toBe(summarizeForVoice({ source: 'back-mind-tool', tool: 'Read', errorText: 'ENOENT' }));
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('SDK throws → deterministic fallback', async () => {
    messagesCreate.mockRejectedValueOnce(new Error('connection refused'));
    const out = await phraseErrorForVoice({ source: 'back-mind-tool', tool: 'Read', errorText: 'ENOENT' });
    expect(out).toContain('Hmm, one of my tools just failed (Read)');
  });

  it('model returns empty/silent text → deterministic fallback', async () => {
    messagesCreate.mockResolvedValueOnce(textBlock(''));
    const out = await phraseErrorForVoice({ source: 'rendition', errorText: 'oops' });
    expect(out).toBe(summarizeForVoice({ source: 'rendition', errorText: 'oops' }));
  });

  it('circuit-breaker opens after 3 consecutive failures', async () => {
    // Three SDK throws to trip the breaker.
    messagesCreate.mockRejectedValue(new Error('boom'));
    for (let i = 0; i < 3; i++) {
      await phraseErrorForVoice({ source: 'back-mind-tool', tool: 'Read', errorText: 'x' });
    }
    // Fourth call must NOT hit the SDK.
    messagesCreate.mockClear();
    const out = await phraseErrorForVoice({ source: 'back-mind-tool', tool: 'Read', errorText: 'still failing' });
    expect(messagesCreate).not.toHaveBeenCalled();
    expect(out).toContain('Hmm, one of my tools just failed (Read)');
  });
});

describe('phraseErrorAnnounce — decision + phrasing combined', () => {
  it('flag-off path: returns decideAnnounce result, never calls the model', async () => {
    // Easiest way to simulate flag-off without re-importing: use the
    // debounce path. Stamp the announce, then call again immediately
    // to force a debounce-suppress.
    decideAnnounce({ source: 'rendition', errorText: 'x' }, 1_000);
    const out = await phraseErrorAnnounce({ source: 'rendition', errorText: 'x' }, undefined, 1_100);
    expect(out.announced).toBe(false);
    expect(out.spokenText).toBe('');
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('announces with model-phrased text on the happy path', async () => {
    messagesCreate.mockResolvedValueOnce(textBlock('Hmm, Read just choked — ENOENT, /foo.'));
    const out = await phraseErrorAnnounce(
      { source: 'back-mind-tool', tool: 'Read', errorText: 'ENOENT' },
      undefined,
      1_000,
    );
    expect(out.announced).toBe(true);
    expect(out.spokenText).toBe('Hmm, Read just choked — ENOENT, /foo.');
    expect(out.debounceSuppressed).toBe(false);
  });

  it('model-fails fallback still announces (with deterministic template)', async () => {
    messagesCreate.mockRejectedValueOnce(new Error('sdk gone'));
    const out = await phraseErrorAnnounce(
      { source: 'back-mind-tool', tool: 'Read', errorText: 'ENOENT' },
      undefined,
      1_000,
    );
    expect(out.announced).toBe(true);
    expect(out.spokenText).toContain('Hmm, one of my tools just failed (Read)');
  });
});
