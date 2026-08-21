import { describe, it, expect } from 'vitest';
import { actionsFromText } from '@agentic-toolkit/realtime';
import './timeline-actions.js';

describe('smoke-test packet (Phase 6 vocabulary — post-verbatim removal)', () => {
  it('plays through the smoke-test packet end-to-end', () => {
    // The smoke-test packet's notes.timeline emits a direct <say>
    // (post-Phase-6; no verbatim splice anymore). Resolver lifts
    // notes.timeline into ScenarioContext.current_slide_authored_timeline;
    // the test exercises the same shape directly.
    const packet =
      '<timeline><say>Hello, welcome to the smoke test.</say><slide_next/></timeline>';
    const { actions, terminator } = actionsFromText(packet, undefined);

    expect(terminator).toBe('slide_next');
    // Sequence: timeline-started → prose (the say body) → slide-nav next
    // (terminator) → timeline-finished
    const types = actions.map((a) => a.type);
    expect(types[0]).toBe('timeline-started');
    expect(types).toContain('prose');
    expect(types).toContain('slide-nav');
    expect(types[types.length - 1]).toBe('timeline-finished');
    const prose = actions.find((a) => a.type === 'prose') as { text: string } | undefined;
    expect(prose?.text).toBe('Hello, welcome to the smoke test.');
    expect(actions).toContainEqual({
      type: 'slide-nav',
      direction: 'next',
      terminator: true,
    });
  });

  it('also plays the canonical <next_slide/> form', () => {
    const packet = '<timeline><say>hi</say><next_slide/></timeline>';
    const { actions, terminator } = actionsFromText(packet, undefined);
    expect(terminator).toBe('next_slide');
    expect(actions).toContainEqual({
      type: 'slide-nav',
      direction: 'next',
      terminator: true,
    });
  });
});
