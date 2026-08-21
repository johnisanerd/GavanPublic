// PAT: regression test — `ncl messaging-groups create` must succeed without
// an explicit --instance (NOT NULL column added by the multi-instance
// migration; the CRUD resource omitted it from the INSERT so every create
// failed). `instance` defaults to channel_type via ColumnDef.defaultFrom.
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-cli-messaging-groups' };
});

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { dispatch } from '../dispatch.js';
// Side-effect import: registers the messaging-groups resource.
import './messaging-groups.js';

describe('messaging-groups create (instance defaultFrom regression)', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
  });

  afterEach(() => {
    closeDb();
  });

  it('defaults instance to channel_type when not provided', async () => {
    const resp = await dispatch(
      {
        id: 'req-1',
        command: 'messaging-groups-create',
        args: { channel_type: 'cli', platform_id: 'local', name: 'cli-local' },
      },
      { caller: 'host' },
    );
    expect(resp.ok).toBe(true);
    const created = (resp as { data: Record<string, unknown> }).data;
    expect(created.instance).toBe('cli');
    const row = getMessagingGroup(String(created.id));
    expect(row?.instance).toBe('cli');
  });

  it('an explicit --instance wins', async () => {
    const resp = await dispatch(
      {
        id: 'req-2',
        command: 'messaging-groups-create',
        args: { channel_type: 'cli', platform_id: 'local2', instance: 'cli-2', name: 'x' },
      },
      { caller: 'host' },
    );
    expect(resp.ok).toBe(true);
    expect((resp as { data: Record<string, unknown> }).data.instance).toBe('cli-2');
  });
});
