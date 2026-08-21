import { describe, it, expect } from 'vitest';
import { TimelineQueue } from './queue.js';
import type { TimelineAction } from './types.js';

function say(text: string): TimelineAction {
  return { kind: 'say', text };
}

describe('TimelineQueue', () => {
  it('enqueues actions in FIFO order', () => {
    const q = new TimelineQueue();
    q.enqueue(say('one'));
    q.enqueue(say('two'));
    q.enqueue(say('three'));

    expect(q.size).toBe(3);
    expect(q.isEmpty).toBe(false);
    expect((q.dequeue() as { text: string }).text).toBe('one');
    expect((q.dequeue() as { text: string }).text).toBe('two');
    expect((q.dequeue() as { text: string }).text).toBe('three');
    expect(q.isEmpty).toBe(true);
    expect(q.dequeue()).toBeUndefined();
  });

  it('peek does not consume', () => {
    const q = new TimelineQueue();
    q.enqueue(say('only'));
    expect((q.peek() as { text: string }).text).toBe('only');
    expect((q.peek() as { text: string }).text).toBe('only');
    expect(q.size).toBe(1);
  });

  it('flush empties and returns discarded actions in order', () => {
    const q = new TimelineQueue();
    q.enqueue(say('a'));
    q.enqueue(say('b'));
    q.enqueue(say('c'));
    const discarded = q.flush();
    expect(discarded.map((a) => (a as { text: string }).text)).toEqual(['a', 'b', 'c']);
    expect(q.isEmpty).toBe(true);
    expect(q.size).toBe(0);
  });

  it('enqueueMany preserves order', () => {
    const q = new TimelineQueue();
    q.enqueueMany([say('one'), say('two'), say('three')]);
    expect(q.snapshot().map((a) => (a as { text: string }).text)).toEqual([
      'one',
      'two',
      'three',
    ]);
  });

  it('snapshot is a read-only copy', () => {
    const q = new TimelineQueue();
    q.enqueue(say('a'));
    const snap = q.snapshot();
    expect(snap.length).toBe(1);
    // Mutating the queue does not affect the prior snapshot.
    q.enqueue(say('b'));
    expect(snap.length).toBe(1);
    expect(q.size).toBe(2);
  });
});
