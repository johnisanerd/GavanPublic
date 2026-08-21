/**
 * Smoke test for the existing Timeline component.
 *
 * Asserts that Timeline still mounts and renders a non-empty DOM
 * after the database / capability / lens tabs were added. We do NOT
 * touch Timeline.tsx or anything in its render path; this test exists
 * to catch any accidental breakage on subsequent edits.
 *
 * Not a behavioral test — just "renders without throwing, produces
 * recognizable DOM."
 */
import { describe, it, expect } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Timeline } from './Timeline';
import { EventDetailsProvider } from './EventDetailsModal';
import type { LogEvent } from '@/types/log-events';

function makeContainer() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

describe('Timeline (smoke)', () => {
  it('mounts with an empty buffer and produces DOM', async () => {
    const container = makeContainer();
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <EventDetailsProvider>
          <Timeline buffer={[]} thread={null} />
        </EventDetailsProvider>,
      );
    });
    // We don't assert on copy; just that the timeline rendered SOMETHING
    // (an empty timeline still emits its scaffold/lanes).
    expect(container.innerHTML.length).toBeGreaterThan(0);
    await act(async () => {
      root.unmount();
    });
  });

  it('mounts with a one-event buffer', async () => {
    const container = makeContainer();
    const root = createRoot(container);
    const event: LogEvent = {
      ts: new Date().toISOString(),
      source: 'nanoclaw-host',
      kind: 'inbound.received',
      thread_id: 'smoke-thread',
      id: 'smoke-1',
      data: { text: 'hello', sender: 'realtime-user', sender_id: 'pstn:+1' },
    } as LogEvent;
    await act(async () => {
      root.render(
        <EventDetailsProvider>
          <Timeline buffer={[event]} thread="smoke-thread" />
        </EventDetailsProvider>,
      );
    });
    expect(container.innerHTML.length).toBeGreaterThan(0);
    await act(async () => {
      root.unmount();
    });
  });
});
