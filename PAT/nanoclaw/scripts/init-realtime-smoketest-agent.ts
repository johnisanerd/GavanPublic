/**
 * PAT: bootstrap the dedicated smoketest wiring + agent group for the realtime channel.
 *
 * Creates a SEPARATE agent group `<folder>-smoketest` with the persona
 * files (CLAUDE.md, skills/) symlinked from the prod agent group's folder
 * so they stay in sync. The smoketest ag has its OWN /workspace/agent/
 * mount, so test runs don't pollute prod Pat's CLAUDE.local.md /
 * conversation history / scratch files.
 *
 * Bootstraps:
 *   user           realtime:smoketest
 *   messaging grp  (channel_type='realtime', platform_id='smoketest')
 *   agent group    <folder>-smoketest, persona symlinked from prod
 *   wiring         realtime:smoketest -> <folder>-smoketest (per-thread)
 *
 * Why a separate ag (not just separate mg, not just session_mode='per-thread'
 * on the phone wiring): when phone Pat's ag was bootstrapped for the
 * realtime:local user, the destination registry treats other users as
 * "send-message-to" destinations — the agent then wraps replies in
 * <message to="realtime-smoketest"> instead of returning a plain chat row.
 * Bootstrapping a fresh ag for the smoketest user fixes that. State is
 * isolated; persona stays in sync via symlinks.
 *
 * Idempotent: re-running fixes drift (session_mode, missing symlinks).
 *
 * Usage:
 *   pnpm exec tsx scripts/init-realtime-smoketest-agent.ts \
 *     --display-name "Gavan" \
 *     [--agent-name "Pat"] [--folder "palisade-internal"]
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from '../src/config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  deleteMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
  updateMessagingGroupAgent,
} from '../src/db/messaging-groups.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { normalizeName } from '../src/modules/agent-to-agent/db/agent-destinations.js';
import { upsertUser } from '../src/modules/permissions/db/users.js';
import type { AgentGroup, MessagingGroup } from '../src/types.js';

const REALTIME_CHANNEL = 'realtime';
const SMOKETEST_PLATFORM_ID = 'smoketest';
const SMOKETEST_USER_ID = `${REALTIME_CHANNEL}:${SMOKETEST_PLATFORM_ID}`;

interface Args {
  displayName: string;
  agentName: string;
  folder?: string;
}

function parseArgs(argv: string[]): Args {
  let displayName: string | undefined;
  let agentName: string | undefined;
  let folder: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key === '--display-name') {
      displayName = val;
      i++;
    } else if (key === '--agent-name') {
      agentName = val;
      i++;
    } else if (key === '--folder') {
      folder = val;
      i++;
    }
  }
  if (!displayName) {
    console.error('Missing required arg: --display-name');
    console.error('See scripts/init-realtime-smoketest-agent.ts header for usage.');
    process.exit(2);
  }
  return { displayName, agentName: agentName?.trim() || 'Pat', folder };
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);

  const now = new Date().toISOString();

  upsertUser({
    id: SMOKETEST_USER_ID,
    kind: REALTIME_CHANNEL,
    display_name: `${args.displayName} (smoketest)`,
    created_at: now,
  });

  const prodFolder = args.folder || `realtime-with-${normalizeName(args.displayName)}`;
  const prodAg = getAgentGroupByFolder(prodFolder);
  if (!prodAg) {
    console.error(`Prod agent group not found: ${prodFolder}`);
    console.error('Run init-realtime-agent.ts first to create the prod agent group.');
    process.exit(1);
  }

  const testFolder = `${prodFolder}-smoketest`;
  let ag: AgentGroup | undefined = getAgentGroupByFolder(testFolder);
  if (!ag) {
    const agId = generateId('ag');
    createAgentGroup({
      id: agId,
      name: `${prodAg.name} (smoketest)`,
      folder: testFolder,
      agent_provider: prodAg.agent_provider,
      created_at: now,
    });
    ag = getAgentGroupByFolder(testFolder)!;
    console.log(`Created smoketest agent group: ${ag.id} (${testFolder})`);
  } else {
    console.log(`Reusing smoketest agent group: ${ag.id} (${testFolder})`);
  }

  // Materialize the smoketest ag folder. Symlink persona files
  // (CLAUDE.md, skills/) from the prod folder so they stay in sync —
  // updates to phone Pat's persona are immediately visible to test Pat.
  // Per-instance state (CLAUDE.local.md, scratch files) is NOT symlinked:
  // tests get their own state so they can't pollute prod's notes.
  const prodDir = path.resolve(GROUPS_DIR, prodFolder);
  const testDir = path.resolve(GROUPS_DIR, testFolder);
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
  }
  for (const personaFile of ['CLAUDE.md', 'skills']) {
    const src = path.join(prodDir, personaFile);
    const dst = path.join(testDir, personaFile);
    if (!fs.existsSync(src)) continue;
    // Refresh the symlink each run so re-bootstrapping fixes drift.
    if (fs.existsSync(dst) || fs.lstatSync(dst, { throwIfNoEntry: false })) {
      try {
        fs.unlinkSync(dst);
      } catch {
        // ignore — might be a directory, leave it
      }
    }
    try {
      fs.symlinkSync(src, dst);
      console.log(`Symlinked ${personaFile}: ${dst} -> ${src}`);
    } catch (err) {
      console.warn(`Could not symlink ${personaFile}: ${(err as Error).message}`);
    }
  }
  // Per-instance CLAUDE.local.md if missing (don't overwrite if present —
  // it's the test ag's own memory).
  const localMd = path.join(testDir, 'CLAUDE.local.md');
  if (!fs.existsSync(localMd)) {
    fs.writeFileSync(
      localMd,
      `# ${ag.name} memory\n\nThis is a smoketest agent group — separate from production. Notes here belong to test runs only.\n`,
    );
  }
  // Copy container.json if present so the test ag has the same container
  // config (env vars, image overrides) as prod. JSON, not symlinked, so
  // operators can tune the test ag's container independently if needed.
  const prodContainer = path.join(prodDir, 'container.json');
  const testContainer = path.join(testDir, 'container.json');
  if (fs.existsSync(prodContainer) && !fs.existsSync(testContainer)) {
    fs.copyFileSync(prodContainer, testContainer);
    console.log(`Copied container.json: ${testContainer}`);
  }

  let mg: MessagingGroup | undefined = getMessagingGroupByPlatform(REALTIME_CHANNEL, SMOKETEST_PLATFORM_ID);
  if (!mg) {
    mg = {
      id: generateId('mg'),
      channel_type: REALTIME_CHANNEL,
      platform_id: SMOKETEST_PLATFORM_ID,
      name: 'Realtime (smoketest)',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now,
    };
    createMessagingGroup(mg);
    console.log(`Created smoketest messaging group: ${mg.id}`);
  }

  // Drop any stale wirings on this mg that point at a DIFFERENT ag (e.g.
  // an earlier version of this script wired the smoketest mg to the prod
  // ag). Smoketest traffic should fan out to one ag — the test one —
  // not get dual-delivered.
  const allWirings = getMessagingGroupAgents(mg.id);
  for (const w of allWirings) {
    if (w.agent_group_id !== ag.id) {
      deleteMessagingGroupAgent(w.id);
      console.log(`Dropped stale wiring ${w.id} (was -> ${w.agent_group_id})`);
    }
  }

  const existing = getMessagingGroupAgentByPair(mg.id, ag.id);
  if (!existing) {
    createMessagingGroupAgent({
      id: generateId('mga'),
      messaging_group_id: mg.id,
      agent_group_id: ag.id,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'per-thread',
      priority: 0,
      created_at: now,
    });
    console.log(`Wired smoketest: ${mg.id} -> ${ag.id} (per-thread)`);
  } else if (existing.session_mode !== 'per-thread') {
    updateMessagingGroupAgent(existing.id, { session_mode: 'per-thread' });
    console.log(`Migrated smoketest wiring ${existing.id} session_mode → per-thread`);
  } else {
    console.log(`Smoketest wiring already exists: ${existing.id} (per-thread)`);
  }

  console.log('');
  console.log('Smoketest wiring ready.');
  console.log(`  user:    ${SMOKETEST_USER_ID}`);
  console.log(`  agent:   ${ag.name} [${ag.id}] @ groups/${testFolder} (persona symlinked from ${prodFolder})`);
  console.log(`  channel: ${REALTIME_CHANNEL}/${SMOKETEST_PLATFORM_ID}`);
  console.log('');
  console.log('Test with:');
  console.log(
    `  curl -sS -X POST http://127.0.0.1:8765/inbound \\\n    -H 'content-type: application/json' \\\n    -d '{"text":"hello","platform_id":"${SMOKETEST_PLATFORM_ID}","thread_id":"smoke-baseline"}'`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
