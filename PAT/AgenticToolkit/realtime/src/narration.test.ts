/**
 * Narrator tests — pure logic, no network.
 *
 * Model calls mocked via the injectable `narrationCall` option. Time
 * controlled via injectable `now`. Tick driven manually via `tickOnce()`.
 *
 * Cadence model under test:
 *   - isProcessingNarration is host-driven (callback). Narrator never
 *     infers it from observed events.
 *   - Max-silence gate: next fire time = (projected end of last
 *     utterance) + MAX_SILENCE_MS. The first fire is gated only by
 *     isProcessingNarration + !isTtsBusy (nextFireEarliestAt = 0).
 *   - No event-freshness gate. No event-count gate. Narrator can fire
 *     even with an empty events buffer (the prompt has fallback lines).
 */
import { describe, it, expect } from 'vitest';
import {
  Narrator,
  MAX_SILENCE_MS,
  TTS_CHARS_PER_SEC,
  TTS_TAIL_PAD_MS,
  cleanUtterance,
  type DetailEvent,
  type NarrationCallRequest,
  type NarrationCallResponse,
} from './narration.js';

interface Harness {
  narrator: Narrator;
  utterances: string[];
  narrationCalls: NarrationCallRequest[];
  ttsBusy: () => boolean;
  setBusy: (b: boolean) => void;
  isProcessing: () => boolean;
  setProcessing: (b: boolean) => void;
  advance: (ms: number) => void;
  now: () => number;
}

function makeHarness(opts: { reply?: string | null; processing?: boolean } = {}): Harness {
  let busy = false;
  let processing = opts.processing ?? true;
  let nowMs = 1_000_000;
  const utterances: string[] = [];
  const narrationCalls: NarrationCallRequest[] = [];
  const reply: string | null = 'reply' in opts ? (opts.reply ?? null) : 'looking at the config now';
  const narrator = new Narrator({
    onUtterance: (text) => utterances.push(text),
    narrationCall: async (req): Promise<NarrationCallResponse> => {
      narrationCalls.push(req);
      return { utterance: reply };
    },
    isTtsBusy: () => busy,
    isProcessingNarration: () => processing,
    now: () => nowMs,
    autoTick: false,
  });
  return {
    narrator,
    utterances,
    narrationCalls,
    ttsBusy: () => busy,
    setBusy: (b) => {
      busy = b;
    },
    isProcessing: () => processing,
    setProcessing: (b) => {
      processing = b;
    },
    advance: (ms) => {
      nowMs += ms;
    },
    now: () => nowMs,
  };
}

const evt = (type: string): DetailEvent => ({ type });

describe('Narrator — host-driven gating', () => {
  it('fires the model and broadcasts when isProcessing=true and TTS is free', async () => {
    const h = makeHarness();
    h.narrator.observe(evt('tool-pre'));
    await h.narrator.tickOnce();
    expect(h.narrationCalls).toHaveLength(1);
    expect(h.utterances).toEqual(['looking at the config now']);
  });

  it('does NOT fire when isProcessing=false', async () => {
    const h = makeHarness({ processing: false });
    h.narrator.observe(evt('tool-pre'));
    await h.narrator.tickOnce();
    expect(h.narrationCalls).toHaveLength(0);
    expect(h.utterances).toEqual([]);
  });

  it('does NOT fire when TTS is busy', async () => {
    const h = makeHarness();
    h.setBusy(true);
    h.narrator.observe(evt('tool-pre'));
    await h.narrator.tickOnce();
    expect(h.narrationCalls).toHaveLength(0);
  });

  it('fires when isProcessing flips on, even with NO events buffered', async () => {
    // Cold-spawn case: forward decided, no tool events yet, but the
    // Narrator should still fill silence.
    const h = makeHarness();
    expect(h.narrator.peekProgressText()).toBe('');
    await h.narrator.tickOnce();
    expect(h.narrationCalls).toHaveLength(1);
    expect(h.utterances).toHaveLength(1);
  });

  it('stops firing when host flips isProcessing=false mid-call sequence', async () => {
    const h = makeHarness();
    h.narrator.observe(evt('tool-pre'));
    await h.narrator.tickOnce();
    expect(h.narrationCalls).toHaveLength(1);
    h.setProcessing(false);
    h.advance(MAX_SILENCE_MS + TTS_TAIL_PAD_MS + 5000); // way past max-silence
    h.narrator.observe(evt('tool-post'));
    await h.narrator.tickOnce();
    expect(h.narrationCalls).toHaveLength(1);
  });
});

describe('Narrator — max-silence cadence', () => {
  it('after firing, next fire is gated by (projected utterance end + MAX_SILENCE_MS)', async () => {
    const reply = 'looking at the config now'; // 25 chars
    const h = makeHarness({ reply });
    h.narrator.observe(evt('tool-pre'));
    await h.narrator.tickOnce();
    expect(h.narrationCalls).toHaveLength(1);

    // The projected duration of `reply` is 25/11 * 1000 + TTS_TAIL_PAD_MS ms.
    // Until that elapses + MAX_SILENCE_MS, no second fire.
    const estDurMs = (reply.length / TTS_CHARS_PER_SEC) * 1000 + TTS_TAIL_PAD_MS;
    h.advance(estDurMs + MAX_SILENCE_MS - 100); // just shy of allowed
    h.narrator.observe(evt('tool-post'));
    await h.narrator.tickOnce();
    expect(h.narrationCalls).toHaveLength(1);

    h.advance(200); // now past the gate
    await h.narrator.tickOnce();
    expect(h.narrationCalls).toHaveLength(2);
  });

  it('first fire happens immediately (nextFireEarliestAt starts at 0)', async () => {
    // Verifies the cold-spawn UX: as soon as host sets isProcessing=true,
    // the very next tick fires without waiting for a synthetic gap.
    const h = makeHarness();
    await h.narrator.tickOnce();
    expect(h.narrationCalls).toHaveLength(1);
  });

  it('long utterance gets a longer post-utterance silence than a short one', async () => {
    const longReply = 'a'.repeat(110); // ~10s of TTS
    const shortReply = 'short'; // ~1.5s of TTS
    const longH = makeHarness({ reply: longReply });
    const shortH = makeHarness({ reply: shortReply });
    longH.narrator.observe(evt('tool-pre'));
    shortH.narrator.observe(evt('tool-pre'));
    await Promise.all([longH.narrator.tickOnce(), shortH.narrator.tickOnce()]);

    // Advance both by the SHORT utterance's expected duration + max-silence.
    // The short one should be ready, the long one should still be gated.
    const shortDurMs = (shortReply.length / TTS_CHARS_PER_SEC) * 1000 + TTS_TAIL_PAD_MS;
    longH.advance(shortDurMs + MAX_SILENCE_MS + 100);
    shortH.advance(shortDurMs + MAX_SILENCE_MS + 100);
    await Promise.all([longH.narrator.tickOnce(), shortH.narrator.tickOnce()]);
    expect(shortH.narrationCalls).toHaveLength(2);
    expect(longH.narrationCalls).toHaveLength(1);
  });
});

describe('Narrator — concurrency / drop semantics', () => {
  it('does not start a second model call while one is in flight', async () => {
    let resolveCall: ((v: NarrationCallResponse) => void) | null = null;
    let nowMs = 1_000_000;
    const calls: NarrationCallRequest[] = [];
    const utterances: string[] = [];
    const narrator = new Narrator({
      onUtterance: (t) => utterances.push(t),
      narrationCall: (req) =>
        new Promise<NarrationCallResponse>((res) => {
          calls.push(req);
          resolveCall = res;
        }),
      isTtsBusy: () => false,
      isProcessingNarration: () => true,
      now: () => nowMs,
      autoTick: false,
    });
    narrator.observe(evt('tool-pre'));
    // Drive tick() directly (not tickOnce — that busy-waits for in-flight
    // to drain, which is exactly the state we want to OBSERVE here).
    // tick() kicks off `void this.fire(...)` and returns immediately.
    await (narrator as unknown as { tick: () => Promise<void> }).tick();
    expect(calls).toHaveLength(1);
    // Second tick during in-flight should bail on isGeneratingNarration.
    nowMs += 10000;
    narrator.observe(evt('tool-post'));
    await (narrator as unknown as { tick: () => Promise<void> }).tick();
    expect(calls).toHaveLength(1);
    // Resolve the pending call; the broadcast lands.
    resolveCall!({ utterance: 'one line' });
    await new Promise((r) => setImmediate(r));
    expect(utterances).toEqual(['one line']);
  });

  it('drops the utterance if TTS got busy while the model was thinking', async () => {
    let busy = false;
    let nowMs = 1_000_000;
    const utterances: string[] = [];
    const narrator = new Narrator({
      onUtterance: (text) => utterances.push(text),
      narrationCall: async () => {
        busy = true; // simulate banter / chat slipping in
        return { utterance: 'should be dropped' };
      },
      isTtsBusy: () => busy,
      isProcessingNarration: () => true,
      now: () => nowMs,
      autoTick: false,
    });
    narrator.observe(evt('tool-pre'));
    await narrator.tickOnce();
    expect(utterances).toEqual([]);
  });

  it('null/empty utterance from the model produces no broadcast', async () => {
    const h = makeHarness({ reply: null });
    h.narrator.observe(evt('tool-pre'));
    await h.narrator.tickOnce();
    expect(h.utterances).toEqual([]);
  });
});

describe('Narrator — observe()', () => {
  it('drops query-start / query-end events (host owns the gate)', async () => {
    const h = makeHarness({ processing: false });
    h.narrator.observe(evt('query-start'));
    h.narrator.observe(evt('query-end'));
    h.narrator.observe(evt('tool-pre'));
    // Even with a tool-pre buffered, isProcessing=false → no fire.
    await h.narrator.tickOnce();
    expect(h.narrationCalls).toHaveLength(0);
  });

  it('drops non-substantive events (token-delta, compact)', async () => {
    const h = makeHarness();
    h.narrator.observe(evt('token-delta'));
    h.narrator.observe(evt('compact'));
    // Neither lands in the buffer; firing still works on the empty buffer.
    await h.narrator.tickOnce();
    expect(h.narrationCalls).toHaveLength(1);
    expect(h.narrationCalls[0]!.recentEvents).toHaveLength(0);
  });

  it('events buffer is bounded — old events fall out under burst', async () => {
    const h = makeHarness();
    for (let i = 0; i < 50; i++) h.narrator.observe(evt(i % 2 === 0 ? 'tool-pre' : 'tool-post'));
    await h.narrator.tickOnce();
    const lastReq = h.narrationCalls.at(-1);
    expect(lastReq).toBeDefined();
    expect(lastReq!.recentEvents.length).toBeLessThanOrEqual(12);
  });
});

describe('cleanUtterance — plain-text contract', () => {
  // Prompt now instructs plain text (no JSON wrapper) so streaming consumers
  // can speak deltas directly. cleanUtterance is forgiving about common
  // model output variations.
  it('passes raw plain text through unchanged', () => {
    expect(cleanUtterance('looking at the config now').utterance).toBe(
      'looking at the config now',
    );
  });

  it('trims surrounding whitespace', () => {
    expect(cleanUtterance('  one moment  \n').utterance).toBe('one moment');
  });

  it('strips wrapping double quotes', () => {
    expect(cleanUtterance('"opening the auth file."').utterance).toBe(
      'opening the auth file.',
    );
  });

  it('strips wrapping single quotes', () => {
    expect(cleanUtterance("'still searching'").utterance).toBe('still searching');
  });

  it('strips an accidental markdown code fence', () => {
    expect(cleanUtterance('```\nstill working\n```').utterance).toBe('still working');
    expect(cleanUtterance('```text\nfound it\n```').utterance).toBe('found it');
  });

  it('preserves inline Cartesia voice tags', () => {
    expect(
      cleanUtterance('<emotion value="excited">found something!</emotion>').utterance,
    ).toBe('<emotion value="excited">found something!</emotion>');
    expect(cleanUtterance('twelve matches [laughter] in the codebase.').utterance).toBe(
      'twelve matches [laughter] in the codebase.',
    );
  });

  it('returns null on empty input (after trim/strip)', () => {
    expect(cleanUtterance('').utterance).toBeNull();
    expect(cleanUtterance('   \n   ').utterance).toBeNull();
    expect(cleanUtterance('""').utterance).toBeNull();
  });
});
