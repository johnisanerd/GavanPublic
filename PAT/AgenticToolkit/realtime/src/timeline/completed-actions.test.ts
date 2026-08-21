/**
 * Tests for the `<completed_actions>` XML emitter.
 *
 * Pure function — no SDK mocks, no clock manipulation. We pin `nowMs`
 * + `ts_start_ms` / `ts_end_ms` explicitly via `Date.UTC(...)` so test
 * snapshots are deterministic regardless of the machine clock or TZ.
 */
import { describe, it, expect } from 'vitest';

import {
  formatDateTimeIso8601,
  formatTimeIso8601Short,
  renderCompletedActions,
  renderInboxWithCompletedActions,
  renderInboxWrapper,
  type CompletedAction,
} from './completed-actions.js';

const T = (h: number, m: number, s: number): number => Date.UTC(2026, 4, 19, h, m, s);

describe('formatTimeIso8601Short', () => {
  it('renders a UTC ms timestamp as HH:MM:SSZ', () => {
    expect(formatTimeIso8601Short(T(1, 35, 40))).toBe('01:35:40Z');
  });

  it('zero-pads single-digit components', () => {
    expect(formatTimeIso8601Short(Date.UTC(2026, 4, 19, 0, 1, 2))).toBe('00:01:02Z');
  });

  it('handles boundary midnight UTC', () => {
    expect(formatTimeIso8601Short(Date.UTC(2026, 4, 19, 0, 0, 0))).toBe('00:00:00Z');
  });
});

describe('formatDateTimeIso8601', () => {
  it('renders full YYYY-MM-DDTHH:MM:SSZ for the cross-midnight wrapper', () => {
    expect(formatDateTimeIso8601(Date.UTC(2026, 4, 19, 23, 59, 30))).toBe('2026-05-19T23:59:30Z');
  });

  it('renders single-digit month/day with zero-pad', () => {
    expect(formatDateTimeIso8601(Date.UTC(2026, 0, 3, 5, 6, 7))).toBe('2026-01-03T05:06:07Z');
  });
});

describe('renderCompletedActions', () => {
  it('returns empty string when given no actions', () => {
    expect(renderCompletedActions({ actions: [], reason: 'completed' })).toBe('');
  });

  it('renders a single completed <say> with both ts attrs', () => {
    const actions: CompletedAction[] = [
      { kind: 'say', ts_start_ms: T(1, 35, 40), ts_end_ms: T(1, 35, 43), text: 'Hello' },
    ];
    const out = renderCompletedActions({ actions, reason: 'completed' });
    expect(out).toBe(
      [
        '<completed_actions reason="completed">',
        '<say ts_start="01:35:40Z" ts_end="01:35:43Z">Hello</say>',
        '</completed_actions>',
      ].join('\n'),
    );
  });

  it('renders self-closing tags for non-say completed actions', () => {
    const actions: CompletedAction[] = [
      { kind: 'next_fragment', ts_start_ms: T(1, 35, 40), ts_end_ms: T(1, 35, 40) },
    ];
    const out = renderCompletedActions({ actions, reason: 'completed' });
    expect(out).toContain('<next_fragment ts_start="01:35:40Z" ts_end="01:35:40Z"/>');
    expect(out).not.toContain('</next_fragment>');
  });

  it('marks partial say with partial="true" and no ts_end', () => {
    // Per plan §3.6.5: interrupted timeline → final action carries
    // partial="true", omits ts_end. The partial text is whatever
    // prefix the channel captured before cancel.
    const actions: CompletedAction[] = [
      { kind: 'next_fragment', ts_start_ms: T(1, 35, 40), ts_end_ms: T(1, 35, 40) },
      { kind: 'say', ts_start_ms: T(1, 35, 40), ts_end_ms: T(1, 35, 43), text: 'First.' },
      {
        kind: 'say',
        ts_start_ms: T(1, 35, 47),
        text: 'Self-replication has been on every major AI safety watch—',
        partial: true,
      },
    ];
    const out = renderCompletedActions({ actions, reason: 'interrupted' });
    expect(out).toContain('<completed_actions reason="interrupted">');
    // First two are fully completed.
    expect(out).toContain('<next_fragment ts_start="01:35:40Z" ts_end="01:35:40Z"/>');
    expect(out).toContain('<say ts_start="01:35:40Z" ts_end="01:35:43Z">First.</say>');
    // Final say has partial="true", no ts_end.
    expect(out).toContain(
      '<say ts_start="01:35:47Z" partial="true">Self-replication has been on every major AI safety watch—</say>',
    );
    expect(out).not.toMatch(/partial="true"[^>]*ts_end=/);
  });

  it('renders partial flag on a non-say action (e.g. cancelled next_fragment)', () => {
    // Edge case: sequencer caught the cancel signal between dispatch
    // and slide-bus ACK. Self-closing tag still gets partial="true".
    const actions: CompletedAction[] = [
      { kind: 'next_fragment', ts_start_ms: T(1, 35, 40), partial: true },
    ];
    const out = renderCompletedActions({ actions, reason: 'interrupted' });
    expect(out).toContain('<next_fragment ts_start="01:35:40Z" partial="true"/>');
    expect(out).not.toContain('ts_end=');
  });

  it('XML-escapes & < > inside <say> body text', () => {
    const actions: CompletedAction[] = [
      {
        kind: 'say',
        ts_start_ms: T(1, 0, 0),
        ts_end_ms: T(1, 0, 1),
        text: 'Tom & Jerry < 3 > you',
      },
    ];
    const out = renderCompletedActions({ actions, reason: 'completed' });
    expect(out).toContain('>Tom &amp; Jerry &lt; 3 &gt; you</say>');
  });

  it('round-trips tag-specific attrs after the timestamps', () => {
    const actions: CompletedAction[] = [
      {
        kind: 'pause',
        ts_start_ms: T(1, 0, 0),
        ts_end_ms: T(1, 0, 1),
        attrs: { ms: 300 },
      },
      {
        kind: 'goto_slide',
        ts_start_ms: T(1, 0, 2),
        ts_end_ms: T(1, 0, 2),
        attrs: { n: 4, v: 1 },
      },
    ];
    const out = renderCompletedActions({ actions, reason: 'completed' });
    expect(out).toContain('<pause ts_start="01:00:00Z" ts_end="01:00:01Z" ms="300"/>');
    expect(out).toContain('<goto_slide ts_start="01:00:02Z" ts_end="01:00:02Z" n="4" v="1"/>');
  });

  it('omits text gracefully when a <say> has no text field', () => {
    const actions: CompletedAction[] = [
      { kind: 'say', ts_start_ms: T(1, 0, 0), ts_end_ms: T(1, 0, 1) },
    ];
    const out = renderCompletedActions({ actions, reason: 'completed' });
    expect(out).toContain('<say ts_start="01:00:00Z" ts_end="01:00:01Z"></say>');
  });
});

describe('renderInboxWrapper', () => {
  it('produces short HH:MM:SSZ form when actions share the now-day', () => {
    const w = renderInboxWrapper({
      nowMs: T(1, 36, 12),
      actions: [{ kind: 'say', ts_start_ms: T(1, 35, 40), ts_end_ms: T(1, 35, 43) }],
    });
    expect(w.open).toBe('<inbox now="01:36:12Z">');
    expect(w.close).toBe('</inbox>');
  });

  it('produces short form when no actions are passed', () => {
    const w = renderInboxWrapper({ nowMs: T(1, 36, 12) });
    expect(w.open).toBe('<inbox now="01:36:12Z">');
  });

  it('falls back to full ISO when nowMs crosses midnight from earliest action', () => {
    // earliest action at 2026-05-19T23:59:30Z, now stamped at 2026-05-20T00:00:30Z.
    const earliest = Date.UTC(2026, 4, 19, 23, 59, 30);
    const nowMs = Date.UTC(2026, 4, 20, 0, 0, 30);
    const w = renderInboxWrapper({
      nowMs,
      actions: [{ kind: 'say', ts_start_ms: earliest, ts_end_ms: earliest }],
    });
    expect(w.open).toBe('<inbox now="2026-05-20T00:00:30Z">');
  });
});

describe('renderInboxWithCompletedActions', () => {
  it('returns the wrapped XML on the happy path', () => {
    const actions: CompletedAction[] = [
      { kind: 'next_fragment', ts_start_ms: T(1, 35, 40), ts_end_ms: T(1, 35, 40) },
      { kind: 'say', ts_start_ms: T(1, 35, 40), ts_end_ms: T(1, 35, 43), text: 'First.' },
    ];
    const out = renderInboxWithCompletedActions({
      actions,
      reason: 'completed',
      nowMs: T(1, 36, 12),
    });
    expect(out.startsWith('<inbox now="01:36:12Z">\n<completed_actions reason="completed">')).toBe(
      true,
    );
    expect(out.endsWith('</completed_actions>\n</inbox>')).toBe(true);
    expect(out).toContain('<next_fragment ts_start="01:35:40Z" ts_end="01:35:40Z"/>');
    expect(out).toContain('<say ts_start="01:35:40Z" ts_end="01:35:43Z">First.</say>');
  });

  it('returns empty string when actions array is empty', () => {
    expect(
      renderInboxWithCompletedActions({ actions: [], reason: 'completed', nowMs: T(1, 36, 12) }),
    ).toBe('');
  });
});
