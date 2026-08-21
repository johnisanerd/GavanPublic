/**
 * Back-mind state synthesizer tests — pure logic, no network.
 *
 * `applyDetailRow` is a deterministic fold over the event log. These tests pin
 * each detail-row type's effect and verify the fold is replay-safe (idempotent
 * for the spike's "apply each row exactly once" contract).
 */
import { describe, it, expect } from 'vitest';

import {
  emptyBackMindState,
  applyDetailRow,
  rebuildBackMindState,
  renderBackMindState,
  type BackMindState,
} from './state.js';
import type { DetailRow } from './nanoclaw-client.js';

function detailRow(seq: number, content: DetailRow['content'], timestamp = `2026-05-05T12:00:${String(seq).padStart(2, '0')}Z`): DetailRow {
  return { seq, timestamp, content };
}

describe('emptyBackMindState', () => {
  it('has every field zeroed', () => {
    const state = emptyBackMindState();
    expect(state.toolHistory).toEqual([]);
    expect(state.streamingTail).toBe('');
  });
});

describe('applyDetailRow', () => {
  it('tool-pre appends an in-progress entry and resets streaming tail', () => {
    const state: BackMindState = {
      ...emptyBackMindState(),
      streamingTail: 'leftover from previous tool',
    };
    const row = detailRow(1, { type: 'tool-pre', tool: 'read_file', input: { path: '/etc/hosts' } });
    const next = applyDetailRow(state, row);
    expect(next.toolHistory).toHaveLength(1);
    expect(next.toolHistory[0]).toEqual({
      tool: 'read_file',
      input: { path: '/etc/hosts' },
      startedAt: row.timestamp,
      finishedAt: null,
    });
    expect(next.streamingTail).toBe('');
  });

  it('tool-post closes the in-progress entry with result + finishedAt', () => {
    const state: BackMindState = {
      ...emptyBackMindState(),
      toolHistory: [{ tool: 'read_file', input: { path: '/x' }, startedAt: '2026-05-05T12:00:00Z', finishedAt: null }],
      streamingTail: 'partial output...',
    };
    const row = detailRow(2, { type: 'tool-post', tool: 'read_file', result: 'file contents' });
    const next = applyDetailRow(state, row);
    expect(next.toolHistory).toHaveLength(1);
    expect(next.toolHistory[0]!.finishedAt).toBe(row.timestamp);
    expect(next.toolHistory[0]!.result).toBe('file contents');
    expect(next.streamingTail).toBe('');
  });

  it('tool-failed closes the in-progress entry with error + finishedAt', () => {
    const state: BackMindState = {
      ...emptyBackMindState(),
      toolHistory: [{ tool: 'install_packages', input: { pkg: 'python3' }, startedAt: 't', finishedAt: null }],
    };
    const row = detailRow(3, { type: 'tool-failed', tool: 'install_packages', error: 'no admin configured' });
    const next = applyDetailRow(state, row);
    expect(next.toolHistory).toHaveLength(1);
    expect(next.toolHistory[0]!.finishedAt).toBe(row.timestamp);
    expect(next.toolHistory[0]!.error).toBe('no admin configured');
  });

  it('token-delta appends to the streaming tail', () => {
    const state = { ...emptyBackMindState(), streamingTail: 'I am ' };
    const row = detailRow(4, { type: 'token-delta', text: 'thinking...' });
    const next = applyDetailRow(state, row);
    expect(next.streamingTail).toBe('I am thinking...');
  });

  it('compact does not mutate state', () => {
    const state: BackMindState = {
      ...emptyBackMindState(),
      toolHistory: [{ tool: 't', input: {}, startedAt: 't0', finishedAt: 'now', result: 'r' }],
    };
    const row = detailRow(5, { type: 'compact', sessionId: 'sess-1' });
    const next = applyDetailRow(state, row);
    expect(next).toEqual(state);
  });

  it('does not mutate the input state', () => {
    const state = emptyBackMindState();
    const snapshot = JSON.parse(JSON.stringify(state));
    applyDetailRow(state, detailRow(1, { type: 'tool-pre', tool: 'x', input: {} }));
    expect(state).toEqual(snapshot);
  });
});

describe('rebuildBackMindState', () => {
  it('folds an empty stream into empty state', () => {
    expect(rebuildBackMindState([])).toEqual(emptyBackMindState());
  });

  it('folds a realistic tool sequence', () => {
    const rows: DetailRow[] = [
      detailRow(1, { type: 'tool-pre', tool: 'read_file', input: { path: '/a' } }),
      detailRow(2, { type: 'token-delta', text: 'reading' }),
      detailRow(3, { type: 'token-delta', text: ' /a' }),
      detailRow(4, { type: 'tool-post', tool: 'read_file', result: 'contents-a' }),
      detailRow(5, { type: 'tool-pre', tool: 'read_file', input: { path: '/b' } }),
      detailRow(6, { type: 'tool-failed', tool: 'read_file', error: 'enoent' }),
    ];
    const state = rebuildBackMindState(rows);
    expect(state.toolHistory).toHaveLength(2);
    expect(state.toolHistory[0]!.tool).toBe('read_file');
    expect(state.toolHistory[0]!.finishedAt).not.toBeNull();
    expect(state.toolHistory[0]!.result).toBe('contents-a');
    expect(state.toolHistory[1]!.finishedAt).not.toBeNull();
    expect(state.toolHistory[1]!.error).toBe('enoent');
    expect(state.streamingTail).toBe(''); // reset by tool-post then tool-pre
  });

  it('replay yields the same state (idempotent for apply-each-once)', () => {
    const rows: DetailRow[] = [
      detailRow(1, { type: 'tool-pre', tool: 't', input: { x: 1 } }),
      detailRow(2, { type: 'tool-post', tool: 't', result: 'ok' }),
    ];
    const a = rebuildBackMindState(rows);
    const b = rebuildBackMindState(rows);
    expect(a).toEqual(b);
  });
});

describe('renderBackMindState', () => {
  it('returns empty string for empty state', () => {
    expect(renderBackMindState(emptyBackMindState())).toBe('');
  });

  it('renders an in-progress tool', () => {
    const state: BackMindState = {
      toolHistory: [{ tool: 'bash', input: { cmd: 'pnpm test' }, startedAt: 't', finishedAt: null }],
      streamingTail: '',
    };
    const out = renderBackMindState(state);
    expect(out).toContain('bash');
    expect(out).toContain('in progress');
    expect(out).toContain('pnpm test');
  });

  it('renders a completed tool with its result', () => {
    const state: BackMindState = {
      toolHistory: [
        { tool: 'read_file', input: { path: '/a' }, startedAt: 't0', finishedAt: 't1', result: 'contents' },
      ],
      streamingTail: '',
    };
    const out = renderBackMindState(state);
    expect(out).toContain('read_file');
    expect(out).toContain('[done]');
    expect(out).toContain('contents');
  });

  it('renders a failed tool with its error', () => {
    const state: BackMindState = {
      toolHistory: [
        { tool: 'fetch', input: { url: 'https://example' }, startedAt: 't0', finishedAt: 't1', error: 'timeout' },
      ],
      streamingTail: '',
    };
    const out = renderBackMindState(state);
    expect(out).toContain('fetch');
    expect(out).toContain('error: timeout');
  });

  it('renders the streaming tail (truncated to last 200 chars)', () => {
    const state = { ...emptyBackMindState(), streamingTail: 'x'.repeat(500) };
    const out = renderBackMindState(state);
    expect(out).toMatch(/^streaming-tail: x{200}$/);
  });
});
