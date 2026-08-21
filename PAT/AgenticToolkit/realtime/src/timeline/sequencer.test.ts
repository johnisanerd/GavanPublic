import { describe, it, expect, vi } from 'vitest';
import { Sequencer, TimelineQueue, AbortError } from './queue.js';
import type {
  CompletedActionRecord,
  DispatchContext,
  TimelineAction,
} from './types.js';

function say(text: string): TimelineAction {
  return { kind: 'say', text };
}

function pause(ms: number): TimelineAction {
  return { kind: 'pause', ms };
}

interface ClockHandle {
  now: () => number;
  advance: (ms: number) => void;
}

function makeClock(start = 1000): ClockHandle {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('Sequencer — linear contract', () => {
  it('awaits each action before starting the next', async () => {
    const q = new TimelineQueue();
    q.enqueue(say('one'));
    q.enqueue(say('two'));
    q.enqueue(say('three'));

    const order: string[] = [];
    let inFlight = 0;

    const dispatch = vi.fn(async (action: TimelineAction) => {
      if (action.kind !== 'say') throw new Error('unexpected kind');
      // Linear: only one dispatch active at a time.
      expect(inFlight).toBe(0);
      inFlight++;
      order.push(`start:${action.text}`);
      // Yield to event loop so an out-of-order overlap WOULD show up.
      await new Promise<void>((r) => setImmediate(r));
      order.push(`end:${action.text}`);
      inFlight--;
    });

    const seq = new Sequencer(q, { timelineId: 't1', dispatch });
    const result = await seq.run();

    expect(result.reason).toBe('completed');
    expect(result.records.length).toBe(3);
    expect(order).toEqual([
      'start:one',
      'end:one',
      'start:two',
      'end:two',
      'start:three',
      'end:three',
    ]);
    expect(dispatch).toHaveBeenCalledTimes(3);
  });

  it('stamps tsStart and tsEnd from injected clock', async () => {
    const q = new TimelineQueue();
    q.enqueue(say('A'));
    q.enqueue(say('B'));

    const clock = makeClock(1_700_000_000_000);

    const dispatch = vi.fn(async () => {
      // Each dispatch "takes" 250ms of wall-clock.
      clock.advance(250);
    });

    const seq = new Sequencer(q, {
      timelineId: 't-clock',
      dispatch,
      now: clock.now,
    });

    const res = await seq.run();
    expect(res.reason).toBe('completed');
    expect(res.records[0]!.tsStart).toBe(1_700_000_000_000);
    expect(res.records[0]!.tsEnd).toBe(1_700_000_000_250);
    expect(res.records[1]!.tsStart).toBe(1_700_000_000_250);
    expect(res.records[1]!.tsEnd).toBe(1_700_000_000_500);
  });

  it('passes a unique sequence index and abort signal per action', async () => {
    const q = new TimelineQueue();
    q.enqueueMany([pause(10), say('x'), say('y')]);

    const contexts: DispatchContext[] = [];
    const dispatch = vi.fn(async (_action: TimelineAction, ctx: DispatchContext) => {
      contexts.push(ctx);
      expect(ctx.timelineId).toBe('t-ctx');
      expect(ctx.signal).toBeInstanceOf(AbortSignal);
      expect(ctx.signal.aborted).toBe(false);
    });

    const seq = new Sequencer(q, { timelineId: 't-ctx', dispatch });
    await seq.run();

    expect(contexts.map((c) => c.seq)).toEqual([0, 1, 2]);
  });

  it('rejects double-run', async () => {
    const q = new TimelineQueue();
    q.enqueue(say('once'));
    const seq = new Sequencer(q, {
      timelineId: 't-once',
      dispatch: async () => {},
    });
    await seq.run();
    await expect(seq.run()).rejects.toThrow();
  });
});

describe('Sequencer — abort', () => {
  it('aborts in-flight action; records it as partial; drops remaining', async () => {
    const q = new TimelineQueue();
    q.enqueueMany([say('one'), say('two'), say('three')]);

    let resolveFirst: (() => void) | null = null;
    const dropped: string[] = [];

    const dispatch = vi.fn((action: TimelineAction, ctx: DispatchContext) => {
      if ((action as { text: string }).text === 'one') {
        return new Promise<void>((resolve, reject) => {
          resolveFirst = resolve;
          ctx.signal.addEventListener('abort', () => {
            reject(new AbortError('test-abort'));
          });
        });
      }
      // Shouldn't get here in this test, but model it cleanly.
      return Promise.resolve();
    });

    const seq = new Sequencer(q, {
      timelineId: 't-abort',
      dispatch,
      hooks: {
        onActionDropped: (a) => {
          dropped.push((a as { text: string }).text);
        },
      },
    });

    const runPromise = seq.run();
    // Yield once so the first dispatch is actually started.
    await new Promise<void>((r) => setImmediate(r));
    expect(resolveFirst).not.toBeNull();

    seq.abort('bargein');
    const res = await runPromise;

    expect(res.reason).toBe('aborted');
    expect(res.records.length).toBe(1);
    expect(res.records[0]!.partial).toBe(true);
    expect(res.records[0]!.reason).toBe('bargein');
    expect(res.records[0]!.tsEnd).not.toBeNull();
    // The other two actions never started — they should appear in `dropped`.
    expect(res.dropped.map((d) => (d.action as { text: string }).text)).toEqual([
      'two',
      'three',
    ]);
    expect(dropped).toEqual(['two', 'three']);
  });

  it('capturePartialText is recorded on aborted action', async () => {
    const q = new TimelineQueue();
    q.enqueue(say('hello, audience'));

    const dispatch = vi.fn((_action: TimelineAction, ctx: DispatchContext) => {
      return new Promise<void>((_resolve, reject) => {
        ctx.signal.addEventListener('abort', () => {
          reject(new AbortError('bargein'));
        });
      });
    });

    const seq = new Sequencer(q, { timelineId: 't-partial', dispatch });
    const runPromise = seq.run();
    await new Promise<void>((r) => setImmediate(r));

    seq.capturePartialText('hello, audi—');
    seq.abort('bargein');
    const res = await runPromise;

    expect(res.records[0]!.partial).toBe(true);
    expect(res.records[0]!.partialText).toBe('hello, audi—');
  });

  it('idempotent abort is safe', async () => {
    const q = new TimelineQueue();
    q.enqueue(say('only'));
    const dispatch = vi.fn((_a: TimelineAction, ctx: DispatchContext) => {
      return new Promise<void>((_res, rej) => {
        ctx.signal.addEventListener('abort', () => rej(new AbortError('x')));
      });
    });
    const seq = new Sequencer(q, { timelineId: 't-double', dispatch });
    const runPromise = seq.run();
    await new Promise<void>((r) => setImmediate(r));
    seq.abort('first');
    seq.abort('second');
    const res = await runPromise;
    expect(res.reason).toBe('aborted');
    expect(res.records[0]!.reason).toBe('first');
  });
});

describe('Sequencer — hooks', () => {
  it('fires onActionStart, onActionComplete in order for each action', async () => {
    const q = new TimelineQueue();
    q.enqueueMany([say('a'), say('b')]);

    const events: string[] = [];

    const seq = new Sequencer(q, {
      timelineId: 't-hooks',
      dispatch: async () => {},
      hooks: {
        onActionStart: (action) => {
          events.push(`start:${(action as { text: string }).text}`);
        },
        onActionComplete: (rec: CompletedActionRecord) => {
          events.push(`complete:${(rec.action as { text: string }).text}`);
        },
      },
    });

    await seq.run();

    expect(events).toEqual(['start:a', 'complete:a', 'start:b', 'complete:b']);
  });

  it('hook throws do not crash the sequencer', async () => {
    const q = new TimelineQueue();
    q.enqueue(say('a'));

    const seq = new Sequencer(q, {
      timelineId: 't-hooks-safe',
      dispatch: async () => {},
      hooks: {
        onActionStart: () => {
          throw new Error('boom');
        },
        onActionComplete: () => {
          throw new Error('boom');
        },
      },
    });

    const res = await seq.run();
    expect(res.reason).toBe('completed');
    expect(res.records.length).toBe(1);
  });
});
