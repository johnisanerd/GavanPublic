// PAT: tests for file publishing — signing, expiry, path containment, serving.
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock factories are hoisted above const declarations — vi.hoisted runs first.
const { TEST_ROOT, TEST_DATA, TEST_GROUPS } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const fsH = require('fs') as typeof import('fs');
  const osH = require('os') as typeof import('os');
  const pathH = require('path') as typeof import('path');
  const root = fsH.mkdtempSync(pathH.join(osH.tmpdir(), 'nanoclaw-file-pub-'));
  return { TEST_ROOT: root, TEST_DATA: pathH.join(root, 'data'), TEST_GROUPS: pathH.join(root, 'groups') };
});

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: TEST_DATA, GROUPS_DIR: TEST_GROUPS };
});

vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: vi.fn((id: string) => (id === 'ag-test' ? { id: 'ag-test', folder: 'test-group' } : undefined)),
}));

import {
  publishFile,
  parseTtlHours,
  mintSlug,
  signName,
  handleFilesPubRequest,
  cleanupExpired,
  DEFAULT_TTL_HOURS,
  MAX_TTL_HOURS,
} from './index.js';

const CALLER = { agentGroupId: 'ag-test', sessionId: 'sess-1' };
const AGENT_DIR = path.join(TEST_GROUPS, 'test-group');
const SESS_DIR = path.join(TEST_DATA, 'v2-sessions', 'ag-test', 'sess-1');

beforeAll(() => {
  fs.mkdirSync(AGENT_DIR, { recursive: true });
  fs.mkdirSync(SESS_DIR, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.PAT_PUBLIC_BASE_URL = 'https://pat-staging.plsd.app';
});

function mockRes() {
  const chunks: Buffer[] = [];
  let status = 0;
  let headers: Record<string, unknown> = {};
  const res = {
    writeHead(s: number, h?: Record<string, unknown>) {
      status = s;
      headers = h ?? {};
      return res;
    },
    end(body?: string | Buffer) {
      if (body) chunks.push(Buffer.from(body));
      res.finishedResolve();
    },
    write(b: string | Buffer) {
      chunks.push(Buffer.from(b));
      return true;
    },
    // stream .pipe target support
    on(ev: string, cb: () => void) {
      if (ev === 'unpipe' || ev === 'error') return res;
      return res;
    },
    once() {
      return res;
    },
    emit() {
      return true;
    },
    removeListener() {
      return res;
    },
    destroy() {
      res.finishedResolve();
    },
    finished: null as unknown as Promise<void>,
    finishedResolve: () => {},
  };
  res.finished = new Promise<void>((r) => (res.finishedResolve = r));
  return {
    res: res as unknown as http.ServerResponse,
    status: () => status,
    headers: () => headers,
    body: () => Buffer.concat(chunks).toString(),
    done: () => res.finished,
  };
}

describe('parseTtlHours', () => {
  it('defaults, parses h/d, clamps to [1h, 7d]', () => {
    expect(parseTtlHours(undefined)).toBe(DEFAULT_TTL_HOURS);
    expect(parseTtlHours('24h')).toBe(24);
    expect(parseTtlHours('3d')).toBe(72);
    expect(parseTtlHours('12')).toBe(12);
    expect(parseTtlHours(0.1)).toBe(1);
    expect(parseTtlHours('30d')).toBe(MAX_TTL_HOURS);
    expect(() => parseTtlHours('soon')).toThrow();
  });
});

describe('mintSlug', () => {
  it('8 chars from the safe alphabet, unique-ish', () => {
    const a = mintSlug();
    const b = mintSlug();
    expect(a).toMatch(/^[a-z2-9]{8}$/);
    expect(a).not.toBe(b);
  });
});

describe('publishFile', () => {
  it('publishes an agent-dir file → name.slug.ext + signed URL', () => {
    fs.writeFileSync(path.join(AGENT_DIR, 'Report Final.pdf'), 'PDFDATA');
    const result = publishFile('/workspace/agent/Report Final.pdf', '24h', CALLER);
    expect(result.name).toMatch(/^Report-Final\.[a-z2-9]{8}\.pdf$/);
    expect(result.url).toMatch(
      /^https:\/\/pat-staging\.plsd\.app\/files\/pub\/Report-Final\.[a-z2-9]{8}\.pdf\?exp=\d+&sig=[0-9a-f]{64}$/,
    );
    expect(fs.existsSync(path.join(TEST_DATA, 'published', result.name))).toBe(true);
    expect(fs.existsSync(path.join(TEST_DATA, 'published', `${result.name}.meta.json`))).toBe(true);
  });

  it('accepts session-dir and relative paths', () => {
    fs.writeFileSync(path.join(SESS_DIR, 'notes.txt'), 'hi');
    fs.writeFileSync(path.join(AGENT_DIR, 'rel.txt'), 'rel');
    expect(publishFile('/workspace/notes.txt', undefined, CALLER).name).toMatch(/^notes\./);
    expect(publishFile('rel.txt', undefined, CALLER).name).toMatch(/^rel\./);
  });

  it('refuses paths outside the workspace and symlink escapes', () => {
    fs.writeFileSync(path.join(TEST_ROOT, 'secret.txt'), 'no');
    expect(() => publishFile('/etc/passwd', undefined, CALLER)).toThrow(/under \/workspace/);
    expect(() => publishFile('/workspace/agent/../../secret.txt', undefined, CALLER)).toThrow();
    fs.symlinkSync(path.join(TEST_ROOT, 'secret.txt'), path.join(AGENT_DIR, 'sneaky.txt'));
    expect(() => publishFile('/workspace/agent/sneaky.txt', undefined, CALLER)).toThrow(/escapes/);
  });

  it('refuses a missing file', () => {
    expect(() => publishFile('/workspace/agent/nope.bin', undefined, CALLER)).toThrow(/not found/);
  });
});

describe('handleFilesPubRequest', () => {
  function urlFor(name: string, exp: number, sig?: string): URL {
    return new URL(`https://x/files/pub/${encodeURIComponent(name)}?exp=${exp}&sig=${sig ?? signName(name, exp)}`);
  }

  it('serves a valid signed URL with safe headers', async () => {
    fs.writeFileSync(path.join(AGENT_DIR, 'pic.png'), 'PNG');
    const pub = publishFile('/workspace/agent/pic.png', '24h', CALLER);
    const u = new URL(pub.url);
    const m = mockRes();
    handleFilesPubRequest(m.res, u);
    await m.done();
    expect(m.status()).toBe(200);
    expect(m.headers()['content-type']).toBe('image/png');
    expect(m.headers()['x-content-type-options']).toBe('nosniff');
    expect(m.headers()['content-security-policy']).toBe('sandbox');
    expect(m.headers()['content-disposition']).toContain('inline');
  });

  it('forces attachment for active-content types (html)', async () => {
    fs.writeFileSync(path.join(AGENT_DIR, 'page.html'), '<script>x</script>');
    const pub = publishFile('/workspace/agent/page.html', '2h', CALLER);
    const m = mockRes();
    handleFilesPubRequest(m.res, new URL(pub.url));
    await m.done();
    expect(m.status()).toBe(200);
    expect(m.headers()['content-disposition']).toContain('attachment');
  });

  it('404s on bad signature / unknown name / traversal', async () => {
    fs.writeFileSync(path.join(AGENT_DIR, 'a.txt'), 'a');
    const pub = publishFile('/workspace/agent/a.txt', '2h', CALLER);
    const exp = Number(new URL(pub.url).searchParams.get('exp'));

    let m = mockRes();
    handleFilesPubRequest(m.res, urlFor(pub.name, exp, 'f'.repeat(64)));
    expect(m.status()).toBe(404);

    m = mockRes();
    handleFilesPubRequest(m.res, urlFor('ghost.txt', exp));
    expect(m.status()).toBe(404);

    m = mockRes();
    handleFilesPubRequest(m.res, new URL('https://x/files/pub/..%2Ffile-pub.key?exp=1&sig=ab'));
    expect(m.status()).toBe(404);
  });

  it('410s + reaps after expiry; tampered exp fails the signature', () => {
    fs.writeFileSync(path.join(AGENT_DIR, 'b.txt'), 'b');
    const pub = publishFile('/workspace/agent/b.txt', '1h', CALLER);
    const realExp = Number(new URL(pub.url).searchParams.get('exp'));

    // Tampering exp without re-signing → 404 (sig covers exp).
    let m = mockRes();
    handleFilesPubRequest(m.res, urlFor(pub.name, realExp + 999999, new URL(pub.url).searchParams.get('sig')!));
    expect(m.status()).toBe(404);

    // A correctly-signed but past exp → 410 and the file is reaped.
    const pastExp = Math.floor(Date.now() / 1000) - 10;
    m = mockRes();
    handleFilesPubRequest(m.res, urlFor(pub.name, pastExp));
    expect(m.status()).toBe(410);
    expect(fs.existsSync(path.join(TEST_DATA, 'published', pub.name))).toBe(false);
  });
});

describe('cleanupExpired', () => {
  it('reaps only expired pairs', () => {
    const dir = path.join(TEST_DATA, 'published');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'old.x.txt'), 'x');
    fs.writeFileSync(path.join(dir, 'old.x.txt.meta.json'), JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 5 }));
    fs.writeFileSync(path.join(dir, 'new.y.txt'), 'y');
    fs.writeFileSync(
      path.join(dir, 'new.y.txt.meta.json'),
      JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    );
    const removed = cleanupExpired();
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(dir, 'old.x.txt'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'new.y.txt'))).toBe(true);
  });
});
