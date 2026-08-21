import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { buildPromptChain, renderChain } from './prompt-snapshot.js';

let tmpRoot: string;
let projectDir: string;
let userDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pat-promptsnap-'));
  projectDir = path.join(tmpRoot, 'group');
  userDir = path.join(tmpRoot, 'agent');
  fs.mkdirSync(projectDir);
  fs.mkdirSync(userDir);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('buildPromptChain', () => {
  test('always includes sdk-preset (opaque) and addendum entries', () => {
    const chain = buildPromptChain('ADDENDUM_TEXT', projectDir, userDir);
    expect(chain[0]).toMatchObject({ source: 'sdk-preset', status: 'opaque' });
    expect(chain[1]).toMatchObject({
      source: 'addendum',
      content: 'ADDENDUM_TEXT',
      status: 'ok',
    });
  });

  test('reports missing files with status=missing, not error', () => {
    const chain = buildPromptChain('', projectDir, userDir);
    const project = chain.find((e) => e.source === 'project-claude-md');
    const userLocal = chain.find((e) => e.source === 'user-claude-local-md');
    expect(project?.status).toBe('missing');
    expect(userLocal?.status).toBe('missing');
  });

  test('dedupes CLAUDE.local.md when both composed @-import AND cwd auto-load paths hit it', () => {
    // Mirror the real-world setup: composed CLAUDE.md @-imports CLAUDE.local.md,
    // AND the SDK cwd auto-load would find the same file. The snapshot should
    // show CLAUDE.local.md content exactly once (the second hit reports as cycle).
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '@./CLAUDE.local.md');
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.local.md'), 'LOCAL_BODY');
    const chain = buildPromptChain('', projectDir, projectDir);
    const okLocal = chain.filter((e) => e.status === 'ok' && path.basename(e.path) === 'CLAUDE.local.md');
    expect(okLocal.length).toBe(1);
    expect(okLocal[0].content).toBe('LOCAL_BODY');
    // The second path should still appear, but marked as cycle (so the chain
    // is honest about both load mechanisms being present).
    const cycleLocal = chain.filter((e) => e.status === 'cycle' && path.basename(e.path) === 'CLAUDE.local.md');
    expect(cycleLocal.length).toBe(1);
  });

  test('reads project CLAUDE.md when present', () => {
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), 'PROJECT_BODY');
    const chain = buildPromptChain('', projectDir, userDir);
    const project = chain.find((e) => e.source === 'project-claude-md');
    expect(project?.status).toBe('ok');
    expect(project?.content).toBe('PROJECT_BODY');
  });

  test('resolves a single @-import from project CLAUDE.md', () => {
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '@./fragment.md\nrest of body');
    fs.writeFileSync(path.join(projectDir, 'fragment.md'), 'FRAGMENT_BODY');
    const chain = buildPromptChain('', projectDir, userDir);
    const fragment = chain.find((e) => e.source === 'import' && e.path.endsWith('fragment.md'));
    expect(fragment?.status).toBe('ok');
    expect(fragment?.content).toBe('FRAGMENT_BODY');
  });

  test('resolves nested @-imports up to the depth limit', () => {
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '@./a.md');
    fs.writeFileSync(path.join(projectDir, 'a.md'), '@./b.md');
    fs.writeFileSync(path.join(projectDir, 'b.md'), '@./c.md');
    fs.writeFileSync(path.join(projectDir, 'c.md'), 'LEAF');
    const chain = buildPromptChain('', projectDir, userDir);
    const paths = chain.filter((e) => e.source === 'import').map((e) => path.basename(e.path));
    expect(paths).toEqual(['a.md', 'b.md', 'c.md']);
    const leaf = chain.find((e) => path.basename(e.path) === 'c.md');
    expect(leaf?.content).toBe('LEAF');
  });

  test('breaks cycles without infinite recursion', () => {
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '@./a.md');
    fs.writeFileSync(path.join(projectDir, 'a.md'), '@./b.md');
    fs.writeFileSync(path.join(projectDir, 'b.md'), '@./a.md');
    const chain = buildPromptChain('', projectDir, userDir);
    const cycleEntries = chain.filter((e) => e.status === 'cycle');
    expect(cycleEntries.length).toBeGreaterThan(0);
  });

  test('absolute @-imports resolve from filesystem root', () => {
    const absFile = path.join(tmpRoot, 'shared.md');
    fs.writeFileSync(absFile, 'SHARED_BODY');
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), `@${absFile}`);
    const chain = buildPromptChain('', projectDir, userDir);
    const shared = chain.find((e) => e.source === 'import' && e.path === absFile);
    expect(shared?.status).toBe('ok');
    expect(shared?.content).toBe('SHARED_BODY');
  });

  test('@-import to a missing file is reported as missing, not error', () => {
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '@./does-not-exist.md');
    const chain = buildPromptChain('', projectDir, userDir);
    const missing = chain.find((e) => e.source === 'import' && e.path.endsWith('does-not-exist.md'));
    expect(missing?.status).toBe('missing');
  });

  test('reproduces the palisade-internal shape (composed + local + nested architecture)', () => {
    // Mirror what a prior review found: composed CLAUDE.md @-imports a shared base and
    // module fragments. The PAT-side composer also @-imports CLAUDE.local.md,
    // which in turn @-imports PAT-ARCHITECTURE.md.
    fs.writeFileSync(path.join(projectDir, '.claude-shared.md'), 'SHARED_BASE');
    fs.mkdirSync(path.join(projectDir, '.claude-fragments'));
    fs.writeFileSync(path.join(projectDir, '.claude-fragments', 'module-core.md'), 'MODULE_CORE');
    fs.writeFileSync(
      path.join(projectDir, 'CLAUDE.md'),
      ['@./.claude-shared.md', '@./.claude-fragments/module-core.md', '@./CLAUDE.local.md'].join('\n'),
    );
    // CLAUDE.local.md lives in userDir per the actual layout; for this test
    // we put a copy in projectDir to match the @-import path. Real cwd layout
    // is exercised separately via the userDir param.
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.local.md'), ['PERSONALITY', '@./PAT-ARCHITECTURE.md'].join('\n'));
    fs.writeFileSync(path.join(projectDir, 'PAT-ARCHITECTURE.md'), 'ARCH_BODY');

    const chain = buildPromptChain('ADDENDUM', projectDir, userDir);
    const okImports = chain.filter((e) => e.source === 'import' && e.status === 'ok').map((e) => path.basename(e.path));
    expect(okImports).toContain('.claude-shared.md');
    expect(okImports).toContain('module-core.md');
    expect(okImports).toContain('CLAUDE.local.md');
    expect(okImports).toContain('PAT-ARCHITECTURE.md');
  });
});

describe('renderChain', () => {
  test('renders ok entries with delimiters showing source + path', () => {
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), 'PROJECT_BODY');
    const chain = buildPromptChain('ADD', projectDir, userDir);
    const rendered = renderChain(chain);
    expect(rendered).toContain('===== addendum [ok] destinations.ts:buildSystemPromptAddendum() =====');
    expect(rendered).toContain('ADD');
    expect(rendered).toContain('===== project-claude-md [ok] ');
    expect(rendered).toContain('PROJECT_BODY');
    expect(rendered).toContain('===== sdk-preset [opaque] ');
    expect(rendered).toContain('<opaque — content not accessible from caller>');
  });

  test('renders missing-status entries with a clear placeholder', () => {
    const chain = buildPromptChain('', projectDir, userDir);
    const rendered = renderChain(chain);
    expect(rendered).toContain('<file not found>');
  });
});
