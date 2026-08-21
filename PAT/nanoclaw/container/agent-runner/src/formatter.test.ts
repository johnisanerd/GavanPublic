/**
 * v1-parity tests for formatter behavior.
 *
 * Port of src/v1/formatting.test.ts (at commit 27c5220, parent of the v1
 * deletion commit 86becf8). Covers: context timezone header, reply_to +
 * quoted_message rendering, XML escaping, and stripInternalTags.
 *
 * Timestamp-format assertions use `formatLocalTime()` output format, which
 * is host locale-dependent for decorators (month abbr, "," separator) but
 * stable for the numeric parts we assert on (hour, minute, year).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './db/connection.js';
import type { MessageInRow } from './db/messages-in.js';
import { getPendingMessages } from './db/messages-in.js';
import { formatMessages, stripInternalTags } from './formatter.js';
import { TIMEZONE } from './timezone.js';

// PAT: bypass getPendingMessages — it always opens the on-disk
// inbound.db (openInboundDb), which fails in tests because the
// in-memory schema set up by initTestSessionDb() is on a separate
// connection. Build the row directly. Mirrors the production
// messages_in row shape (db/messages-in.ts: MessageInRow).
function buildRow(
  id: string,
  kind: string,
  content: object,
  opts?: { timestamp?: string; channel_type?: string; platform_id?: string },
): MessageInRow {
  return {
    id,
    seq: null,
    kind,
    timestamp: opts?.timestamp ?? new Date().toISOString(),
    status: 'pending',
    process_after: null,
    recurrence: null,
    tries: 0,
    trigger: 1,
    platform_id: opts?.platform_id ?? null,
    channel_type: opts?.channel_type ?? null,
    thread_id: null,
    content: JSON.stringify(content),
  };
}

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function insertMessage(
  id: string,
  kind: string,
  content: object,
  opts?: { timestamp?: string },
) {
  const timestamp = opts?.timestamp ?? new Date().toISOString();
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, content)
       VALUES (?, ?, ?, 'pending', ?)`,
    )
    .run(id, kind, timestamp, JSON.stringify(content));
}

describe('context timezone header', () => {
  it('prepends <context timezone="..."/> to formatted output', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hello' });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain(`<context timezone="${TIMEZONE}"`);
  });

  it('includes the header even when the message list is empty', () => {
    const result = formatMessages([]);
    expect(result).toContain(`<context timezone="${TIMEZONE}"`);
  });

  it('header comes before the first <message> block when multiple are present', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'one' });
    insertMessage('m2', 'chat', { sender: 'Bob', text: 'two' });
    const result = formatMessages(getPendingMessages());
    const ctxIdx = result.indexOf('<context');
    const firstMsgIdx = result.indexOf('<message ');
    expect(ctxIdx).toBeGreaterThanOrEqual(0);
    expect(firstMsgIdx).toBeGreaterThan(ctxIdx);
  });
});

describe('multi-message chat batches', () => {
  // Regression guard for #2555: an outer `<messages>` envelope around
  // multiple chat messages caused the Claude Agent SDK to emit a synthetic
  // `No response requested.` stub instead of calling the API. Each
  // `<message>` block is self-contained; concatenating them is enough.
  it('does NOT wrap multiple chat messages in an outer <messages> envelope', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'one' });
    insertMessage('m2', 'chat', { sender: 'Bob', text: 'two' });
    const result = formatMessages(getPendingMessages());
    expect(result).not.toContain('<messages>');
    expect(result).not.toContain('</messages>');
  });

  it('emits one <message> block per inbound row, in order', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'first' });
    insertMessage('m2', 'chat', { sender: 'Bob', text: 'second' });
    insertMessage('m3', 'chat', { sender: 'Carol', text: 'third' });
    const result = formatMessages(getPendingMessages());
    const matches = result.match(/<message [^>]*>/g) ?? [];
    expect(matches.length).toBe(3);
    const firstIdx = result.indexOf('first');
    const secondIdx = result.indexOf('second');
    const thirdIdx = result.indexOf('third');
    expect(firstIdx).toBeGreaterThan(0);
    expect(secondIdx).toBeGreaterThan(firstIdx);
    expect(thirdIdx).toBeGreaterThan(secondIdx);
  });
});

describe('timestamp formatting', () => {
  it('renders time via formatLocalTime (user TZ)', () => {
    // 2026-06-15T12:00:00Z — timezone-agnostic assertions (year is stable)
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hi' }, { timestamp: '2026-06-15T12:00:00.000Z' });
    const result = formatMessages(getPendingMessages());
    // formatLocalTime's format in en-US contains the year and a month abbrev
    expect(result).toContain('2026');
    expect(result).toMatch(/Jun/);
  });

  it('uses 12-hour AM/PM format', () => {
    // 15:30 UTC — some hour will show with AM or PM depending on TZ
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hi' }, { timestamp: '2026-06-15T15:30:00.000Z' });
    const result = formatMessages(getPendingMessages());
    expect(result).toMatch(/(AM|PM)/);
  });
});

describe('reply_to + quoted_message rendering', () => {
  it('renders reply_to attribute and quoted_message when all fields present', () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: 'Yes, on my way!',
      replyTo: { id: '42', sender: 'Bob', text: 'Are you coming tonight?' },
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('reply_to="42"');
    expect(result).toContain('<quoted_message from="Bob">Are you coming tonight?</quoted_message>');
    expect(result).toContain('Yes, on my way!</message>');
  });

  it('omits reply_to and quoted_message when no reply context', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'plain' });
    const result = formatMessages(getPendingMessages());
    expect(result).not.toContain('reply_to');
    expect(result).not.toContain('quoted_message');
  });

  it('renders reply_to but omits quoted_message when original content is missing', () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: 'ack',
      replyTo: { id: '42', sender: 'Bob' }, // no text
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('reply_to="42"');
    expect(result).not.toContain('quoted_message');
  });

  it('XML-escapes reply context', () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: 'reply',
      replyTo: { id: '1', sender: 'A & B', text: '<script>alert("xss")</script>' },
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('from="A &amp; B"');
    expect(result).toContain('&lt;script&gt;');
    expect(result).toContain('&quot;xss&quot;');
  });
});

describe('XML escaping', () => {
  it('escapes <, >, &, " in sender and body', () => {
    insertMessage('m1', 'chat', {
      sender: 'A & B <Co>',
      text: '<script>alert("xss")</script>',
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('sender="A &amp; B &lt;Co&gt;"');
    expect(result).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });
});

describe('stripInternalTags', () => {
  it('strips single-line internal tags and trims', () => {
    expect(stripInternalTags('hello <internal>secret</internal> world')).toBe('hello  world');
  });

  it('strips multi-line internal tags', () => {
    expect(stripInternalTags('hello <internal>\nsecret\nstuff\n</internal> world')).toBe(
      'hello  world',
    );
  });

  it('strips multiple internal tag blocks', () => {
    expect(stripInternalTags('<internal>a</internal>hello<internal>b</internal>')).toBe('hello');
  });

  it('returns empty string when input is only internal tags', () => {
    expect(stripInternalTags('<internal>only this</internal>')).toBe('');
  });

  it('returns input unchanged when there are no internal tags', () => {
    expect(stripInternalTags('hello world')).toBe('hello world');
  });

  it('preserves content that surrounds internal tags', () => {
    expect(stripInternalTags('<internal>thinking</internal>The answer is 42')).toBe(
      'The answer is 42',
    );
  });
});

// PAT: e2e regression for the Slack/Signal image fix (commit 5bd2e2a).
// inbound attachments carry base64 bytes in `attachments[].data`; the
// formatter must materialize them to disk so the back-mind's Read tool
// can ingest them. The test exercises the full path: synthetic
// messages_in row → formatMessages → file on disk + formatted string
// referencing the localPath.
describe('attachment materialization (Slack/Signal image fix)', () => {
  // Minimal real PNG (8x1 transparent), >100 bytes so a base64 round-trip
  // is realistic but the assertion stays fast.
  const PNG_BYTES = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAABCAYAAAAjbtCgAAAAGklEQVQYV2NkYGD4z8DAwMjAwMD4n4GBAQAQOAEEumb1RQAAAABJRU5ErkJggg==',
    'base64',
  );

  let tmpDir: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pat-attach-test-'));
    prevEnv = process.env.PAT_INBOUND_ATTACHMENT_DIR;
    process.env.PAT_INBOUND_ATTACHMENT_DIR = tmpDir;
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.PAT_INBOUND_ATTACHMENT_DIR;
    else process.env.PAT_INBOUND_ATTACHMENT_DIR = prevEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes attachment bytes to disk and renders localPath in output', () => {
    const row = buildRow('m1', 'chat', {
      sender: 'Alice',
      text: 'look at this',
      attachments: [
        { name: 'cat.png', mimeType: 'image/png', data: PNG_BYTES.toString('base64') },
      ],
    });

    const result = formatMessages([row]);

    // File materialized — sha1-keyed name with .png extension.
    const entries = fs.readdirSync(tmpDir);
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatch(/^[0-9a-f]{16}\.png$/);

    // Bytes round-trip cleanly.
    const written = fs.readFileSync(path.join(tmpDir, entries[0]!));
    expect(written.equals(PNG_BYTES)).toBe(true);

    // Formatted string references the localPath (under /workspace) so
    // the back-mind's Read tool can pick it up.
    expect(result).toContain('saved to /workspace/agent/inbound-attachments/');
    expect(result).toContain(entries[0]!);
    // And the file: tag — formatAttachments defaults `type` to 'file'.
    expect(result).toContain('[file:');
  });

  it('falls back to the stub (no throw) when the dir cannot be written', () => {
    // chmod the tmpdir read-only → writeFileSync inside throws → the
    // best-effort catch in materializeAttachmentBytes() swallows it →
    // formatter's localPath branch is skipped and we fall through to
    // the `[type: name]` stub.
    fs.chmodSync(tmpDir, 0o500);
    try {
      const row = buildRow('m2', 'chat', {
        sender: 'Bob',
        text: 'second image',
        attachments: [
          { name: 'dog.png', mimeType: 'image/png', data: PNG_BYTES.toString('base64') },
        ],
      });

      // Must not throw.
      const result = formatMessages([row]);

      // No file landed.
      expect(fs.readdirSync(tmpDir).length).toBe(0);

      // Stub form — no `saved to`, name still rendered.
      expect(result).not.toContain('saved to /workspace/');
      expect(result).toContain('dog.png');
    } finally {
      // Restore perms so afterEach cleanup can rm the dir.
      fs.chmodSync(tmpDir, 0o700);
    }
  });
});
