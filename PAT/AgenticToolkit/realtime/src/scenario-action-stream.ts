/**
 * PAT: scenario tag-stream → action-stream interpreter.
 *
 * Consumes events from `TagStreamParser` and dispatches digested
 * `ScenarioAction` events. The interpreter is the "front-mind" layer in
 * `plans/presenter-tag-stream.md`:
 *
 *   back-mind (chat row text)
 *      ↓
 *   TagStreamParser
 *      ↓ open/close/text/selfClose events
 *   ScenarioActionStream  ← this file
 *      ↓ ScenarioAction events
 *   transport (rendition SSE / slide-bus POST / dashboard log)
 *
 * Responsibilities:
 *   - Coalesce contiguous `text` events into one prose action.
 *   - Recognize the `tool_*` tag prefix and produce a `tool` action.
 *   - Pass through Cartesia native tags (break, emotion) as
 *     prose with `cartesia: true` so the rendition transport can emit
 *     them inline (Cartesia TTS picks them up; Anam ignores).
 *   - For every other self-closing tag, consult the timeline action
 *     domain registry (Phase 5 of plans/timeline-runtime-and-scenarios.md).
 *     Scenario-specific tags (slide nav, fragment, ask) live in the
 *     `scenarios.presentation` extension; the interpreter unwraps the
 *     legacy `ScenarioAction` shape from `DomainAction.payload.legacy`
 *     so the existing onAction callback path continues to work until
 *     Phase 2's sequencer takes over.
 *   - Unknown tags → emit `unknown-tag` action AND pass through as
 *     raw prose so we don't drop content.
 *
 * Sequencing: actions are emitted in stream order. The consumer is
 * expected to await prose actions on the renditionTransport (so
 * fragment advances land AFTER the prose that preceded them) — see the
 * orchestrator integration for the dispatch loop.
 */

import { TagStreamParser, type TagEvent } from './tag-stream-parser.js';
// PAT: Phase 5 — registry consult for scenario-specific tags. The
// scenarios package contributes the `scenarios.presentation` extension
// that claims slide-nav / fragment / ask-for-questions tags (+ legacy
// aliases). When no extension matches, falls through to the unknown-tag
// path below.
import { findExtensionFor } from './timeline/registry.js';
import type { DomainAction } from './timeline/types.js';

/** Discriminated-union action shape. Mirrors `ScenarioActionType` in
 *  `log-events.ts`. Consumers dispatch on `.type`. */
export type ScenarioAction =
  | { type: 'prose'; text: string; cartesia?: boolean }
  | { type: 'slide-nav'; direction: 'next' | 'prev' | 'up' | 'down' | 'left' | 'right'; terminator: true }
  | { type: 'slide-goto'; target_slide: number; terminator: true }
  | { type: 'fragment'; direction: 'next' | 'prev' }
  | { type: 'ask-questions'; terminator: true }
  | { type: 'tool'; tool_name: string; tool_args: Record<string, string | number | boolean> }
  | { type: 'pause'; ms: number }
  | { type: 'cartesia-passthrough'; tag: string; raw: string }
  | { type: 'unknown-tag'; raw_tag: string; passthrough_text: string }
  // PAT Phase 6: `<timeline_span from="N" to="M"/>` — back-mind emits a
  // short span reference; orchestrator inline-expands actions N..M
  // from the CURRENT slide's authored timeline (from
  // `ScenarioContext.current_slide_authored_timeline`). Bounds inclusive
  // on both ends. The interpreter only emits the structured action —
  // the actual hydration (re-parse, slice, splice) happens in the
  // orchestrator's queue-build path so failures get a single forensic
  // emit (`timeline.span-hydrated`) rather than one per replay.
  | { type: 'timeline-span'; from: number; to: number }
  // PAT: <timeline>...</timeline> XML wrapper — bracket events around a
  // playback sequence. Emitted on parser's `open`/`close` for tag='timeline'.
  // The orchestrator pairs these by timeline_id, tracks per-thread
  // delivering/conversing mode, and emits `timeline.started` /
  // `timeline.finished` structured log events.
  | { type: 'timeline-started'; timeline_id: string }
  | { type: 'timeline-finished'; timeline_id: string };

/** Slide-level context the interpreter accepts for cursor / log
 *  attribution. Optional — interpreter still works without it. */
export interface InterpreterSlideContext {
  slide_n: number;
}

export interface InterpreterOpts {
  /** Current slide context — slide_n only, used for log attribution
   *  and the orchestrator's per-thread cursor. */
  slide?: InterpreterSlideContext;
  /** Called once per dispatched action. Synchronous; the consumer is
   *  expected to fire-and-forget side effects (rendition, slide-bus
   *  POST, log emit). */
  onAction: (action: ScenarioAction, seq: number) => void;
  /** Called when a terminator action has been dispatched. Lets the
   *  consumer know the stream is logically complete and any further
   *  events should warn. */
  onTerminator?: (terminator: string) => void;
}

/**
 * Streaming action-stream interpreter. Construct once per chat-row,
 * feed parser events, drains actions via the `onAction` callback.
 *
 * Usage:
 *   const stream = new ScenarioActionStream({ onAction, slide });
 *   const parser = new TagStreamParser();
 *   for (const chunk of chunks) {
 *     for (const ev of parser.push(chunk)) stream.feed(ev);
 *   }
 *   for (const ev of parser.end()) stream.feed(ev);
 *   stream.end();
 */
export class ScenarioActionStream {
  private opts: InterpreterOpts;
  private seq = 0;
  private terminated = false;
  /** Coalesce contiguous text events into a single prose action — the
   *  consumer prefers a few well-sized prose actions over a flood of
   *  small ones for TTS smoothness. Flushed on the first non-text
   *  event or on end(). */
  private proseBuf = '';
  /** Track open `<emotion>` etc. so we can pass-through their content
   *  with the wrapping tags around it. */
  private cartesiaOpen: { tag: string; opening: string } | null = null;
  /** PAT: track open `<timeline>` wrappers — LIFO so nested timelines
   *  (if they ever happen) get matched by id. The interpreter assigns
   *  ids per-instance; the orchestrator stamps log events from them. */
  private timelineStack: string[] = [];
  private timelineCounter = 0;

  constructor(opts: InterpreterOpts) {
    this.opts = opts;
  }

  feed(ev: TagEvent): void {
    if (this.terminated) {
      // Post-terminator events shouldn't happen; if they do, treat
      // them as prose so we don't drop content. We pulse a warning
      // action so the dashboard sees the anomaly.
      if (ev.kind === 'text' && ev.text.trim().length > 0) {
        this.flushProse();
        this.emit({
          type: 'unknown-tag',
          raw_tag: 'post-terminator-text',
          passthrough_text: ev.text,
        });
        this.opts.onAction({ type: 'prose', text: ev.text }, this.seq);
        this.seq++;
      }
      return;
    }

    switch (ev.kind) {
      case 'text': {
        if (this.cartesiaOpen) {
          // Buffer inside cartesia tag — append, will flush on close.
          this.cartesiaOpen.opening += ev.text;
          return;
        }
        this.proseBuf += ev.text;
        return;
      }
      case 'selfClose': {
        this.handleSelfClose(ev.tag, ev.attrs);
        return;
      }
      case 'open': {
        this.handleOpen(ev.tag, ev.attrs);
        return;
      }
      case 'close': {
        this.handleClose(ev.tag);
        return;
      }
      case 'warning': {
        // Surface as an unknown-tag action; preserves observability
        // without aborting the stream.
        this.flushProse();
        this.emit({
          type: 'unknown-tag',
          raw_tag: `parser:${ev.reason}`,
          passthrough_text: ev.partial,
        });
        return;
      }
    }
  }

  end(): void {
    if (this.cartesiaOpen) {
      // Unclosed cartesia tag — treat the captured content as prose
      // and warn.
      const { tag, opening } = this.cartesiaOpen;
      this.cartesiaOpen = null;
      this.proseBuf += `<${tag}>${opening}`;
      this.emit({
        type: 'unknown-tag',
        raw_tag: `unclosed:${tag}`,
        passthrough_text: opening,
      });
    }
    this.flushProse();
    // PAT: auto-close any open <timeline> wrappers. Agent might have
    // forgotten the closing tag — non-fatal; the state machine just
    // needs the timeline to flip off. The orchestrator will emit
    // timeline.finished with reason='completed'.
    while (this.timelineStack.length > 0) {
      const id = this.timelineStack.pop()!;
      this.emit({ type: 'timeline-finished', timeline_id: id });
    }
    if (!this.terminated) {
      this.opts.onTerminator?.('none');
    }
  }

  private handleSelfClose(tag: string, attrs: Record<string, string | number | boolean>): void {
    // PAT: Phase 5 — consult the timeline action domain registry for
    // scenario-specific tags. The `scenarios.presentation` extension
    // claims slide-nav / fragment / ask-for-questions tags (+ legacy
    // aliases like `slide_next` / `frag_next` / `slide_go_to`). The
    // extension's `parseAction` returns a `DomainAction` whose
    // `payload.legacy` carries the legacy `ScenarioAction` shape the
    // existing onAction callback path expects. `is_terminator` on the
    // payload tells us whether to flip the terminated flag + notify
    // onTerminator.
    //
    // Verbatim, break/emotion (Cartesia passthrough), `tool_*`, and
    // `timeline` wrapper open/close stay handled in this file — those
    // are base concerns (prose-buffer splice, generic tool prefix,
    // wrapper state machine) rather than scenario vocabulary.
    // PAT Phase 6: timeline_span — recognized as a base concern (not
    // routed through the scenarios extension) because the orchestrator
    // needs to inline-expand it before the queue is built, which is
    // upstream of the registry's dispatch path. The interpreter just
    // emits the structured action; hydration lives in the orchestrator
    // where the scenario context (and `current_slide_authored_timeline`)
    // is in scope.
    if (tag === 'timeline_span') {
      this.flushProse();
      const from = Number(attrs.from ?? -1);
      const to = Number(attrs.to ?? -1);
      if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < from) {
        this.emit({
          type: 'unknown-tag',
          raw_tag: tag,
          passthrough_text: `<timeline_span from="${attrs.from}" to="${attrs.to}"/>`,
        });
        return;
      }
      this.emit({ type: 'timeline-span', from, to });
      return;
    }
    if (tag !== 'break' && !tag.startsWith('tool_')) {
      const ext = findExtensionFor(tag);
      if (ext) {
        const da = ext.parseAction(tag, attrs);
        if (da && da.kind === 'domain') {
          this.dispatchDomainAction(tag, da);
          return;
        }
      }
    }
    if (tag === 'pause') {
      // PAT Phase 6: `<pause ms="N"/>` — non-blocking visual beat.
      // Sequencer's `pause` action waits N ms before consuming the
      // next action. Distinct from Cartesia <break/> which is a
      // TTS-level pause baked into the spoken audio.
      this.flushProse();
      const ms = Number(attrs.ms ?? 0);
      this.emit({ type: 'pause', ms: Number.isFinite(ms) && ms >= 0 ? ms : 0 });
      return;
    }
    if (tag === 'break') {
      // Cartesia pause — passthrough as prose with the original tag
      // markup so downstream TTS that respects it picks it up. Anam
      // ignores; harmless.
      const raw = `<break${attrs.time !== undefined ? ` time="${attrs.time}"` : ''}/>`;
      this.proseBuf += raw;
      this.emit({ type: 'cartesia-passthrough', tag: 'break', raw });
      return;
    }
    if (tag.startsWith('tool_')) {
      this.flushProse();
      const toolName = tag.slice('tool_'.length);
      this.emit({ type: 'tool', tool_name: toolName, tool_args: attrs });
      return;
    }
    // Unknown self-closing tag — emit observation, pass through as
    // prose verbatim.
    this.flushProse();
    const raw = `<${tag}${this.attrsToString(attrs)}/>`;
    this.emit({ type: 'unknown-tag', raw_tag: tag, passthrough_text: raw });
    this.proseBuf += raw;
  }

  /** PAT: Phase 5 — emit the legacy ScenarioAction shape that the
   *  pre-sequencer dispatch path expects, lifted from a domain
   *  extension's parseAction output. The extension stamps
   *  `payload.legacy` with the legacy union member and `is_terminator`
   *  with whether to flip the interpreter into post-terminator mode.
   *
   *  Domain actions without a `legacy` payload are reported via the
   *  unknown-tag channel (observability only) so a misconfigured
   *  extension doesn't silently drop content. Phase 2's sequencer will
   *  stop unwrapping legacy here and dispatch the DomainAction directly. */
  private dispatchDomainAction(tag: string, da: DomainAction): void {
    this.flushProse();
    const legacy = (da.payload?.legacy ?? null) as ScenarioAction | null;
    const isTerminator = da.payload?.is_terminator === true;
    if (legacy) {
      this.emit(legacy);
    } else {
      this.emit({
        type: 'unknown-tag',
        raw_tag: `domain:${da.domainKind}:no-legacy`,
        passthrough_text: '',
      });
    }
    if (isTerminator) {
      this.terminated = true;
      this.opts.onTerminator?.(tag);
    }
  }

  private handleOpen(tag: string, attrs: Record<string, string | number | boolean>): void {
    if (tag === 'timeline') {
      // PAT: emit timeline-started bracket. Generate a stable per-instance
      // id so the orchestrator can pair this with the matching finished.
      this.flushProse();
      this.timelineCounter += 1;
      const id = `tl-${this.timelineCounter}`;
      this.timelineStack.push(id);
      this.emit({ type: 'timeline-started', timeline_id: id });
      return;
    }
    if (tag === 'say') {
      // PAT Phase 6: <say> is the canonical spoken-prose wrapper
      // (replaces the deprecated <verbatim/> splice). It's transparent
      // in the action stream — its inner text flows through the prose
      // buffer like raw text would, so a `<say>...</say>` becomes one
      // prose action just like text between tags does. The structured-
      // log `attrs.text` on `timeline.action-enqueued` still carries
      // the literal say body for dashboard rendering.
      this.flushProse();
      return;
    }
    if (tag === 'emotion') {
      // Capture content; emit on close.
      this.flushProse();
      this.cartesiaOpen = { tag: 'emotion', opening: '' };
      // Reconstruct the opening token to preserve attrs for Cartesia.
      const rawOpen = `<emotion${this.attrsToString(attrs)}>`;
      // Accumulate the wrapping into proseBuf at close time; for now
      // stash the open in the cartesiaOpen slot.
      this.cartesiaOpen.opening = '';
      // Stash the rendered open separately by re-using proseBuf at
      // close.
      this.proseBuf += rawOpen;
      return;
    }
    // Unknown open tag — emit observation and treat as literal prose
    // so we don't lose content.
    this.flushProse();
    const raw = `<${tag}${this.attrsToString(attrs)}>`;
    this.emit({ type: 'unknown-tag', raw_tag: tag, passthrough_text: raw });
    this.proseBuf += raw;
  }

  private handleClose(tag: string): void {
    if (tag === 'timeline') {
      // PAT: emit timeline-finished bracket. Pop id; if stack is empty
      // the agent emitted a stray </timeline> — treat as unknown.
      this.flushProse();
      const id = this.timelineStack.pop();
      if (!id) {
        this.emit({
          type: 'unknown-tag',
          raw_tag: '/timeline',
          passthrough_text: '</timeline> with no matching open',
        });
        return;
      }
      this.emit({ type: 'timeline-finished', timeline_id: id });
      return;
    }
    if (tag === 'say') {
      // PAT Phase 6: matches handleOpen('say') — transparent. Flush
      // the accumulated say body as its own prose action so it's a
      // discrete TTS beat, then continue.
      this.flushProse();
      return;
    }
    if (tag === 'emotion' && this.cartesiaOpen?.tag === 'emotion') {
      const captured = this.cartesiaOpen.opening;
      this.cartesiaOpen = null;
      this.proseBuf += `${captured}</emotion>`;
      this.emit({ type: 'cartesia-passthrough', tag: 'emotion', raw: `${captured}</emotion>` });
      return;
    }
    // Unknown close — treat as literal prose.
    this.proseBuf += `</${tag}>`;
    this.emit({ type: 'unknown-tag', raw_tag: `/${tag}`, passthrough_text: `</${tag}>` });
  }

  private flushProse(): void {
    if (this.proseBuf.length === 0) return;
    const text = this.proseBuf;
    this.proseBuf = '';
    // PAT Phase 6: skip whitespace-only buffers — those are formatting
    // newlines/indentation between tags in the authored timeline (e.g.
    // `<say>...</say>\n  <next_slide/>`), not spoken content. Without
    // this guard, every formatting gap becomes a "say" prose action
    // and banter-dispatch gets called with empty content per gap.
    if (/^\s*$/.test(text)) return;
    this.opts.onAction({ type: 'prose', text }, this.seq);
    this.seq++;
  }

  private emit(action: ScenarioAction): void {
    this.opts.onAction(action, this.seq);
    this.seq++;
  }

  private attrsToString(attrs: Record<string, string | number | boolean>): string {
    const parts = Object.entries(attrs).map(([k, v]) => {
      if (v === true) return ` ${k}`;
      return ` ${k}="${String(v)}"`;
    });
    return parts.join('');
  }
}

/** Convenience: drive both parser and interpreter from a complete
 *  chat-row string. Returns the actions in order. */
export function actionsFromText(
  text: string,
  slide: InterpreterSlideContext | undefined,
): { actions: ScenarioAction[]; terminator: string } {
  const actions: ScenarioAction[] = [];
  let terminator = 'none';
  const parser = new TagStreamParser();
  const stream = new ScenarioActionStream({
    slide,
    onAction: (a) => actions.push(a),
    onTerminator: (t) => {
      terminator = t;
    },
  });
  for (const ev of parser.push(text)) stream.feed(ev);
  for (const ev of parser.end()) stream.feed(ev);
  stream.end();
  return { actions, terminator };
}
