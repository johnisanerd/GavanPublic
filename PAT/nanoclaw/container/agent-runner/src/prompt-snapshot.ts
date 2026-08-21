// PAT: prompt-snapshot helper — reconstructs the full system-prompt chain
// that the Claude Code SDK assembles at query time, so the `llm.call` log
// event can capture more than just the runtime addendum from destinations.ts.
//
// Why this exists: the SDK takes `systemPrompt: { type: 'preset', append }`
// plus `settingSources: ['project', 'user']` and resolves the project
// CLAUDE.md + per-group CLAUDE.local.md + their `@./...` imports
// internally — none of that is visible from the call site. To debug
// "what is actually in the back-mind's prompt right now?" we reconstruct
// the same chain from the filesystem at log-write time.
//
// The Claude Code SDK preset itself is opaque (ships inside
// @anthropic-ai/claude-agent-sdk) — that one chunk we cannot reconstruct,
// so the snapshot marks it as such.

import fs from 'fs';
import path from 'path';

interface PromptChainEntry {
  source: 'sdk-preset' | 'addendum' | 'project-claude-md' | 'user-claude-local-md' | 'import';
  /** Path that was read, or symbolic name for opaque/synthetic entries. */
  path: string;
  /** Reconstructed content. Empty string when status is 'opaque' or 'missing'. */
  content: string;
  /** 'ok' = read successfully; 'missing' = file does not exist;
   *  'opaque' = exists in the prompt but we cannot read it (SDK preset);
   *  'cycle' = @import cycle hit, skipped to avoid infinite recursion;
   *  'depth-limit' = recursion depth exceeded;
   *  'error' = read failed with a non-ENOENT error. */
  status: 'ok' | 'missing' | 'opaque' | 'cycle' | 'depth-limit' | 'error';
  /** Error message when status='error'. */
  error?: string;
}

const MAX_IMPORT_DEPTH = 6;
const IMPORT_RE = /^@(\.{1,2}\/[^\s\n]+|\/[^\s\n]+)/gm;

/**
 * Reconstruct the prompt chain. Returns a flat list of entries in the order
 * the SDK is expected to assemble them.
 *
 * @param addendum   Runtime addendum string (destinations.ts output).
 * @param projectDir Where the SDK looks for the project CLAUDE.md
 *                   (typically `/workspace/group`).
 * @param userDir    Where the per-group CLAUDE.local.md lives
 *                   (typically `/workspace/agent`).
 */
export function buildPromptChain(addendum: string, projectDir: string, userDir: string): PromptChainEntry[] {
  const chain: PromptChainEntry[] = [];

  chain.push({
    source: 'sdk-preset',
    path: '@anthropic-ai/claude-agent-sdk:preset=claude_code',
    content: '',
    status: 'opaque',
  });

  chain.push({
    source: 'addendum',
    path: 'destinations.ts:buildSystemPromptAddendum()',
    content: addendum,
    status: 'ok',
  });

  // PAT: shared `visited` across both trees so that CLAUDE.local.md
  // doesn't appear twice — the composer @-imports it from CLAUDE.md
  // AND it loads via cwd auto-load. Either path is equivalent from the
  // model's POV; the snapshot should reflect that with one entry, not
  // two with the same content.
  const visited = new Set<string>();

  const projectClaudeMd = path.join(projectDir, 'CLAUDE.md');
  collectFile(projectClaudeMd, 'project-claude-md', chain, visited, 0);

  const userClaudeLocalMd = path.join(userDir, 'CLAUDE.local.md');
  collectFile(userClaudeLocalMd, 'user-claude-local-md', chain, visited, 0);

  return chain;
}

function collectFile(
  filePath: string,
  source: PromptChainEntry['source'],
  chain: PromptChainEntry[],
  visited: Set<string>,
  depth: number,
): void {
  if (depth > MAX_IMPORT_DEPTH) {
    chain.push({ source, path: filePath, content: '', status: 'depth-limit' });
    return;
  }

  const resolved = path.resolve(filePath);
  if (visited.has(resolved)) {
    chain.push({ source, path: resolved, content: '', status: 'cycle' });
    return;
  }
  visited.add(resolved);

  let content: string;
  try {
    content = fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      chain.push({ source, path: resolved, content: '', status: 'missing' });
    } else {
      chain.push({ source, path: resolved, content: '', status: 'error', error: String(err) });
    }
    return;
  }

  chain.push({ source, path: resolved, content, status: 'ok' });

  // PAT: collect all @-import specs BEFORE recursing — recursion resets
  // the module-level regex's `lastIndex`, which would otherwise cause the
  // outer loop to re-match its first import after the inner call returns.
  const dir = path.dirname(resolved);
  const importSpecs: string[] = [];
  for (const match of content.matchAll(IMPORT_RE)) {
    importSpecs.push(match[1]);
  }
  for (const spec of importSpecs) {
    const importPath = path.isAbsolute(spec) ? spec : path.resolve(dir, spec);
    collectFile(importPath, 'import', chain, visited, depth + 1);
  }
}

/**
 * Render the chain as a single string with delimiters showing source.
 * Used to populate the `system_prompt` field of `llm.call` events without
 * needing a schema change for a separate structured field.
 */
export function renderChain(chain: PromptChainEntry[]): string {
  const parts: string[] = [];
  for (const entry of chain) {
    const header = `===== ${entry.source} [${entry.status}] ${entry.path} =====`;
    if (entry.status === 'opaque') {
      parts.push(`${header}\n<opaque — content not accessible from caller>\n`);
    } else if (entry.status === 'missing') {
      parts.push(`${header}\n<file not found>\n`);
    } else if (entry.status === 'cycle') {
      parts.push(`${header}\n<@-import cycle — already included earlier in chain>\n`);
    } else if (entry.status === 'depth-limit') {
      parts.push(`${header}\n<recursion depth limit hit>\n`);
    } else if (entry.status === 'error') {
      parts.push(`${header}\n<read failed: ${entry.error}>\n`);
    } else {
      parts.push(`${header}\n${entry.content}\n`);
    }
  }
  return parts.join('\n');
}
