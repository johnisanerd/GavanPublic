import { describe, it, expect } from 'vitest';
import {
  actionKindLabel,
  buildActionEnqueued,
  buildActionCompleted,
  buildActionCancelled,
} from './events.js';
import type { CompletedActionRecord, TimelineAction } from './types.js';

describe('actionKindLabel', () => {
  it('returns the kind directly for base variants', () => {
    expect(actionKindLabel({ kind: 'say', text: 'hi' })).toBe('say');
    expect(actionKindLabel({ kind: 'pause', ms: 100 })).toBe('pause');
    expect(actionKindLabel({ kind: 'wait-for-cue', cue: 'X' })).toBe('wait-for-cue');
  });

  it('decorates tool actions with name and async marker', () => {
    expect(
      actionKindLabel({ kind: 'tool', name: 'send_signal', args: {} }),
    ).toBe('tool:send_signal');
    expect(
      actionKindLabel({ kind: 'tool', name: 'send_signal', args: {}, async: true }),
    ).toBe('tool:send_signal:async');
  });

  it('decorates terminator with reason', () => {
    expect(
      actionKindLabel({ kind: 'terminator', reason: 'next_slide' }),
    ).toBe('terminator:next_slide');
  });

  it('uses domainKind for domain actions', () => {
    expect(
      actionKindLabel({ kind: 'domain', domainKind: 'next_fragment' }),
    ).toBe('next_fragment');
  });
});

describe('buildActionEnqueued', () => {
  it('produces a well-shaped log event with derived attrs', () => {
    const ev = buildActionEnqueued({
      timelineId: 't-1',
      action: { kind: 'say', text: 'hello' },
      seq: 0,
      threadId: 'thr-A',
    });
    expect(ev.kind).toBe('timeline.action-enqueued');
    expect(ev.source).toBe('nanoclaw-host');
    expect(ev.level).toBe('info');
    expect(ev.thread_id).toBe('thr-A');
    expect(ev.data).toEqual({
      timeline_id: 't-1',
      kind: 'say',
      seq: 0,
      attrs: { text: 'hello' },
    });
    // ts is an ISO-8601 string
    expect(ev.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('derives attrs per action kind for the dashboard', () => {
    // pause carries ms
    const pauseEv = buildActionEnqueued({
      timelineId: 't',
      action: { kind: 'pause', ms: 250 },
      seq: 0,
    });
    expect(pauseEv.data.attrs).toEqual({ ms: 250 });

    // tool carries tool_name and async marker
    const toolEv = buildActionEnqueued({
      timelineId: 't',
      action: { kind: 'tool', name: 'send_signal', args: { target: 'audience' }, async: true },
      seq: 0,
    });
    expect(toolEv.data.attrs).toMatchObject({
      tool_name: 'send_signal',
      async: true,
      arg_target: 'audience',
    });

    // domain fragment/slide derives direction
    const fragEv = buildActionEnqueued({
      timelineId: 't',
      action: { kind: 'domain', domainKind: 'next_fragment' },
      seq: 0,
    });
    expect(fragEv.data.attrs?.direction).toBe('next');

    const navEv = buildActionEnqueued({
      timelineId: 't',
      action: { kind: 'domain', domainKind: 'nav_slide_left' },
      seq: 0,
    });
    expect(navEv.data.attrs?.direction).toBe('left');

    // goto_slide includes n from payload
    const gotoEv = buildActionEnqueued({
      timelineId: 't',
      action: { kind: 'domain', domainKind: 'goto_slide', payload: { n: 4 } },
      seq: 0,
    });
    expect(gotoEv.data.attrs).toMatchObject({ n: 4 });

    // terminator carries reason
    const termEv = buildActionEnqueued({
      timelineId: 't',
      action: { kind: 'terminator', reason: 'ask_for_questions' },
      seq: 0,
    });
    expect(termEv.data.attrs?.reason).toBe('ask_for_questions');
  });

  it('caller can override derived attrs', () => {
    const ev = buildActionEnqueued({
      timelineId: 't',
      action: { kind: 'say', text: 'hi' },
      seq: 0,
      attrs: { text: 'OVERRIDE', extra: 1 },
    });
    expect(ev.data.attrs).toEqual({ text: 'OVERRIDE', extra: 1 });
  });
});

describe('buildActionCompleted', () => {
  it('derives duration from tsEnd - tsStart', () => {
    const action: TimelineAction = { kind: 'say', text: 'hi' };
    const record: CompletedActionRecord = {
      action,
      seq: 2,
      tsStart: 1000,
      tsEnd: 1750,
      partial: false,
    };
    const ev = buildActionCompleted({ timelineId: 't', record });
    expect(ev.data.duration_ms).toBe(750);
    expect(ev.data.ts_start).toBe(1000);
    expect(ev.data.ts_end).toBe(1750);
    expect(ev.data.seq).toBe(2);
    expect(ev.data.kind).toBe('say');
  });

  it('handles missing tsEnd by falling back to tsStart (zero duration)', () => {
    const ev = buildActionCompleted({
      timelineId: 't',
      record: {
        action: { kind: 'pause', ms: 0 },
        seq: 0,
        tsStart: 500,
        tsEnd: null,
        partial: true,
      },
    });
    expect(ev.data.duration_ms).toBe(0);
    expect(ev.data.ts_end).toBe(500);
  });
});

describe('buildActionCancelled', () => {
  it('omits partial when not provided', () => {
    const ev = buildActionCancelled({
      timelineId: 't',
      action: { kind: 'say', text: 'cut' },
      seq: 1,
      reason: 'bargein',
    });
    expect(ev.data).toEqual({
      timeline_id: 't',
      kind: 'say',
      seq: 1,
      reason: 'bargein',
    });
  });

  it('includes partial when provided', () => {
    const ev = buildActionCancelled({
      timelineId: 't',
      action: { kind: 'say', text: 'cut' },
      seq: 1,
      reason: 'bargein',
      partial: 'cut sho—',
    });
    expect(ev.data.partial).toBe('cut sho—');
  });
});
