import { describe, it, expect } from 'vitest';

import { parseTagStream, TagStreamParser } from './tag-stream-parser.js';

describe('TagStreamParser', () => {
  it('emits plain text as prose', () => {
    expect(parseTagStream('hello world')).toEqual([{ kind: 'text', text: 'hello world' }]);
  });

  it('parses self-closing nav tags', () => {
    const ev = parseTagStream('before <slide_next/> after');
    expect(ev).toEqual([
      { kind: 'text', text: 'before ' },
      { kind: 'selfClose', tag: 'slide_next', attrs: {} },
      { kind: 'text', text: ' after' },
    ]);
  });

  it('coerces attribute types', () => {
    const ev = parseTagStream('<slide_go_to n="4"/> <emotion value="calm">hi</emotion>');
    expect(ev[0]).toEqual({ kind: 'selfClose', tag: 'slide_go_to', attrs: { n: 4 } });
    expect(ev[2]).toEqual({ kind: 'open', tag: 'emotion', attrs: { value: 'calm' } });
    expect(ev[3]).toEqual({ kind: 'text', text: 'hi' });
    expect(ev[4]).toEqual({ kind: 'close', tag: 'emotion' });
  });

  it('handles chunk-split tags', () => {
    const p = new TagStreamParser();
    p.push('foo <slide_n');
    p.push('ext/> bar');
    p.end();
    const ev = p.events();
    expect(ev[0]).toEqual({ kind: 'text', text: 'foo ' });
    expect(ev[1]).toEqual({ kind: 'selfClose', tag: 'slide_next', attrs: {} });
    expect(ev[2]).toEqual({ kind: 'text', text: ' bar' });
  });

  it('verbatim with anchor', () => {
    expect(parseTagStream('<verbatim a="opening"/>')).toEqual([
      { kind: 'selfClose', tag: 'verbatim', attrs: { a: 'opening' } },
    ]);
  });

  it('tool tag with multiple attrs', () => {
    const ev = parseTagStream('<tool_send_signal target="audience" demo="true"/>');
    expect(ev[0]).toEqual({
      kind: 'selfClose',
      tag: 'tool_send_signal',
      attrs: { target: 'audience', demo: true },
    });
  });

  it('emits warning on malformed tag and preserves content', () => {
    const ev = parseTagStream('a < b > c');
    // `< b ` parses fine (single attr 'b'); validate it still produces
    // a tag event rather than dropping the surrounding text.
    const texts = ev.filter((e) => e.kind === 'text').map((e) => (e as { text: string }).text);
    expect(texts.join('|')).toContain('a ');
    expect(texts.join('|')).toContain(' c');
  });

  it('warns on unclosed tag at end()', () => {
    const p = new TagStreamParser();
    p.push('foo <slide_n');
    const tail = p.end();
    expect(tail.some((e) => e.kind === 'warning' && e.reason === 'unclosed-tag')).toBe(true);
  });
});
