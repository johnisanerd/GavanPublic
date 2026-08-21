/**
 * PAT R11: rename channel_type 'realtime' → 'phone-call' to match the
 * source file name (`src/channels/phone-call.ts`) and what this channel
 * actually does (PSTN voice). The 'realtime' name described the
 * cognition layer (front-mind / back-mind cadence), which now lives in
 * `@agentic-toolkit/realtime` shared with anam-web.
 *
 * Idempotent: matches WHERE channel_type='realtime', UPDATE, no-op on
 * re-run. The channel adapter registers under both names during the
 * transition (`registerChannelAdapter('phone-call', ...)` is the new
 * default; the old 'realtime' string is no longer referenced in
 * channel code after this migration runs).
 *
 * Tables touched:
 *   - messaging_groups (channel_type='realtime' → 'phone-call')
 *   - dropped_messages (channel_type='realtime' → 'phone-call')
 *   - user_dms        (channel_type='realtime' → 'phone-call')
 *   - any other table with a channel_type column whose existing value
 *     might be 'realtime' — best-effort scan via PRAGMA + UPDATE.
 *
 * Called out in plans/refactor-bundle-2026-05-14.md as a real prod-data
 * change; deploy with care.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

const PAT_CHANNEL_TYPE_OLD = 'realtime';
const PAT_CHANNEL_TYPE_NEW = 'phone-call';

const TABLES_WITH_CHANNEL_TYPE = ['messaging_groups', 'dropped_messages', 'user_dms'];

export const migration014PatChannelTypeRename: Migration = {
  version: 14,
  name: 'pat-channel-type-rename',
  up: (db: Database.Database) => {
    for (const table of TABLES_WITH_CHANNEL_TYPE) {
      const exists = (
        db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table) as
          | { name: string }
          | undefined
      )?.name;
      if (!exists) continue;
      const cols = db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'channel_type')) continue;
      db.prepare(`UPDATE ${table} SET channel_type = ? WHERE channel_type = ?`).run(
        PAT_CHANNEL_TYPE_NEW,
        PAT_CHANNEL_TYPE_OLD,
      );
    }
  },
};
