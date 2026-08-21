/**
 * Task #7 — end-to-end test that `dispatchTagStream` now drives the
 * queue + sequencer + banter-dispatch + scenarios.presentation
 * extension all the way through.
 *
 * Strategy: build a minimal `ChannelOrchestrator` with a real
 * (registered) scenarios.presentation extension, drive a raw chat-row
 * string with prose + next_fragment + prose, and assert on the
 * structured log emit stream that:
 *   - 3 actions enqueue + complete in strict order
 *   - banter-dispatch.called fires per `<say>` with ok:false (no API key)
 *   - the host-side scenarioActionDispatcher receives the legacy
 *     ScenarioAction for the fragment, awaited by the sequencer
 *   - the rendition transport sees per-say start/delta/end (no
 *     coalesced single stream)
 *   - barge-in via clearIntent aborts mid-stream, partial actions get
 *     timeline.action-cancelled, partial-text capture lands the
 *     broadcast-but-cut-off say on completed_actions
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChannelOrchestrator, type ChannelTransport } from './channel-orchestrator.js';
import type { HostAdapter, StructuredLogEvent } from './host-adapter.js';
import { resetRegistry } from './timeline/index.js';
import { registerActionDomain } from './timeline/registry.js';
import type { ScenarioContext } from './prompts/_scenario-context.js';
import type { ActionDomainExtension, TimelineAction } from './timeline/index.js';

// Test extension — mirrors the surface of @agentic-toolkit/scenarios's
// scenarios.presentation extension but lives in realtime/ to keep the
// dep direction one-way (scenarios depends on realtime; not vice
// versa). The legacy ScenarioAction shape is unwrapped from
// payload.legacy at dispatch — same contract the real extension uses.
// Tag → (domainKind, legacy action, is_terminator) mirror of the
// real scenarios.presentation extension. Kept identical-in-shape so the
// integration test exercises the same dispatchDomainAction path the
// real extension does. Covers the full §3.11 vocabulary PLUS the 9
// pre-§3.11 aliases scenario-ext maintains for back-compat — so if a
// test adds a fixture using `<slide_next/>` or `<frag_next/>` the mock
// handles it identically.
const TAG_DEFS: Record<
  string,
  {
    domainKind: string;
    legacy: { type: string; direction?: string; target_slide?: number; terminator?: true };
    is_terminator: boolean;
  }
> = {
  // Canonical (§3.11)
  next_fragment:  { domainKind: 'next_fragment',  legacy: { type: 'fragment',  direction: 'next' }, is_terminator: false },
  prev_fragment:  { domainKind: 'prev_fragment',  legacy: { type: 'fragment',  direction: 'prev' }, is_terminator: false },
  next_slide:     { domainKind: 'next_slide',     legacy: { type: 'slide-nav', direction: 'next',  terminator: true }, is_terminator: true },
  prev_slide:     { domainKind: 'prev_slide',     legacy: { type: 'slide-nav', direction: 'prev',  terminator: true }, is_terminator: true },
  nav_slide_up:   { domainKind: 'nav_slide_up',   legacy: { type: 'slide-nav', direction: 'up',    terminator: true }, is_terminator: true },
  nav_slide_down: { domainKind: 'nav_slide_down', legacy: { type: 'slide-nav', direction: 'down',  terminator: true }, is_terminator: true },
  nav_slide_left: { domainKind: 'nav_slide_left', legacy: { type: 'slide-nav', direction: 'left',  terminator: true }, is_terminator: true },
  nav_slide_right:{ domainKind: 'nav_slide_right',legacy: { type: 'slide-nav', direction: 'right', terminator: true }, is_terminator: true },
  goto_slide:     { domainKind: 'goto_slide',     legacy: { type: 'slide-goto', target_slide: 1, terminator: true }, is_terminator: true },
  ask_for_questions: { domainKind: 'ask_for_questions', legacy: { type: 'ask-questions', terminator: true }, is_terminator: true },
  // Aliases (pre-§3.11) — collapsed to canonical domainKind so the
  // legacy SKILL.md vocabulary still parses unchanged.
  slide_next:  { domainKind: 'next_slide',     legacy: { type: 'slide-nav', direction: 'next',  terminator: true }, is_terminator: true },
  slide_prev:  { domainKind: 'prev_slide',     legacy: { type: 'slide-nav', direction: 'prev',  terminator: true }, is_terminator: true },
  slide_up:    { domainKind: 'nav_slide_up',   legacy: { type: 'slide-nav', direction: 'up',    terminator: true }, is_terminator: true },
  slide_down:  { domainKind: 'nav_slide_down', legacy: { type: 'slide-nav', direction: 'down',  terminator: true }, is_terminator: true },
  slide_left:  { domainKind: 'nav_slide_left', legacy: { type: 'slide-nav', direction: 'left',  terminator: true }, is_terminator: true },
  slide_right: { domainKind: 'nav_slide_right',legacy: { type: 'slide-nav', direction: 'right', terminator: true }, is_terminator: true },
  slide_go_to: { domainKind: 'goto_slide',     legacy: { type: 'slide-goto', target_slide: 1, terminator: true }, is_terminator: true },
  frag_next:   { domainKind: 'next_fragment',  legacy: { type: 'fragment',  direction: 'next' }, is_terminator: false },
  frag_prev:   { domainKind: 'prev_fragment',  legacy: { type: 'fragment',  direction: 'prev' }, is_terminator: false },
};

function makeMockPresentationExtension(): ActionDomainExtension {
  return {
    name: 'scenarios.presentation-mock',
    matches: (tag) => tag in TAG_DEFS,
    parseAction: (tag, attrs) => {
      const def = TAG_DEFS[tag];
      if (!def) return null;
      let legacy: Record<string, unknown> = { ...def.legacy };
      const payload: Record<string, unknown> = { is_terminator: def.is_terminator };
      // goto_slide carries an `n` attr (and optionally `v`); both
      // canonical (`goto_slide`) and alias (`slide_go_to`) tags route
      // here and have the attr.
      if (def.domainKind === 'goto_slide') {
        const n = Number(attrs.n ?? 1);
        const nFinal = Number.isFinite(n) ? n : 1;
        legacy = { type: 'slide-goto', target_slide: nFinal, terminator: true };
        payload.n = nFinal;
        if (attrs.v !== undefined) {
          const v = Number(attrs.v);
          if (Number.isFinite(v)) payload.v = v;
        }
      }
      payload.legacy = legacy;
      return { kind: 'domain', domainKind: def.domainKind, payload };
    },
    dispatch: async (action: TimelineAction, ctx) => {
      if (action.kind !== 'domain') return;
      const host = (ctx.host ?? {}) as {
        scenarioActionDispatcher?: (
          action: unknown,
          ctx: { scenario: unknown; threadId: string | null; platformId: string | null },
        ) => void | Promise<void>;
        scenario?: unknown;
      };
      const dispatcher = host.scenarioActionDispatcher;
      if (!dispatcher) return;
      const legacy = (action.payload?.legacy ?? null) as unknown;
      if (!legacy) return;
      await dispatcher(legacy, {
        scenario: host.scenario,
        threadId: ctx.threadId ?? null,
        platformId: ctx.platformId ?? null,
      });
    },
  };
}

function makeHost(): {
  adapter: HostAdapter;
  events: StructuredLogEvent[];
  warnings: { msg: string; meta?: Record<string, unknown> }[];
} {
  const events: StructuredLogEvent[] = [];
  const warnings: { msg: string; meta?: Record<string, unknown> }[] = [];
  const adapter: HostAdapter = {
    log: {
      event: (ev) => {
        events.push(ev);
      },
      info: () => {},
      warn: (msg, meta) => {
        warnings.push({ msg, meta });
      },
    },
  };
  return { adapter, events, warnings };
}

function recordingTransport(opts?: {
  /** Simulates the back-channel: when the host signals "end of
   *  utterance" (transport.onEnd), call markEnded shortly after to
   *  mimic the browser's endOfSpeech / Cartesia AgentTurnEnded. Without
   *  this, waitForEnded in onSay would wait the full ~1.5s fallback
   *  per say. */
  onBackChannelEnd?: (text: string) => void;
}): {
  transport: ChannelTransport;
  events: { kind: string; payload?: unknown }[];
} {
  const events: { kind: string; payload?: unknown }[] = [];
  const transport: ChannelTransport = {
    onStreamStarted: () => events.push({ kind: 'stream-started' }),
    onDelta: (text, seq) => events.push({ kind: 'delta', payload: { text, seq } }),
    onEnd: (text, deltaCount) => {
      events.push({ kind: 'end', payload: { text, deltaCount } });
      // Fire the back-channel asynchronously so the orchestrator's
      // await waitForEnded() actually waits one microtask — matches
      // production where the browser's endOfSpeech round-trips back.
      if (opts?.onBackChannelEnd) {
        queueMicrotask(() => opts.onBackChannelEnd!(text));
      }
    },
    onCancelled: (reason, partial, deltaCount) =>
      events.push({ kind: 'cancelled', payload: { reason, partial, deltaCount } }),
  };
  return { transport, events };
}

function eventsOfKind(events: StructuredLogEvent[], kind: string): StructuredLogEvent[] {
  return events.filter((e) => e.kind === kind);
}

const RAW_TIMELINE = `<timeline>Hello.<next_fragment/>World.</timeline>`;

// Minimal ScenarioContext shape — we just need slug + tag_stream_enabled
// for the dispatchTagStream gate; everything else is opaque.
function makeScenario(): ScenarioContext {
  return {
    slug: 'wired-test',
    tag_stream_enabled: true,
    current_slide: 1,
  } as ScenarioContext;
}

describe('dispatchTagStream — wired to runTimelineSequence', () => {
  // The scenarios.presentation extension registers globally at module
  // load. Tests reset the registry to a clean baseline, then re-register
  // so each test starts from a known state.
  beforeEach(() => {
    resetRegistry();
    registerActionDomain(makeMockPresentationExtension());
  });

  afterEach(() => {
    resetRegistry();
  });

  it('routes prose → say + next_fragment → domain dispatch, linear contract holds', { timeout: 15_000 }, async () => {
    const { adapter, events } = makeHost();

    let dispatcherCalled = 0;
    const orch = new ChannelOrchestrator({
      host: adapter,
      scenarioResolver: () => makeScenario(),
      scenarioActionDispatcher: async (action) => {
        // The scenarios extension's dispatch hands the legacy action
        // here. Validate shape + count the call.
        dispatcherCalled += 1;
        expect(action.type).toBe('fragment');
      },
    });

    // Simulate the back-channel: when the host signals end-of-utterance
    // on the transport, immediately fire markEnded as if the browser
    // had returned its endOfSpeech POST. Pairs each per-say
    // waitForEnded() with a fast resolution; without it the say would
    // wait the full fallback.
    const { transport, events: transportEvents } = recordingTransport({
      onBackChannelEnd: (text) => orch.tts.markEnded('thread-A', text),
    });

    await orch.deliverChat({
      threadKey: 'chan:thread-A',
      threadId: 'thread-A',
      platformId: 'chan',
      agentGroupId: 'ag-test',
      rawText: RAW_TIMELINE,
      renditionTransport: transport,
    });

    // ── Action lifecycle events ────────────────────────────────────
    const enqueued = eventsOfKind(events, 'timeline.action-enqueued');
    const completed = eventsOfKind(events, 'timeline.action-completed');
    expect(enqueued.length).toBe(3);
    expect(completed.length).toBe(3);
    expect(enqueued.map((e) => e.data.kind)).toEqual(['say', 'next_fragment', 'say']);
    expect(completed.map((e) => e.data.kind)).toEqual(['say', 'next_fragment', 'say']);
    // Strict order — seq is 0..2 contiguous, no cancels.
    expect(enqueued.map((e) => e.data.seq)).toEqual([0, 1, 2]);
    expect(completed.map((e) => e.data.seq)).toEqual([0, 1, 2]);
    // Linear contract: each completed event's `ts_end` for action N
    // happens BEFORE the next action's enqueue would observe (we
    // enqueue all up front, but completion stamps must be monotonic).
    const tsEnds = completed.map((e) => Number(e.data.ts_end));
    expect(tsEnds[0]!).toBeLessThanOrEqual(tsEnds[1]!);
    expect(tsEnds[1]!).toBeLessThanOrEqual(tsEnds[2]!);

    // Enqueue events carry the salient attrs the dashboard reads.
    const sayEnq = enqueued.filter((e) => e.data.kind === 'say');
    expect((sayEnq[0]!.data.attrs as Record<string, unknown>).text).toBe('Hello.');
    expect((sayEnq[1]!.data.attrs as Record<string, unknown>).text).toBe('World.');
    const fragEnq = enqueued.find((e) => e.data.kind === 'next_fragment');
    expect((fragEnq!.data.attrs as Record<string, unknown>).direction).toBe('next');

    // ── Banter-dispatch.called per say ─────────────────────────────
    const banterEv = eventsOfKind(events, 'banter-dispatch.called');
    expect(banterEv.length).toBe(2);
    // No API key in tests — both calls fall back to raw text.
    expect((banterEv[0]!.data as Record<string, unknown>).ok).toBe(false);
    expect((banterEv[0]!.data as Record<string, unknown>).input_text).toBe('Hello.');
    expect((banterEv[0]!.data as Record<string, unknown>).output_text).toBe('Hello.');

    // ── Scenarios extension fired the slide-bus POST ───────────────
    expect(dispatcherCalled).toBe(1);

    // ── Per-say rendition streams (NOT coalesced) ──────────────────
    // Each say opens its own stream-started → delta → end triplet.
    // 2 says → 2 triplets → 6 transport events.
    expect(transportEvents.filter((e) => e.kind === 'stream-started').length).toBe(2);
    expect(transportEvents.filter((e) => e.kind === 'delta').length).toBe(2);
    expect(transportEvents.filter((e) => e.kind === 'end').length).toBe(2);
    // Order: started, delta, end, started, delta, end (interleaved with
    // the fragment dispatch which doesn't touch the transport).
    expect(transportEvents.map((e) => e.kind)).toEqual([
      'stream-started', 'delta', 'end',
      'stream-started', 'delta', 'end',
    ]);

    // ── Timeline wrapper opened/closed exactly once ────────────────
    const started = eventsOfKind(events, 'timeline.started');
    const finished = eventsOfKind(events, 'timeline.finished');
    expect(started.length).toBe(1);
    expect(finished.length).toBe(1);
    expect((finished[0]!.data as { reason: string }).reason).toBe('completed');
  });

  it('barge-in mid-stream cancels remaining actions and stamps partial-text on the in-flight say', { timeout: 15_000 }, async () => {
    const { adapter, events } = makeHost();
    const { transport } = recordingTransport();

    const orch = new ChannelOrchestrator({
      host: adapter,
      scenarioResolver: () => makeScenario(),
      scenarioActionDispatcher: async () => {},
    });

    // Long-running timeline: 3 says (~ 1s each at chars/11 + 400ms).
    // First-say-cancelled-mid-flight is the deterministic test case.
    const longRaw = `<timeline>${'A'.repeat(100)}<next_fragment/>${'B'.repeat(100)}</timeline>`;

    const runP = orch.deliverChat({
      threadKey: 'chan:thread-B',
      threadId: 'thread-B',
      platformId: 'chan',
      agentGroupId: 'ag-test',
      rawText: longRaw,
      renditionTransport: transport,
    });

    // Yield enough times for the first say to start its TTS wait.
    for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));

    orch.clearIntent('chan:thread-B', { threadId: 'thread-B', platformId: 'chan' });

    await runP;

    // The first say should have a cancelled event with partial-text.
    const cancelled = eventsOfKind(events, 'timeline.action-cancelled');
    expect(cancelled.length).toBeGreaterThanOrEqual(1);
    // At least one cancelled event should carry partial-text (the
    // in-flight say). Dropped actions don't carry it.
    const withPartial = cancelled.filter((e) => 'partial' in (e.data as Record<string, unknown>));
    expect(withPartial.length).toBeGreaterThanOrEqual(1);
    const partial = (withPartial[0]!.data as { partial: string }).partial;
    expect(typeof partial).toBe('string');
    expect(partial.length).toBeGreaterThan(0);

    // Timeline finished with interrupted reason.
    const finished = eventsOfKind(events, 'timeline.finished');
    expect(finished.length).toBe(1);
    expect((finished[0]!.data as { reason: string }).reason).toBe('interrupted');

    // Completed_actions block reflects the partial state.
    const block = orch.getCompletedActionsBlock('chan:thread-B');
    expect(block).not.toBeNull();
    expect(block!).toContain('<completed_actions reason="interrupted">');
    expect(block!).toMatch(/<say [^>]*partial="true"/);
  });

  it('legacy aliases + goto_slide route through the same domain dispatch', { timeout: 15_000 }, async () => {
    const { adapter, events } = makeHost();

    const dispatchedActions: { type: string; direction?: string; target_slide?: number }[] = [];
    const orch = new ChannelOrchestrator({
      host: adapter,
      scenarioResolver: () => makeScenario(),
      scenarioActionDispatcher: async (action) => {
        dispatchedActions.push(action as { type: string; direction?: string; target_slide?: number });
      },
    });
    const { transport } = recordingTransport({
      onBackChannelEnd: (text) => orch.tts.markEnded('thread-D', text),
    });

    // Drive a mix of canonical + legacy + goto_slide so the test
    // exercises the alias collapse + payload.n pass-through.
    await orch.deliverChat({
      threadKey: 'chan:thread-D',
      threadId: 'thread-D',
      platformId: 'chan',
      agentGroupId: 'ag-test',
      rawText: `<timeline>A<frag_next/>B<slide_go_to n="4"/></timeline>`,
      renditionTransport: transport,
    });

    // 4 actions: say, next_fragment (from frag_next alias), say, goto_slide
    const enqueued = eventsOfKind(events, 'timeline.action-enqueued');
    expect(enqueued.map((e) => e.data.kind)).toEqual([
      'say', 'next_fragment', 'say', 'goto_slide',
    ]);

    // attrs on goto_slide carries n=4
    const gotoEnq = enqueued.find((e) => e.data.kind === 'goto_slide');
    expect((gotoEnq!.data.attrs as Record<string, unknown>).n).toBe(4);

    // Both alias-routed actions hit the same dispatcher path as canonical.
    expect(dispatchedActions.length).toBe(2);
    expect(dispatchedActions[0]!.type).toBe('fragment');
    expect(dispatchedActions[0]!.direction).toBe('next');
    expect(dispatchedActions[1]!.type).toBe('slide-goto');
    expect(dispatchedActions[1]!.target_slide).toBe(4);
  });

  it('synthetic timeline wrapper when raw text has no <timeline> tag', { timeout: 15_000 }, async () => {
    const { adapter, events } = makeHost();

    const orch = new ChannelOrchestrator({
      host: adapter,
      scenarioResolver: () => makeScenario(),
      scenarioActionDispatcher: async () => {},
    });
    const { transport } = recordingTransport({
      onBackChannelEnd: (text) => orch.tts.markEnded('thread-C', text),
    });

    // No <timeline> wrapper — the orchestrator should synthesize one
    // so state-machine bookkeeping (isDelivering) still works.
    await orch.deliverChat({
      threadKey: 'chan:thread-C',
      threadId: 'thread-C',
      platformId: 'chan',
      agentGroupId: 'ag-test',
      rawText: 'Bare prose with no timeline tag.<next_fragment/>',
      renditionTransport: transport,
    });

    const started = eventsOfKind(events, 'timeline.started');
    const finished = eventsOfKind(events, 'timeline.finished');
    expect(started.length).toBe(1);
    expect(finished.length).toBe(1);
    expect((started[0]!.data as { timeline_id: string }).timeline_id).toMatch(/^tl-syn-/);
  });
});
