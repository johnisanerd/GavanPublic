/**
 * PAT: bootstrap a realtime-channel agent for the agentic_toolkit spike.
 *
 * Creates an agent group, a messaging group on (channel_type='realtime',
 * platform_id='local'), and wires them with engage_mode='pattern' / '.'
 * (matches anything → chat-classified inbound rows wake the back-mind).
 *
 * Mirrors `init-cli-agent.ts` 1:1 but for the realtime channel. Runs
 * alongside the live host (the central DB is WAL-mode), so this can be
 * safely re-run while `pnpm run dev` is up.
 *
 * Usage:
 *   pnpm exec tsx scripts/init-realtime-agent.ts \
 *     --display-name "Gavan" \
 *     [--agent-name "Pat"]
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
  updateMessagingGroupAgent,
} from '../src/db/messaging-groups.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { normalizeName } from '../src/modules/agent-to-agent/db/agent-destinations.js';
import { upsertUser } from '../src/modules/permissions/db/users.js';
import { initGroupFilesystem } from '../src/group-init.js';
import type { AgentGroup, MessagingGroup } from '../src/types.js';

const REALTIME_CHANNEL = 'realtime';
const REALTIME_PLATFORM_ID = 'local';
const REALTIME_SYNTHETIC_USER_ID = `${REALTIME_CHANNEL}:${REALTIME_PLATFORM_ID}`;

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
    console.error('See scripts/init-realtime-agent.ts header for usage.');
    process.exit(2);
  }

  return {
    displayName,
    agentName: agentName?.trim() || 'Pat',
    folder,
  };
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
    id: REALTIME_SYNTHETIC_USER_ID,
    kind: REALTIME_CHANNEL,
    display_name: args.displayName,
    created_at: now,
  });

  const folder = args.folder || `realtime-with-${normalizeName(args.displayName)}`;
  let ag: AgentGroup | undefined = getAgentGroupByFolder(folder);
  if (!ag) {
    const agId = generateId('ag');
    createAgentGroup({
      id: agId,
      name: args.agentName,
      folder,
      agent_provider: null,
      created_at: now,
    });
    ag = getAgentGroupByFolder(folder)!;
    console.log(`Created agent group: ${ag.id} (${folder})`);
  } else {
    console.log(`Reusing agent group: ${ag.id} (${folder})`);
  }
  initGroupFilesystem(ag, {
    instructions:
      `# ${args.agentName}\n\n` +
      `You are ${args.agentName}, a voice-first agent for ${args.displayName}. ` +
      `You operate behind a real-time conversational layer (front-mind / back-mind architecture). ` +
      `Keep replies concise — they will be spoken aloud.`,
  });

  let mg: MessagingGroup | undefined = getMessagingGroupByPlatform(REALTIME_CHANNEL, REALTIME_PLATFORM_ID);
  if (!mg) {
    mg = {
      id: generateId('mg'),
      channel_type: REALTIME_CHANNEL,
      platform_id: REALTIME_PLATFORM_ID,
      name: 'Realtime (voice)',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now,
    };
    createMessagingGroup(mg);
    console.log(`Created realtime messaging group: ${mg.id}`);
  }

  // The phone wiring uses session_mode='shared' so all phone callers
  // collapse into one session/container. Smoke testing isolation does
  // NOT come from this wiring — it comes from a separate
  // (realtime:smoketest) messaging group bootstrapped by
  // init-realtime-smoketest-agent.ts with session_mode='per-thread'.
  // Keeping these separate means changes to test routing don't affect
  // production phone behaviour.
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
      session_mode: 'shared',
      priority: 0,
      created_at: now,
    });
    console.log(`Wired realtime: ${mg.id} -> ${ag.id} (shared)`);
  } else if (existing.session_mode !== 'shared') {
    updateMessagingGroupAgent(existing.id, { session_mode: 'shared' });
    console.log(`Migrated wiring ${existing.id} session_mode → shared`);
  } else {
    console.log(`Wiring already exists: ${existing.id} (shared)`);
  }

  console.log('');
  console.log('Realtime agent ready.');
  console.log(`  user:    ${REALTIME_SYNTHETIC_USER_ID}`);
  console.log(`  agent:   ${ag.name} [${ag.id}] @ groups/${folder}`);
  console.log(`  channel: ${REALTIME_CHANNEL}/${REALTIME_PLATFORM_ID}`);
  console.log('');
  console.log('Test with:');
  console.log(
    `  curl -sS -X POST http://127.0.0.1:8765/inbound \\\n    -H 'content-type: application/json' \\\n    -d '{"text":"hello, can you hear me"}'`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
