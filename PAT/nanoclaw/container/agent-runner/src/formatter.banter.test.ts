/**
 * PAT: banter group formatter tests.
 *
 * Verifies that messages_in rows with kind='banter' are wrapped in
 * <banter><said from="..." time="...">...</said></banter>, parallel
 * to the existing <messages> grouping for chat rows.
 *
 * These tests construct MessageInRow objects directly and pass them to
 * formatMessages() — no DB involvement. Matches the formatter's contract
 * (it operates on rows, not on the DB) and sidesteps the macOS test
 * limitation that openInboundDb() needs `/workspace/inbound.db` to exist.
 */
import { describe, it, expect } from 'bun:test';

import type { MessageInRow } from './db/messages-in.js';
import { formatMessages } from './formatter.js';

function row(id: string, kind: string, content: object, timestamp = '2026-05-04T17:00:00.000Z'): MessageInRow {
  return {
    id,
    seq: null,
    kind,
    timestamp,
    status: 'pending',
    process_after: null,
    recurrence: null,
    tries: 0,
    trigger: kind === 'banter' ? 0 : 1,
    platform_id: null,
    channel_type: null,
    thread_id: null,
    content: JSON.stringify(content),
  };
}

describe('PAT banter formatter', () => {
  it('wraps banter rows in a <banter>...</banter> group with <said from=...>', () => {
    const result = formatMessages([
      row('b1', 'banter', { sender: 'pat', text: 'checking the config files now' }),
      row('b2', 'banter', { sender: 'user', text: 'cool, thanks' }),
    ]);
    expect(result).toContain('<banter>');
    expect(result).toContain('</banter>');
    expect(result).toContain('<said from="pat"');
    expect(result).toContain('<said from="user"');
    expect(result).toContain('checking the config files now');
    expect(result).toContain('cool, thanks');
  });

  it('places <banter> before <messages> when both kinds are present', () => {
    const result = formatMessages([
      row('b1', 'banter', { sender: 'pat', text: 'on it' }),
      row('m1', 'chat', { sender: 'caller', text: 'try the json approach instead' }),
      row('m2', 'chat', { sender: 'caller', text: 'actually nevermind' }),
    ]);
    const banterIdx = result.indexOf('<banter>');
    // upstream v2.1.19 dropped the outer <messages> wrapper — each chat row is
    // now a self-contained <message id="..."> block. Assert on that instead.
    const messagesIdx = result.indexOf('<message ');
    expect(banterIdx).toBeGreaterThanOrEqual(0);
    expect(messagesIdx).toBeGreaterThan(banterIdx);
  });

  it('XML-escapes banter body and from attribute', () => {
    const result = formatMessages([row('b1', 'banter', { sender: 'user', text: 'use < and > and & in body' })]);
    expect(result).toContain('&lt;');
    expect(result).toContain('&gt;');
    expect(result).toContain('&amp;');
    // Raw '<' should not appear inside the banter text body
    expect(result).not.toMatch(/<said[^>]*>use < and/);
  });

  it('falls back to from="unknown" when sender is missing', () => {
    const result = formatMessages([row('b1', 'banter', { text: 'no sender field' })]);
    expect(result).toContain('from="unknown"');
  });

  it('does not emit a <banter> group when no banter rows exist', () => {
    const result = formatMessages([row('m1', 'chat', { sender: 'Alice', text: 'hi' })]);
    expect(result).not.toContain('<banter>');
  });
});
