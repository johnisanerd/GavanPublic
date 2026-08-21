/**
 * PAT realtime channel adapter — HTTP surface smoke tests.
 *
 * Covers:
 *   - GET /health → 200 with channel marker
 *   - POST /inbound  → handler runs without throwing; onInbound dispatched
 *     when the front-mind decides 'forward' (only in live-API runs)
 *   - GET /outbound → SSE accepted; deliver() pushes payloads to connected clients
 *   - POST /barge-in → cancel propagation endpoint (Wave 1.1 Path C)
 *
 * PAT: setup now seeds a realtime messaging group + wired agent in an
 * in-memory test DB, because handleInbound calls into
 * ensureRealtimeMessagingGroup, which lazily creates per-caller mgs by
 * copying wiring from an existing realtime mg. Without a seeded mg the
 * inbound path 503s; without initTestDb() it throws "Database not
 * initialized." Both are pre-existing failures from when the inbound
 * handler grew beyond the original smoke-test surface.
 *
 * Trace broadcasting is disabled here (NANOCLAW_TRACE_LLM_CALLS=0) so
 * the SSE stream tests only see deliver()'s own payloads, not the
 * `kind:'trace'` events `runBanterRender` fires on every
 * model call (including the no-API-key failure path).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { createPhoneCallAdapter } from './phone-call.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage } from './adapter.js';
import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from '../db/index.js';
// PAT: caller-authorization-gate tests need to seed a known person and reset
// the owner-phone allowlist cache between runs.
import { createPerson, addIdentifier } from '../people/index.js';
import { resetOwnerPhonesCache } from '../modules/permissions/realtime-owners.js';

const PORT = 18765;
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_PLATFORM_ID = '+15555550000';
const TEST_CALLER_PHONE = TEST_PLATFORM_ID;

function nowIso(): string {
  return new Date().toISOString();
}

/** Seed an in-memory DB with a realtime messaging group + a wired agent.
 *  Mirrors the minimum nanoclaw config the realtime channel adapter
 *  needs at runtime; without it ensureRealtimeMessagingGroup() returns
 *  null and POST /inbound 503s. */
function seedRealtimeWiring(): void {
  createAgentGroup({
    id: 'ag-test',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: nowIso(),
  });
  createMessagingGroup({
    id: 'mg-realtime-test',
    channel_type: 'phone-call',
    platform_id: TEST_PLATFORM_ID,
    name: `phone-call:${TEST_PLATFORM_ID}`,
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: nowIso(),
  });
  createMessagingGroupAgent({
    id: 'mga-realtime-test',
    messaging_group_id: 'mg-realtime-test',
    agent_group_id: 'ag-test',
    // 'pattern' with '.' is the "match everything" sentinel — same shape
    // ensureRealtimeMessagingGroup will copy onto per-caller mgs.
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'accumulate',
    session_mode: 'per-thread',
    priority: 0,
    created_at: nowIso(),
  });
}

// PAT: a gated phone-call messaging group (its own per-caller platform_id) so
// the inbound caller-authorization gate actually enforces. `policy` is the
// `unknown_sender_policy` under test. Wires to the same 'ag-test' agent group
// seeded by seedRealtimeWiring().
function seedGatedWiring(platformId: string, policy: 'request_approval' | 'strict'): void {
  const mgId = `mg-gated-${platformId}`;
  createMessagingGroup({
    id: mgId,
    channel_type: 'phone-call',
    platform_id: platformId,
    name: `phone-call:${platformId}`,
    is_group: 0,
    unknown_sender_policy: policy,
    created_at: nowIso(),
  });
  createMessagingGroupAgent({
    id: `mga-gated-${platformId}`,
    messaging_group_id: mgId,
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

describe('realtime channel adapter', () => {
  let adapter: ChannelAdapter;
  let inbound: Array<{ platformId: string; message: InboundMessage }>;

  beforeEach(async () => {
    process.env.REALTIME_PORT = String(PORT);
    // PAT: suppress trace SSE broadcasts so the deliver() test only
    // observes the chat payload, not the runBanterRender
    // trace event that fires on every model call (including no-API-key
    // failure paths used in tests).
    process.env.NANOCLAW_TRACE_LLM_CALLS = '0';
    const db = initTestDb();
    runMigrations(db);
    seedRealtimeWiring();
    inbound = [];
    adapter = createPhoneCallAdapter();
    const setup: ChannelSetup = {
      onInbound: (platformId, _threadId, message) => {
        inbound.push({ platformId, message });
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
    delete process.env.REALTIME_PORT;
    delete process.env.NANOCLAW_TRACE_LLM_CALLS;
    // PAT: drop the owner-phone allowlist so it doesn't leak between tests.
    delete process.env.PAT_OWNER_PHONES;
    resetOwnerPhonesCache();
  });

  it('answers /health', async () => {
    const r = await fetch(`${BASE}/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, channel: 'phone-call' });
  });

  // PAT: rewritten — this test was originally written against an earlier
  // realtime adapter that forwarded EVERY inbound straight to onInbound.
  // Today the handler runs a front-mind banter pass + request-layer
  // classification; only request-layer decision='forward' calls
  // onInbound. Without ANTHROPIC_API_KEY (i.e. in this test), the
  // request layer fails the no-API-key path and returns decision='silent'
  // — so onInbound legitimately does NOT fire. The HTTP-surface contract
  // we still want to verify: handler accepts the request, returns 200
  // with `{accepted:true, decision}`, and didn't throw.
  it('POST /inbound: handler returns 200 with decision; onInbound only on forward', async () => {
    const r = await fetch(`${BASE}/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'what is the weather',
        sender: 'realtime-user',
        caller_number: TEST_CALLER_PHONE,
      }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { accepted: boolean; decision: string; spoke: boolean };
    expect(body.accepted).toBe(true);
    // No API key → request layer fails open-circuit → silent. (When the
    // suite runs with a real ANTHROPIC_API_KEY, decision may be 'forward'
    // or 'noop'; either is acceptable here — we just want to know the
    // shape is intact.)
    expect(['forward', 'noop', 'silent']).toContain(body.decision);
    expect(typeof body.spoke).toBe('boolean');
    // onInbound only fires on forward — and only forward decisions reach
    // the back-mind.
    if (body.decision === 'forward') {
      expect(inbound).toHaveLength(1);
      const msg = inbound[0]!;
      expect(msg.platformId).toBe(TEST_PLATFORM_ID);
      expect(msg.message.kind).toBe('chat');
      expect((msg.message.content as { sender: string }).sender).toBe('realtime-user');
    } else {
      expect(inbound).toHaveLength(0);
    }
  });

  // ── PAT: inbound caller-authorization gate ──────────────────────────────

  // (a) Unknown caller + request_approval policy → spoken refusal, no inbound
  //     written, agent not woken. The response is {accepted:false, refused:true}
  //     and a `permissions.caller-refused` line is emitted; the SSE stream
  //     carries the refusal as a realtime-utterance.
  it('GATE: unknown caller + request_approval → refused, no agent engagement', async () => {
    const GATED_PHONE = '+15555559999';
    seedGatedWiring(GATED_PHONE, 'request_approval');

    // Attach an SSE listener so we can confirm the spoken refusal goes out.
    const ctrl = new AbortController();
    const resp = await fetch(`${BASE}/outbound`, { signal: ctrl.signal });
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    const sseLines: string[] = [];
    const readPromise = (async () => {
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) if (line.startsWith('data: ')) sseLines.push(line.slice(6));
        if (sseLines.length >= 2) return; // open ACK + refusal utterance
      }
    })();
    await new Promise((r) => setTimeout(r, 50));

    const r = await fetch(`${BASE}/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'let me in', sender: 'realtime-user', caller_number: GATED_PHONE }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { accepted: boolean; refused?: boolean; reason?: string };
    expect(body.accepted).toBe(false);
    expect(body.refused).toBe(true);
    expect(body.reason).toBe('unauthorized_caller');
    // The agent must NOT have been woken (no forward → no onInbound).
    expect(inbound).toHaveLength(0);

    await Promise.race([
      readPromise,
      new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('SSE timeout')), 2000)),
    ]);
    ctrl.abort();
    const parsed = sseLines.map((s) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    });
    const refusal = parsed.find((p) => p && p.kind === 'realtime-utterance' && typeof p.content?.text === 'string');
    expect(refusal).toBeDefined();
    expect(refusal.content.text).toMatch(/recognize this number/i);
  });

  // (b1) Known caller via owner phone (PAT_OWNER_PHONES) + request_approval →
  //      passes the gate. Without an API key the request layer is 'silent', so
  //      we assert the call was NOT refused (the {accepted:true,...} shape)
  //      rather than asserting onInbound fired.
  it('GATE: owner phone + request_approval → passes the gate', async () => {
    const OWNER_PHONE = '+15555558888';
    process.env.PAT_OWNER_PHONES = OWNER_PHONE;
    resetOwnerPhonesCache();
    seedGatedWiring(OWNER_PHONE, 'request_approval');

    const r = await fetch(`${BASE}/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'it is me', sender: 'realtime-user', caller_number: OWNER_PHONE }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { accepted: boolean; decision?: string; refused?: boolean };
    expect(body.accepted).toBe(true);
    expect(body.refused).toBeUndefined();
    expect(['forward', 'noop', 'silent']).toContain(body.decision);
  });

  // (b2) Known PERSON (a person_identifiers phone row) + request_approval →
  //      auto-enroll links the handle, autoApproveKnownPerson grants membership,
  //      the caller passes. Uses the operator's real number +15550100000 to prove
  //      the production scenario the operator cares about.
  it('GATE: known person (+15550100000) + request_approval → passes the gate', async () => {
    const PERSON_PHONE = '+15550100000';
    const person = createPerson({ first_name: 'Op', last_name: 'Erator' });
    addIdentifier({ person_id: person.id, kind: 'phone', value: PERSON_PHONE });
    seedGatedWiring(PERSON_PHONE, 'request_approval');

    const r = await fetch(`${BASE}/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi pat', sender: 'realtime-user', caller_number: PERSON_PHONE }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { accepted: boolean; refused?: boolean; decision?: string };
    expect(body.accepted).toBe(true);
    expect(body.refused).toBeUndefined();
  });

  // (c) public policy → unknown caller passes regardless (unchanged behavior).
  //     This is the default seedRealtimeWiring() mg (TEST_PLATFORM_ID, public),
  //     so an unrecognized caller is NOT refused.
  it('GATE: public policy → unknown caller passes (behavior unchanged)', async () => {
    const r = await fetch(`${BASE}/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'stranger here', sender: 'realtime-user', caller_number: TEST_CALLER_PHONE }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { accepted: boolean; refused?: boolean };
    expect(body.accepted).toBe(true);
    expect(body.refused).toBeUndefined();
  });

  it('rejects POST /inbound missing text', async () => {
    const r = await fetch(`${BASE}/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sender: 'realtime-user' }),
    });
    expect(r.status).toBe(400);
  });

  // PAT: Path C — /barge-in endpoint shape. We don't have an active
  // session in this test so the kill path can't fire — but the
  // response shape MUST be stable and the accumulator MUST be
  // cleared even on no-op runs, so future barge-ins start clean.
  it('POST /barge-in: returns shape even when no session exists', async () => {
    const r = await fetch(`${BASE}/barge-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ thread_id: 'call-nonexistent', reason: 'user-turn-started' }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ok: boolean;
      killed_container: boolean;
      killed_session_id: string | null;
      dropped_pending_contexts: number;
    };
    expect(body.ok).toBe(true);
    expect(body.killed_container).toBe(false); // no live session
    expect(body.killed_session_id).toBe(null);
    expect(body.dropped_pending_contexts).toBe(0);
  });

  it('POST /barge-in: tolerates missing thread_id without crashing', async () => {
    const r = await fetch(`${BASE}/barge-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'user-turn-started' }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('POST /barge-in: rejects malformed JSON', async () => {
    const r = await fetch(`${BASE}/barge-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(r.status).toBe(400);
  });

  // PAT: Path A rendition streaming — when PAT_STREAMING_BANTER=1, the
  // rendition loop in deliver() (chat kind) routes through
  // streamBanterRender and emits utterance-delta /
  // utterance-end / utterance-cancel SSE events. In the no-API-key test
  // env, streamBanterToSse fires onCancelled('error', '', 0) and returns
  // {text: null, silent: false} — so we expect to observe a
  // 'utterance-cancel' event with source='banter-rendition' AND the
  // existing back-compat 'chat' event (raw fallback for the rendition
  // loop's `spoken = renderedText || contexts[0]` path).
  it('PAT_STREAMING_BANTER=1: rendition chat row emits utterance-cancel + chat SSE events', async () => {
    process.env.PAT_STREAMING_BANTER = '1';
    try {
      const ctrl = new AbortController();
      const resp = await fetch(`${BASE}/outbound`, { signal: ctrl.signal });
      expect(resp.status).toBe(200);
      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      const sseLines: string[] = [];

      const readPromise = (async () => {
        let buf = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) return;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (line.startsWith('data: ')) sseLines.push(line.slice(6));
          }
          // Collect at least: open ACK + utterance-cancel + chat = 3.
          if (sseLines.length >= 3) return;
        }
      })();

      await new Promise((r) => setTimeout(r, 50));
      await adapter.deliver('local', null, {
        kind: 'chat',
        content: { text: 'rendition input', sender: 'realtime-agent' },
      });

      await Promise.race([
        readPromise,
        new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('SSE timeout')), 2000)),
      ]);
      ctrl.abort();

      const parsed = sseLines.map((s) => {
        try {
          return JSON.parse(s);
        } catch {
          return null;
        }
      });

      // We expect (a) the connection-open ACK, (b) at least one
      // utterance-cancel for the rendition stream, and (c) the
      // canonical `chat` event with the rendered/fallback text.
      const cancelEvent = parsed.find(
        (p) => p && p.kind === 'utterance-cancel' && p.content?.source === 'banter-rendition',
      );
      expect(cancelEvent).toBeDefined();
      expect(cancelEvent.content.reason).toBe('error');

      const chatEvent = parsed.find((p) => p && p.kind === 'chat');
      expect(chatEvent).toBeDefined();
      // Without API key the rendition is null/silent; the loop falls back
      // to the raw context text. The 'chat' event carries that fallback
      // plus the `_backMindRaw` stamp the existing loop adds.
      expect(chatEvent.content).toMatchObject({ text: 'rendition input' });
    } finally {
      delete process.env.PAT_STREAMING_BANTER;
    }
  });

  // PAT: regression for the original streaming-banter feature flag —
  // when PAT_STREAMING_BANTER is NOT set, the rendition loop uses the
  // blocking runBanterRender path and emits ONLY the
  // legacy 'chat' SSE event (no utterance-* events).
  it('PAT_STREAMING_BANTER unset: rendition chat row emits ONLY chat SSE event', async () => {
    // Ensure flag is unset for this test (afterEach cleanup is paranoid).
    delete process.env.PAT_STREAMING_BANTER;
    const ctrl = new AbortController();
    const resp = await fetch(`${BASE}/outbound`, { signal: ctrl.signal });
    expect(resp.status).toBe(200);
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    const sseLines: string[] = [];

    const readPromise = (async () => {
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('data: ')) sseLines.push(line.slice(6));
        }
        if (sseLines.length >= 2) return;
      }
    })();

    await new Promise((r) => setTimeout(r, 50));
    await adapter.deliver('local', null, {
      kind: 'chat',
      content: { text: 'rendition input', sender: 'realtime-agent' },
    });

    await Promise.race([
      readPromise,
      new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('SSE timeout')), 2000)),
    ]);
    ctrl.abort();

    const parsed = sseLines.map((s) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    });
    const utteranceEvents = parsed.filter((p) => p && typeof p.kind === 'string' && p.kind.startsWith('utterance-'));
    expect(utteranceEvents).toHaveLength(0);
    const chatEvent = parsed.find((p) => p && p.kind === 'chat');
    expect(chatEvent).toBeDefined();
  });

  it('streams deliver() payloads through SSE /outbound stream', async () => {
    const ctrl = new AbortController();
    const resp = await fetch(`${BASE}/outbound`, { signal: ctrl.signal });
    expect(resp.status).toBe(200);
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    const sseLines: string[] = [];

    // Read in the background; collect 'data: ' payloads.
    const readPromise = (async () => {
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('data: ')) sseLines.push(line.slice(6));
        }
        if (sseLines.length >= 2) return;
      }
    })();

    // Give the server a tick to register the SSE client.
    await new Promise((r) => setTimeout(r, 50));

    await adapter.deliver('local', null, {
      kind: 'chat',
      content: { text: 'narration line', sender: 'realtime-agent' },
    });

    await Promise.race([
      readPromise,
      new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('SSE timeout')), 2000)),
    ]);
    ctrl.abort();

    expect(sseLines.length).toBeGreaterThanOrEqual(2);
    const open = JSON.parse(sseLines[0]!);
    expect(open).toEqual({ ok: true });
    const delivery = JSON.parse(sseLines[1]!);
    expect(delivery.kind).toBe('chat');
    // PAT: Wave 1.1 Path C — when runBanterRender fails
    // (no API key in tests) the chat path falls back to the raw text and
    // stamps `_backMindRaw` onto the SSE payload for forensic audit. The
    // assertion uses subset-matching rather than strict equality so the
    // test stays stable across future rendition-output additions.
    expect(delivery.content).toMatchObject({ text: 'narration line', sender: 'realtime-agent' });
  });
});
