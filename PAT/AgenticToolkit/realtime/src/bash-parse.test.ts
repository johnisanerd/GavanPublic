/**
 * bash-parse — unit tests for the Bash command categorizer.
 */
import { describe, it, expect } from 'vitest';

import { parseBashCommand } from './bash-parse.js';

describe('parseBashCommand', () => {
  it('returns null for empty / non-string input', () => {
    expect(parseBashCommand('')).toBeNull();
    expect(parseBashCommand('   ')).toBeNull();
    expect(parseBashCommand(undefined as unknown as string)).toBeNull();
  });

  describe('web fetches', () => {
    it('classifies curl with hostname', () => {
      expect(parseBashCommand('curl https://example.com/api/foo')).toEqual({
        type: 'fetched-web-page',
        salient: 'example.com',
      });
    });
    it('classifies wget', () => {
      expect(parseBashCommand('wget -O - https://news.ycombinator.com')).toEqual({
        type: 'fetched-web-page',
        salient: 'news.ycombinator.com',
      });
    });
    it('classifies firecrawl by binary name', () => {
      const r = parseBashCommand('firecrawl scrape https://docs.example.com');
      expect(r?.type).toBe('fetched-web-page');
    });
    it('falls back to raw url when not parseable', () => {
      expect(parseBashCommand('curl no-scheme.example')).toEqual({
        type: 'fetched-web-page',
        salient: '',
      });
    });
  });

  describe('program runs', () => {
    it('classifies node script.js', () => {
      expect(parseBashCommand('node scripts/foo.js')).toEqual({
        type: 'ran-program',
        salient: 'foo.js',
      });
    });
    it('classifies python file', () => {
      expect(parseBashCommand('python3 ./tools/check.py --flag')).toEqual({
        type: 'ran-program',
        salient: 'check.py',
      });
    });
    it('classifies bun run X', () => {
      expect(parseBashCommand('bun run dev')).toEqual({
        type: 'ran-program',
        salient: 'dev',
      });
    });
    it('classifies npm run X', () => {
      expect(parseBashCommand('npm run build:check')).toEqual({
        type: 'ran-program',
        salient: 'build:check',
      });
    });
    it('classifies pnpm exec X', () => {
      expect(parseBashCommand('pnpm exec vite')).toEqual({
        type: 'ran-program',
        salient: 'vite',
      });
    });
    it('classifies ./script', () => {
      expect(parseBashCommand('./bin/release.sh --dry-run')).toEqual({
        type: 'ran-program',
        salient: 'release.sh',
      });
    });
  });

  describe('git', () => {
    it('extracts subcommand', () => {
      expect(parseBashCommand('git status --short')).toEqual({
        type: 'git',
        salient: 'status',
      });
      expect(parseBashCommand('git log -10')).toEqual({
        type: 'git',
        salient: 'log',
      });
    });
  });

  describe('file reading', () => {
    it('classifies cat with file', () => {
      expect(parseBashCommand('cat README.md')).toEqual({
        type: 'read-file',
        salient: 'README.md',
      });
    });
    it('classifies head with file', () => {
      expect(parseBashCommand('head -n 20 some/file.ts')).toEqual({
        type: 'read-file',
        salient: 'some/file.ts',
      });
    });
  });

  describe('listing', () => {
    it('classifies ls', () => {
      expect(parseBashCommand('ls -la some/dir')).toEqual({
        type: 'listed-files',
        salient: 'some/dir',
      });
    });
    it('classifies find', () => {
      expect(parseBashCommand('find . -name "*.ts"')).toEqual({
        type: 'listed-files',
        salient: '*.ts',
      });
    });
  });

  describe('searching', () => {
    it('classifies grep with pattern', () => {
      expect(parseBashCommand('grep -rn "TODO" src/')).toEqual({
        type: 'searched-files',
        salient: 'TODO',
      });
    });
    it('classifies rg', () => {
      expect(parseBashCommand('rg foo')).toEqual({
        type: 'searched-files',
        salient: 'foo',
      });
    });
  });

  describe('package install', () => {
    it('classifies npm install', () => {
      expect(parseBashCommand('npm install')).toEqual({
        type: 'installed-packages',
        salient: 'npm',
      });
    });
    it('classifies pnpm add', () => {
      expect(parseBashCommand('pnpm add lodash')).toEqual({
        type: 'installed-packages',
        salient: 'pnpm',
      });
    });
  });

  describe('directory ops', () => {
    it('classifies mkdir', () => {
      expect(parseBashCommand('mkdir -p new/dir')).toEqual({
        type: 'made-directory',
        salient: 'new/dir',
      });
    });
    it('classifies cd', () => {
      expect(parseBashCommand('cd src/')).toEqual({
        type: 'changed-directory',
        salient: 'src/',
      });
    });
  });

  describe('pipelines', () => {
    it('inspects first stage of pipeline', () => {
      // First stage is `ls -la` — only flags, no positional → empty salient.
      expect(parseBashCommand('ls -la | grep foo')).toEqual({
        type: 'listed-files',
        salient: '',
      });
    });
    it('uses path arg from first stage of pipeline', () => {
      expect(parseBashCommand('ls some/dir | wc -l')).toEqual({
        type: 'listed-files',
        salient: 'some/dir',
      });
    });
    it('handles && conditional', () => {
      expect(parseBashCommand('git status && git log')).toEqual({
        type: 'git',
        salient: 'status',
      });
    });
  });

  describe('env-prefix stripping', () => {
    it('handles leading env vars', () => {
      expect(parseBashCommand('FOO=bar BAZ=qux git status')).toEqual({
        type: 'git',
        salient: 'status',
      });
    });
  });

  it('returns null for unrecognized command', () => {
    expect(parseBashCommand('foobarbaz xyz')).toBeNull();
  });
});
