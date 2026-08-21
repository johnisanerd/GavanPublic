/**
 * Trace-based tests for the timeline-runtime wiring on ChannelOrchestrator.
 *
 * These exercise the queue + sequencer integration via `runTimelineSequence`
 * — the linear contract, abort propagation, completed_actions block
 * rendering, and the `<inbox now>` wrapper. Assertions are made against the
 * structured log emit stream (the same `kind` discriminator dashboards and
 * `pat-trace.py` consume) so the test surface is the same one production
 * forensics uses.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChannelOrchestrator, type TimelineBaseHandlers } from './channel-orchestrator.js';
import type { HostAdapter, StructuredLogEvent } from './host-adapter.js';
import type { DispatchContext, TimelineAction } from './timeline/index.js';
import { resetRegistry } from './timeline/index.js';

function makeHost(): { adapter: HostAdapter; events: StructuredLogEvent[] } {
  const events: StructuredLogEvent[] = [];
  const adapter: HostAdapter = {
    log: {
      event: (ev) => {
        events.push(ev);
      },
      info: () => {},
      warn: () => {},
    },
  };
  return { adapter, events };
}

function eventsOfKind(events: StructuredLogEvent[], kind: string): StructuredLogEvent[] {
  return events.filter((e) => e.kind === kind);
}

describe('runTimelineSequence — linear contract', () => {
  beforeEach(() => {
    resetRegistry();
  });

  it('dispatches actions in order; later say does not start before prior fragment completes', async () => {
    const { adapter, events } = makeHost();
    const orch = new ChannelOrchestrator({ host: adapter });

    const observed: string[] = [];
    const handlers: TimelineBaseHandlers = {
      onSay: async (action) => {
        observed.push(`say-start:${action.text}`);
        await new Promise<void>((r) => setImmediate(r));
        observed.push(`say-end:${action.text}`);
      },
    };

    // Stand in for "fragment" — a domain action that takes a tick to
    // complete (slide-bus POST in production).
    const fragmentExt = {
      name: 'scenarios-test',
      matches: (t: string) => t === 'next_fragment',
      parseAction: () => ({ kind: 'domain' as const, domainKind: 'next_fragment' }),
      dispatch: async (action: TimelineAction, _ctx: DispatchContext) => {
        if (action.kind !== 'domain') throw new Error('unexpected');
        observed.push(`fragment-start:${action.domainKind}`);
        await new Promise<void>((r) => setImmediate(r));
        observed.push(`fragment-end:${action.domainKind}`);
      },
    };
    // Register so domain actions route to our handler.
    const { registerActionDomain } = await import('./timeline/index.js');
    registerActionDomain(fragmentExt);

    const actions: TimelineAction[] = [
      { kind: 'domain', domainKind: 'next_fragment' },
      { kind: 'say', text: 'first bullet' },
      { kind: 'domain', domainKind: 'next_fragment' },
      { kind: 'say', text: 'second bullet' },
    ];

    const result = await orch.runTimelineSequence({
      timelineId: 'tl-1',
      threadKey: 'chan:thread-A',
      threadId: 'thread-A',
      platformId: 'chan',
      actions,
      handlers,
    });

    expect(result.reason).toBe('completed');
    expect(result.records.length).toBe(4);

    // Strict interleave — no fragment-start before the prior say-end.
    expect(observed).toEqual([
      'fragment-start:next_fragment',
      'fragment-end:next_fragment',
      'say-start:first bullet',
      'say-end:first bullet',
      'fragment-start:next_fragment',
      'fragment-end:next_fragment',
      'say-start:second bullet',
      'say-end:second bullet',
    ]);

    // One enqueue + one complete per action, in matching order.
    const enq = eventsOfKind(events, 'timeline.action-enqueued');
    const comp = eventsOfKind(events, 'timeline.action-completed');
    expect(enq.length).toBe(4);
    expect(comp.length).toBe(4);
    expect(enq.map((e) => e.data.seq)).toEqual([0, 1, 2, 3]);
    expect(comp.map((e) => e.data.seq)).toEqual([0, 1, 2, 3]);
    // Log kinds align with the action kind labels.
    expect(comp.map((e) => e.data.kind)).toEqual([
      'next_fragment',
      'say',
      'next_fragment',
      'say',
    ]);
  });

  it('pause action observes the action signal — cancellable', async () => {
    const { adapter, events } = makeHost();
    const orch = new ChannelOrchestrator({ host: adapter });

    const actions: TimelineAction[] = [
      { kind: 'pause', ms: 10_000 },
      { kind: 'say', text: 'should never speak' },
    ];

    const handlers: TimelineBaseHandlers = {
      onSay: async () => {
        throw new Error('should not be reached — aborted before second action');
      },
    };

    const runPromise = orch.runTimelineSequence({
      timelineId: 'tl-pause',
      threadKey: 'chan:thread-P',
      threadId: 'thread-P',
      platformId: 'chan',
      actions,
      handlers,
    });

    await new Promise<void>((r) => setImmediate(r));
    expect(orch.abortTimelineSequence('chan:thread-P', 'test-abort')).toBe(true);

    const res = await runPromise;
    expect(res.reason).toBe('aborted');
    // First action cancelled mid-flight (partial=true); second dropped.
    const cancelled = eventsOfKind(events, 'timeline.action-cancelled');
    expect(cancelled.length).toBe(2);
    expect(cancelled[0]!.data.kind).toBe('pause');
    expect(cancelled[1]!.data.kind).toBe('say');
    // No completion events fired.
    expect(eventsOfKind(events, 'timeline.action-completed').length).toBe(0);
  });
});

describe('runTimelineSequence — abort mid-stream', () => {
  beforeEach(() => {
    resetRegistry();
  });

  it('drains remaining actions as cancelled and surfaces partial=true on the in-flight', async () => {
    const { adapter, events } = makeHost();
    const orch = new ChannelOrchestrator({ host: adapter });

    let abortedSay = false;
    const handlers: TimelineBaseHandlers = {
      onSay: async (action, ctx) => {
        if (action.text === 'one') return; // completes
        // Second say — long-running, abort interrupts it.
        return new Promise<void>((_res, rej) => {
          ctx.signal.addEventListener('abort', () => {
            abortedSay = true;
            rej(new Error('AbortError-mock'));
          });
        });
      },
    };

    const actions: TimelineAction[] = [
      { kind: 'say', text: 'one' },
      { kind: 'say', text: 'two-long' },
      { kind: 'say', text: 'three' },
      { kind: 'say', text: 'four' },
    ];

    const runPromise = orch.runTimelineSequence({
      timelineId: 'tl-abort',
      threadKey: 'chan:thread-X',
      threadId: 'thread-X',
      platformId: 'chan',
      actions,
      handlers,
    });

    // Yield enough times to let the first say complete and the second start.
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    expect(orch.abortTimelineSequence('chan:thread-X', 'bargein')).toBe(true);
    const res = await runPromise;

    expect(res.reason).toBe('aborted');
    expect(abortedSay).toBe(true);
    // One say completed; one was cut mid-flight; two dropped.
    expect(eventsOfKind(events, 'timeline.action-completed').length).toBe(1);
    const cancelled = eventsOfKind(events, 'timeline.action-cancelled');
    expect(cancelled.length).toBe(3);
    // Reasons: in-flight gets the bargein reason; dropped say(s) get
    // either 'bargein' (from sequencer.abortReason fallback) — verify
    // we got SOMETHING for each.
    for (const c of cancelled) {
      expect(typeof c.data.reason).toBe('string');
    }
  });

  it('abort with no active sequencer is a safe no-op', () => {
    const { adapter } = makeHost();
    const orch = new ChannelOrchestrator({ host: adapter });
    expect(orch.abortTimelineSequence('chan:thread-Y', 'nothing')).toBe(false);
  });
});

describe('getCompletedActionsBlock', () => {
  beforeEach(() => {
    resetRegistry();
  });

  it('returns null when no run has happened for the thread', () => {
    const { adapter } = makeHost();
    const orch = new ChannelOrchestrator({ host: adapter });
    expect(orch.getCompletedActionsBlock('chan:thread-N')).toBeNull();
  });

  it('renders a clean-completion block with ts_start + ts_end per action', async () => {
    const { adapter } = makeHost();
    const orch = new ChannelOrchestrator({ host: adapter });
    await orch.runTimelineSequence({
      timelineId: 'tl-done',
      threadKey: 'chan:thread-A',
      threadId: 'thread-A',
      platformId: 'chan',
      actions: [{ kind: 'say', text: 'hello world' }, { kind: 'pause', ms: 0 }],
      handlers: { onSay: async () => {} },
    });
    const block = orch.getCompletedActionsBlock('chan:thread-A');
    expect(block).not.toBeNull();
    expect(block!).toContain('<completed_actions reason="completed">');
    expect(block!).toMatch(/<say ts_start="\d{2}:\d{2}:\d{2}Z" ts_end="\d{2}:\d{2}:\d{2}Z">hello world<\/say>/);
    expect(block!).toMatch(/<pause ts_start="\d{2}:\d{2}:\d{2}Z" ts_end="\d{2}:\d{2}:\d{2}Z" ms="0"\/>/);
    expect(block!.endsWith('</completed_actions>')).toBe(true);
  });

  it('renders an interrupted block with partial="true" on the in-flight action', async () => {
    const { adapter } = makeHost();
    const orch = new ChannelOrchestrator({ host: adapter });

    const handlers: TimelineBaseHandlers = {
      onSay: async (_action, ctx) => {
        return new Promise<void>((_res, rej) => {
          ctx.signal.addEventListener('abort', () => rej(new Error('aborted')));
        });
      },
    };

    const runPromise = orch.runTimelineSequence({
      timelineId: 'tl-cut',
      threadKey: 'chan:thread-Z',
      threadId: 'thread-Z',
      platformId: 'chan',
      actions: [{ kind: 'say', text: 'hello, audience' }],
      handlers,
    });
    await new Promise<void>((r) => setImmediate(r));
    orch.abortTimelineSequence('chan:thread-Z', 'bargein');
    await runPromise;

    const block = orch.getCompletedActionsBlock('chan:thread-Z');
    expect(block).not.toBeNull();
    expect(block!).toContain('<completed_actions reason="interrupted">');
    expect(block!).toMatch(/<say ts_start="\d{2}:\d{2}:\d{2}Z" partial="true">hello, audience<\/say>/);
  });

  it('consume:true clears the stash', async () => {
    const { adapter } = makeHost();
    const orch = new ChannelOrchestrator({ host: adapter });
    await orch.runTimelineSequence({
      timelineId: 'tl-once',
      threadKey: 'chan:thread-A',
      threadId: 'thread-A',
      platformId: 'chan',
      actions: [{ kind: 'say', text: 'x' }],
      handlers: { onSay: async () => {} },
    });
    expect(orch.getCompletedActionsBlock('chan:thread-A', { consume: true })).not.toBeNull();
    expect(orch.getCompletedActionsBlock('chan:thread-A')).toBeNull();
  });
});

describe('wrapInbox', () => {
  it('stamps an HH:MM:SSZ now from an injected clock', () => {
    const { adapter } = makeHost();
    const orch = new ChannelOrchestrator({ host: adapter });
    // 2026-05-18T01:36:12Z → 01:36:12Z
    const epoch = Date.UTC(2026, 4, 18, 1, 36, 12);
    const wrapped = orch.wrapInbox('<user>hi</user>', { now: epoch });
    expect(wrapped.startsWith('<inbox now="01:36:12Z">')).toBe(true);
    expect(wrapped).toContain('<user>hi</user>');
    expect(wrapped.endsWith('</inbox>')).toBe(true);
  });

  it('appends a completed_actions block when one is stashed', async () => {
    const { adapter } = makeHost();
    const orch = new ChannelOrchestrator({ host: adapter });
    await orch.runTimelineSequence({
      timelineId: 'tl-w',
      threadKey: 'chan:thread-W',
      threadId: 'thread-W',
      platformId: 'chan',
      actions: [{ kind: 'say', text: 'hi' }],
      handlers: { onSay: async () => {} },
    });
    const wrapped = orch.wrapInbox('<user>wait, what?</user>', {
      threadKey: 'chan:thread-W',
      now: Date.UTC(2026, 4, 18, 1, 36, 12),
    });
    expect(wrapped).toContain('<inbox now="01:36:12Z">');
    expect(wrapped).toContain('<user>wait, what?</user>');
    expect(wrapped).toContain('<completed_actions reason="completed">');
    expect(wrapped).toContain('<say ');
  });
});

describe('barge-in path (clearIntent) aborts the sequencer', () => {
  it('clearIntent with ctx aborts the active timeline sequencer', async () => {
    const { adapter } = makeHost();
    const orch = new ChannelOrchestrator({ host: adapter });

    const handlers: TimelineBaseHandlers = {
      onSay: async (_action, ctx) => {
        return new Promise<void>((_res, rej) => {
          ctx.signal.addEventListener('abort', () => rej(new Error('aborted')));
        });
      },
    };

    const runPromise = orch.runTimelineSequence({
      timelineId: 'tl-clear',
      threadKey: 'chan:thread-C',
      threadId: 'thread-C',
      platformId: 'chan',
      actions: [
        { kind: 'say', text: 'long' },
        { kind: 'say', text: 'never' },
      ],
      handlers,
    });
    await new Promise<void>((r) => setImmediate(r));

    orch.clearIntent('chan:thread-C', { threadId: 'thread-C', platformId: 'chan' });
    const res = await runPromise;
    expect(res.reason).toBe('aborted');
  });
});
