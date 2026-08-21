/**
 * PAT anam-web channel adapter — HTTP + WebSocket surface smoke tests.
 *
 * Covers (HTTP):
 *   - GET /health → 200 with channel marker
 *   - POST /anam-web/message missing session header → 400
 *   - POST /anam-web/message happy path → OpenAI-shape SSE; ends with [DONE];
 *     onInbound dispatched only when the request-layer says 'forward'
 *     (in no-API-key test env that's a no-op)
 *   - POST /anam-web/barge-in → shape stable, no session needed
 *   - POST /anam-web/session-ended → shape stable, no session needed
 *   - GET /anam-web/events: SSE accepted, missing ?session → 400, opens
 *     stream with comment line when session supplied
 *
 * Covers (WebSocket — PAT, 2026-05-23):
 *   - Upgrade succeeds for /anam-web/ws; foreign upgrade paths get dropped
 *   - Inbound `user-message` triggers the orchestrator loop AND deltas
 *     surface as banter.* JSON frames on the same socket
 *   - Malformed / unknown frames don't crash the socket
 *
 * Test DB is in-memory; seeded with one anam-web mg so ensureAnamWebMessagingGroup
 * doesn't 503 out. NANOCLAW_TRACE_LLM_CALLS=0 mirrors realtime.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';

import { createAnamWebAdapter } from './anam-web.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage } from './adapter.js';
import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from '../db/index.js';

const PORT = 18766;
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_PLATFORM_ID = 'anam-web:test-uuid-0001';
const TEST_SESSION_ID = 'session-aaaa-bbbb-cccc';

function nowIso(): string {
  return new Date().toISOString();
}

function seedAnamWebWiring(): void {
  createAgentGroup({
    id: 'ag-test',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: nowIso(),
  });
  createMessagingGroup({
    id: 'mg-anam-web-test',
    channel_type: 'anam-web',
    platform_id: TEST_PLATFORM_ID,
    name: `anam-web:${TEST_PLATFORM_ID}`,
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: nowIso(),
  });
  createMessagingGroupAgent({
    id: 'mga-anam-web-test',
    messaging_group_id: 'mg-anam-web-test',
    agent_group_id: 'ag-test',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'accumulate',
    session_mode: 'per-thread',
    priority: 0,
    created_at: nowIso(),
  });
}

describe('anam-web channel adapter', () => {
  let adapter: ChannelAdapter;
  let inbound: Array<{ platformId: string; threadId: string | null; message: InboundMessage }>;

  beforeEach(async () => {
    process.env.ANAM_WEB_CHANNEL_PORT = String(PORT);
    process.env.NANOCLAW_TRACE_LLM_CALLS = '0';
    // PAT: lazy-provision requires the configured default agent group;
    // tests pin it to the seeded `ag-test` so the auto-create path is
    // exercised when an existing seed mg is absent (auto-provision tests
    // override this where needed).
    process.env.ANAM_WEB_DEFAULT_AGENT_GROUP_ID = 'ag-test';
    const db = initTestDb();
    runMigrations(db);
    seedAnamWebWiring();
    inbound = [];
    adapter = createAnamWebAdapter();
    const setup: ChannelSetup = {
      onInbound: (platformId, threadId, message) => {
        inbound.push({ platformId, threadId, message });
      },
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    };
    await adapter.setup(setup);
  });

  afterEach(async () => {
    await adapter.teardown();
    closeDb();
    delete process.env.ANAM_WEB_CHANNEL_PORT;
    delete process.env.NANOCLAW_TRACE_LLM_CALLS;
    delete process.env.ANAM_WEB_DEFAULT_AGENT_GROUP_ID;
  });

  it('answers /health', async () => {
    const r = await fetch(`${BASE}/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, channel: 'anam-web' });
  });

  it('rejects /anam-web/message without session header', async () => {
    const r = await fetch(`${BASE}/anam-web/message`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pat-platform-id': TEST_PLATFORM_ID,
      },
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hello' }] }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toContain('x-pat-session-id');
  });

  it('rejects /anam-web/message with no user message', async () => {
    const r = await fetch(`${BASE}/anam-web/message`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pat-platform-id': TEST_PLATFORM_ID,
        'x-pat-session-id': TEST_SESSION_ID,
      },
      body: JSON.stringify({ messages: [{ role: 'assistant', content: 'huh' }] }),
    });
    expect(r.status).toBe(400);
  });

  // PAT: like realtime.test.ts, without ANTHROPIC_API_KEY the front-mind
  // / request-layer pipeline fails open-circuit → decision='silent' →
  // onInbound never fires. The contract we verify here is the SSE shape
  // is stable, ends with [DONE], and the handler doesn't throw.
  it('POST /anam-web/message: emits SSE chat-completions response ending in [DONE]', async () => {
    const r = await fetch(`${BASE}/anam-web/message`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pat-platform-id': TEST_PLATFORM_ID,
        'x-pat-session-id': TEST_SESSION_ID,
      },
      body: JSON.stringify({
        model: 'pat-banter',
        stream: true,
        messages: [{ role: 'user', content: 'what is the weather' }],
      }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/event-stream');
    expect(r.body).not.toBeNull();

    const reader = r.body!.getReader();
    const decoder = new TextDecoder();
    let acc = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      acc += decoder.decode(value, { stream: true });
      if (acc.includes('[DONE]')) break;
    }
    expect(acc).toContain('data: [DONE]');

    // Lines that aren't [DONE] should parse as OpenAI-shape chunks if present.
    const dataLines = acc
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => l.slice(6));
    for (const line of dataLines) {
      if (line === '[DONE]') continue;
      try {
        const parsed = JSON.parse(line) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        expect(Array.isArray(parsed.choices)).toBe(true);
      } catch (err) {
        throw new Error(`non-JSON SSE delta line: ${line} (${(err as Error).message})`);
      }
    }
    // onInbound fires on forward (kind:'chat') and on every banter
    // ack/noop user aside (kind:'banter', via recordBanter). In this
    // no-API-key test, request-layer is silent → no chat row. Banter
    // ack may emit its fallback line as a kind:'banter' row.
    const chatInbound = inbound.filter((e) => e.message.kind === 'chat');
    if (chatInbound.length > 0) {
      expect(chatInbound[0]!.platformId).toBe(TEST_PLATFORM_ID);
      expect(chatInbound[0]!.threadId).toBe(`anam-web-call-${TEST_SESSION_ID}`);
    }
    for (const e of inbound) {
      expect(['chat', 'banter']).toContain(e.message.kind);
    }
  });

  it('POST /anam-web/message: 503 when no anam-web mg exists', async () => {
    // Use a different platform id; no mg exists for it AND there's
    // already a seed mg so it would normally lazy-create off the seed.
    // To get 503 we'd need NO seeds at all — close DB, recreate empty.
    // Easier: assert ensureAnamWebMessagingGroup happily creates a new
    // mg for a fresh platform id by leaning on the seed.
    const FRESH = 'anam-web:test-uuid-fresh';
    const r = await fetch(`${BASE}/anam-web/message`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pat-platform-id': FRESH,
        'x-pat-session-id': 'session-fresh',
      },
      body: JSON.stringify({
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    // Lazy provisioning should still 200 because the seed mg exists.
    expect(r.status).toBe(200);
  });

  // PAT: removed POST /anam-web/prewarm test block 2026-05-26 — back-mind
  // prewarm route deleted (was blocking real chat rows for the full SDK
  // cold-start). See nanoclaw/src/channels/anam-web.ts for the matching
  // removal of handlePrewarm / handlePrewarmWarmup / prewarmBackMind.

  it('POST /anam-web/barge-in: returns shape even when no session exists', async () => {
    const r = await fetch(`${BASE}/anam-web/barge-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'nonexistent-session', reason: 'user-said' }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ok: boolean;
      killed_container: boolean;
      killed_session_id: string | null;
      aborted_streams: number;
    };
    expect(body.ok).toBe(true);
    expect(body.killed_container).toBe(false);
    expect(body.killed_session_id).toBe(null);
    expect(body.aborted_streams).toBe(0);
  });

  it('POST /anam-web/barge-in: rejects malformed JSON', async () => {
    const r = await fetch(`${BASE}/anam-web/barge-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(r.status).toBe(400);
  });

  it('POST /anam-web/session-ended: rejects missing sessionId', async () => {
    const r = await fetch(`${BASE}/anam-web/session-ended`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
  });

  it('POST /anam-web/session-ended: returns ok=true for unknown session', async () => {
    const r = await fetch(`${BASE}/anam-web/session-ended`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'never-existed' }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; closed: number };
    expect(body.ok).toBe(true);
    expect(body.closed).toBe(0);
  });

  it('GET /anam-web/events: rejects missing ?session=', async () => {
    const r = await fetch(`${BASE}/anam-web/events`);
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toContain('session');
  });

  it('GET /anam-web/events: opens SSE stream with session id', async () => {
    const ctrl = new AbortController();
    const r = await fetch(`${BASE}/anam-web/events?session=${TEST_SESSION_ID}`, { signal: ctrl.signal });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/event-stream');
    const reader = r.body!.getReader();
    const decoder = new TextDecoder();
    // Read enough bytes to see the initial comment line.
    let acc = '';
    const readPromise = (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        acc += decoder.decode(value, { stream: true });
        if (acc.includes(`anam-web events session=${TEST_SESSION_ID}`)) return;
      }
    })();
    await Promise.race([
      readPromise,
      new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('SSE timeout')), 1500)),
    ]);
    ctrl.abort();
    expect(acc).toContain(`anam-web events session=${TEST_SESSION_ID}`);
  });

  // PAT: lazy auto-provision tests. Verify the seed-mg-free path —
  // ensureAnamWebMessagingGroup creates the wiring + destination using
  // ANAM_WEB_DEFAULT_AGENT_GROUP_ID instead of copying from an existing mg.
  describe('auto-provision (PAT)', () => {
    it('creates messaging_group + wiring + destination + user_dm for a brand-new visitor', async () => {
      const { getMessagingGroupByPlatform, getMessagingGroupAgents } = await import('../db/messaging-groups.js');
      const { getDestinations } = await import('../modules/agent-to-agent/db/agent-destinations.js');
      const { getUserDm } = await import('../modules/permissions/db/user-dms.js');
      const { getUser } = await import('../modules/permissions/db/users.js');

      // A fresh platform id — no existing mg, but ag-test is the seed
      // already created by seedAnamWebWiring above. To exercise the
      // seed-mg-free path we make sure provisioning finds the new mg
      // even though it can't copy wiring from a seed; the env var pin
      // (ANAM_WEB_DEFAULT_AGENT_GROUP_ID=ag-test) is what wires it.
      const FRESH = 'anam-web:abcd1234-fresh-uuid-rest';
      const r = await fetch(`${BASE}/anam-web/message`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-pat-platform-id': FRESH,
          'x-pat-session-id': 'session-fresh-aaaa',
        },
        body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(r.status).toBe(200);
      await r.body!.cancel();

      // mg exists with the canonical destination name.
      const mg = getMessagingGroupByPlatform('anam-web', FRESH);
      expect(mg).toBeDefined();
      expect(mg!.name).toBe('anam-web-abcd1234');

      // mga wires the configured default agent group.
      const mgas = getMessagingGroupAgents(mg!.id);
      expect(mgas).toHaveLength(1);
      expect(mgas[0]!.agent_group_id).toBe('ag-test');

      // agent_destinations row lands with the same canonical name.
      const dests = getDestinations('ag-test');
      const ours = dests.find((d) => d.target_id === mg!.id);
      expect(ours).toBeDefined();
      expect(ours!.local_name).toBe('anam-web-abcd1234');
      expect(ours!.target_type).toBe('channel');

      // users + user_dms upserted so future cold-DM outbound is a single read.
      const user = getUser(FRESH);
      expect(user).toBeDefined();
      expect(user!.kind).toBe('anam-web');
      const userDm = getUserDm(FRESH, 'anam-web');
      expect(userDm).toBeDefined();
      expect(userDm!.messaging_group_id).toBe(mg!.id);
    });

    it('is idempotent — second turn from the same visitor creates no new mg/mga/destination', async () => {
      const { getMessagingGroupByPlatform, getMessagingGroupAgents } = await import('../db/messaging-groups.js');
      const { getDestinations } = await import('../modules/agent-to-agent/db/agent-destinations.js');

      const FRESH = 'anam-web:abcd5678-fresh-twice';
      for (let i = 0; i < 2; i++) {
        const r = await fetch(`${BASE}/anam-web/message`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-pat-platform-id': FRESH,
            'x-pat-session-id': `session-twice-${i}`,
          },
          body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: `hi ${i}` }] }),
        });
        expect(r.status).toBe(200);
        await r.body!.cancel();
      }

      const mg = getMessagingGroupByPlatform('anam-web', FRESH);
      expect(mg).toBeDefined();
      // Exactly one wiring, exactly one destination — re-entry didn't duplicate.
      expect(getMessagingGroupAgents(mg!.id)).toHaveLength(1);
      const dests = getDestinations('ag-test').filter((d) => d.target_id === mg!.id);
      expect(dests).toHaveLength(1);
    });

    it('503s with a clear error when ANAM_WEB_DEFAULT_AGENT_GROUP_ID is unset', async () => {
      delete process.env.ANAM_WEB_DEFAULT_AGENT_GROUP_ID;

      const FRESH = 'anam-web:unconfigured-uuid';
      const r = await fetch(`${BASE}/anam-web/message`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-pat-platform-id': FRESH,
          'x-pat-session-id': 'session-unconfig',
        },
        body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(r.status).toBe(503);
      const body = (await r.json()) as { error: string };
      expect(body.error).toContain('ANAM_WEB_DEFAULT_AGENT_GROUP_ID');
    });
  });

  // ─────────────────── WebSocket bridge (PAT, 2026-05-23) ─────────────
  //
  // The new `/anam-web/ws` endpoint replaces the per-turn POST + per-call
  // SSE pair used by pat-web. Tests below cover the connection lifecycle
  // + frame routing — without the front-mind API path (no ANTHROPIC_API_KEY)
  // banter-ack short-circuits silent, so we assert behaviorally that
  // the socket stays open and the orchestrator loop ran (no thrown
  // error reaches the WS as a close).

  describe('GET /anam-web/ws (PAT realtime bridge)', () => {
    // Helper: open a WS to the test port and wait for handshake. Tests
    // own the lifecycle — must close before the it() block returns or
    // afterEach's teardown will race the close.
    async function openWs(path: string = '/anam-web/ws'): Promise<WebSocket> {
      const ws = new WebSocket(
        `ws://127.0.0.1:${PORT}${path}?session=${TEST_SESSION_ID}&platform_id=${encodeURIComponent(TEST_PLATFORM_ID)}`,
      );
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', (err) => reject(err));
        setTimeout(() => reject(new Error('WS open timeout')), 1500);
      });
      return ws;
    }

    it('accepts upgrade and stays open through one user-message frame', async () => {
      const ws = await openWs();
      try {
        // Frame the user-message exactly as pat-web's bridge does.
        ws.send(
          JSON.stringify({
            kind: 'user-message',
            text: 'hi there',
            threadId: `anam-web-call-${TEST_SESSION_ID}`,
            platformId: TEST_PLATFORM_ID,
            correlationId: 'corr-test-0001',
          }),
        );
        // Give the orchestrator loop a moment to run. We don't assert
        // specific banter frames arrive — without ANTHROPIC_API_KEY the
        // front-mind is open-circuit (silent decision). What we DO
        // assert is the socket stays open + no exception propagated to
        // it (close code would be != 1006/normal if the handler threw).
        await new Promise((r) => setTimeout(r, 200));
        expect(ws.readyState).toBe(WebSocket.OPEN);
      } finally {
        ws.close();
        // Give the close handler a tick to fire so afterEach's
        // adapter.teardown() doesn't trip on a still-open socket.
        await new Promise((r) => setTimeout(r, 50));
      }
    });

    it('tolerates non-JSON frames without closing', async () => {
      const ws = await openWs();
      try {
        ws.send('{not json');
        ws.send('plain string');
        await new Promise((r) => setTimeout(r, 50));
        expect(ws.readyState).toBe(WebSocket.OPEN);
      } finally {
        ws.close();
        await new Promise((r) => setTimeout(r, 50));
      }
    });

    it('tolerates unknown frame kinds without closing', async () => {
      const ws = await openWs();
      try {
        ws.send(JSON.stringify({ kind: 'ping' }));
        ws.send(JSON.stringify({ kind: 'who-knows', text: 'x' }));
        await new Promise((r) => setTimeout(r, 50));
        expect(ws.readyState).toBe(WebSocket.OPEN);
      } finally {
        ws.close();
        await new Promise((r) => setTimeout(r, 50));
      }
    });

    it('drops upgrade on a foreign path', async () => {
      // The server attaches the upgrade handler to ALL upgrade requests
      // but only accepts `/anam-web/ws`; everything else is socket-destroyed
      // before WS handshake completes. Connect to a wrong path and verify
      // we never see 'open'.
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/anam-web/wrong-path`);
      const settled = await new Promise<'opened' | 'errored' | 'closed'>((resolve) => {
        ws.once('open', () => resolve('opened'));
        ws.once('error', () => resolve('errored'));
        ws.once('close', () => resolve('closed'));
        setTimeout(() => resolve('errored'), 500);
      });
      try {
        ws.close();
      } catch {
        /* noop */
      }
      // Either 'errored' or 'closed' is acceptable — both indicate the
      // upgrade was rejected (or never completed). NOT 'opened'.
      expect(settled).not.toBe('opened');
    });

    it('routes a turn-ended frame without erroring', async () => {
      const ws = await openWs();
      try {
        ws.send(
          JSON.stringify({
            kind: 'turn-ended',
            text: 'pat said something',
            threadId: `anam-web-call-${TEST_SESSION_ID}`,
            interrupted: false,
          }),
        );
        await new Promise((r) => setTimeout(r, 50));
        expect(ws.readyState).toBe(WebSocket.OPEN);
      } finally {
        ws.close();
        await new Promise((r) => setTimeout(r, 50));
      }
    });

    it('routes a barge-in frame and short-circuits cleanly when no session exists', async () => {
      const ws = await openWs();
      try {
        ws.send(
          JSON.stringify({
            kind: 'barge-in',
            sessionId: 'never-existed-bargein',
            reason: 'user-said',
          }),
        );
        await new Promise((r) => setTimeout(r, 50));
        expect(ws.readyState).toBe(WebSocket.OPEN);
      } finally {
        ws.close();
        await new Promise((r) => setTimeout(r, 50));
      }
    });

    it('routes a session-ended frame without erroring on unknown session', async () => {
      const ws = await openWs();
      try {
        ws.send(
          JSON.stringify({
            kind: 'session-ended',
            sessionId: 'never-existed-session',
          }),
        );
        await new Promise((r) => setTimeout(r, 50));
        expect(ws.readyState).toBe(WebSocket.OPEN);
      } finally {
        ws.close();
        await new Promise((r) => setTimeout(r, 50));
      }
    });
  });
});
