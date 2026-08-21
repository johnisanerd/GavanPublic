/**
 * Unit tests for the host-side capability resolvers (TaskList #8).
 * Lifecycle split: install-state per agent group vs per-inbound caller
 * context. Drives both `buildInstallCapabilities` and
 * `buildCallerContext` directly so we don't need a running
 * orchestrator.
 *
 * Channel registry is not exercised here because
 * `getRegisteredChannelNames()` reads a module-level Map that adapters
 * self-register into on import; tests run in a vanilla import context
 * with no adapters loaded, so the registry is empty. That's the right
 * baseline — adapters register at host startup, not at lib import time.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  initTestDb,
  runMigrations,
} from './db/index.js';
import { buildCallerContext, buildInstallCapabilities, resolveAgentGroupForPlatform } from './capability-resolver.js';
import { grantRole } from './modules/permissions/db/user-roles.js';
import { upsertUser } from './modules/permissions/db/users.js';

function nowIso(): string {
  return new Date().toISOString();
}

function seedAgentGroup(id: string, name: string, folder: string): void {
  createAgentGroup({
    id,
    name,
    folder,
    agent_provider: null,
    created_at: nowIso(),
  });
}

function seedMgWiredToAgent(args: {
  mgId: string;
  channelType: string;
  platformId: string;
  agentGroupId: string;
}): void {
  createMessagingGroup({
    id: args.mgId,
    channel_type: args.channelType,
    platform_id: args.platformId,
    name: `${args.channelType}-${args.platformId.slice(-6)}`,
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: nowIso(),
  });
  createMessagingGroupAgent({
    id: `mga-${args.mgId}`,
    messaging_group_id: args.mgId,
    agent_group_id: args.agentGroupId,
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'accumulate',
    session_mode: 'per-thread',
    priority: 10,
    created_at: nowIso(),
  });
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

describe('buildInstallCapabilities — agent-group-scoped install surface', () => {
  it('returns the agentGroupId + agentGroupName when the row exists', () => {
    seedAgentGroup('ag-7', 'TestAgent', 'test-agent-folder');
    const snap = buildInstallCapabilities({ agentGroupId: 'ag-7' });
    expect(snap.agentGroupId).toBe('ag-7');
    expect(snap.agentGroupName).toBe('TestAgent');
  });

  it('handles missing agent group gracefully (agentGroupName undefined)', () => {
    const snap = buildInstallCapabilities({ agentGroupId: 'ag-missing' });
    expect(snap.agentGroupId).toBe('ag-missing');
    expect(snap.agentGroupName).toBeUndefined();
    // Static catalogs still emit.
    expect((snap.containerMcpTools ?? []).length).toBeGreaterThan(0);
    expect((snap.sdkTools ?? []).length).toBeGreaterThan(0);
  });

  it('emits the container MCP tools catalog', () => {
    const snap = buildInstallCapabilities({ agentGroupId: 'ag-any' });
    const names = (snap.containerMcpTools ?? []).map((e) => e.name);
    expect(names).toContain('send_message');
    expect(names).toContain('schedule_task');
    expect(names).toContain('ask_user_question');
  });

  it('emits the SDK tools catalog', () => {
    const snap = buildInstallCapabilities({ agentGroupId: 'ag-any' });
    const names = (snap.sdkTools ?? []).map((e) => e.name);
    expect(names).toContain('Read');
    expect(names).toContain('Bash');
    expect(names).toContain('WebFetch');
  });

  it('emits the host-verbs catalog', () => {
    const snap = buildInstallCapabilities({ agentGroupId: 'ag-any' });
    const names = (snap.hostVerbs ?? []).map((e) => e.name);
    expect(names).toContain('barge-in');
    expect(names).toContain('narration');
  });

  // PAT: slash-commands removed from install-caps render — front-mind
  // never narrates/acks about them. Back-mind owns slash-command knowledge.
  it('does NOT emit a slash-commands catalog', () => {
    const snap = buildInstallCapabilities({ agentGroupId: 'ag-any' });
    expect((snap as Record<string, unknown>).slashCommands).toBeUndefined();
  });

  it('does NOT include per-inbound caller fields', () => {
    seedAgentGroup('ag-7', 'TestAgent', 'test-agent-folder');
    const snap = buildInstallCapabilities({ agentGroupId: 'ag-7' });
    // Install caps are stable across inbounds — caller / handles /
    // permissions live in buildCallerContext (per-inbound).
    expect((snap as Record<string, unknown>).caller).toBeUndefined();
    expect((snap as Record<string, unknown>).knownHandles).toBeUndefined();
    expect((snap as Record<string, unknown>).permissions).toBeUndefined();
  });
});

describe('buildCallerContext — caller identity + role', () => {
  it('returns role=unknown for a sender not in the users table', () => {
    const ctx = buildCallerContext({
      agentGroupId: 'ag-unset',
      senderId: 'pstn:+15550100000',
    });
    expect(ctx.caller?.role).toBe('unknown');
    expect(ctx.caller?.platformId).toBe('pstn:+15550100000');
    expect(ctx.caller?.channelType).toBe('pstn');
    expect(ctx.caller?.suffix).toBe('4959');
    expect(ctx.caller?.displayName).toBeNull();
    expect(ctx.permissions?.callerRole).toBe('unknown');
    expect(ctx.permissions?.approvalGatedVerbs?.length).toBeGreaterThan(0);
    expect(ctx.permissions?.callerVerbs).toBeUndefined();
  });

  it('returns role=owner for a global owner', () => {
    upsertUser({
      id: 'pstn:+15550100000',
      kind: 'pstn',
      display_name: 'Gavan',
      created_at: nowIso(),
    });
    grantRole({
      user_id: 'pstn:+15550100000',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: nowIso(),
    });
    const ctx = buildCallerContext({
      agentGroupId: 'ag-1',
      senderId: 'pstn:+15550100000',
    });
    expect(ctx.caller?.role).toBe('owner');
    expect(ctx.caller?.displayName).toBe('Gavan');
    expect(ctx.permissions?.callerRole).toBe('owner');
    expect(ctx.permissions?.callerVerbs?.length).toBeGreaterThan(0);
    expect(ctx.permissions?.approvalGatedVerbs).toBeUndefined();
  });

  it('returns role=admin for a scoped agent-group admin', () => {
    seedAgentGroup('ag-1', 'Pat', 'pat');
    upsertUser({ id: 'signal:+15551112222', kind: 'signal', display_name: null, created_at: nowIso() });
    grantRole({
      user_id: 'signal:+15551112222',
      role: 'admin',
      agent_group_id: 'ag-1',
      granted_by: null,
      granted_at: nowIso(),
    });
    const ctx = buildCallerContext({
      agentGroupId: 'ag-1',
      senderId: 'signal:+15551112222',
    });
    expect(ctx.caller?.role).toBe('admin');
    expect(ctx.agentGroupId).toBe('ag-1');
  });

  it('returns role=member for a registered user with no roles', () => {
    upsertUser({ id: 'pstn:+15551112222', kind: 'pstn', display_name: 'Test', created_at: nowIso() });
    const ctx = buildCallerContext({
      agentGroupId: 'ag-any',
      senderId: 'pstn:+15551112222',
    });
    expect(ctx.caller?.role).toBe('member');
  });

  it('derives suffix from the platform id last-4 for non-phone callers', () => {
    const ctx = buildCallerContext({
      agentGroupId: 'ag-any',
      senderId: 'anam-web:abcd1234efgh5678',
    });
    expect(ctx.caller?.suffix).toBe('5678');
  });
});

describe('buildCallerContext — known handles (suffix-match)', () => {
  it('matches other handles with the same E.164 suffix', () => {
    const ts = nowIso();
    upsertUser({ id: 'pstn:+15550100000', kind: 'pstn', display_name: 'Gavan', created_at: ts });
    upsertUser({ id: 'signal:+15550100000', kind: 'signal', display_name: 'Gavan (Signal)', created_at: ts });
    upsertUser({ id: 'whatsapp:+15550100000', kind: 'whatsapp', display_name: null, created_at: ts });
    upsertUser({ id: 'pstn:+15551112222', kind: 'pstn', display_name: 'Other', created_at: ts });

    const ctx = buildCallerContext({
      agentGroupId: 'ag-any',
      senderId: 'pstn:+15550100000',
    });
    const ids = ctx.knownHandles?.map((h) => h.platformId) ?? [];
    expect(ids).toContain('pstn:+15550100000');
    expect(ids).toContain('signal:+15550100000');
    expect(ids).toContain('whatsapp:+15550100000');
    expect(ids).not.toContain('pstn:+15551112222');
    const caller = ctx.knownHandles?.find((h) => h.isCurrentCaller);
    expect(caller?.platformId).toBe('pstn:+15550100000');
    expect(ctx.knownHandles?.[0]?.suffix).toBe('4959');
  });

  it('returns an empty known-handles list for a non-phone sender', () => {
    upsertUser({ id: 'anam-web:abc12345', kind: 'anam-web', display_name: null, created_at: nowIso() });
    upsertUser({ id: 'pstn:+15550100000', kind: 'pstn', display_name: null, created_at: nowIso() });
    const ctx = buildCallerContext({
      agentGroupId: 'ag-any',
      senderId: 'anam-web:abc12345',
    });
    expect(ctx.knownHandles).toEqual([]);
  });
});

describe('resolveAgentGroupForPlatform', () => {
  it('returns the wired agent group when a messaging-group row exists', () => {
    seedAgentGroup('ag-7', 'TestAgent', 'test-agent-folder');
    seedMgWiredToAgent({
      mgId: 'mg-7',
      channelType: 'pstn',
      platformId: 'pstn:+15550100000',
      agentGroupId: 'ag-7',
    });
    const resolved = resolveAgentGroupForPlatform('pstn', 'pstn:+15550100000');
    expect(resolved?.agentGroupId).toBe('ag-7');
    expect(resolved?.agentGroupName).toBe('TestAgent');
    expect(resolved?.folder).toBe('test-agent-folder');
  });

  it('returns null when nothing is wired for the platform', () => {
    const resolved = resolveAgentGroupForPlatform('pstn', 'pstn:+19999999999');
    expect(resolved).toBeNull();
  });
});
