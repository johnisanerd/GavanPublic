/**
 * PAT: interactive harness for the people-spine HTTP API. Boots ONLY the admin
 * HTTP server against a throwaway DB (migrated), seeds a few `users` rows, and
 * stays alive so you can drive `POST /admin/ncl` with curl.
 *
 *   PAT_DISABLE_HOST_LOG=1 pnpm exec tsx scripts/people-http-harness.ts
 *
 * Then, in another shell:
 *   B=http://127.0.0.1:8769
 *   curl -s $B/admin/ncl -d '{"command":"people-create","args":{"first-name":"Ada","last-name":"Lovelace"}}' | jq
 *   curl -s $B/admin/ncl -d '{"command":"people-list"}' | jq
 *
 * Env: PEOPLE_HARNESS_DB (default /tmp/nanoclaw-people-harness.db, deleted on
 * boot), PAT_ADMIN_PORT (default 8769 here), PAT_ADMIN_TOKEN (optional).
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { initDb, getDb } from '../src/db/connection.js';
import { runMigrations, createAgentGroup } from '../src/db/index.js';
import { createMessagingGroup } from '../src/db/messaging-groups.js';
import { createSession } from '../src/db/sessions.js';
import { ensureSchema } from '../src/db/session-db.js';
import { sessionDir, outboundDbPath } from '../src/session-manager.js';
import { DATA_DIR } from '../src/config.js';
import { createPerson, addIdentifier, linkHandle } from '../src/people/index.js';
import { startAdminServer, adminPort } from '../src/admin/server.js';

const dbPath = process.env.PEOPLE_HARNESS_DB || '/tmp/nanoclaw-people-harness.db';
for (const suffix of ['', '-wal', '-shm']) {
  try {
    fs.rmSync(dbPath + suffix);
  } catch {
    /* not present */
  }
}

process.env.PAT_ADMIN_PORT = process.env.PAT_ADMIN_PORT || '8769';
// The /admin/ncl bridge is opt-in + fail-closed; enable it with a dev token
// for the harness (real deploys leave PAT_ENABLE_NCL_HTTP unset).
process.env.PAT_ENABLE_NCL_HTTP = '1';
process.env.PAT_ADMIN_TOKEN = process.env.PAT_ADMIN_TOKEN || 'dev-harness-token';

const db = initDb(dbPath);
runMigrations(db);

// Seed a handful of handles so link / backfill / resolve have material.
const now = new Date().toISOString();
const seed = db.prepare(`INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)`);
for (const [id, kind, name] of [
  ['signal:+15550100001', 'signal', 'Ada (Signal)'],
  ['pstn:+15550100001', 'pstn', 'Ada (phone)'],
  ['telegram:<telegram-id>', 'telegram', 'Ada (TG)'],
  ['signal:+15550100002', 'signal', 'Someone else'],
] as const) {
  seed.run(id, kind, name, now);
}

// Seed a person + a couple of conversations (session DBs on disk) so the
// recall endpoints (conversations-list / conversations-get) have material.
const AG = 'palisade-internal';
createAgentGroup({ id: AG, name: 'Pat', folder: 'palisade-internal', agent_provider: null, created_at: now });
const ada = createPerson({ first_name: 'Ada', last_name: 'Lovelace' });
addIdentifier({ person_id: ada.id, kind: 'phone', value: '+15550100001' });
linkHandle('signal:+15550100001', ada.id);
linkHandle('pstn:+15550100001', ada.id);

function seedConversation(
  mgId: string,
  channelType: string,
  platformId: string,
  sessionId: string,
  threadId: string | null,
  inbound: Array<{ kind?: string; text: string; ts: string }>,
  outbound: Array<{ text: string; ts: string }>,
): void {
  createMessagingGroup({
    id: mgId,
    channel_type: channelType,
    platform_id: platformId,
    name: null,
    is_group: 0,
    unknown_sender_policy: 'request_approval',
    denied_at: null,
    created_at: now,
  });
  createSession({
    id: sessionId,
    agent_group_id: AG,
    messaging_group_id: mgId,
    thread_id: threadId,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: inbound.length ? inbound[inbound.length - 1]!.ts : now,
    created_at: inbound.length ? inbound[0]!.ts : now,
  });
  fs.mkdirSync(sessionDir(AG, sessionId), { recursive: true });
  // Content source is the SDK transcript. Write the continuation pointer in
  // outbound.db (session_state) + the transcript .jsonl on disk.
  const outP = outboundDbPath(AG, sessionId);
  ensureSchema(outP, 'outbound');
  const sdkId = `sdk-${sessionId}`;
  const outDb = new Database(outP);
  outDb
    .prepare("INSERT INTO session_state (key, value, updated_at) VALUES ('continuation:claude', ?, ?)")
    .run(sdkId, now);
  outDb.close();

  const enc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const entries: unknown[] = [];
  for (const m of inbound) {
    if (m.kind === 'banter') continue; // banter rides inside real <message> framing; skip the placeholder
    entries.push({
      type: 'user',
      timestamp: m.ts,
      message: {
        role: 'user',
        content: `<message id="1" from="${channelType}:${platformId}" sender="x" time="${m.ts}">${enc(m.text)}</message>`,
      },
    });
  }
  for (const m of outbound) {
    entries.push({
      type: 'assistant',
      timestamp: m.ts,
      message: { role: 'assistant', content: [{ type: 'text', text: m.text }] },
    });
  }
  entries.sort((a, b) => ((a as { timestamp: string }).timestamp < (b as { timestamp: string }).timestamp ? -1 : 1));
  const tdir = path.join(DATA_DIR, 'v2-sessions', AG, '.claude-shared', 'projects', '-workspace-agent');
  fs.mkdirSync(tdir, { recursive: true });
  fs.writeFileSync(path.join(tdir, `${sdkId}.jsonl`), entries.map((e) => JSON.stringify(e)).join('\n'));
}

seedConversation(
  'mg-sig',
  'signal',
  '+15550100001',
  'sess-sig',
  null,
  [
    { text: 'hey can you check my flight to SF', ts: '2026-06-20T10:00:00Z' },
    { kind: 'banter', text: '[banter context noise]', ts: '2026-06-20T10:00:01Z' },
    { text: 'thanks!', ts: '2026-06-20T10:05:00Z' },
  ],
  [{ text: 'Your flight UA 482 is on time, boards 3:10pm.', ts: '2026-06-20T10:01:00Z' }],
);
seedConversation(
  'mg-pstn',
  'pstn',
  '+15550100001',
  'sess-pstn',
  'call-abc',
  [{ text: 'calling about dinner reservation', ts: '2026-06-21T18:00:00Z' }],
  [{ text: 'Booked Nopa for 4 at 7:30.', ts: '2026-06-21T18:01:00Z' }],
);

await startAdminServer();

const port = adminPort();
const tok = process.env.PAT_ADMIN_TOKEN!;
console.log(`\npeople HTTP harness ready on http://127.0.0.1:${port}`);
console.log(`DB: ${dbPath}`);
console.log(`Admin token: ${tok}   (bridge is opt-in + token-required)`);
console.log(`Console: http://127.0.0.1:${port}/admin/people?token=${tok}`);
console.log(`Seeded users: signal:+15550100001, pstn:+15550100001, telegram:<telegram-id>, signal:+15550100002`);
console.log(`\nTry:`);
console.log(`  B=http://127.0.0.1:${port}`);
console.log(
  `  curl -s $B/admin/ncl -H 'authorization: Bearer ${tok}' -d '{"command":"people-create","args":{"first-name":"Ada","last-name":"Lovelace"}}' | jq`,
);
console.log(`\nCtrl-C to stop.\n`);
