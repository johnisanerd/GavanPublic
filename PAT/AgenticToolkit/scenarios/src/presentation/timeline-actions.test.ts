import { describe, it, expect } from 'vitest';

import {
  findExtensionFor,
  listExtensions,
  registerActionDomain,
  type DispatchContext,
  type DomainAction,
} from '@agentic-toolkit/realtime';

// Importing the module triggers registerActionDomain(...) at module load
// (the value-bearing re-export through ./index.ts preserves the side
// effect against tree-shakers). Pull the extension out for direct
// interrogation.
import {
  isScenarioDomainAction,
  SCENARIO_DOMAIN_KINDS,
  scenariosPresentationExtension,
  type LegacyScenarioAction,
} from './timeline-actions.js';

const fakeCtx = (overrides: Partial<DispatchContext> = {}): DispatchContext => ({
  timelineId: 'tl-test',
  seq: 0,
  signal: new AbortController().signal,
  threadId: 'thread-1',
  sessionId: 'session-1',
  platformId: 'anam-web:test',
  host: {},
  ...overrides,
});

describe('scenarios.presentation timeline-actions extension', () => {

  describe('matches()', () => {
    it.each([
      // canonical
      'next_slide',
      'prev_slide',
      'nav_slide_up',
      'nav_slide_down',
      'nav_slide_left',
      'nav_slide_right',
      'goto_slide',
      'next_fragment',
      'prev_fragment',
      'ask_for_questions',
      // legacy aliases
      'slide_next',
      'slide_prev',
      'slide_up',
      'slide_down',
      'slide_left',
      'slide_right',
      'slide_go_to',
      'frag_next',
      'frag_prev',
    ])('claims %s', (tag) => {
      expect(scenariosPresentationExtension.matches(tag)).toBe(true);
    });

    it.each(['verbatim', 'break', 'emotion', 'timeline', 'tool_send_signal', 'random_unknown'])(
      'does not claim %s',
      (tag) => {
        expect(scenariosPresentationExtension.matches(tag)).toBe(false);
      },
    );
  });

  describe('parseAction()', () => {
    it('canonical next_slide → DomainAction with legacy slide-nav next + terminator', () => {
      const da = scenariosPresentationExtension.parseAction('next_slide', {});
      expect(da).toBeTruthy();
      expect(da!.kind).toBe('domain');
      const domain = da as DomainAction;
      expect(domain.domainKind).toBe('next_slide');
      expect(domain.payload?.is_terminator).toBe(true);
      expect(domain.payload?.legacy).toEqual({
        type: 'slide-nav',
        direction: 'next',
        terminator: true,
      });
    });

    it('alias slide_next collapses to next_slide domainKind', () => {
      const da = scenariosPresentationExtension.parseAction('slide_next', {}) as DomainAction;
      expect(da.domainKind).toBe('next_slide');
      expect(da.payload?.legacy).toEqual({
        type: 'slide-nav',
        direction: 'next',
        terminator: true,
      });
    });

    it.each([
      ['nav_slide_up', 'up'],
      ['nav_slide_down', 'down'],
      ['nav_slide_left', 'left'],
      ['nav_slide_right', 'right'],
      ['slide_up', 'up'],
      ['slide_down', 'down'],
      ['slide_left', 'left'],
      ['slide_right', 'right'],
    ] as const)('directional %s → slide-nav %s + terminator', (tag, direction) => {
      const da = scenariosPresentationExtension.parseAction(tag, {}) as DomainAction;
      expect(da.payload?.is_terminator).toBe(true);
      expect(da.payload?.legacy).toEqual({
        type: 'slide-nav',
        direction,
        terminator: true,
      });
    });

    it('goto_slide n="4" produces slide-goto with target_slide=4 + n=4 in payload', () => {
      const da = scenariosPresentationExtension.parseAction('goto_slide', { n: 4 }) as DomainAction;
      expect(da.domainKind).toBe('goto_slide');
      expect(da.payload?.n).toBe(4);
      expect(da.payload?.legacy).toEqual({
        type: 'slide-goto',
        target_slide: 4,
        terminator: true,
      });
    });

    it('goto_slide with v="3" carries the vertical index in payload', () => {
      const da = scenariosPresentationExtension.parseAction('goto_slide', {
        n: 2,
        v: 3,
      }) as DomainAction;
      expect(da.payload?.n).toBe(2);
      expect(da.payload?.v).toBe(3);
    });

    it('alias slide_go_to → goto_slide domainKind', () => {
      const da = scenariosPresentationExtension.parseAction('slide_go_to', {
        n: 5,
      }) as DomainAction;
      expect(da.domainKind).toBe('goto_slide');
      expect(da.payload?.n).toBe(5);
    });

    it('next_fragment is NOT a terminator', () => {
      const da = scenariosPresentationExtension.parseAction('next_fragment', {}) as DomainAction;
      expect(da.domainKind).toBe('next_fragment');
      expect(da.payload?.is_terminator).toBe(false);
      expect(da.payload?.legacy).toEqual({ type: 'fragment', direction: 'next' });
    });

    it('alias frag_next → next_fragment domainKind', () => {
      const da = scenariosPresentationExtension.parseAction('frag_next', {}) as DomainAction;
      expect(da.domainKind).toBe('next_fragment');
    });

    it('ask_for_questions is a terminator', () => {
      const da = scenariosPresentationExtension.parseAction('ask_for_questions', {}) as DomainAction;
      expect(da.payload?.is_terminator).toBe(true);
      expect(da.payload?.legacy).toEqual({ type: 'ask-questions', terminator: true });
    });

    it('unknown tag → null', () => {
      expect(scenariosPresentationExtension.parseAction('some_unrelated_tag', {})).toBeNull();
    });
  });

  describe('dispatch()', () => {
    it('calls ctx.host.scenarioActionDispatcher with the legacy ScenarioAction', async () => {
      const calls: Array<{
        action: LegacyScenarioAction;
        threadId: string | null;
        platformId: string | null;
        scenario: unknown;
      }> = [];
      const ctx = fakeCtx({
        host: {
          scenario: { slug: 'smoke-test' },
          scenarioActionDispatcher: (
            action: LegacyScenarioAction,
            inner: { scenario: unknown; threadId: string | null; platformId: string | null },
          ) => {
            calls.push({ action, ...inner });
          },
        },
      });

      const action = scenariosPresentationExtension.parseAction('next_slide', {}) as DomainAction;
      await scenariosPresentationExtension.dispatch(action, ctx);

      expect(calls).toHaveLength(1);
      expect(calls[0].action).toEqual({
        type: 'slide-nav',
        direction: 'next',
        terminator: true,
      });
      expect(calls[0].threadId).toBe('thread-1');
      expect(calls[0].platformId).toBe('anam-web:test');
      expect(calls[0].scenario).toEqual({ slug: 'smoke-test' });
    });

    it('awaits async dispatcher (slide-bus POST simulation)', async () => {
      let resolved = false;
      const ctx = fakeCtx({
        host: {
          scenarioActionDispatcher: async () => {
            await new Promise((r) => setTimeout(r, 5));
            resolved = true;
          },
        },
      });
      const action = scenariosPresentationExtension.parseAction('goto_slide', {
        n: 3,
      }) as DomainAction;
      await scenariosPresentationExtension.dispatch(action, ctx);
      expect(resolved).toBe(true);
    });

    it('is a no-op when ctx.host.scenarioActionDispatcher is missing', async () => {
      const ctx = fakeCtx({ host: {} });
      const action = scenariosPresentationExtension.parseAction('next_slide', {}) as DomainAction;
      await expect(scenariosPresentationExtension.dispatch(action, ctx)).resolves.toBeUndefined();
    });

    it('is a no-op for non-scenario domain actions', async () => {
      const calls: unknown[] = [];
      const ctx = fakeCtx({
        host: { scenarioActionDispatcher: (a: LegacyScenarioAction) => calls.push(a) },
      });
      const foreign: DomainAction = {
        kind: 'domain',
        domainKind: 'drone_move_to',
        payload: { lat: 0, lon: 0 },
      };
      await scenariosPresentationExtension.dispatch(foreign, ctx);
      expect(calls).toHaveLength(0);
    });
  });

  describe('module-load registration', () => {
    it('extension is registered at module load and findable by claimed tags', () => {
      // The side-effect import at the top of timeline-actions.ts ran
      // registerActionDomain when this test file was loaded. Confirm the
      // registry now resolves the canonical tags to this extension.
      expect(findExtensionFor('next_slide')?.name).toBe('scenarios.presentation');
      expect(findExtensionFor('goto_slide')?.name).toBe('scenarios.presentation');
      expect(findExtensionFor('next_fragment')?.name).toBe('scenarios.presentation');
      // Legacy aliases also resolve.
      expect(findExtensionFor('slide_next')?.name).toBe('scenarios.presentation');
      expect(findExtensionFor('frag_next')?.name).toBe('scenarios.presentation');
    });

    it('re-registering is idempotent on name (no double-add)', () => {
      const before = listExtensions().length;
      registerActionDomain(scenariosPresentationExtension);
      registerActionDomain(scenariosPresentationExtension);
      // listExtensions count stays the same — idempotent on `name`.
      expect(listExtensions().length).toBe(before);
    });
  });

  describe('isScenarioDomainAction()', () => {
    it('true for scenario domain kinds', () => {
      for (const kind of SCENARIO_DOMAIN_KINDS) {
        expect(
          isScenarioDomainAction({
            kind: 'domain',
            domainKind: kind,
            payload: {},
          }),
        ).toBe(true);
      }
    });

    it('false for foreign domain kinds', () => {
      expect(
        isScenarioDomainAction({
          kind: 'domain',
          domainKind: 'drone_move_to',
          payload: {},
        }),
      ).toBe(false);
    });

    it('false for base action kinds', () => {
      expect(
        isScenarioDomainAction({ kind: 'say', text: 'hi' }),
      ).toBe(false);
    });
  });
});
