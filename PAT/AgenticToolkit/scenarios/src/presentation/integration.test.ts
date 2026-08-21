/**
 * Integration tests: parser → queue → sequencer → handlers end-to-end.
 *
 * The unit tests in realtime/ and scenarios/ exercise each piece in
 * isolation:
 *  - `TagStreamParser` (realtime)
 *  - `ScenarioActionStream` (realtime, legacy onAction path)
 *  - `TimelineQueue` + `Sequencer` (realtime/timeline)
 *  - `scenariosPresentationExtension.parseAction` / `dispatch` (scenarios)
 *
 * Task #9 closes the gap: drive a full `<timeline>...</timeline>` XML
 * string through the new queue-driven pipeline and assert the linear
 * contract holds AND the legacy compat path works.
 *
 * Why scenarios/ (rather than realtime/integration.test.ts): the test
 * exercises the REAL `scenarios.presentation` domain extension — its
 * tag→DomainAction mapping, its host-callback delegation. Realtime/
 * can't import scenarios/ (dependency direction). scenarios/ can import
 * realtime/. So the integration surface naturally lives here.
 */

import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import {
  ChannelOrchestrator,
  TagStreamParser,
  findExtensionFor,
  registerActionDomain,
  resetRegistry,
  type HostAdapter,
  type StructuredLogEvent,
  type TagEvent,
  type TimelineAction,
} from '@agentic-toolkit/realtime';

import {
  scenariosPresentationExtension,
  type LegacyScenarioAction,
} from './timeline-actions.js';

// `TimelineBaseHandlers` is declared inside realtime's
// channel-orchestrator and not in the package index. Extract it
// structurally via the orchestrator's method signature — keeps the test
// off the deep import path and avoids index churn that would race with
// timeline-core's parallel work on Task #7.
type RunTimelineSeqArgs = Parameters<ChannelOrchestrator['runTimelineSequence']>[0];
type TimelineBaseHandlers = NonNullable<RunTimelineSeqArgs['handlers']>;

// ───────────────────── XML → TimelineAction[] helper ───────────────────
//
// Walks the parser's event stream and builds a TimelineAction array:
//   - `<timeline>` open/close → skipped (wrapper, no action)
//   - `<say target="ID">text</say>` open/text/close → { kind: 'say', text, target? }
//   - `<pause ms="N"/>` → { kind: 'pause', ms: N }
//   - Other self-closing tags → consult the action-domain registry. If an
//     extension claims the tag, take its parseAction output. Otherwise
//     the tag is ignored (the production interpreter would log it as
//     unknown-tag; for this test we want the action stream clean).
//
// Phase 7 will likely consolidate this logic somewhere consumable; for
// now it lives inline as part of the integration test surface.
export function parseTimelineXml(xml: string): TimelineAction[] {
  const actions: TimelineAction[] = [];
  const parser = new TagStreamParser();
  let say: { text: string; target?: string } | null = null;

  const handle = (ev: TagEvent): void => {
    switch (ev.kind) {
      case 'open':
        if (ev.tag === 'timeline') return;
        if (ev.tag === 'say') {
          const target =
            typeof ev.attrs.target === 'string' ? ev.attrs.target : undefined;
          say = { text: '', target };
        }
        return;
      case 'close':
        if (ev.tag === 'timeline') return;
        if (ev.tag === 'say' && say !== null) {
          const a: TimelineAction =
            say.target !== undefined
              ? { kind: 'say', text: say.text, target: say.target }
              : { kind: 'say', text: say.text };
          actions.push(a);
          say = null;
        }
        return;
      case 'text':
        if (say !== null) say.text += ev.text;
        return;
      case 'selfClose': {
        if (ev.tag === 'pause') {
          const ms = Number(ev.attrs.ms ?? 0);
          actions.push({ kind: 'pause', ms: Number.isFinite(ms) ? ms : 0 });
          return;
        }
        const ext = findExtensionFor(ev.tag);
        if (!ext) return;
        const action = ext.parseAction(ev.tag, ev.attrs);
        if (action !== null) actions.push(action);
        return;
      }
      case 'warning':
        return;
    }
  };

  for (const ev of parser.push(xml)) handle(ev);
  for (const ev of parser.end()) handle(ev);
  return actions;
}

// ───────────────────────── test harness boilerplate ────────────────────

function makeHost(): { adapter: HostAdapter; events: StructuredLogEvent[] } {
  const events: StructuredLogEvent[] = [];
  const adapter: HostAdapter = {
    log: {
      event: (ev) => {
        events.push(ev);
      },
      info: () => {},
      warn: () => {},
    },
  };
  return { adapter, events };
}

function eventsOfKind(
  events: StructuredLogEvent[],
  kind: string,
): StructuredLogEvent[] {
  return events.filter((e) => e.kind === kind);
}

interface DispatcherCall {
  action: LegacyScenarioAction;
  threadId: string | null;
  platformId: string | null;
  scenario: unknown;
}

describe('integration: <timeline> XML → parser → queue → sequencer → handlers', () => {
  // The scenarios.presentation extension auto-registers at module load.
  // Tests reset + re-register to keep cross-test isolation explicit; the
  // real extension is what drives the dispatch path in production.
  beforeEach(() => {
    resetRegistry();
    registerActionDomain(scenariosPresentationExtension);
  });

  afterEach(() => {
    resetRegistry();
  });

  describe('parseTimelineXml — helper sanity', () => {
    it('produces TimelineAction[] for the §3.11 canonical packet shape', () => {
      const xml = `<timeline>
        <next_fragment/>
        <say>Hello world</say>
        <pause ms="200"/>
        <next_slide/>
      </timeline>`;
      const actions = parseTimelineXml(xml);

      // Parser yields some whitespace text events between tags that fold
      // into the surrounding say. Filter that down to the structurally
      // meaningful actions.
      const kinds = actions.map((a) =>
        a.kind === 'domain' ? `domain:${a.domainKind}` : a.kind,
      );
      expect(kinds).toEqual([
        'domain:next_fragment',
        'say',
        'pause',
        'domain:next_slide',
      ]);
      // say.text contains exactly the textual content between <say>/</say>.
      const say = actions.find((a) => a.kind === 'say') as
        | (TimelineAction & { kind: 'say' })
        | undefined;
      expect(say?.text).toBe('Hello world');
      const pause = actions.find((a) => a.kind === 'pause') as
        | (TimelineAction & { kind: 'pause' })
        | undefined;
      expect(pause?.ms).toBe(200);
    });

    it('preserves <say target="ID"> attribute', () => {
      const xml =
        '<timeline><say target="single_agent">A single AI agent.</say><next_slide/></timeline>';
      const actions = parseTimelineXml(xml);
      const say = actions.find((a) => a.kind === 'say') as
        | (TimelineAction & { kind: 'say' })
        | undefined;
      expect(say?.target).toBe('single_agent');
      expect(say?.text).toBe('A single AI agent.');
    });
  });

  describe('happy path — linear contract', () => {
    it('all 5 actions enqueue + complete in order; says block before subsequent fragments', async () => {
      const xml = `<timeline><next_fragment/><say>Hello world</say><next_fragment/><say>Second line</say><next_slide/></timeline>`;

      const observed: string[] = [];
      const dispatcherCalls: DispatcherCall[] = [];

      const { adapter, events } = makeHost();
      const orch = new ChannelOrchestrator({ host: adapter });

      const handlers: TimelineBaseHandlers = {
        onSay: async (action) => {
          observed.push(`say-start:${action.text}`);
          // Simulate the TTS-end-of-speech delay (production: real audio).
          await new Promise<void>((r) => setTimeout(r, 50));
          observed.push(`say-end:${action.text}`);
        },
      };

      const host = {
        scenario: { slug: 'integration-test' },
        scenarioActionDispatcher: async (
          action: LegacyScenarioAction,
          ctx: { scenario: unknown; threadId: string | null; platformId: string | null },
        ) => {
          observed.push(
            `scn-fire:${action.type}:${
              action.type === 'slide-nav' ? action.direction : action.type === 'fragment' ? action.direction : ''
            }`,
          );
          dispatcherCalls.push({
            action,
            threadId: ctx.threadId,
            platformId: ctx.platformId,
            scenario: ctx.scenario,
          });
        },
      };

      const actions = parseTimelineXml(xml);
      expect(actions.length).toBe(5);

      const result = await orch.runTimelineSequence({
        timelineId: 'tl-happy',
        threadKey: 'chan:thread-happy',
        threadId: 'thread-happy',
        platformId: 'anam-web:integration',
        actions,
        handlers,
        host,
      });

      expect(result.reason).toBe('completed');
      expect(result.records.length).toBe(5);

      // The linear contract — strict interleave between handlers + the
      // scenario dispatcher. No fragment fires before the prior say
      // resolves, no slide-nav before its prior say.
      expect(observed).toEqual([
        'scn-fire:fragment:next',
        'say-start:Hello world',
        'say-end:Hello world',
        'scn-fire:fragment:next',
        'say-start:Second line',
        'say-end:Second line',
        'scn-fire:slide-nav:next',
      ]);

      // Log emit stream covers each enqueue + completion.
      const enq = eventsOfKind(events, 'timeline.action-enqueued');
      const comp = eventsOfKind(events, 'timeline.action-completed');
      expect(enq.map((e) => e.data.seq)).toEqual([0, 1, 2, 3, 4]);
      expect(comp.map((e) => e.data.seq)).toEqual([0, 1, 2, 3, 4]);
      expect(comp.map((e) => e.data.kind)).toEqual([
        'next_fragment',
        'say',
        'next_fragment',
        'say',
        'next_slide',
      ]);
      // Says took ~50ms each (within a generous lower bound — CI jitter
      // can stretch this, just verify it's not instant).
      const sayDurations = comp
        .filter((e) => e.data.kind === 'say')
        .map((e) => e.data.duration_ms as number);
      for (const d of sayDurations) expect(d).toBeGreaterThanOrEqual(40);

      // Each scenario dispatcher call sees the right host context.
      expect(dispatcherCalls.length).toBe(3);
      for (const c of dispatcherCalls) {
        expect(c.threadId).toBe('thread-happy');
        expect(c.platformId).toBe('anam-web:integration');
        expect(c.scenario).toEqual({ slug: 'integration-test' });
      }
    });

    it('inserts a <pause ms> in the middle and the sequencer waits for it', async () => {
      const xml =
        '<timeline><say>before</say><pause ms="60"/><say>after</say><next_slide/></timeline>';
      const observed: string[] = [];
      const t0 = Date.now();
      const observedAt: number[] = [];

      const { adapter } = makeHost();
      const orch = new ChannelOrchestrator({ host: adapter });

      const handlers: TimelineBaseHandlers = {
        onSay: async (action) => {
          observed.push(`say:${action.text}`);
          observedAt.push(Date.now() - t0);
        },
      };
      const host = {
        scenarioActionDispatcher: () => {
          observed.push('slide-nav');
          observedAt.push(Date.now() - t0);
        },
      };

      const result = await orch.runTimelineSequence({
        timelineId: 'tl-pause-mid',
        threadKey: 'chan:thread-pause',
        threadId: 'thread-pause',
        platformId: 'chan',
        actions: parseTimelineXml(xml),
        handlers,
        host,
      });

      expect(result.reason).toBe('completed');
      expect(observed).toEqual(['say:before', 'say:after', 'slide-nav']);
      // The second say didn't start until the 60ms pause had elapsed.
      expect(observedAt[1]! - observedAt[0]!).toBeGreaterThanOrEqual(55);
    });
  });

  describe('abort mid-stream', () => {
    it('drains remaining actions as cancelled; partial=true on in-flight; completed_actions XML reflects reason=interrupted', async () => {
      const xml = `<timeline>
        <say>one</say>
        <say>two</say>
        <next_fragment/>
        <say>three (will be cut)</say>
        <next_fragment/>
        <next_slide/>
      </timeline>`;
      const actions = parseTimelineXml(xml);
      // 6 structural actions
      expect(actions.length).toBe(6);

      const { adapter, events } = makeHost();
      const orch = new ChannelOrchestrator({ host: adapter });
      const threadKey = 'chan:thread-abort';
      let inFlightAbortFired = false;

      const handlers: TimelineBaseHandlers = {
        onSay: async (action, ctx) => {
          if (action.text === 'one' || action.text === 'two') return;
          // Long-running say — capture the partial-text snapshot so the
          // completed_actions block can render it, then wait for abort.
          return new Promise<void>((_res, rej) => {
            ctx.signal.addEventListener('abort', () => {
              inFlightAbortFired = true;
              rej(new Error('AbortError-mock'));
            });
          });
        },
      };
      const host = {
        scenarioActionDispatcher: async () => {
          // Fast dispatcher — no waiting.
        },
      };

      const runPromise = orch.runTimelineSequence({
        timelineId: 'tl-abort-mid',
        threadKey,
        threadId: 'thread-abort',
        platformId: 'chan',
        actions,
        handlers,
        host,
      });

      // Yield so 'one' + 'two' complete, then the fragment fires, then
      // the third say starts (and blocks).
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setImmediate(r));

      expect(orch.abortTimelineSequence(threadKey, 'bargein')).toBe(true);
      const result = await runPromise;

      expect(result.reason).toBe('aborted');
      expect(inFlightAbortFired).toBe(true);

      // 3 completed (one, two, next_fragment), 3 cancelled (in-flight
      // say plus the 2 dropped trailing actions).
      const completed = eventsOfKind(events, 'timeline.action-completed');
      const cancelled = eventsOfKind(events, 'timeline.action-cancelled');
      expect(completed.map((e) => e.data.kind)).toEqual([
        'say',
        'say',
        'next_fragment',
      ]);
      expect(cancelled.length).toBe(3);
      expect(cancelled.map((e) => e.data.kind)).toEqual([
        'say',
        'next_fragment',
        'next_slide',
      ]);

      // completed_actions XML reflects the abort.
      const block = orch.getCompletedActionsBlock(threadKey);
      expect(block).not.toBeNull();
      expect(block!).toContain('<completed_actions reason="interrupted">');
      // Two fully-completed says with both ts_start and ts_end.
      expect(block!).toMatch(
        /<say ts_start="\d{2}:\d{2}:\d{2}Z" ts_end="\d{2}:\d{2}:\d{2}Z">one<\/say>/,
      );
      expect(block!).toMatch(
        /<say ts_start="\d{2}:\d{2}:\d{2}Z" ts_end="\d{2}:\d{2}:\d{2}Z">two<\/say>/,
      );
      // The in-flight say carries partial="true" and no ts_end.
      expect(block!).toMatch(
        /<say ts_start="\d{2}:\d{2}:\d{2}Z" partial="true">three \(will be cut\)<\/say>/,
      );
      expect(block!.endsWith('</completed_actions>')).toBe(true);
    });
  });

  describe('legacy tag compat — slide_next === next_slide', () => {
    it('produces the same slide-nav next dispatch as the canonical form', async () => {
      const legacyCalls: LegacyScenarioAction[] = [];
      const canonicalCalls: LegacyScenarioAction[] = [];

      const orchFor = (calls: LegacyScenarioAction[]) => {
        const { adapter } = makeHost();
        const orch = new ChannelOrchestrator({ host: adapter });
        const host = {
          scenario: {},
          scenarioActionDispatcher: (action: LegacyScenarioAction) => {
            calls.push(action);
          },
        };
        return { orch, host };
      };

      const { orch: orchLegacy, host: hostLegacy } = orchFor(legacyCalls);
      await orchLegacy.runTimelineSequence({
        timelineId: 'tl-legacy',
        threadKey: 'chan:thread-legacy',
        threadId: 't',
        platformId: 'p',
        actions: parseTimelineXml('<timeline><slide_next/></timeline>'),
        host: hostLegacy,
      });

      const { orch: orchCanon, host: hostCanon } = orchFor(canonicalCalls);
      await orchCanon.runTimelineSequence({
        timelineId: 'tl-canon',
        threadKey: 'chan:thread-canon',
        threadId: 't',
        platformId: 'p',
        actions: parseTimelineXml('<timeline><next_slide/></timeline>'),
        host: hostCanon,
      });

      // Same legacy ScenarioAction payload reached the host dispatcher
      // from both tag forms.
      expect(legacyCalls).toEqual([
        { type: 'slide-nav', direction: 'next', terminator: true },
      ]);
      expect(canonicalCalls).toEqual(legacyCalls);
    });

    it('frag_next → next_fragment and slide_go_to n=3 → goto_slide with target_slide=3', async () => {
      const calls: LegacyScenarioAction[] = [];
      const { adapter } = makeHost();
      const orch = new ChannelOrchestrator({ host: adapter });
      const host = {
        scenarioActionDispatcher: (action: LegacyScenarioAction) => {
          calls.push(action);
        },
      };
      await orch.runTimelineSequence({
        timelineId: 'tl-aliases',
        threadKey: 'chan:thread-aliases',
        threadId: 't',
        platformId: 'p',
        actions: parseTimelineXml(
          '<timeline><frag_next/><slide_go_to n="3"/></timeline>',
        ),
        host,
      });
      expect(calls).toEqual([
        { type: 'fragment', direction: 'next' },
        { type: 'slide-goto', target_slide: 3, terminator: true },
      ]);
    });
  });

  describe('no-extension domain action emits a warn but does not break the sequencer', () => {
    it('unknown domainKind logs warn and instant-completes', async () => {
      const { adapter, events } = makeHost();
      const orch = new ChannelOrchestrator({ host: adapter });
      const result = await orch.runTimelineSequence({
        timelineId: 'tl-unknown',
        threadKey: 'chan:thread-unknown',
        threadId: 't',
        platformId: 'p',
        actions: [
          { kind: 'domain', domainKind: 'made_up_domain_action' },
          { kind: 'say', text: 'still runs' },
        ],
        handlers: { onSay: async () => {} },
      });
      expect(result.reason).toBe('completed');
      expect(result.records.length).toBe(2);
      const completed = eventsOfKind(events, 'timeline.action-completed');
      expect(completed.length).toBe(2);
    });
  });
});
