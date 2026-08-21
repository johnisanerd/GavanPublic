import { afterAll, beforeAll, describe, it, expect } from 'vitest';

import { actionsFromText, ScenarioActionStream } from './scenario-action-stream.js';
import { TagStreamParser } from './tag-stream-parser.js';
import {
  registerActionDomain,
  resetRegistry,
  type ActionDomainExtension,
} from './timeline/index.js';

/** Test-only fake of the scenarios.presentation extension. Mirrors the
 *  legacy ScenarioAction shape so the interpreter, post-Phase-5 refactor,
 *  emits the same actions as before. The real extension lives in
 *  `@agentic-toolkit/scenarios/presentation` — realtime tests can't
 *  import scenarios (dependency direction), so we re-spell the relevant
 *  tag mappings inline here. */
const fakeScenariosExtension: ActionDomainExtension = {
  name: 'scenarios.presentation.test-fake',
  matches(tag) {
    return (
      tag === 'slide_next' ||
      tag === 'slide_prev' ||
      tag === 'slide_up' ||
      tag === 'slide_down' ||
      tag === 'slide_left' ||
      tag === 'slide_right' ||
      tag === 'slide_go_to' ||
      tag === 'frag_next' ||
      tag === 'frag_prev' ||
      tag === 'ask_for_questions' ||
      // canonical (§3.11) — covered by the same fake so both wire forms work
      tag === 'next_slide' ||
      tag === 'prev_slide' ||
      tag === 'goto_slide' ||
      tag === 'next_fragment' ||
      tag === 'prev_fragment'
    );
  },
  parseAction(tag, attrs) {
    const navMap: Record<string, 'next' | 'prev' | 'up' | 'down' | 'left' | 'right'> = {
      slide_next: 'next',
      slide_prev: 'prev',
      slide_up: 'up',
      slide_down: 'down',
      slide_left: 'left',
      slide_right: 'right',
      next_slide: 'next',
      prev_slide: 'prev',
    };
    if (tag in navMap) {
      return {
        kind: 'domain',
        domainKind: tag,
        payload: {
          legacy: { type: 'slide-nav', direction: navMap[tag]!, terminator: true },
          is_terminator: true,
        },
      };
    }
    if (tag === 'slide_go_to' || tag === 'goto_slide') {
      const rawN = Number(attrs.n ?? 1);
      const n = Number.isFinite(rawN) ? rawN : 1;
      return {
        kind: 'domain',
        domainKind: 'goto_slide',
        payload: {
          legacy: { type: 'slide-goto', target_slide: n, terminator: true },
          is_terminator: true,
          n,
        },
      };
    }
    if (tag === 'frag_next' || tag === 'next_fragment') {
      return {
        kind: 'domain',
        domainKind: 'next_fragment',
        payload: {
          legacy: { type: 'fragment', direction: 'next' },
          is_terminator: false,
        },
      };
    }
    if (tag === 'frag_prev' || tag === 'prev_fragment') {
      return {
        kind: 'domain',
        domainKind: 'prev_fragment',
        payload: {
          legacy: { type: 'fragment', direction: 'prev' },
          is_terminator: false,
        },
      };
    }
    if (tag === 'ask_for_questions') {
      return {
        kind: 'domain',
        domainKind: 'ask_for_questions',
        payload: {
          legacy: { type: 'ask-questions', terminator: true },
          is_terminator: true,
        },
      };
    }
    return null;
  },
  async dispatch() {
    // Tests exercise the parseAction → onAction callback path; the
    // sequencer-driven dispatch path is covered by the scenarios package
    // tests.
  },
};

describe('scenario-action-stream', () => {
  // PAT: Phase 5 — realtime's interpreter consults the timeline action
  // domain registry for scenario-specific tags. Register the fake
  // extension before tests so the legacy tag set continues to produce
  // the same ScenarioActions the test expectations are written against.
  beforeAll(() => {
    registerActionDomain(fakeScenariosExtension);
  });
  afterAll(() => {
    resetRegistry();
  });

  it('emits prose actions for plain text', () => {
    const { actions, terminator } = actionsFromText('hello world', undefined);
    expect(actions).toEqual([{ type: 'prose', text: 'hello world' }]);
    expect(terminator).toBe('none');
  });

  it('terminates on slide_next and reports terminator', () => {
    const { actions, terminator } = actionsFromText('say this <slide_next/>', undefined);
    expect(actions).toContainEqual({ type: 'prose', text: 'say this ' });
    expect(actions).toContainEqual({ type: 'slide-nav', direction: 'next', terminator: true });
    expect(terminator).toBe('slide_next');
  });

  it('emits fragment actions mid-stream', () => {
    const { actions } = actionsFromText('one <frag_next/> two <frag_next/> three <slide_next/>', undefined);
    const types = actions.map((a) => a.type);
    expect(types).toEqual([
      'prose',
      'fragment',
      'prose',
      'fragment',
      'prose',
      'slide-nav',
    ]);
  });

  it('tool_* prefix produces tool actions', () => {
    const { actions } = actionsFromText('<tool_send_signal target="audience" demo="true"/>', undefined);
    expect(actions).toContainEqual({
      type: 'tool',
      tool_name: 'send_signal',
      tool_args: { target: 'audience', demo: true },
    });
  });

  it('slide_go_to produces goto with target', () => {
    const { actions, terminator } = actionsFromText('switching <slide_go_to n="4"/>', undefined);
    expect(actions).toContainEqual({ type: 'slide-goto', target_slide: 4, terminator: true });
    expect(terminator).toBe('slide_go_to');
  });

  it('ask_for_questions terminates the stream', () => {
    const { actions, terminator } = actionsFromText('any questions? <ask_for_questions/>', undefined);
    expect(actions).toContainEqual({ type: 'ask-questions', terminator: true });
    expect(terminator).toBe('ask_for_questions');
  });

  it('passes through break and emotion as cartesia passthrough', () => {
    const { actions } = actionsFromText('<break time="400ms"/> hi', undefined);
    expect(actions.some((a) => a.type === 'cartesia-passthrough')).toBe(true);
  });

  it('chunked feed produces same actions as one-shot', () => {
    const text = 'before <frag_next/> middle <slide_next/>';
    const oneShot = actionsFromText(text, undefined).actions;

    const parser = new TagStreamParser();
    const collected: typeof oneShot = [];
    const stream = new ScenarioActionStream({
      onAction: (a) => collected.push(a),
    });
    parser.push('befo').forEach((e) => stream.feed(e));
    parser.push('re <frag_n').forEach((e) => stream.feed(e));
    parser.push('ext/> mid').forEach((e) => stream.feed(e));
    parser.push('dle <slide_ne').forEach((e) => stream.feed(e));
    parser.push('xt/>').forEach((e) => stream.feed(e));
    parser.end().forEach((e) => stream.feed(e));
    stream.end();

    // The terminator/seq distribution is the same; the per-chunk
    // version coalesces text differently, so compare types + key bits.
    expect(collected.map((a) => a.type)).toEqual(oneShot.map((a) => a.type));
  });

  describe('domain extension registry consult', () => {
    it('dispatches an action emitted by a custom-registered extension', () => {
      // Register a one-off extension that claims `unit_test_marker` and
      // turns it into a slide-nav. Verify the interpreter consults the
      // registry, unwraps the legacy payload, and emits the right
      // ScenarioAction. (Real Phase-5 scenarios extension is exercised
      // by the scenarios package tests; this is the realtime-side
      // registry-path coverage.)
      const localExt: ActionDomainExtension = {
        name: 'unit-test:marker',
        matches: (tag) => tag === 'unit_test_marker',
        parseAction: (_tag, _attrs) => ({
          kind: 'domain',
          domainKind: 'unit_test_marker',
          payload: {
            legacy: { type: 'slide-nav', direction: 'next', terminator: true },
            is_terminator: true,
          },
        }),
        dispatch: async () => {},
      };
      registerActionDomain(localExt);
      const { actions, terminator } = actionsFromText('hi <unit_test_marker/>', undefined);
      expect(actions).toContainEqual({ type: 'slide-nav', direction: 'next', terminator: true });
      expect(terminator).toBe('unit_test_marker');
    });

    it('falls through to unknown-tag when no extension claims the tag', () => {
      // Pre-Phase-5: `slide_unwired` would have been unknown anyway.
      // Post-Phase-5: same — registry consult returns null, interpreter
      // falls through to the unknown-tag observability path.
      const { actions } = actionsFromText('hi <slide_unwired/>', undefined);
      expect(actions.some((a) => a.type === 'unknown-tag')).toBe(true);
    });
  });

  describe('<timeline> wrapper', () => {
    it('emits timeline-started/timeline-finished bracketing actions', () => {
      const { actions } = actionsFromText(
        '<timeline>hello world.<slide_next/></timeline>',
        undefined,
      );
      const types = actions.map((a) => a.type);
      // started → prose → slide-nav → finished
      expect(types[0]).toBe('timeline-started');
      expect(types[types.length - 1]).toBe('timeline-finished');
      expect(types).toContain('prose');
      expect(types).toContain('slide-nav');
      // ids match (only one wrapper opened)
      const started = actions.find((a) => a.type === 'timeline-started') as { timeline_id: string };
      const finished = actions.find((a) => a.type === 'timeline-finished') as { timeline_id: string };
      expect(started.timeline_id).toBe(finished.timeline_id);
    });

    it('auto-closes an unclosed <timeline> at end-of-stream', () => {
      // Agent forgot </timeline>; interpreter should still emit a
      // timeline-finished so the state machine flips off.
      const { actions } = actionsFromText('<timeline>say it <slide_next/>', undefined);
      const types = actions.map((a) => a.type);
      expect(types).toContain('timeline-started');
      expect(types).toContain('timeline-finished');
      expect(types).toContain('slide-nav');
    });

    it('emits unknown-tag for stray </timeline> close with no matching open', () => {
      const { actions } = actionsFromText('lone close: </timeline>', undefined);
      const types = actions.map((a) => a.type);
      expect(types).toContain('unknown-tag');
      // No bracket-pair was opened, so no started/finished should fire.
      expect(types).not.toContain('timeline-started');
      expect(types).not.toContain('timeline-finished');
    });

    it('does not fire timeline events for content with no wrapper', () => {
      const { actions } = actionsFromText('plain prose <slide_next/>', undefined);
      const types = actions.map((a) => a.type);
      expect(types).not.toContain('timeline-started');
      expect(types).not.toContain('timeline-finished');
    });
  });
});
