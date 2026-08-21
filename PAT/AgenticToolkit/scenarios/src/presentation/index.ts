/**
 * Presentation kind — slide DSL + validator + TTS compile. Pure
 * logic (no DOM, no React) so any Node or browser consumer can use
 * it: pat-frontend server (upload validation), nanoclaw container
 * (pre-inject validation), pat-frontend UI (operator feedback).
 *
 * React layouts live under `/presentation/react` (separate subpath
 * export to keep this barrel framework-free).
 */
export * from './slide-spec.js';
export * from './validate-spec.js';
export * from './compile-tts.js';
// Phase 5 of plans/timeline-runtime-and-scenarios.md — the scenarios
// timeline-actions domain extension registers itself with
// @agentic-toolkit/realtime's timeline registry at module load. The
// re-export below makes the import a value-bearing one so tree-shakers
// can't drop the side-effect registration.
export {
  scenariosPresentationExtension,
  isScenarioDomainAction,
  SCENARIO_DOMAIN_KINDS,
} from './timeline-actions.js';
export type {
  ScenarioDomainKind,
  LegacyScenarioAction,
  PresentationDispatchHost,
} from './timeline-actions.js';
// PAT Phase 6: reveal-HTML → PresentationSlide[] extractor.
export {
  extractPresentationSlides,
  extractOne,
  renderPresentationSlide,
} from './extract.js';
export type {
  PresentationSlide,
  ExtractOptions,
} from './extract.js';

/** Shape stashed under ScenarioRow.display for the presentation
 *  kind. Operator UI casts to this when rendering the list. */
export interface PresentationDisplay {
  slide_count: number;
  duration_budget_s?: number;
  /** First-slide title for a quick visual cue. */
  cover_title?: string;
}
