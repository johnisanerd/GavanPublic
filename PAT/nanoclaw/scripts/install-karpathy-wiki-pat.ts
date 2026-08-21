/**
 * PAT: install the Karpathy LLM-Wiki skill into PAT's primary agent group
 * (`palisade-internal`, agent group id `ag-<redacted>`).
 *
 * The stock `/add-karpathy-llm-wiki` skill at
 * `.claude/skills/add-karpathy-llm-wiki/SKILL.md` is a human-walkthrough
 * skill — it's meant to be invoked by a Claude Code session at the
 * keyboard, Q&A-style, against an interactive operator. This script is the
 * non-interactive equivalent for PAT's specific group. It does steps
 * 3a/3b/3c/5 of that skill non-interactively, with bias settings agreed
 * during Wave 2.E.
 *
 * Why we don't modify the upstream skill: the stock skill is the
 * collaborative interface for human-operated NanoClaw deployments; we want
 * to keep it intact for future operators using NanoClaw for unrelated
 * domains. PAT's needs are specific (voice-conversational artifacts,
 * single-writer back-mind, atomic-rename lock) and worth a separate
 * installer rather than a fork.
 *
 * ## Divergences from upstream SKILL.md (intentional, not bug-compat)
 *
 * 1. Container skill: the upstream SKILL.md says "Create
 *    `container/skills/wiki/SKILL.md`" — this script doesn't create that
 *    file. It already exists, committed in this repo at that path with
 *    PAT-specific biases (calls/, feedback/, references/ shape; atomic-
 *    rename lock; single-writer discipline; voice-aware tone).
 *
 * 2. Group-level CLAUDE.md: the upstream skill says edit the group's
 *    `CLAUDE.md`. NanoClaw v2 composes `CLAUDE.md` at spawn time from a
 *    set of fragments — the human-editable surface is `CLAUDE.local.md`.
 *    This script appends to `groups/palisade-internal/CLAUDE.local.md`.
 *
 * 3. Step-5 cron-task creation: the upstream skill snippet uses a
 *    `scheduled_tasks` table in `store/messages.db`. That's the old v1
 *    schema. In v2 (current), scheduled tasks are `messages_in` rows with
 *    `kind='task'` in a per-session `inbound.db`. This script uses
 *    `insertTask()` from `src/modules/scheduling/db.ts` against the
 *    realtime group's active session.
 *
 * ## Deploy story
 *
 * This installer writes to `groups/<folder>/`, which is gitignored.
 * The wiki itself grows organically: this installer wires the CLAUDE.local.md
 * + scheduled lint task; the back-mind populates the wiki contents
 * through normal use of the wiki skill. There is no seed-import step
 * (task #41 removed the prior `seed-wiki-from-memory.ts` + the
 * `container/wiki-seed/` snapshot + the `fly-entrypoint.sh §1.5`
 * cp-rn block — those bypassed organic growth with a 48-entry
 * pre-load from local auto-memory, which the user later decided was
 * a mistake).
 *
 * ## Idempotence
 *
 * Every step is gated on the target not already existing:
 *   - wiki/ + sources/ + subdirs — `mkdirSync({ recursive: true })`
 *   - wiki/index.md + wiki/log.md — written only if missing
 *   - CLAUDE.local.md append — checks for a sentinel string before
 *     appending
 *   - scheduled task — looks for any pending/paused live task with
 *     id starting `task-wiki-lint-` and skips if found
 *
 * ## Usage
 *
 *   pnpm exec tsx scripts/install-karpathy-wiki-pat.ts
 *
 * No flags — the target group is hardcoded by folder name. Re-running is
 * a no-op once everything is in place.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR, TIMEZONE } from '../src/config.js';
import { getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import { getSessionsByAgentGroup } from '../src/db/sessions.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { insertTask } from '../src/modules/scheduling/db.js';
import { openInboundDb } from '../src/db/session-db.js';
import { inboundDbPath } from '../src/session-manager.js';

const GROUP_FOLDER = 'palisade-internal';

// `0 12 * * *` interpreted per the host's TIMEZONE config (see
// src/config.ts:resolveConfigTimezone). On Fly TZ is unset → defaults to
// UTC, so 12:00 UTC = 04:00 America/Los_Angeles (PT, no DST → see note).
// On the local dev box TIMEZONE will resolve to America/Los_Angeles, so a
// dev-installed task fires at noon PT — that's fine for smoke-testing.
// Wave 2.E ships this on Fly, so the production cadence is 4am PT.
const LINT_CRON = '0 12 * * *';

// Sentinel string in CLAUDE.local.md so re-runs don't double-append.
const CLAUDE_LOCAL_SENTINEL = '<!-- PAT: wiki-system installed by install-karpathy-wiki-pat.ts -->';

// CLAUDE.local.md additions, biased per Wave 2.E plan toward voice-
// conversational artifacts. This is addressed to the back-mind (the wiki
// writer); the front-mind awareness lives separately in realtime/src
// system prompts.
const CLAUDE_LOCAL_INSERT = `
${CLAUDE_LOCAL_SENTINEL}

# Your extended memory: \`wiki/\`

You have a persistent cross-session wiki in your group folder at \`wiki/\`
that survives every container restart. It's structured around voice-
conversational artifacts:

- \`wiki/calls/\` — one summary per call after it ends (decisions, follow-ups, tone)
- \`wiki/feedback/\` — how Gavan wants you to behave (rule + \`**Why:**\` + \`**How to apply:**\`)
- \`wiki/users/\` — per-person pages (Gavan, teammates, callers)
- \`wiki/projects/\` — active work, motivations, deadlines (date-stamped, decay fast)
- \`wiki/references/\` — external systems, API quirks, deployed-state facts
- \`wiki/concepts/\` — AI-safety framing, mini-app teachings, cross-cutting ideas
- \`wiki/index.md\` — read this first on any recall query
- \`wiki/log.md\` — append-only chronological record (ingests, queries, lint passes)

**You are the sole writer.** Don't let other agents or scheduled tasks
write to \`wiki/\`. For ingests touching 5+ pages, use the atomic-rename
lock at \`wiki/.lock\` (see \`container/skills/wiki/SKILL.md\`).

When recalling: grep the index first, then drill into specific pages.
When ingesting: process sources one at a time, fully — never batch-read
and integrate later, that produces shallow generic pages.

The wiki skill at \`container/skills/wiki/SKILL.md\` has the full workflow,
file formats, and lint criteria — consult it whenever you're about to
ingest, recall, or lint.
`;

interface InstallReport {
  agentGroupId: string;
  groupDir: string;
  wikiDir: string;
  filesystemCreated: string[];
  filesystemReused: string[];
  claudeLocalAppended: boolean;
  cronTaskInserted: boolean;
  cronTaskId: string | null;
  cronTaskExisting: string | null;
  scheduledIn: string | null;
}

function ensureDir(dir: string, createdList: string[], reusedList: string[], label: string): void {
  if (fs.existsSync(dir)) {
    reusedList.push(label);
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  createdList.push(label);
}

function writeIfMissing(file: string, body: string, createdList: string[], reusedList: string[], label: string): void {
  if (fs.existsSync(file)) {
    reusedList.push(label);
    return;
  }
  fs.writeFileSync(file, body);
  createdList.push(label);
}

function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function buildIndexSeed(): string {
  return `# Wiki Index

Pat's persistent memory across sessions. Last updated: ${todayUtcDate()}.

## Users

_<no pages yet — add one for Gavan after the first substantive call>_

## Feedback (how to behave)

_<no pages yet>_

## Projects (active work)

_<no pages yet>_

## References (external systems, deployed-state facts)

_<no pages yet>_

## Calls

_<no pages yet — first call summary lands here after the call ends>_

## Concepts

_<no pages yet>_
`;
}

function buildLogSeed(): string {
  return `# Wiki Log

Append-only chronological record. New entries on top? No — bottom-append.
Each entry begins with \`## [YYYY-MM-DD]\` so \`grep "^## \\[" wiki/log.md | tail -5\`
yields the last 5.

## [${todayUtcDate()}] init | wiki installed
Installed by \`scripts/install-karpathy-wiki-pat.ts\`. Empty structure.
Seed-import from local auto-memory (if run) appends below this line.
`;
}

function appendClaudeLocalIfMissing(groupDir: string): boolean {
  const file = path.join(groupDir, 'CLAUDE.local.md');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (existing.includes(CLAUDE_LOCAL_SENTINEL)) return false;
  // Preserve a trailing newline boundary so the append cleanly separates
  // from previous content.
  const needsSeparator = existing.length > 0 && !existing.endsWith('\n');
  fs.writeFileSync(file, existing + (needsSeparator ? '\n' : '') + CLAUDE_LOCAL_INSERT);
  return true;
}

function findExistingWikiLintTaskId(dbPath: string): string | null {
  if (!fs.existsSync(dbPath)) return null;
  const db = openInboundDb(dbPath);
  try {
    const row = db
      .prepare(
        "SELECT id FROM messages_in WHERE kind = 'task' AND status IN ('pending', 'paused') AND id LIKE 'task-wiki-lint-%' LIMIT 1",
      )
      .get() as { id: string } | undefined;
    return row?.id ?? null;
  } finally {
    db.close();
  }
}

async function nextRunIso(cronExpr: string): Promise<string> {
  // cron-parser is already a transitive dep via scheduling. Same import
  // pattern as recurrence.ts.
  const { CronExpressionParser } = await import('cron-parser');
  const interval = CronExpressionParser.parse(cronExpr, { tz: TIMEZONE });
  return interval.next().toISOString();
}

async function scheduleWikiLint(
  sessionDbPath: string,
  groupFolder: string,
): Promise<{ inserted: boolean; taskId: string | null; existing: string | null; nextRun: string | null }> {
  const existing = findExistingWikiLintTaskId(sessionDbPath);
  if (existing) {
    return { inserted: false, taskId: null, existing, nextRun: null };
  }

  const taskId = `task-wiki-lint-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const nextRun = await nextRunIso(LINT_CRON);
  const prompt =
    'Run a wiki lint pass per the `wiki` container skill at ' +
    '`container/skills/wiki/SKILL.md`. Check for contradictions, stale ' +
    'claims, orphan pages, missing concept pages, index gaps, and cross-' +
    'reference holes. Produce a short markdown report — list findings, ' +
    'flag the load-bearing ones, and offer to fix what is safe to fix ' +
    'without further input. Do not auto-edit contradictions; surface them ' +
    'and wait for Gavan.';

  const db = openInboundDb(sessionDbPath);
  try {
    insertTask(db, {
      id: taskId,
      processAfter: nextRun,
      recurrence: LINT_CRON,
      // Cron-triggered tasks have no message origin — the host sweep will
      // route them to this session by virtue of the row living in this
      // session's inbound.db.
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ prompt, script: null }),
    });
  } finally {
    db.close();
  }
  console.log(`[install-karpathy-wiki] scheduled wiki-lint task ${taskId} (${groupFolder}, next run ${nextRun})`);
  return { inserted: true, taskId, existing: null, nextRun };
}

async function main(): Promise<void> {
  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db); // idempotent

  const ag = getAgentGroupByFolder(GROUP_FOLDER);
  if (!ag) {
    console.error(
      `Agent group with folder='${GROUP_FOLDER}' not found. Run ` + `scripts/init-realtime-agent.ts first.`,
    );
    process.exit(2);
  }

  const groupDir = path.resolve(GROUPS_DIR, ag.folder);
  if (!fs.existsSync(groupDir)) {
    console.error(
      `Group folder ${groupDir} does not exist — group filesystem not initialized. ` +
        `Run scripts/init-realtime-agent.ts first.`,
    );
    process.exit(2);
  }

  const created: string[] = [];
  const reused: string[] = [];

  // 1. Wiki structure.
  const wikiDir = path.join(groupDir, 'wiki');
  ensureDir(wikiDir, created, reused, 'wiki/');
  for (const sub of ['users', 'feedback', 'projects', 'references', 'calls', 'concepts']) {
    ensureDir(path.join(wikiDir, sub), created, reused, `wiki/${sub}/`);
  }
  writeIfMissing(path.join(wikiDir, 'index.md'), buildIndexSeed(), created, reused, 'wiki/index.md');
  writeIfMissing(path.join(wikiDir, 'log.md'), buildLogSeed(), created, reused, 'wiki/log.md');

  // 2. Sources dir (raw curated material — read-only to Pat).
  ensureDir(path.join(groupDir, 'sources'), created, reused, 'sources/');

  // 3. Group CLAUDE.local.md append (back-mind awareness).
  const claudeLocalAppended = appendClaudeLocalIfMissing(groupDir);
  if (claudeLocalAppended) created.push('CLAUDE.local.md (appended wiki section)');
  else reused.push('CLAUDE.local.md (already had wiki section)');

  // 4. Scheduled nightly lint task.
  // The realtime group typically has exactly one shared session
  // (session_mode='shared' for realtime mg, see init-realtime-agent.ts).
  // We schedule the task on the most-recent active session; if no
  // sessions exist yet (group never ran), defer scheduling — the install
  // is still useful (filesystem + CLAUDE.local.md) and the task can be
  // re-installed once a session exists.
  const sessions = getSessionsByAgentGroup(ag.id);
  let cronResult: Awaited<ReturnType<typeof scheduleWikiLint>> = {
    inserted: false,
    taskId: null,
    existing: null,
    nextRun: null,
  };
  if (sessions.length === 0) {
    console.warn(
      `[install-karpathy-wiki] no sessions exist yet for ${GROUP_FOLDER}; ` +
        `skipping cron task install. Re-run after first inbound to schedule lint.`,
    );
  } else {
    // Most recent session. resolveSession defaults to shared mode for
    // realtime — there will typically only be one.
    const session = sessions[sessions.length - 1];
    const dbPath = inboundDbPath(ag.id, session.id);
    cronResult = await scheduleWikiLint(dbPath, GROUP_FOLDER);
  }

  const report: InstallReport = {
    agentGroupId: ag.id,
    groupDir,
    wikiDir,
    filesystemCreated: created,
    filesystemReused: reused,
    claudeLocalAppended,
    cronTaskInserted: cronResult.inserted,
    cronTaskId: cronResult.taskId,
    cronTaskExisting: cronResult.existing,
    scheduledIn: cronResult.nextRun,
  };

  console.log('');
  console.log('Karpathy wiki install — done.');
  console.log(JSON.stringify(report, null, 2));
  console.log('');
  if (created.length > 0) {
    console.log(`Created: ${created.join(', ')}`);
  }
  if (reused.length > 0) {
    console.log(`Reused (already in place): ${reused.join(', ')}`);
  }
  if (cronResult.existing) {
    console.log(`Existing wiki-lint task already scheduled: ${cronResult.existing}`);
  }
  console.log('');
  console.log('Wiki is installed and ready. Back-mind will populate it');
  console.log('organically through normal use of the wiki skill.');
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
