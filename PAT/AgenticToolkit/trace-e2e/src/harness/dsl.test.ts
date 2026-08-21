/**
 * Unit tests for the trace-e2e DSL.
 *
 * Uses a synthetic EventStream (not the live SSE one) so the tests run
 * fast and deterministically. The shape of the synthetic stream
 * mirrors the real one — events array + onEach listener registration —
 * so the DSL doesn't know it's being tested.
 */
import { describe, test, expect, vi } from 'vitest';
import type { LogEvent } from './types.js';
import type { EventStream } from './stream.js';
import { createTraceLog, TraceTimeoutError } from './dsl.js';

function ev(kind: string, tsMs: number, data: Record<string, unknown> = {}): LogEvent {
  return {
    ts: new Date(tsMs).toISOString(),
    kind,
    data,
    source: 'nanoclaw-host',
  };
}

/** Build a stream with `initial` events already captured and a controlled
 *  push surface for adding more during the test. */
function fakeStream(initial: LogEvent[] = []): {
  stream: EventStream;
  push: (e: LogEvent) => void;
} {
  const events: LogEvent[] = [...initial];
  const listeners = new Set<(e: LogEvent) => void>();
  const stream: EventStream = {
    events,
    onEach(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      listeners.clear();
    },
    ready: Promise.resolve(),
  };
  return {
    stream,
    push(e) {
      events.push(e);
      for (const l of listeners) l(e);
    },
  };
}

describe('waitFor', () => {
  test('resolves immediately if the event already exists in the buffer (default since=0)', async () => {
    const { stream } = fakeStream([
      ev('foo.happened', 1000),
      ev('bar.happened', 2000),
    ]);
    const log = createTraceLog(stream);
    const e = await log.waitFor('foo.happened', { within: 100 });
    expect(e.kind).toBe('foo.happened');
  });

  test('resolves when a matching event arrives after waitFor starts', async () => {
    const { stream, push } = fakeStream();
    const log = createTraceLog(stream);
    const promise = log.waitFor('foo.happened', { within: 1000 });
    // Push after a tick so we exercise the listener path, not the
    // already-captured fast path.
    setTimeout(() => push(ev('foo.happened', Date.now())), 10);
    const e = await promise;
    expect(e.kind).toBe('foo.happened');
  });

  test('applies the predicate filter', async () => {
    const { stream, push } = fakeStream();
    const log = createTraceLog(stream);
    const promise = log.waitFor(
      'request-layer.decided',
      (e) => (e.data.decision as string) === 'forward',
      { within: 1000 },
    );
    setTimeout(() => push(ev('request-layer.decided', Date.now(), { decision: 'banter' })), 10);
    setTimeout(() => push(ev('request-layer.decided', Date.now(), { decision: 'forward' })), 30);
    const e = await promise;
    expect(e.data.decision).toBe('forward');
  });

  test('respects since: prior event is filtered out by ts', async () => {
    const t0 = Date.now() - 1000;
    const t1 = Date.now();
    const { stream } = fakeStream([
      ev('foo.happened', t0, { tag: 'old' }),
      ev('foo.happened', t1, { tag: 'new' }),
    ]);
    const log = createTraceLog(stream);
    // Use the t0 event as the anchor; expect the t1 event to be the
    // first match.
    const since = stream.events[0]!;
    const e = await log.waitFor('foo.happened', null, { within: 100, since });
    expect(e.data.tag).toBe('new');
  });

  test('default since=0 — does NOT filter out events captured before waitFor was called', async () => {
    // This is the regression test for the bug found 2026-05-18:
    // request-layer.decided fired during sendUser's SSE drain (before
    // waitFor started). The old default since=Date.now() filtered it
    // out. The fix is default since=0 → events already in buffer are
    // eligible.
    const { stream } = fakeStream([
      ev('request-layer.decided', Date.now() - 500, { decision: 'forward' }),
    ]);
    // Sleep a beat so "now" is comfortably after the event ts.
    await new Promise((r) => setTimeout(r, 20));
    const log = createTraceLog(stream);
    const e = await log.waitFor(
      'request-layer.decided',
      (x) => (x.data.decision as string) === 'forward',
      { within: 100 },
    );
    expect(e.data.decision).toBe('forward');
  });

  test('times out with TraceTimeoutError if no match arrives', async () => {
    const { stream, push } = fakeStream();
    const log = createTraceLog(stream);
    const promise = log.waitFor('foo.happened', { within: 50 });
    // Push a non-matching event so the tail has something.
    setTimeout(() => push(ev('bar.happened', Date.now(), { detail: 'context' })), 10);
    await expect(promise).rejects.toThrow(TraceTimeoutError);
  });

  test('TraceTimeoutError carries waitingFor, elapsedMs, and tail', async () => {
    const { stream, push } = fakeStream();
    const log = createTraceLog(stream);
    const promise = log.waitFor(
      'foo.happened',
      (e) => Boolean(e.data.flag),
      { within: 50, describe: "flag=true" },
    );
    setTimeout(() => push(ev('bar.happened', Date.now())), 10);
    try {
      await promise;
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(TraceTimeoutError);
      const err = e as TraceTimeoutError;
      expect(err.waitingFor).toContain('foo.happened');
      expect(err.waitingFor).toContain('flag=true');
      expect(err.elapsedMs).toBeGreaterThanOrEqual(40);
      expect(err.tail.length).toBeGreaterThan(0);
      expect(err.message).toContain('foo.happened');
    }
  });

  test('TraceTimeoutError includes most-recent of related kinds when configured', async () => {
    const { stream } = fakeStream([
      ev('chat.row-received', Date.now() - 1000, { preview: 'old chat row' }),
      ev('detail.row-received', Date.now() - 500, { type: 'query-end' }),
    ]);
    const log = createTraceLog(stream);
    try {
      // scenario.tag-stream-started has chat.row-received in its
      // RELATED_KINDS list per dsl.ts.
      await log.waitFor('scenario.tag-stream-started', { within: 30 });
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as TraceTimeoutError;
      expect(err.relatedMostRecent['chat.row-received']).toBeDefined();
      expect((err.relatedMostRecent['chat.row-received']!.data as { preview: string }).preview).toBe('old chat row');
    }
  });

  test('supports the two-arg shorthand (kind, opts) when no predicate', async () => {
    const { stream } = fakeStream([ev('foo', 1000)]);
    const log = createTraceLog(stream);
    const e = await log.waitFor('foo', { within: 100 });
    expect(e.kind).toBe('foo');
  });
});

describe('expectSequence', () => {
  test('waits for ordered steps; events between steps are allowed', async () => {
    const { stream, push } = fakeStream();
    const log = createTraceLog(stream);
    const promise = log.expectSequence(
      [{ kind: 'a' }, { kind: 'b' }, { kind: 'c' }],
      { within: 500 },
    );
    setTimeout(() => push(ev('a', Date.now())), 10);
    setTimeout(() => push(ev('x', Date.now())), 20); // interleaved, allowed
    setTimeout(() => push(ev('b', Date.now())), 30);
    setTimeout(() => push(ev('c', Date.now())), 40);
    const out = await promise;
    expect(out.map((e) => e.kind)).toEqual(['a', 'b', 'c']);
  });

  test('applies per-step predicates', async () => {
    const { stream, push } = fakeStream();
    const log = createTraceLog(stream);
    const promise = log.expectSequence(
      [
        { kind: 'request-layer.decided', predicate: (e) => (e.data.decision as string) === 'forward' },
        { kind: 'utterance.stream-started' },
      ],
      { within: 500 },
    );
    setTimeout(() => push(ev('request-layer.decided', Date.now(), { decision: 'banter' })), 10);
    setTimeout(() => push(ev('request-layer.decided', Date.now(), { decision: 'forward' })), 30);
    setTimeout(() => push(ev('utterance.stream-started', Date.now(), {})), 50);
    const out = await promise;
    expect(out[0]!.data.decision).toBe('forward');
    expect(out[1]!.kind).toBe('utterance.stream-started');
  });

  test('throws TraceTimeoutError if the budget exhausts before later steps complete', async () => {
    const { stream, push } = fakeStream();
    const log = createTraceLog(stream);
    const promise = log.expectSequence(
      [{ kind: 'a' }, { kind: 'b' }],
      { within: 100 },
    );
    setTimeout(() => push(ev('a', Date.now())), 10);
    // never push 'b'
    await expect(promise).rejects.toThrow(TraceTimeoutError);
  });
});

describe('between', () => {
  test('count() over a captured window', () => {
    const t0 = 1000;
    const { stream } = fakeStream([
      ev('start', t0),
      ev('hit', t0 + 100),
      ev('hit', t0 + 200),
      ev('miss', t0 + 250),
      ev('hit', t0 + 300),
      ev('end', t0 + 400),
      ev('hit', t0 + 500), // outside window
    ]);
    const log = createTraceLog(stream);
    const start = stream.events[0]!;
    const end = stream.events[5]!;
    expect(log.between(start, end).count('hit')).toBe(3);
  });

  test('count() with predicate', () => {
    const { stream } = fakeStream([
      ev('start', 1000),
      ev('action', 1100, { type: 'prose' }),
      ev('action', 1200, { type: 'slide-nav' }),
      ev('action', 1300, { type: 'prose' }),
      ev('end', 1400),
    ]);
    const log = createTraceLog(stream);
    const start = stream.events[0]!;
    const end = stream.events[4]!;
    expect(
      log.between(start, end).count('action', (e) => e.data.type === 'prose'),
    ).toBe(2);
  });

  test('all() returns the matching events in capture order', () => {
    const { stream } = fakeStream([
      ev('start', 1000),
      ev('e', 1100, { i: 1 }),
      ev('e', 1200, { i: 2 }),
      ev('end', 1300),
    ]);
    const log = createTraceLog(stream);
    const matches = log.between(stream.events[0]!, stream.events[3]!).all('e');
    expect(matches.map((m) => m.data.i)).toEqual([1, 2]);
  });

  test('first() returns the earliest match in the window', () => {
    const { stream } = fakeStream([
      ev('start', 1000),
      ev('e', 1100, { i: 'first' }),
      ev('e', 1200, { i: 'second' }),
      ev('end', 1300),
    ]);
    const log = createTraceLog(stream);
    const f = log.between(stream.events[0]!, stream.events[3]!).first('e');
    expect((f!.data as { i: string }).i).toBe('first');
  });

  test('inclusive bounds — events with ts === start.ts or === end.ts are counted', () => {
    const t = 1000;
    const { stream } = fakeStream([
      ev('boundary', t),
      ev('boundary', t),
    ]);
    const log = createTraceLog(stream);
    expect(log.between(stream.events[0]!, stream.events[1]!).count('boundary')).toBe(2);
  });
});

describe('assertNot', () => {
  test('passes if no matching event fires within the window', async () => {
    const { stream, push } = fakeStream();
    const log = createTraceLog(stream);
    const promise = log.assertNot('error.surfaced', null, { within: 50 });
    setTimeout(() => push(ev('other', Date.now())), 10);
    await expect(promise).resolves.toBeUndefined();
  });

  test('fails immediately if a matching event fires within the window', async () => {
    const { stream, push } = fakeStream();
    const log = createTraceLog(stream);
    const promise = log.assertNot('error.surfaced', null, { within: 200 });
    setTimeout(() => push(ev('error.surfaced', Date.now(), { msg: 'boom' })), 10);
    await expect(promise).rejects.toThrow(/assertNot violated/);
  });

  test('predicate narrows what counts as a violation', async () => {
    const { stream, push } = fakeStream();
    const log = createTraceLog(stream);
    const promise = log.assertNot(
      'error.surfaced',
      (e) => (e.data.severity as string) === 'fatal',
      { within: 50 },
    );
    setTimeout(() => push(ev('error.surfaced', Date.now(), { severity: 'warn' })), 10);
    // The 'warn' event doesn't match the predicate, so assertNot should resolve.
    await expect(promise).resolves.toBeUndefined();
  });
});

describe('all / first (retrospective)', () => {
  test('all() returns every match in capture order', () => {
    const { stream } = fakeStream([
      ev('e', 1000, { i: 1 }),
      ev('other', 1100),
      ev('e', 1200, { i: 2 }),
    ]);
    const log = createTraceLog(stream);
    const got = log.all('e');
    expect(got.map((e) => e.data.i)).toEqual([1, 2]);
  });

  test('first() returns earliest match', () => {
    const { stream } = fakeStream([
      ev('e', 1000, { i: 'first' }),
      ev('e', 1100, { i: 'second' }),
    ]);
    const log = createTraceLog(stream);
    expect((log.first('e')!.data as { i: string }).i).toBe('first');
  });

  test('all() with predicate', () => {
    const { stream } = fakeStream([
      ev('e', 1000, { ok: true }),
      ev('e', 1100, { ok: false }),
      ev('e', 1200, { ok: true }),
    ]);
    const log = createTraceLog(stream);
    expect(log.all('e', (x) => x.data.ok === true).length).toBe(2);
  });
});
