/**
 * Scenarios presentation — timeline action domain extension.
 *
 * Owns the scenario-specific vocabulary (slide nav, fragment, ask) and
 * registers with the @agentic-toolkit/realtime timeline registry at
 * module load. Importers of `@agentic-toolkit/scenarios/presentation`
 * trigger registration as a side effect (nanoclaw, smoketest).
 *
 * Tag-name vocabulary per plans/timeline-runtime-and-scenarios.md §3.11.
 * Pre-§3.11 tag names (`slide_next`, `frag_next`, `slide_go_to`, etc.)
 * are kept as cheap aliases so existing packets (smoke-test, palisade)
 * keep playing through the transition. The SKILL.md migration to the
 * canonical names is a separate task.
 *
 * Phase 5 behavior preservation: the orchestrator's tag-stream
 * interpreter still dispatches via the legacy `ScenarioAction` shape and
 * the nanoclaw-side `scenarioActionDispatcher` callback. The extension's
 * `parseAction` returns a `DomainAction` whose `payload.legacy` carries
 * that legacy shape; the interpreter unwraps it. The extension's
 * `dispatch` (which will be called by Phase 2's sequencer) calls the
 * same callback via `ctx.host.scenarioActionDispatcher` so the
 * slide-bus POST path is unchanged either way.
 *
 * Why an escape hatch instead of flat variants: realtime's
 * `TimelineAction` is `BaseTimelineAction | DomainAction`. Domain
 * packages contribute via `DomainAction { kind: 'domain'; domainKind;
 * payload? }` so realtime's base type doesn't have to know about
 * scenarios. The `domainKind` strings here mirror plan §3.11's
 * canonical tag names verbatim.
 */

// PAT: import from the narrow `@agentic-toolkit/realtime/timeline`
// sub-export rather than the top-level entry. The top-level re-exports
// `state`, `nanoclawClient`, `narration`, `banter` etc. which transitively
// depend on `better-sqlite3` (Node-native). pat-web imports this file via
// its deck renderer; Vite tries to bundle the whole graph for the browser
// and explodes on `util.promisify`. The timeline sub-export is self-
// contained (queue / sequencer / registry / types / events / parser /
// completed-actions) — browser-safe.
import {
  registerActionDomain,
  type ActionDomainExtension,
  type DomainAction,
  type TimelineAction,
} from '@agentic-toolkit/realtime/timeline';

/** Canonical DomainAction.domainKind values owned by this extension.
 *  Matches the new vocabulary from plan §3.11 verbatim. */
export const SCENARIO_DOMAIN_KINDS = [
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
] as const;

export type ScenarioDomainKind = (typeof SCENARIO_DOMAIN_KINDS)[number];

/** Tag → canonical DomainKind. The left column is the wire form (what
 *  appears inside `<...>` in the agent's output); the right is the
 *  in-memory DomainAction.domainKind. Aliases (`slide_next`, `frag_next`,
 *  ...) collapse to the canonical name. */
const TAG_TO_DOMAIN_KIND: Record<string, ScenarioDomainKind> = {
  // Canonical (post-§3.11 vocabulary)
  next_slide: 'next_slide',
  prev_slide: 'prev_slide',
  nav_slide_up: 'nav_slide_up',
  nav_slide_down: 'nav_slide_down',
  nav_slide_left: 'nav_slide_left',
  nav_slide_right: 'nav_slide_right',
  goto_slide: 'goto_slide',
  next_fragment: 'next_fragment',
  prev_fragment: 'prev_fragment',
  ask_for_questions: 'ask_for_questions',
  // Aliases — pre-§3.11 tag names. Kept working so existing packets
  // (`<verbatim a="all"/><slide_next/>` in the smoke-test, etc.) play
  // unchanged. Removable once SKILL.md migration ships.
  slide_next: 'next_slide',
  slide_prev: 'prev_slide',
  slide_up: 'nav_slide_up',
  slide_down: 'nav_slide_down',
  slide_left: 'nav_slide_left',
  slide_right: 'nav_slide_right',
  slide_go_to: 'goto_slide',
  frag_next: 'next_fragment',
  frag_prev: 'prev_fragment',
};

/** DomainKinds that close out a timeline (terminator semantics in the
 *  pre-Phase-2 interpreter; once Phase 2 lands, the sequencer reads
 *  this off the action shape directly). */
const TERMINATOR_KINDS: ReadonlySet<ScenarioDomainKind> = new Set<ScenarioDomainKind>([
  'next_slide',
  'prev_slide',
  'nav_slide_up',
  'nav_slide_down',
  'nav_slide_left',
  'nav_slide_right',
  'goto_slide',
  'ask_for_questions',
]);

/** Legacy ScenarioAction shape used by the pre-Phase-5 interpreter +
 *  nanoclaw's `dispatchScenarioAction`. Embedded in
 *  `DomainAction.payload.legacy` so the existing onAction callback path
 *  keeps working until Phase 2's sequencer takes over.
 *
 *  Mirrors the `ScenarioAction` union in
 *  `realtime/src/scenario-action-stream.ts` for the four variants this
 *  extension produces. Defined locally here (rather than imported) to
 *  keep the dependency direction clean — scenarios depends on realtime
 *  through the timeline registry only, not through the legacy shape. */
export type LegacyScenarioAction =
  | { type: 'slide-nav'; direction: 'next' | 'prev' | 'up' | 'down' | 'left' | 'right'; terminator: true }
  | { type: 'slide-goto'; target_slide: number; terminator: true }
  | { type: 'fragment'; direction: 'next' | 'prev' }
  | { type: 'ask-questions'; terminator: true };

/** DispatchContext.host shape that the orchestrator (Phase 2) threads
 *  through for scenarios. Read by `dispatch`. Free-form on the registry
 *  side; this interface documents what we need. */
export interface PresentationDispatchHost {
  /** Host-side legacy dispatcher (nanoclaw's slide-bus POST + cursor
   *  mutation). Optional — omitted in tests or non-presenter channels. */
  scenarioActionDispatcher?: (
    action: LegacyScenarioAction,
    ctx: { scenario: unknown; threadId: string | null; platformId: string | null },
  ) => void | Promise<void>;
  /** Scenario context — opaque payload, forwarded verbatim. */
  scenario?: unknown;
}

/** Type guard: is this a scenarios-presentation domain action? */
export function isScenarioDomainAction(action: TimelineAction): action is DomainAction {
  if (action.kind !== 'domain') return false;
  return (SCENARIO_DOMAIN_KINDS as readonly string[]).includes(action.domainKind);
}

function buildLegacy(kind: ScenarioDomainKind, n = 1): LegacyScenarioAction {
  switch (kind) {
    case 'next_slide':
      return { type: 'slide-nav', direction: 'next', terminator: true };
    case 'prev_slide':
      return { type: 'slide-nav', direction: 'prev', terminator: true };
    case 'nav_slide_up':
      return { type: 'slide-nav', direction: 'up', terminator: true };
    case 'nav_slide_down':
      return { type: 'slide-nav', direction: 'down', terminator: true };
    case 'nav_slide_left':
      return { type: 'slide-nav', direction: 'left', terminator: true };
    case 'nav_slide_right':
      return { type: 'slide-nav', direction: 'right', terminator: true };
    case 'goto_slide':
      return { type: 'slide-goto', target_slide: n, terminator: true };
    case 'next_fragment':
      return { type: 'fragment', direction: 'next' };
    case 'prev_fragment':
      return { type: 'fragment', direction: 'prev' };
    case 'ask_for_questions':
      return { type: 'ask-questions', terminator: true };
  }
}

/** The extension. Registered at module load — see bottom of file. */
export const scenariosPresentationExtension: ActionDomainExtension = {
  name: 'scenarios.presentation',

  matches(tag) {
    return Object.prototype.hasOwnProperty.call(TAG_TO_DOMAIN_KIND, tag);
  },

  parseAction(tag, attrs) {
    const kind = TAG_TO_DOMAIN_KIND[tag];
    if (!kind) return null;

    if (kind === 'goto_slide') {
      const rawN = Number(attrs.n ?? 1);
      const n = Number.isFinite(rawN) ? rawN : 1;
      const payload: Record<string, unknown> = {
        legacy: buildLegacy('goto_slide', n),
        is_terminator: true,
        n,
      };
      if (attrs.v !== undefined) {
        const rawV = Number(attrs.v);
        if (Number.isFinite(rawV)) payload.v = rawV;
      }
      return { kind: 'domain', domainKind: 'goto_slide', payload };
    }

    return {
      kind: 'domain',
      domainKind: kind,
      payload: {
        legacy: buildLegacy(kind),
        is_terminator: TERMINATOR_KINDS.has(kind),
      },
    };
  },

  async dispatch(action, ctx) {
    if (!isScenarioDomainAction(action)) return;
    const host = (ctx.host ?? {}) as PresentationDispatchHost;
    const dispatcher = host.scenarioActionDispatcher;
    if (!dispatcher) {
      // No host-side wiring (test channel, unconfigured deploy). The
      // observability layer already saw the action via the orchestrator;
      // here is the no-op path — keep the timeline progressing.
      return;
    }
    const legacy = (action.payload?.legacy ?? null) as LegacyScenarioAction | null;
    if (!legacy) return;
    await dispatcher(legacy, {
      scenario: host.scenario,
      threadId: ctx.threadId ?? null,
      platformId: ctx.platformId ?? null,
    });
  },
};

// Module-load side effect: register with the global registry so any
// importer of `@agentic-toolkit/scenarios/presentation` activates the
// extension without explicit wiring. `registerActionDomain` is
// idempotent on `name`, so double-imports collapse cleanly.
registerActionDomain(scenariosPresentationExtension);
