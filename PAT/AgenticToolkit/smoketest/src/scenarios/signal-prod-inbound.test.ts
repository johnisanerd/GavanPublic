/**
 * Unit coverage for signal-prod-inbound's pure assertion DSL.
 *
 * The scenario itself drives the live prod stack (rig HTTP + WS +
 * pat-frontend log proxy) — those paths only run when env vars are
 * set. These hermetic tests cover only the predicate logic so we can
 * be confident the assertion fails loudly on the exact failure modes
 * the scenario is supposed to catch:
 *
 *   - PAT never received the inbound (no routing.message-routed)
 *   - PAT routed it but the back-mind never produced an outbound
 *     (no routing.message-delivered)
 *   - Cross-talk from another sender's inbound — wrong user_id match
 *   - Cross-talk from another channel's delivery — wrong session_id
 *   - Log ordering violation (delivery emitted before route — would
 *     point at a log-rotation bug)
 */
import { describe, expect, it } from 'vitest';

import {
  assertSignalProdInboundChain,
  pickAccountIdentities,
  type LogEvent,
} from './signal-prod-inbound.scenario.js';

const RIG_E164 = '+15550100005';
const RIG_UUID = '00000000-0000-4000-8000-000000000000';
const PAT_E164 = '+15550100003';

// ── Fixture helpers ──────────────────────────────────────────────────────

const ts = (offsetMs: number): string => new Date(1_700_000_000_000 + offsetMs).toISOString();

const routed = (overrides: Partial<LogEvent> = {}): LogEvent => ({
  ts: ts(0),
  kind: 'routing.message-routed',
  session_id: 'session-abc',
  level: 'info',
  source: 'nanoclaw-host',
  data: {
    agent_group: 'palisade-internal',
    msg_kind: 'chat',
    user_id: `signal:${RIG_E164}`,
    wake: true,
    created: false,
    agent_group_name: 'palisade-internal',
    engage_mode: 'mention',
  },
  ...overrides,
});

const delivered = (overrides: Partial<LogEvent> = {}): LogEvent => ({
  ts: ts(8_000),
  kind: 'routing.message-delivered',
  session_id: 'session-abc',
  level: 'info',
  source: 'nanoclaw-host',
  data: {
    msg_id: 'out-123',
    msg_kind: 'chat',
    channel_type: 'signal',
    platform_id: RIG_E164,
    platform_msg_id: '1715000099999',
  },
  ...overrides,
});

// ── Tests ────────────────────────────────────────────────────────────────

describe('assertSignalProdInboundChain', () => {
  it('passes when routed + delivered both present on the same session', () => {
    const v = assertSignalProdInboundChain({
      rigIdentities: [RIG_E164, RIG_UUID],
      events: [routed(), delivered()],
    });
    expect(v.ok).toBe(true);
    expect(v.routed).not.toBeNull();
    expect(v.delivered).not.toBeNull();
    expect(v.reason).toMatch(/session session-abc/);
  });

  it('fails when there is no routing.message-routed (inbound never reached PAT)', () => {
    const v = assertSignalProdInboundChain({
      rigIdentities: [RIG_E164, RIG_UUID],
      events: [
        // Routing for a different sender — should NOT satisfy.
        routed({ data: { ...routed().data, user_id: 'signal:+19999999999' } }),
        delivered(),
      ],
    });
    expect(v.ok).toBe(false);
    expect(v.routed).toBeNull();
    expect(v.delivered).toBeNull();
    expect(v.reason).toMatch(/no routing.message-routed/);
  });

  it('fails when routed but no matching delivered (back-mind never replied)', () => {
    const v = assertSignalProdInboundChain({
      rigIdentities: [RIG_E164, RIG_UUID],
      events: [routed()],
    });
    expect(v.ok).toBe(false);
    expect(v.routed).not.toBeNull();
    expect(v.delivered).toBeNull();
    expect(v.reason).toMatch(/no matching routing.message-delivered/);
  });

  it("ignores deliveries on a different session_id (cross-talk safety)", () => {
    const v = assertSignalProdInboundChain({
      rigIdentities: [RIG_E164, RIG_UUID],
      events: [
        routed({ session_id: 'session-abc' }),
        // Delivery for an unrelated session — must NOT satisfy.
        delivered({ session_id: 'session-other' }),
      ],
    });
    expect(v.ok).toBe(false);
    expect(v.delivered).toBeNull();
  });

  it('ignores deliveries on a different channel_type (e.g. slack delivery for same session)', () => {
    const v = assertSignalProdInboundChain({
      rigIdentities: [RIG_E164, RIG_UUID],
      events: [
        routed(),
        delivered({ data: { ...delivered().data, channel_type: 'slack' } }),
      ],
    });
    expect(v.ok).toBe(false);
    expect(v.delivered).toBeNull();
  });

  it('ignores deliveries addressed to a different platform_id (different signal recipient)', () => {
    const v = assertSignalProdInboundChain({
      rigIdentities: [RIG_E164, RIG_UUID],
      events: [
        routed(),
        delivered({ data: { ...delivered().data, platform_id: '+19998887777' } }),
      ],
    });
    expect(v.ok).toBe(false);
    expect(v.delivered).toBeNull();
  });

  it('fails when delivered ts precedes routed ts (log ordering violated)', () => {
    const v = assertSignalProdInboundChain({
      rigIdentities: [RIG_E164, RIG_UUID],
      events: [
        routed({ ts: ts(5_000) }),
        delivered({ ts: ts(0) }),  // 5s before routed → impossible
      ],
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/ordering violated/);
  });

  it('ignores routing.message-routed for the wrong msg_kind (e.g. system actions)', () => {
    const v = assertSignalProdInboundChain({
      rigIdentities: [RIG_E164, RIG_UUID],
      events: [
        routed({ data: { ...routed().data, msg_kind: 'system' } }),
        delivered(),
      ],
    });
    expect(v.ok).toBe(false);
    expect(v.routed).toBeNull();
  });

  it('picks the first routed event when multiple match — production logs may include retries', () => {
    const first = routed({ ts: ts(0), session_id: 'session-A' });
    const second = routed({ ts: ts(2_000), session_id: 'session-B' });
    const v = assertSignalProdInboundChain({
      rigIdentities: [RIG_E164, RIG_UUID],
      events: [first, second, delivered({ session_id: 'session-A' })],
    });
    expect(v.ok).toBe(true);
    expect(v.routed?.session_id).toBe('session-A');
  });
});

describe('pickAccountIdentities', () => {
  it("returns default.number when present (rig's preferred shape)", () => {
    expect(
      pickAccountIdentities({
        accounts: [{ number: '+15550100005', uuid: 'aaa' }],
        default: { number: '+15550100005', uuid: 'aaa' },
      }),
    ).toEqual(['+15550100005', 'aaa']);
  });

  it('falls back to accounts[0].number when default is absent', () => {
    expect(
      pickAccountIdentities({
        accounts: [{ number: '+15550100006', uuid: 'bbb' }],
      }),
    ).toEqual(['+15550100006', 'bbb']);
  });

  it('returns empty string on degraded responses', () => {
    expect(pickAccountIdentities({})).toEqual([]);
    expect(pickAccountIdentities({ accounts: [] })).toEqual([]);
    expect(pickAccountIdentities({ accounts: [{ uuid: 'no-number' }] })).toEqual(['no-number']);
    expect(pickAccountIdentities(null)).toEqual([]);
    expect(pickAccountIdentities(undefined)).toEqual([]);
  });
});

describe('signal-prod-inbound scenario shape', () => {
  // Belt-and-braces — guard against accidentally re-introducing the
  // local-SSE coupling, since this scenario CANNOT use a local NanoClaw
  // to satisfy its assertions (it asserts against prod).
  it('opts out of the local-SSE tap via requiresLocalClient=false', async () => {
    const mod = await import('./signal-prod-inbound.scenario.js');
    expect(mod.signalProdInbound.requiresLocalClient).toBe(false);
  });

  it('has a customRun implementation', async () => {
    const mod = await import('./signal-prod-inbound.scenario.js');
    expect(typeof mod.signalProdInbound.customRun).toBe('function');
  });
});

// Suppress unused-var warning if PAT_E164 isn't referenced (it's here
// for grep-ability and future test additions).
void PAT_E164;
