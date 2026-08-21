/**
 * bash-parse — turn a Bash tool's `command` string into a coarse,
 * human-friendly category + a salient detail string.
 *
 * Used by NarrationManager to enrich `detail.row-received` events with a
 * `parsed_command` field so every consumer (pat-web tool banners,
 * pat-frontend timeline, future Slack bots) renders the same friendly
 * label without re-implementing the regex catalog.
 *
 * The catalog is deliberately small + heuristic. Bash is unbounded; the
 * rules below cover the obvious patterns Pat actually invokes during
 * normal back-mind work. Falls back to `null` for anything we can't
 * categorize — consumers should then show the raw command (or the tool
 * name).
 *
 * Pure function. No side effects. Easily unit-testable.
 */
export type ParsedBashCommandType =
  | 'fetched-web-page'
  | 'ran-program'
  | 'git'
  | 'read-file'
  | 'listed-files'
  | 'searched-files'
  | 'installed-packages'
  | 'edited-file'
  | 'made-directory'
  | 'changed-directory'
  | 'other';

export interface ParsedBashCommand {
  type: ParsedBashCommandType;
  /** A short detail extracted from the command — hostname for fetches,
   *  script name for runs, subcommand for git, file path for reads, etc.
   *  Empty string when nothing is salient. */
  salient: string;
}

/**
 * Parse a single bash command string into a {type, salient} pair, or
 * null if no rule matched. The first rule that matches wins.
 *
 * Rules are intentionally English-friendly past-tense: Pat speaks about
 * what it just did, so the categories are named for how a UI would label
 * a completed action.
 */
export function parseBashCommand(cmdRaw: string): ParsedBashCommand | null {
  if (typeof cmdRaw !== 'string') return null;
  const cmd = cmdRaw.trim();
  if (!cmd) return null;

  // Strip a leading env-var prefix (`FOO=bar BAZ=qux real-cmd ...`) so
  // the head matcher sees the actual program name.
  const head = stripEnvPrefix(cmd);
  if (!head) return null;
  const lower = head.toLowerCase();

  // ── 0. Pipelines / chains — recurse on the first stage ──────────────
  // Has to come BEFORE individual rules so `lastNonFlagArg` doesn't
  // happily walk past the `|` and grab the next stage's argument.
  if (/[|&;]/.test(head)) {
    const firstStage = head.split(/[|&;]/, 1)[0]?.trim();
    if (firstStage && firstStage !== head) {
      const sub = parseBashCommand(firstStage);
      if (sub) return sub;
    }
  }

  // ── 1. Web fetches ──────────────────────────────────────────────────
  // curl, wget, http (httpie), https (httpie), firecrawl-cli style.
  if (
    /^(curl|wget|http|https)\b/i.test(head) ||
    /\bfirecrawl(-cli)?\b/i.test(head) ||
    /\bhttpie\b/i.test(head)
  ) {
    const url = extractUrl(head);
    return { type: 'fetched-web-page', salient: hostnameOf(url) ?? url ?? '' };
  }

  // ── 2. Program runs (interpreters + script files) ───────────────────
  // node script.js, python foo.py, bun run x, deno run, ./script.sh, etc.
  // Order matters: package-manager subcommands first so we don't
  // mis-classify `npm install` as `node install`.
  if (/^(npm|pnpm|yarn|bun|pip|uv|cargo)\s+(install|add|i\b)/i.test(head)) {
    return { type: 'installed-packages', salient: firstWord(head) };
  }
  // `npm run X` / `pnpm exec X` / `bun run X` — must match BEFORE the
  // generic interpreter rule below, otherwise `bun run dev` parses as
  // "bun executes script `run`" instead of "bun runs script `dev`".
  const npmRunMatch = /^(npm|pnpm|yarn|bun)\s+(run|exec)\s+(\S+)/i.exec(head);
  if (npmRunMatch) {
    return { type: 'ran-program', salient: npmRunMatch[3]! };
  }
  // Generic interpreter: `node script.js`, `python foo.py`, `tsx file.ts`.
  const runMatch = /^(node|deno|bun|python3?|ruby|perl|tsx|ts-node)\s+(\S+)/i.exec(head);
  if (runMatch) {
    return { type: 'ran-program', salient: basenameOf(runMatch[2]!) };
  }
  // Direct execution: ./foo, ./bin/foo, ../scripts/foo.sh
  const directExec = /^(\.{1,2}\/\S+)/i.exec(head);
  if (directExec) {
    return { type: 'ran-program', salient: basenameOf(directExec[1]!) };
  }

  // ── 3. Git ───────────────────────────────────────────────────────────
  if (/^git\b/i.test(head)) {
    const sub = /^git\s+(\S+)/i.exec(head);
    return { type: 'git', salient: sub ? sub[1]! : '' };
  }

  // ── 4. File reading ─────────────────────────────────────────────────
  if (/^(cat|head|tail|less|more|bat)\b/i.test(head)) {
    const arg = lastNonFlagArg(head);
    return { type: 'read-file', salient: arg ?? '' };
  }

  // ── 5. Listing ──────────────────────────────────────────────────────
  if (/^(ls|tree|find)\b/i.test(head)) {
    const arg = lastNonFlagArg(head);
    return { type: 'listed-files', salient: arg ?? '' };
  }

  // ── 6. Searching ────────────────────────────────────────────────────
  if (/^(grep|rg|ag|ack|fzf)\b/i.test(head)) {
    // First positional after the command is usually the pattern.
    const args = tokenize(head).slice(1).filter((a) => !a.startsWith('-'));
    return { type: 'searched-files', salient: args[0] ?? '' };
  }

  // ── 7. Editing (sed/awk in-place) ───────────────────────────────────
  if (/^(sed|awk)\b/i.test(head)) {
    const arg = lastNonFlagArg(head);
    return { type: 'edited-file', salient: arg ?? '' };
  }

  // ── 8. Directory ops ────────────────────────────────────────────────
  if (/^mkdir\b/i.test(head)) {
    const arg = lastNonFlagArg(head);
    return { type: 'made-directory', salient: arg ?? '' };
  }
  if (/^cd\b/i.test(head)) {
    const arg = lastNonFlagArg(head);
    return { type: 'changed-directory', salient: arg ?? '' };
  }

  // (Pipelines / conditionals handled at rule 0 above.)

  // No match — let callers know explicitly so they can render the raw
  // command instead of mislabeling.
  void lower; // (`lower` retained for symmetry / future rules.)
  return null;
}

// ─────────────────────── helpers ───────────────────────────────────────

function stripEnvPrefix(cmd: string): string {
  // Strip leading `FOO=bar BAZ=qux` env-var assignments. Stops at the
  // first token that isn't an assignment.
  const tokens = cmd.split(/\s+/);
  let i = 0;
  while (i < tokens.length && /^[A-Z_][A-Z0-9_]*=/.test(tokens[i]!)) i++;
  return tokens.slice(i).join(' ');
}

function tokenize(cmd: string): string[] {
  // Coarse splitter — doesn't deal with quoted strings, but adequate for
  // categorization. Strip surrounding quotes from each token so things
  // like `git "status"` still match positional args.
  return cmd
    .split(/\s+/)
    .map((t) => t.replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

function firstWord(cmd: string): string {
  return tokenize(cmd)[0] ?? '';
}

function basenameOf(p: string): string {
  if (!p) return '';
  const noQuery = p.split(/[?#]/, 1)[0]!;
  const trimmed = noQuery.replace(/\/$/, '');
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

function lastNonFlagArg(cmd: string): string | null {
  const tokens = tokenize(cmd).slice(1);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i]!;
    if (!t.startsWith('-')) return t;
  }
  return null;
}

function extractUrl(cmd: string): string | null {
  const m = /(https?:\/\/[^\s'"`]+)/i.exec(cmd);
  return m ? m[1]! : null;
}

function hostnameOf(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.hostname;
  } catch {
    return null;
  }
}
