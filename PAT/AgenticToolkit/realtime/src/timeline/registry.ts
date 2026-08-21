/**
 * Timeline action domain extension registry.
 *
 * Domain packages (`scenarios/`, future `robotics/`, etc.) own their
 * action variants + parser hooks + dispatchers. They register a single
 * `ActionDomainExtension` with the timeline runtime at module load.
 *
 * The parser walks tag events → for each tag, finds the first matching
 * extension via `matches(tag)` → calls `parseAction(...)` → enqueues
 * result. The sequencer dispatches by calling `extension.dispatch(...)`
 * and awaits the returned promise.
 *
 * Conflict policy: first-registered wins on overlapping `matches`. A
 * warning is reported via the optional `onConflict` hook so the
 * conflict is visible without crashing module load.
 *
 * The registry is process-global by design — there is one timeline
 * runtime per realtime process, and extensions are static for that
 * process's lifetime. Tests use `resetRegistry()` to start fresh.
 */

import type { DispatchContext, TimelineAction } from './types.js';

/** Domain extension contract — one per owning package. */
export interface ActionDomainExtension {
  /** Stable, human-readable name. Used in warnings + diagnostics. */
  readonly name: string;

  /** Predicate: does this extension handle the given XML tag name?
   *  Called with the raw tag name as it came off the parser (e.g.
   *  `'next_fragment'`, `'tool_send_signal'`). */
  matches(tag: string): boolean;

  /** Turn a parsed tag (name + attributes) into a TimelineAction. May
   *  return null to skip the tag without warning (treat as no-op). */
  parseAction(
    tag: string,
    attrs: Record<string, string | number | boolean>,
  ): TimelineAction | null;

  /** Fire the action's side effect. The returned promise resolves when
   *  the action's audience-perceptible completion has fired
   *  (TTS-end-of-speech, slide-bus ACK, tool-post arrival, setTimeout
   *  fire). Rejects with AbortError if the dispatch was cancelled via
   *  `ctx.signal`. */
  dispatch(action: TimelineAction, ctx: DispatchContext): Promise<void>;
}

/** Conflict-warning hook — called when a tag matches more than one
 *  registered extension. First-registered still wins; this just makes
 *  the collision visible. Default is a noop in production; tests inject
 *  a recorder to assert on conflicts. */
export type RegistryConflictHook = (info: {
  tag: string;
  winner: string;
  loser: string;
}) => void;

let extensions: ActionDomainExtension[] = [];
let conflictHook: RegistryConflictHook | null = null;

/** Install (or replace) the conflict hook. Pass `null` to disable. */
export function setRegistryConflictHook(hook: RegistryConflictHook | null): void {
  conflictHook = hook;
}

/** Register a domain extension. Idempotent on `name` — calling twice
 *  with the same `name` replaces the prior registration in place. */
export function registerActionDomain(ext: ActionDomainExtension): void {
  const existing = extensions.findIndex((e) => e.name === ext.name);
  if (existing >= 0) {
    extensions[existing] = ext;
    return;
  }
  extensions.push(ext);
}

/** Find the first extension whose `matches(tag)` returns true. Emits a
 *  conflict notification (via `conflictHook`) if more than one matches.
 *  Returns null when no extension claims the tag. */
export function findExtensionFor(tag: string): ActionDomainExtension | null {
  let winner: ActionDomainExtension | null = null;
  for (const ext of extensions) {
    if (!ext.matches(tag)) continue;
    if (winner === null) {
      winner = ext;
      continue;
    }
    // Subsequent matches are conflicts — first wins.
    if (conflictHook) {
      conflictHook({ tag, winner: winner.name, loser: ext.name });
    }
  }
  return winner;
}

/** Snapshot of currently-registered extensions. Read-only. */
export function listExtensions(): readonly ActionDomainExtension[] {
  return extensions.slice();
}

/** Clear the registry. Tests only — production code should never call this. */
export function resetRegistry(): void {
  extensions = [];
  conflictHook = null;
}
