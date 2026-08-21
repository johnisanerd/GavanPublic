/**
 * PAT: one-shot recall smoke — fetch a real conversation via the Phase-2 read
 * path against on-disk transcripts. Point SMOKE_DB at a COPY of v2.db and
 * NANOCLAW_DATA_DIR at the real data dir (transcripts + outbound.db live there).
 *
 *   cp data/v2.db /tmp/recall-smoke.db
 *   SMOKE_DB=/tmp/recall-smoke.db NANOCLAW_DATA_DIR=$PWD/data \
 *     pnpm exec tsx scripts/recall-smoke.ts <session_id> [tools]
 */
import { initDb } from '../src/db/connection.js';
import { fetchConversation } from '../src/conversations/index.js';
import type { ToolDetail } from '../src/conversations/transcript.js';

initDb(process.env.SMOKE_DB || 'data/v2.db');
const sid = process.argv[2];
const tools = (process.argv[3] as ToolDetail) || 'truncated';
if (!sid) {
  console.error('usage: recall-smoke.ts <session_id> [tools]');
  process.exit(2);
}

const r = fetchConversation({ sessionId: sid, tools });
console.log(`channel=${r.session.channel_type} thread=${r.session.thread_id}`);
console.log(`messages=${r.messages.length} truncated=${r.truncated}\n`);
for (const m of r.messages.slice(0, 14)) {
  const tag = m.role === 'tool' ? `[tool:${m.tool?.name}]` : `[${m.role}${m.sender ? ' ' + m.sender : ''}]`;
  const body = (m.text || '').replace(/\s+/g, ' ').slice(0, 140);
  console.log(`${tag} ${body}`);
  if (m.role === 'tool' && m.tool?.result)
    console.log(`    ↳ result: ${m.tool.result.replace(/\s+/g, ' ').slice(0, 100)}`);
}
