/**
 * Timeline — DAW-style multi-track view of a single thread.
 *
 *   ┌─ vars ──────────────────────────────────────────────┐
 *   │ processing  ────▓▓▓▓▓──────────────  ●              │
 *   │ tts-busy    ──▓──────────▓▓▓▓──────  ○              │
 *   │ container   ────▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ●               │
 *   ├─ events (one row per kind) ─────────────────────────┤
 *   │ inbound.received        │     │      "What's two…" │
 *   │ banter.called           │     │      "Yeah lemme…" │
 *   │ ...                                                  │
 *   ├─ voice (stereo) ────────────────────────────────────┤
 *   │ agent       ⌐━━━⌐ ──── ⌐━━━━━⌐                     │
 *   │ ────────────────────────────────  centerline         │
 *   │ user        ─── ⌐━━━⌐ ─────                         │
 *   └────────────────────────────────────────────── now ──┘
 *
 * Phase 1 (done): static window, var blocks, event ticks, voice spans.
 * Phase 2 (done): drag playhead to scrub state-at-time.
 * Phase 3 (done, smoke threads only): drag-and-drop .wav onto voice
 *   track to render an actual mixed waveform aligned to the recorded
 *   call's boundaries. Uses AudioContext.decodeAudioData; computes
 *   per-pixel peaks lazily and renders to a canvas.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LogEvent } from '@/types/log-events';
import { useEventDetails } from '@/components/EventDetailsModal';
import { setDebugSurface } from '@/lib/debug-surface';

interface TimelineProps {
  /** Single rolling buffer of events from App.tsx. Already misc-stripped. */
  buffer: LogEvent[];
  /** Thread to render. Filters events to this thread. */
  thread: string | null;
  /** Window size in ms (default 60_000). */
  windowMs?: number;
}

// ─────────────────────── Wav waveform support ──────────────────────────
//
// Smoketest --call mode (cartesia-call.ts) writes a mixed `call.wav` to
// data/v2-sessions/_smoketest/<scenario>-<ts>/. Drag that file onto the
// timeline and we align it across the recorded call's voice-event extent
// (first start to last stop), then draw a downsampled peak waveform to
// canvas. Alignment is best-effort — a real fix would have the smoketest
// also write a metadata file with the WS-connect / WS-disconnect ts.

interface LoadedWav {
  /** AudioBuffer kept around in case we want to play it later. */
  audioBuffer: AudioBuffer;
  /** Per-pixel peak amplitudes, sampled at the most recent render width.
   *  We re-derive these on width change. Two channels max — average. */
  peaks: number[];
  /** Width the peaks were computed for. */
  peaksWidth: number;
  /** File name for display. */
  fileName: string;
}

/** Compute one peak (max abs sample) per output pixel from an AudioBuffer. */
function computeWaveformPeaks(buffer: AudioBuffer, width: number): number[] {
  const total = buffer.length;
  const samplesPerPx = Math.max(1, Math.floor(total / width));
  const peaks = new Array<number>(width).fill(0);
  // Average across all channels — call.wav from smoketest is mono-mixed
  // already, but be safe.
  const channels = buffer.numberOfChannels;
  for (let i = 0; i < width; i++) {
    const start = i * samplesPerPx;
    const end = Math.min(total, start + samplesPerPx);
    let peak = 0;
    for (let c = 0; c < channels; c++) {
      const data = buffer.getChannelData(c);
      for (let j = start; j < end; j++) {
        const v = Math.abs(data[j]!);
        if (v > peak) peak = v;
      }
    }
    peaks[i] = peak;
  }
  return peaks;
}

/** Spans of voice events for the displayed thread, used to align the wav.
 *  We straddle the earliest cartesia voice event and the latest one — the
 *  wav file's recording window in cartesia-call.ts begins on the
 *  WebSocket "start" message (before any voice) and ends on close, but
 *  the voice-event extent is the closest proxy we have without an
 *  explicit metadata file. */
interface CallExtent {
  startMs: number;
  endMs: number;
}

function callExtentOf(buffer: LogEvent[], thread: string | null): CallExtent | null {
  if (!thread) return null;
  let startMs = Infinity;
  let endMs = -Infinity;
  for (const rec of buffer) {
    if (rec.thread_id !== thread) continue;
    if (
      rec.kind !== 'cartesia.agent-turn-boundary' &&
      rec.kind !== 'cartesia.user-turn-boundary' &&
      rec.kind !== 'utterance.stream-started' &&
      rec.kind !== 'utterance.stream-ended' &&
      rec.kind !== 'call.started' &&
      rec.kind !== 'call.ended'
    ) {
      continue;
    }
    const ts = rec.ts ? Date.parse(rec.ts) : 0;
    if (ts < startMs) startMs = ts;
    if (ts > endMs) endMs = ts;
  }
  if (startMs === Infinity || endMs === -Infinity) return null;
  return { startMs, endMs };
}

const DEFAULT_WINDOW_MS = 60_000;

// ─────────────────────── Track configuration ────────────────────────────

/** Boolean state vars, top section. */
const VAR_TRACKS = [
  { key: 'processing', label: 'processing' },
  { key: 'tts-busy', label: 'tts busy' },
  { key: 'container', label: 'container' },
] as const;
type VarKey = (typeof VAR_TRACKS)[number]['key'];

/** Event tracks — only kinds that carry actual content (text, decision,
 *  tool name). Pure state-transition events (session.created,
 *  container.spawned/exited, session.closed, routing.*, tts.turn-ended)
 *  are dropped here because the var section already shows their state
 *  cleanly; rendering them as bare ticks with `—` for last-line was
 *  noise. Add a kind back if it grows useful per-event content. */
const EVENT_TRACKS = [
  { key: 'inbound.received', label: 'inbound.received' },
  { key: 'banter.called', label: 'banter.called' },
  { key: 'request-layer.decided', label: 'request-layer.decided' },
  { key: 'narrator.fired', label: 'narrator.fired' },
  { key: 'chat.row-received', label: 'chat.row-received' },
  { key: 'banter.rendered', label: 'banter.rendered' },
  { key: 'cartesia.task-cancelled', label: 'cartesia.task-cancelled' },
  { key: 'utterance.stream-cancelled', label: 'utterance.stream-cancelled' },
  // Each delta gets its own tick — dense by design. The voice-stereo
  // row above auto-merges them; this lane is for "every chunk of TTS
  // that left nanoclaw" as discrete events you can hover/click.
  { key: 'utterance.stream-delta', label: 'utterance.stream-delta' },
  // PAT: tag-stream lifecycle — see plans/presenter-tag-stream.md.
  // tag-stream-started / -ended bracket a chat-row's parsed actions;
  // scenario.action is dense (one tick per dispatched action). Useful
  // for "where is the presenter cursor right now?" and "how many
  // fragments fired on slide 3?" forensic questions.
  { key: 'scenario.tag-stream-started', label: 'scenario.start' },
  { key: 'scenario.action', label: 'scenario.action' },
  { key: 'scenario.tag-stream-ended', label: 'scenario.end' },
  // PAT: timeline runtime — see plans/timeline-runtime-and-scenarios.md §3.2/§6.
  // The two `tl.start` / `tl.end` brackets pair by `timeline_id` and
  // stay as single-tick lanes above the swimlane section below; the
  // three action-* events (enqueued / completed / cancelled) are paired
  // into per-category spans rendered in the dedicated "timeline (front-mind)"
  // section, NOT as event ticks here. See `timelineActionSpans` in
  // buildTrackData.
  { key: 'timeline.started', label: 'tl.start' },
  { key: 'timeline.finished', label: 'tl.end' },
] as const;

// ─────────────────────── Layout constants ────────────────────────────

const LABEL_W = 180;
const LASTLINE_W_DEFAULT = 320;
const LASTLINE_W_MIN = 140;
const LASTLINE_W_MAX = 640;
const TRACK_H = 22;
const VOICE_H = 52; // double-height stereo voice track
const SECTION_PAD = 14;
const NOW_GUTTER = 12;
const RULER_H = 18;

/** Local-time HH:MM:SS (no Z, no ms). Used for everything user-facing —
 *  we used to show UTC ISO slices; the user wants machine-local time. */
function fmtLocalSec(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/** Local-time HH:MM:SS.mmm — only for tooltips where ms matters. */
function fmtLocalMs(ms: number): string {
  const d = new Date(ms);
  return `${fmtLocalSec(ms)}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

// ─────────────────────── Derived state ──────────────────────────────

interface VarInterval {
  startMs: number;
  endMs: number;
  /** Event that started this interval (flipped the var on). Carried so
   *  the bar is clickable and surfaces the originating event in a modal. */
  startRec: LogEvent;
}

interface EventTick {
  ts: number;
  text: string;
  rec: LogEvent;
}

interface VoiceSpan {
  startMs: number;
  endMs: number;
  text: string;
  open: boolean;
  /** Originating turn-boundary edge='start' event. */
  startRec: LogEvent;
}

interface ToolSpan {
  /** Tool name (e.g. "Bash"). Used to bucket spans into tracks. */
  tool: string;
  startMs: number;
  endMs: number;
  /** True if no `tool-post` / `tool-failed` arrived — span ends "now". */
  open: boolean;
  /** True if the matching post was a tool-failed. */
  failed: boolean;
  /** tool-use-id for tooltip / debugging. */
  id: string;
  /** Pre event (tool-pre detail row). Click target. */
  preRec: LogEvent;
}

// ─────────────────────── Timeline action spans ──────────────────────────
//
// Pair `timeline.action-enqueued` ↔ `timeline.action-completed` /
// `timeline.action-cancelled` events by `(timeline_id, seq)` and render
// each pair as a horizontal bar on a per-category swimlane. The action
// `kind` payload follows `actionKindLabel()` in
// realtime/src/timeline/events.ts: 'say', 'pause', 'tool:<name>',
// 'tool:<name>:async', 'wait-for-cue', 'terminator:<reason>', or a
// domain variant id like 'next_fragment' / 'next_slide'.
//
// Lane vocabulary (per team-lead refinement on Task #8): split by NOUN.
// fragment and slide are separate swimlanes; wait-for-cue and
// ask_for_questions get their own row so they don't get lost in a
// catch-all. Empty categories auto-hide at render time.

export type TimelineCategory =
  | 'fragment'
  | 'slide'
  | 'say'
  | 'tool'
  | 'pause'
  | 'wait'
  | 'qa'
  | 'other';

/** Bucket an action `kind` label into a coarse semantic category for
 *  swimlane assignment. Pure on the kind string — no side effects, no
 *  per-event branching elsewhere. */
function actionCategory(kind: string): TimelineCategory {
  if (kind === 'say') return 'say';
  if (kind === 'pause') return 'pause';
  if (kind === 'wait-for-cue') return 'wait';
  // ask_for_questions also arrives as `terminator:ask_for_questions`
  // from the sequencer; treat both spellings.
  if (kind === 'ask_for_questions' || kind === 'terminator:ask_for_questions') return 'qa';
  // tool, async_tool — the round-trip-to-back-mind family.
  if (kind === 'tool' || kind.startsWith('tool:')) return 'tool';
  // Fragment reveals are a distinct authoring affordance from slide nav.
  if (kind === 'next_fragment' || kind === 'prev_fragment') return 'fragment';
  // Slide navigation — directional + goto + terminator-flavored variants.
  if (
    kind === 'next_slide' ||
    kind === 'prev_slide' ||
    kind === 'goto_slide' ||
    kind.startsWith('nav_slide_') ||
    kind.startsWith('terminator:next_slide') ||
    kind.startsWith('terminator:prev_slide') ||
    kind.startsWith('terminator:goto_slide') ||
    kind.startsWith('terminator:nav_slide_') ||
    kind.startsWith('terminator:end_of_timeline')
  ) {
    return 'slide';
  }
  return 'other';
}

/** Short string rendered inside a span bar (or in the right-side
 *  last-line when the bar's too narrow to read). The salient is
 *  CATEGORY-driven, not literal kind, so each lane gets the affordance
 *  the user actually cares about — direction arrows for nav, text
 *  preview for say, tool name for tool, ms for pause, etc. */
function actionSalient(span: TimelineActionSpan): string {
  switch (span.category) {
    case 'fragment': {
      const k = span.kind;
      if (k === 'next_fragment') return '→';
      if (k === 'prev_fragment') return '←';
      return k;
    }
    case 'slide': {
      const k = span.kind.replace(/^terminator:/, '');
      if (k === 'next_slide') return '→';
      if (k === 'prev_slide') return '←';
      if (k === 'nav_slide_up') return '↑';
      if (k === 'nav_slide_down') return '↓';
      if (k === 'nav_slide_left') return '←';
      if (k === 'nav_slide_right') return '→';
      // goto_slide — pull `n` (and optional `v`) from the enqueue
      // attrs (timeline-core 03ae995). Falls back to `→…` if the
      // host hadn't stamped attrs yet.
      if (k === 'goto_slide') {
        const n = span.attrs?.n;
        const v = span.attrs?.v;
        if (typeof n === 'number') {
          return typeof v === 'number' ? `→${n}:v${v}` : `→${n}`;
        }
        return '→…';
      }
      if (k === 'end_of_timeline') return '◼';
      return k;
    }
    case 'say': {
      // banter-dispatch.called events fire DURING the say's playback;
      // we cross-reference them in buildTrackData and stash the output
      // here so the bar shows the actual spoken text preview.
      if (span.sayText) return clipLine(span.sayText, 28);
      if (span.partialText) return clipLine(span.partialText, 28);
      return 'say';
    }
    case 'tool': {
      // Prefer attrs.tool_name (timeline-core 03ae995); fall back to
      // parsing the kind label. `:async` suffix becomes a trailing
      // marker so the cascade tells you which tool was fire-and-forget.
      const fromAttrs = span.attrs?.tool_name;
      const name =
        (typeof fromAttrs === 'string' && fromAttrs) ||
        span.kind.replace(/^tool:/, '').replace(/:async$/, '');
      const asyncMark = span.attrs?.async === true || /:async$/.test(span.kind) ? ' …' : '';
      return `${name || 'tool'}${asyncMark}`;
    }
    case 'pause': {
      // Wall-clock span IS the played pause duration. Authored `ms`
      // lives in attrs (timeline-core 03ae995) — surface it with a
      // delta marker when it differs from played, so timing drift
      // pops on the dashboard.
      const played = Math.round(span.endMs - span.startMs);
      const authored = span.attrs?.ms;
      if (typeof authored === 'number' && Math.abs(authored - played) > 25) {
        return `${authored}→${played}ms`;
      }
      return `${played}ms`;
    }
    case 'wait': {
      // wait-for-cue's `cue` lives in attrs (timeline-core 03ae995).
      const cue = span.attrs?.cue;
      return typeof cue === 'string' && cue ? cue : 'cue';
    }
    case 'qa':
      // Ask-for-questions terminator — `?` glyph reads as "pause for
      // audience" at a glance.
      return '?';
    case 'other':
    default:
      return span.kind;
  }
}

const TIMELINE_CATEGORY_ORDER: readonly TimelineCategory[] = [
  // Rough top-to-bottom reading: navigation first (sets where you are),
  // then say (what's heard), then tool (back-mind round-trips), then
  // the rarer categories.
  'slide',
  'fragment',
  'say',
  'tool',
  'pause',
  'wait',
  'qa',
  'other',
] as const;

const TIMELINE_CATEGORY_LABEL: Record<TimelineCategory, string> = {
  slide: 'slide',
  fragment: 'fragment',
  say: 'say',
  tool: 'tool',
  pause: 'pause',
  wait: 'wait',
  qa: 'qa',
  other: 'other',
};

interface TimelineActionSpan {
  /** Composite key = `${timeline_id}:${seq}`. Used internally for the
   *  enqueue ↔ start ↔ completion pair lookup; surfaced in the tooltip
   *  so forensics can correlate with the structured-log feed. */
  id: string;
  timelineId: string;
  seq: number;
  /** Action kind as emitted by the host (`actionKindLabel`). */
  kind: string;
  category: TimelineCategory;
  /** Bar left edge. Set from `timeline.action-started` when present (the
   *  actual moment the sequencer began awaiting this action), else
   *  falls back to the enqueue ts. The user explicitly asked the
   *  swimlane to span started → completed so a terminator sitting in
   *  the queue behind a long say doesn't render as a bar covering the
   *  say's whole duration. */
  startMs: number;
  /** Enqueue ts — when the action joined the queue. Kept separate from
   *  `startMs` so the tooltip can show the queue-wait gap if it was
   *  significant. */
  enqueueMs: number;
  /** End time. If the completion/cancel signal hasn't arrived, the bar
   *  runs to the right edge of the window and `open=true`. */
  endMs: number;
  /** True iff the bar has no completion signal yet (still in flight). */
  open: boolean;
  /** True iff the action was cancelled (mid-flight or queue-drop). */
  cancelled: boolean;
  /** Cancellation reason, when cancelled=true. */
  cancelReason?: string;
  /** Captured partial text for cancelled `say` actions. */
  partialText?: string;
  /** Best-effort spoken text for `say` actions. Two sources, in
   *  preference order:
   *   1) `banter-dispatch.called.data.output_text` whose ts falls in
   *      this span's window — the Pat-voiced REWRITE the audience
   *      actually heard (carries emotion/break tags). Phase 3 design.
   *   2) `attrs.text` on the enqueue event — the AUTHORED text
   *      (timeline-core 03ae995). Fallback when banter-dispatch
   *      didn't fire (raw-fallback path) or rolled out of the buffer.
   *  We populate whichever we find; `actionSalient` reads `sayText`. */
  sayText?: string;
  /** Action attrs from the enqueue event's `data.attrs` (timeline-core
   *  03ae995). Per-kind shape: see TimelineActionEnqueuedEvent in
   *  log-events.ts. Used by `actionSalient` for goto_slide target,
   *  wait-for-cue cue name, pause authored ms, tool name, etc.
   *  Optional — pre-attrs traces omit it and salients fall back to
   *  generic placeholders. */
  attrs?: Record<string, string | number | boolean>;
  /** Click target: the originating enqueue event (falls back to the
   *  completion event if enqueue wasn't observed). */
  startRec: LogEvent;
}

interface TrackData {
  varIntervals: Record<VarKey, VarInterval[]>;
  varCurrent: Record<VarKey, boolean>;
  eventTicks: Record<string, EventTick[]>;
  eventLastLine: Record<string, string>;
  voiceAgentSpans: VoiceSpan[];
  voiceUserSpans: VoiceSpan[];
  voiceAgentLast: string;
  voiceUserLast: string;
  /** Tool-call spans, bucketed by tool name. Each entry pairs a
   *  detail.row-received `tool-pre` with its matching `tool-post`
   *  or `tool-failed` (by `tool_use_id`). Pre without post = open. */
  toolSpans: Record<string, ToolSpan[]>;
  toolNames: string[];
  /** Timeline-action spans, bucketed by semantic category. Each entry
   *  pairs a `timeline.action-enqueued` with its matching
   *  `timeline.action-completed` or `timeline.action-cancelled`
   *  (by `${timeline_id}:${seq}`). Enqueue with no closer = open. */
  timelineActionSpans: Record<TimelineCategory, TimelineActionSpan[]>;
  /** Categories that have at least one span — rendered in this order. */
  timelineCategories: TimelineCategory[];
  windowStartMs: number;
  windowEndMs: number;
  /** Full thread extent — used by the minimap to render the
   *  zoom-out track. windowStart/End are a sub-range of this. */
  fullStartMs: number;
  fullEndMs: number;
}

function parseTs(rec: LogEvent): number {
  return rec.ts ? Date.parse(rec.ts) : 0;
}

/** Pull the most informative single field from a tool-pre `input` record.
 *  Returned string is unbounded — caller should clamp for display. The
 *  goal is a glanceable identifier per call: the Bash command, the file
 *  path being read/edited, the search query, the URL, etc. */
function salientToolField(
  tool: string | undefined,
  input: Record<string, unknown> | undefined,
): string {
  if (!input || !tool) return '';
  const get = (key: string): string | undefined => {
    const v = input[key];
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return undefined;
  };
  switch (tool) {
    case 'Bash':
    case 'BashOutput':
      return get('command') ?? get('bash_id') ?? '';
    case 'Read':
    case 'NotebookRead':
      return get('file_path') ?? '';
    case 'Write':
      return get('file_path') ?? '';
    case 'Edit':
    case 'NotebookEdit':
      return get('file_path') ?? get('notebook_path') ?? '';
    case 'Grep':
      return [get('pattern'), get('path')].filter(Boolean).join(' · ');
    case 'Glob':
      return get('pattern') ?? '';
    case 'WebSearch':
      return get('query') ?? '';
    case 'WebFetch':
      return get('url') ?? '';
    case 'Task':
      return get('description') ?? get('subagent_type') ?? '';
    case 'KillShell':
      return get('shell_id') ?? '';
    case 'TodoWrite':
      // todos is an array — synthesize a count.
      if (Array.isArray(input.todos)) {
        return `${(input.todos as unknown[]).length} todos`;
      }
      return '';
    default: {
      // Unknown tool — try common fallback keys in priority order.
      return (
        get('command') ??
        get('query') ??
        get('url') ??
        get('file_path') ??
        get('path') ??
        get('pattern') ??
        get('description') ??
        ''
      );
    }
  }
}

/** Single-line trim with ellipsis for inline display in narrow bars. */
function clipLine(s: string, maxChars: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > maxChars ? `${oneLine.slice(0, maxChars - 1)}…` : oneLine;
}

function previewText(rec: LogEvent): string {
  const d = rec.data as Record<string, unknown>;
  // PAT: scenario.* events carry their salient field by action_type
  // discriminator, not in a uniform `text` slot. Surface action context
  // inline so the Timeline lane is glanceable without click-to-modal.
  if (rec.kind === 'scenario.action') {
    const actionType = typeof d.action_type === 'string' ? d.action_type : '?';
    const slide = typeof d.slide_n === 'number' ? `s${d.slide_n}` : '';
    const prefix = slide ? `[${slide}] ${actionType}` : actionType;
    switch (actionType) {
      case 'prose':
      case 'verbatim-expanded': {
        const anchor = typeof d.anchor === 'string' ? ` ${d.anchor}` : '';
        const text = typeof d.text === 'string' ? ` "${d.text}"` : '';
        return `${prefix}${anchor}${text}`;
      }
      case 'slide-nav':
        return `${prefix} ${typeof d.direction === 'string' ? d.direction : ''}`;
      case 'slide-goto':
        return `${prefix} →${typeof d.target_slide === 'number' ? d.target_slide : '?'}`;
      case 'fragment':
        return `${prefix} ${typeof d.fragment_direction === 'string' ? d.fragment_direction : ''}`;
      case 'tool':
        return `${prefix} ${typeof d.tool_name === 'string' ? d.tool_name : ''}`;
      case 'cartesia-passthrough':
        return `${prefix} <${typeof d.raw_tag === 'string' ? d.raw_tag : ''}/>`;
      case 'unknown-tag':
        return `${prefix} <${typeof d.raw_tag === 'string' ? d.raw_tag : ''}/>`;
      case 'ask-questions':
        return prefix;
      default:
        return prefix;
    }
  }
  if (rec.kind === 'scenario.tag-stream-started') {
    const slide = typeof d.slide_n === 'number' ? `s${d.slide_n}` : '?';
    const chars = typeof d.raw_chars === 'number' ? ` ${d.raw_chars}c` : '';
    return `${slide}${chars}`;
  }
  if (rec.kind === 'scenario.tag-stream-ended') {
    const slide = typeof d.slide_n === 'number' ? `s${d.slide_n}` : '?';
    const count = typeof d.action_count === 'number' ? ` ${d.action_count}a` : '';
    const dur = typeof d.duration_ms === 'number' ? ` ${Math.round(d.duration_ms)}ms` : '';
    const term = typeof d.terminator === 'string' ? ` term=${d.terminator}` : '';
    return `${slide}${count}${dur}${term}`;
  }
  // PAT: timeline runtime brackets. timeline.action-* are NOT lane
  // ticks anymore — they're paired into per-category spans in the
  // dedicated swimlane section; the salient info there lives on the
  // span tooltip / right-side last-line, not here.
  if (rec.kind === 'timeline.started') {
    const tid = typeof d.timeline_id === 'string' ? d.timeline_id : '?';
    const slug = typeof d.scenario_slug === 'string' ? ` · ${d.scenario_slug}` : '';
    return `[${tid}]${slug}`;
  }
  if (rec.kind === 'timeline.finished') {
    const reason = typeof d.reason === 'string' ? d.reason : '?';
    const dur = typeof d.duration_ms === 'number' ? ` · ${Math.round(d.duration_ms)}ms` : '';
    return `${reason}${dur}`;
  }
  if (typeof d.text === 'string') return d.text;
  if (typeof d.utterance === 'string') return d.utterance;
  if (typeof d.response_text === 'string') return d.response_text;
  if (typeof d.preview === 'string') return d.preview;
  if (typeof d.invoke_text === 'string') return d.invoke_text;
  if (typeof d.text_preview === 'string') return d.text_preview;
  if (typeof d.rendered_text === 'string') return d.rendered_text;
  if (typeof d.reason === 'string') return d.reason;
  // routing.message-routed/delivered carry these — synthesize a label.
  if (typeof d.msg_kind === 'string' && typeof d.agent_group_name === 'string') {
    return `${d.msg_kind} → ${d.agent_group_name}`;
  }
  if (typeof d.msg_kind === 'string' && typeof d.channel_type === 'string') {
    return `${d.msg_kind} via ${d.channel_type}`;
  }
  if (typeof d.msg_kind === 'string') return d.msg_kind;
  if (typeof d.container_name === 'string') return d.container_name;
  if (typeof d.session_mode === 'string') return `mode=${d.session_mode}`;
  if (typeof d.exit_code === 'number') return `exit=${d.exit_code}`;
  return '';
}

function buildTrackData(
  buffer: LogEvent[],
  thread: string | null,
  windowMs: number,
  /** Wall-clock ms; defaults to "now" derived from the latest event. */
  playheadMs: number | null,
  /** Caller-supplied wall-clock-ish value. Pass a 4Hz-ticked Date.now()
   *  here to keep the right edge sliding between events. */
  nowMs: number,
  /** Premiere-style viewport selection: [startFrac, endFrac] of the
   *  full thread extent. [0, 1] = fit-all (legacy auto-grow). Anything
   *  narrower is the user zooming in via the minimap. */
  viewportFrac: [number, number],
): TrackData {
  const filtered = thread ? buffer.filter((r) => r.thread_id === thread) : [];
  const sorted = [...filtered].sort((a, b) => parseTs(a) - parseTs(b));

  const latest = sorted.length > 0 ? parseTs(sorted[sorted.length - 1]!) : nowMs;
  const earliest = sorted.length > 0 ? parseTs(sorted[0]!) : nowMs;
  // "Now" tracks wall-clock via the caller-supplied tick.
  const fullEndMs = Math.max(latest + 500, nowMs);
  // Floor the natural window at the configured `windowMs` so a brand-new
  // short thread isn't rendered into a 5-second slice that's hard to read.
  const fullStartMs = Math.min(earliest - 500, fullEndMs - windowMs);
  const fullSpan = fullEndMs - fullStartMs;
  // Premiere-style viewport: the user's [startFrac, endFrac] selects a
  // sub-range of the full extent. [0, 1] keeps the legacy fit-all
  // behavior (auto-grow). Anything narrower is a zoom.
  const [vs, ve] = viewportFrac;
  const windowStartMs = fullStartMs + vs * fullSpan;
  const windowEndMs = fullStartMs + ve * fullSpan;
  // Playhead = where state "as of" is computed. Defaults to now.
  const ph = playheadMs ?? windowEndMs;

  // ─────────── Vars ───────────
  const varIntervals: Record<VarKey, VarInterval[]> = {
    processing: [],
    'tts-busy': [],
    container: [],
  };
  const varCurrent: Record<VarKey, boolean> = {
    processing: false,
    'tts-busy': false,
    container: false,
  };
  const varStartMs: Partial<Record<VarKey, number>> = {};
  const varStartRec: Partial<Record<VarKey, LogEvent>> = {};

  const flipOn = (key: VarKey, ts: number, rec: LogEvent) => {
    if (varStartMs[key] !== undefined) return;
    varStartMs[key] = ts;
    varStartRec[key] = rec;
    varCurrent[key] = true;
  };
  const flipOff = (key: VarKey, ts: number) => {
    const start = varStartMs[key];
    const rec = varStartRec[key];
    if (start !== undefined && rec) {
      varIntervals[key].push({ startMs: start, endMs: ts, startRec: rec });
      varStartMs[key] = undefined;
      varStartRec[key] = undefined;
    }
    varCurrent[key] = false;
  };

  // Walk all events to build the FULL set of intervals (for visual blocks).
  // varCurrent below is then derived AT the playhead — independently — so
  // moving the playhead reveals on/off state at any point in time.
  for (const rec of sorted) {
    const ts = parseTs(rec);
    if (rec.kind === 'state.transitioned') {
      const d = rec.data;
      if (d.state === 'isProcessingNarration') {
        if (d.to) flipOn('processing', ts, rec);
        else flipOff('processing', ts);
      } else if (d.state === 'isTtsBusy') {
        if (d.to) flipOn('tts-busy', ts, rec);
        else flipOff('tts-busy', ts);
      }
    } else if (rec.kind === 'tts.busy-marked') {
      flipOn('tts-busy', ts, rec);
    } else if (rec.kind === 'tts.turn-ended') {
      flipOff('tts-busy', ts);
    } else if (rec.kind === 'container.spawned') {
      flipOn('container', ts, rec);
    } else if (rec.kind === 'container.exited') {
      flipOff('container', ts);
    } else if (rec.kind === 'session.closed') {
      flipOff('container', ts);
      flipOff('processing', ts);
    }
  }
  for (const k of Object.keys(varStartMs) as VarKey[]) {
    const start = varStartMs[k];
    const rec = varStartRec[k];
    if (start !== undefined && rec) {
      varIntervals[k].push({ startMs: start, endMs: windowEndMs, startRec: rec });
    }
  }
  // varCurrent AT the playhead: a var is on iff some interval contains ph.
  for (const k of Object.keys(varCurrent) as VarKey[]) {
    varCurrent[k] = varIntervals[k].some((iv) => iv.startMs <= ph && ph <= iv.endMs);
  }

  // ─────────── Event ticks ───────────
  const eventTicks: Record<string, EventTick[]> = {};
  const eventLastLine: Record<string, string> = {};
  for (const t of EVENT_TRACKS) {
    eventTicks[t.key] = [];
    eventLastLine[t.key] = '';
  }
  for (const rec of sorted) {
    if (!(rec.kind in eventTicks)) continue;
    const ts = parseTs(rec);
    const text = previewText(rec);
    eventTicks[rec.kind]!.push({ ts, text, rec });
    // Last-line is the most recent text whose `ts <= playhead`.
    if (text && ts <= ph) eventLastLine[rec.kind] = text;
  }

  // ─────────── Voice spans ───────────
  // Walk all `cartesia.<who>-text-sent` events and bucket by [startMs, endMs)
  // for each closed span — used to fill in span text when the boundary
  // edge='stop' didn't carry a `text` field (Cartesia's user-turn-boundary
  // stops don't, but the running text is in `cartesia.user-text-sent`).
  const textSentByKind = (kind: string): LogEvent[] =>
    sorted.filter((r) => r.kind === kind);
  const collectSpans = (
    boundaryKind: string,
    textKind: string,
  ): { spans: VoiceSpan[]; last: string } => {
    const spans: VoiceSpan[] = [];
    let last = '';
    let open: { startMs: number; rec: LogEvent } | null = null;
    for (const rec of sorted) {
      if (rec.kind !== boundaryKind) continue;
      const ts = parseTs(rec);
      const edge = (rec.data as { edge?: string }).edge;
      if (edge === 'start') {
        open = { startMs: ts, rec };
      } else if (edge === 'stop') {
        const text = (rec.data as { text?: string }).text ?? '';
        if (open) {
          spans.push({
            startMs: open.startMs,
            endMs: ts,
            text,
            open: false,
            startRec: open.rec,
          });
          open = null;
        }
        if (text) last = text;
      }
    }
    if (open) {
      spans.push({
        startMs: open.startMs,
        endMs: windowEndMs,
        text: '',
        open: true,
        startRec: open.rec,
      });
    }
    // Backfill text from cumulative `<who>-text-sent` events whose ts
    // falls within the span's [startMs, endMs] range. Uses the latest
    // such text (cumulative streams carry the running prefix).
    const textEvents = textSentByKind(textKind);
    for (const span of spans) {
      if (span.text) continue;
      let bestTs = -1;
      let bestText = '';
      for (const tr of textEvents) {
        const tts = parseTs(tr);
        if (tts < span.startMs || tts > span.endMs) continue;
        const t = (tr.data as { text?: string }).text ?? '';
        if (!t) continue;
        if (tts > bestTs) {
          bestTs = tts;
          bestText = t;
        }
      }
      if (bestText) span.text = bestText;
    }
    if (!last) {
      for (let i = spans.length - 1; i >= 0; i--) {
        if (spans[i]!.text) {
          last = spans[i]!.text;
          break;
        }
      }
    }
    return { spans, last };
  };
  // PAT: Path A doesn't have agent-turn boundaries — the agent voice is
  // a delta stream from Haiku (banter-ack / rendition / narration) on the
  // host. We pair `utterance.stream-started` with `utterance.stream-ended`
  // keyed by `data.source` so concurrent streams (e.g. narration while
  // rendition is still running) don't collide. Text comes from
  // utterance.stream-ended.data.full_text directly — no cumulative
  // backfill needed.
  const collectStreamSpans = (): { spans: VoiceSpan[]; last: string } => {
    const spans: VoiceSpan[] = [];
    let last = '';
    const open = new Map<string, { startMs: number; rec: LogEvent }>();
    for (const rec of sorted) {
      const d = rec.data as { source?: string; full_text?: string; partial_text?: string };
      const source = d.source ?? 'unknown';
      const ts = parseTs(rec);
      if (rec.kind === 'utterance.stream-started') {
        open.set(source, { startMs: ts, rec });
      } else if (rec.kind === 'utterance.stream-ended') {
        const o = open.get(source);
        const text = d.full_text ?? '';
        spans.push({
          startMs: o?.startMs ?? ts,
          endMs: ts,
          text,
          open: false,
          startRec: o?.rec ?? rec,
        });
        open.delete(source);
        if (text) last = text;
      } else if (rec.kind === 'utterance.stream-cancelled') {
        const o = open.get(source);
        const text = d.partial_text ?? '';
        spans.push({
          startMs: o?.startMs ?? ts,
          endMs: ts,
          text,
          open: false,
          startRec: o?.rec ?? rec,
        });
        open.delete(source);
      }
    }
    for (const [, o] of open) {
      spans.push({
        startMs: o.startMs,
        endMs: windowEndMs,
        text: '',
        open: true,
        startRec: o.rec,
      });
    }
    spans.sort((a, b) => a.startMs - b.startMs);
    return { spans, last };
  };
  const agent = collectStreamSpans();
  // User speech: Cartesia channels emit `cartesia.user-turn-boundary` +
  // `cartesia.user-text-sent`; anam-web delivers a finalized transcript as
  // a single `inbound.received` point event (no STT streaming, no VAD edges
  // surfaced upstream). Synthesize a fixed-width span ending at the
  // received-ts so the row renders something on anam-web threads.
  const SYNTH_USER_SPAN_MS = 600;
  const collectInboundUserSpans = (): { spans: VoiceSpan[]; last: string } => {
    const spans: VoiceSpan[] = [];
    let last = '';
    for (const rec of sorted) {
      if (rec.kind !== 'inbound.received') continue;
      const d = rec.data as { text?: string; sender?: string };
      if (d.sender !== 'realtime-user') continue;
      const text = d.text ?? '';
      const ts = parseTs(rec);
      spans.push({
        startMs: ts - SYNTH_USER_SPAN_MS,
        endMs: ts,
        text,
        open: false,
        startRec: rec,
      });
      if (text) last = text;
    }
    return { spans, last };
  };
  const userCartesia = collectSpans('cartesia.user-turn-boundary', 'cartesia.user-text-sent');
  const userInbound = collectInboundUserSpans();
  const user = {
    spans: [...userCartesia.spans, ...userInbound.spans].sort((a, b) => a.startMs - b.startMs),
    last: userInbound.last || userCartesia.last,
  };

  // Voice "last line" supplements:
  //   • User: cartesia.user-turn-boundary edge='stop' has no text — STT
  //     transcript only arrives via `cartesia.user-text-sent`.
  //   • Agent: Path A — full_text rides utterance.stream-ended. For an
  //     in-progress stream we backfill from utterance.stream-delta whose
  //     `text_delta` is incremental (concatenate by source).
  // Last-line for voice — most recent text whose ts <= playhead.
  let lastUserText = '';
  let lastAgentText = '';
  const inflightAgentBySource = new Map<string, string>();
  for (const rec of sorted) {
    const ts = parseTs(rec);
    if (ts > ph) break;
    const d = rec.data as { text?: string; text_delta?: string; full_text?: string; source?: string };
    const senderField = (rec.data as { sender?: string }).sender;
    if (rec.kind === 'cartesia.user-text-sent' && typeof d.text === 'string') {
      lastUserText = d.text;
    } else if (
      rec.kind === 'inbound.received' &&
      senderField === 'realtime-user' &&
      typeof d.text === 'string'
    ) {
      lastUserText = d.text;
    } else if (rec.kind === 'utterance.stream-started' && typeof d.source === 'string') {
      inflightAgentBySource.set(d.source, '');
    } else if (rec.kind === 'utterance.stream-delta' && typeof d.text_delta === 'string') {
      const src = d.source ?? 'unknown';
      const cur = inflightAgentBySource.get(src) ?? '';
      const next = cur + d.text_delta;
      inflightAgentBySource.set(src, next);
      lastAgentText = next;
    } else if (rec.kind === 'utterance.stream-ended' && typeof d.full_text === 'string' && d.full_text) {
      const src = d.source ?? 'unknown';
      lastAgentText = d.full_text;
      inflightAgentBySource.delete(src);
    }
  }

  // ─────────── Tool spans (back-mind detail rows) ───────────
  // detail.row-received with type='tool-pre'/'tool-post'/'tool-failed'.
  // Pair pre↔post by `tool_use_id`. Group spans by tool name so the
  // dashboard can show one row per tool.
  const toolSpans: Record<string, ToolSpan[]> = {};
  const toolNames: string[] = [];
  // Map tool_use_id → in-progress tool span (open) so we can close
  // it when the matching post arrives.
  const openTools = new Map<string, ToolSpan>();
  for (const rec of sorted) {
    if (rec.kind !== 'detail.row-received') continue;
    const ts = parseTs(rec);
    const d = rec.data as { type?: string; tool?: string; tool_use_id?: string };
    if (d.type === 'tool-pre' && d.tool && d.tool_use_id) {
      const span: ToolSpan = {
        tool: d.tool,
        startMs: ts,
        endMs: windowEndMs,
        open: true,
        failed: false,
        id: d.tool_use_id,
        preRec: rec,
      };
      openTools.set(d.tool_use_id, span);
      if (!toolSpans[d.tool]) {
        toolSpans[d.tool] = [];
        toolNames.push(d.tool);
      }
      toolSpans[d.tool]!.push(span);
    } else if ((d.type === 'tool-post' || d.type === 'tool-failed') && d.tool_use_id) {
      const span = openTools.get(d.tool_use_id);
      if (span) {
        span.endMs = ts;
        span.open = false;
        span.failed = d.type === 'tool-failed';
        openTools.delete(d.tool_use_id);
      }
    }
  }

  // ─────────── Timeline action spans (front-mind sequencer) ───────────
  // Pair timeline.action-enqueued ↔ timeline.action-completed/-cancelled
  // by `${timeline_id}:${seq}`. Build one span per pair, bucket by
  // semantic category for the swimlane render.
  const timelineActionSpans: Record<TimelineCategory, TimelineActionSpan[]> = {
    slide: [],
    fragment: [],
    say: [],
    tool: [],
    pause: [],
    wait: [],
    qa: [],
    other: [],
  };
  const openActions = new Map<string, TimelineActionSpan>();
  // Pre-pass: if a closer arrives BEFORE its enqueue in the sorted list
  // (clock skew, log-buffer ordering) we still want the bar to exist.
  // Two-phase approach: first collect enqueues; second pass resolves closers.
  for (const rec of sorted) {
    if (rec.kind !== 'timeline.action-enqueued') continue;
    const ts = parseTs(rec);
    const d = rec.data as {
      timeline_id?: string;
      seq?: number;
      kind?: string;
      // PAT (timeline-core 03ae995): per-action salient fields stamped
      // by `defaultAttrsForAction()` in realtime/src/timeline/events.ts.
      attrs?: Record<string, string | number | boolean>;
    };
    if (!d.timeline_id || typeof d.seq !== 'number' || !d.kind) continue;
    const id = `${d.timeline_id}:${d.seq}`;
    if (openActions.has(id)) continue; // dedupe — duplicate enqueue is host bug
    const category = actionCategory(d.kind);
    const span: TimelineActionSpan = {
      id,
      timelineId: d.timeline_id,
      seq: d.seq,
      kind: d.kind,
      category,
      // Provisional startMs = enqueue ts. Overwritten on the next pass
      // when `timeline.action-started` arrives (the actual dispatch
      // start). Pre-Phase-7.5 traces with no `action-started` events
      // fall back to this value and behave as before.
      startMs: ts,
      enqueueMs: ts,
      endMs: windowEndMs,
      open: true,
      cancelled: false,
      attrs: d.attrs,
      // Authored say text — `attrs.text` carries the line as written
      // before banter-dispatch's rewrite. We prime `sayText` with this
      // so the bar reads meaningfully even before (or instead of) the
      // dispatch's output. Cross-ref pass below overwrites with the
      // dispatch's rewrite when one shows up.
      sayText: typeof d.attrs?.text === 'string' ? d.attrs.text : undefined,
      startRec: rec,
    };
    openActions.set(id, span);
    timelineActionSpans[category].push(span);
  }
  for (const rec of sorted) {
    const ts = parseTs(rec);
    if (rec.kind === 'timeline.action-started') {
      // PAT: bar left edge moves from enqueue ts to dispatch-start ts.
      // For actions that sat in queue waiting on a prior action's
      // completion (most often a terminator behind a long say), this
      // collapses the bar to the actual playback window.
      const d = rec.data as { timeline_id?: string; seq?: number };
      if (!d.timeline_id || typeof d.seq !== 'number') continue;
      const span = openActions.get(`${d.timeline_id}:${d.seq}`);
      if (span) span.startMs = ts;
      continue;
    }
    if (rec.kind === 'timeline.action-completed') {
      const d = rec.data as { timeline_id?: string; seq?: number };
      if (!d.timeline_id || typeof d.seq !== 'number') continue;
      const span = openActions.get(`${d.timeline_id}:${d.seq}`);
      if (span) {
        span.endMs = ts;
        span.open = false;
        openActions.delete(span.id);
      }
    } else if (rec.kind === 'timeline.action-cancelled') {
      const d = rec.data as {
        timeline_id?: string;
        seq?: number;
        kind?: string;
        reason?: string;
        partial?: string;
      };
      if (!d.timeline_id || typeof d.seq !== 'number') continue;
      const id = `${d.timeline_id}:${d.seq}`;
      let span = openActions.get(id);
      if (!span && d.kind) {
        // Cancelled with no observed enqueue (e.g. queue-drop on a
        // queued-but-not-yet-played action, OR the enqueue rolled out
        // of the buffer). Synthesize a zero-width bar at the cancel ts
        // so the cascade still shows the cancellation.
        const category = actionCategory(d.kind);
        span = {
          id,
          timelineId: d.timeline_id,
          seq: d.seq,
          kind: d.kind,
          category,
          startMs: ts,
          enqueueMs: ts,
          endMs: ts,
          open: false,
          cancelled: true,
          startRec: rec,
        };
        timelineActionSpans[category].push(span);
      }
      if (span) {
        span.endMs = ts;
        span.open = false;
        span.cancelled = true;
        if (typeof d.reason === 'string') span.cancelReason = d.reason;
        if (typeof d.partial === 'string') span.partialText = d.partial;
        openActions.delete(id);
      }
    }
  }
  // Stable ordering within each category by startMs (sorted already
  // delivered enqueues in order, but a synth-on-cancel could land out
  // of place).
  for (const cat of TIMELINE_CATEGORY_ORDER) {
    timelineActionSpans[cat].sort((a, b) => a.startMs - b.startMs);
  }

  // Best-effort: cross-reference banter-dispatch.called events to
  // recover the spoken text for each completed `say` span. The log
  // payload for action-completed doesn't carry text, but
  // banter-dispatch fires once per say during its playback window
  // (Phase 3 contract). Walk the dispatch events and attach each one
  // to the say span whose [startMs, endMs] interval contains its ts.
  // If multiple dispatch events fall in one span (shouldn't happen,
  // but be defensive), latest wins.
  const saySpans = timelineActionSpans.say;
  if (saySpans.length > 0) {
    for (const rec of sorted) {
      if (rec.kind !== 'banter-dispatch.called') continue;
      const ts = parseTs(rec);
      const d = rec.data as { output_text?: string; input_text?: string };
      const text = d.output_text || d.input_text || '';
      if (!text) continue;
      // Linear scan — say spans are typically <30 per call so the
      // O(N*M) cost is negligible vs the indexing complexity of a
      // sorted-window scan.
      for (const span of saySpans) {
        if (ts >= span.startMs && ts <= span.endMs) {
          span.sayText = text;
          break;
        }
      }
    }
  }

  const timelineCategories = TIMELINE_CATEGORY_ORDER.filter(
    (c) => timelineActionSpans[c].length > 0,
  );

  return {
    varIntervals,
    varCurrent,
    eventTicks,
    eventLastLine,
    voiceAgentSpans: agent.spans,
    voiceUserSpans: user.spans,
    voiceAgentLast: lastAgentText,
    voiceUserLast: lastUserText,
    toolSpans,
    toolNames,
    timelineActionSpans,
    timelineCategories,
    windowStartMs,
    windowEndMs,
    fullStartMs,
    fullEndMs,
  };
}

// ─────────────────────── Helpers ────────────────────────────

function timeToFrac(ms: number, startMs: number, endMs: number): number {
  if (endMs <= startMs) return 1;
  return Math.min(1, Math.max(0, (ms - startMs) / (endMs - startMs)));
}

interface RowProps {
  label: string;
  children: React.ReactNode;
  rightSlot?: React.ReactNode;
  height?: number;
  lastLineW: number;
}

function TrackRow({ label, children, rightSlot, height = TRACK_H, lastLineW }: RowProps) {
  return (
    <div className="flex items-center" style={{ height }}>
      <div
        className="text-[12px] font-mono uppercase tracking-[0.04em] text-[var(--color-ink-4)] pr-3 text-right truncate"
        style={{ width: LABEL_W }}
      >
        {label}
      </div>
      <div className="relative flex-1 h-full">
        <div
          aria-hidden
          className="absolute inset-x-0 top-1/2 h-px bg-[var(--color-border-subtle)]"
        />
        {children}
      </div>
      <div
        className="text-[13px] truncate text-[var(--color-ink-3)] pl-3"
        style={{ width: lastLineW }}
      >
        {rightSlot}
      </div>
    </div>
  );
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div
      className="text-[12px] font-semibold uppercase tracking-[0.22em] text-[var(--color-ink-2)]"
      style={{ paddingLeft: 4, paddingTop: SECTION_PAD, paddingBottom: 6 }}
    >
      {label}
    </div>
  );
}

// ─────────────────────── Main component ──────────────────────────────

export function Timeline({ buffer, thread, windowMs = DEFAULT_WINDOW_MS }: TimelineProps) {
  const details = useEventDetails();
  // Playhead — a wall-clock ms value clamped into the visible window. null
  // means "follow now" (live tail). Reset whenever the thread changes so
  // we don't carry a scrub from one call into another.
  const [playheadMs, setPlayheadMs] = useState<number | null>(null);
  useEffect(() => {
    setPlayheadMs(null);
  }, [thread]);

  // Premiere-style viewport: [startFrac, endFrac] of the full thread
  // extent. [0, 1] = fit-all. The minimap below the plot lets the user
  // drag handles to resize / drag the middle to pan. Reset on thread
  // change so a zoom from one call doesn't carry into another.
  const [viewportFrac, setViewportFrac] = useState<[number, number]>([0, 1]);
  useEffect(() => {
    setViewportFrac([0, 1]);
  }, [thread]);

  // Resizable last-line column. Persisted to localStorage.
  const [storedLastLineW, setLastLineW] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem('pat:timelineLastLineW'));
      if (Number.isFinite(v) && v >= LASTLINE_W_MIN && v <= LASTLINE_W_MAX) return v;
    } catch {
      /* noop */
    }
    return LASTLINE_W_DEFAULT;
  });
  useEffect(() => {
    try {
      localStorage.setItem('pat:timelineLastLineW', String(storedLastLineW));
    } catch {
      /* noop */
    }
  }, [storedLastLineW]);

  // PAT: observe container width so the last-line column shrinks (or
  // disappears) when the dashboard pane is narrow. Default behavior
  // gave the last-line column a fixed 320px and ate the timeline plot
  // when the dashboard rendered alongside the deck pane (~450px wide),
  // collapsing the plot to single-pixel width. Timeline plot wins over
  // last-line text — we need a minimum 240px of plot.
  const MIN_PLOT_W = 240;
  const [containerW, setContainerW] = useState<number>(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setContainerW(e.contentRect.width);
    });
    ro.observe(el);
    setContainerW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  // Effective last-line width: clamp to leave at least MIN_PLOT_W for
  // the timeline plot. If there's not enough room for both MIN_PLOT_W
  // and LASTLINE_W_MIN, drop the last-line column entirely (set to 0).
  const lastLineW = (() => {
    if (containerW <= 0) return storedLastLineW;
    const budget = containerW - LABEL_W - NOW_GUTTER - MIN_PLOT_W;
    if (budget < LASTLINE_W_MIN) return 0;
    return Math.min(storedLastLineW, budget);
  })();

  // PERF: between-event "alive" feel without re-layout thrash.
  //
  // History: a 60Hz RAF tick caused React to patch style="left:X%" on
  // every absolute-positioned span every frame, plus full reflow of the
  // timeline subtree, which compounded badly when cartesia.agent-text-sent
  // streamed 10-30 cumulative events per turn.
  //
  // Compromise: drive a 4Hz tick (250ms). Same diff, fewer of them.
  // The window only advances when *something* changes — between events
  // the right edge keeps moving, but only ~4× per second. This is fast
  // enough that the timeline feels alive between calls, slow enough to
  // not thrash layout during a live cartesia text stream.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  const data = useMemo(
    () => buildTrackData(buffer, thread, windowMs, playheadMs, nowTick, viewportFrac),
    [buffer, thread, windowMs, playheadMs, nowTick, viewportFrac],
  );

  // ─────────── Loaded wav (Phase 3) ───────────
  const [loadedWav, setLoadedWav] = useState<LoadedWav | null>(null);
  const [wavError, setWavError] = useState<string | null>(null);
  // Reset on thread change — old wav doesn't apply to a different call.
  useEffect(() => {
    setLoadedWav(null);
    setWavError(null);
  }, [thread]);

  const handleWavFile = useCallback(async (file: File) => {
    setWavError(null);
    try {
      const arrayBuf = await file.arrayBuffer();
      // AudioContext is fine to throwaway — we only need decodeAudioData.
      const Ctor =
        (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
          .AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) {
        setWavError('AudioContext not available in this browser');
        return;
      }
      const ctx = new Ctor();
      const audioBuffer = await ctx.decodeAudioData(arrayBuf.slice(0));
      void ctx.close?.();
      setLoadedWav({
        audioBuffer,
        peaks: [],
        peaksWidth: 0,
        fileName: file.name,
      });
    } catch (err) {
      setWavError(`failed to decode wav: ${(err as Error).message}`);
    }
  }, []);

  // Mouse drag/click on the plot area moves the playhead. We capture
  // pointer events on a transparent overlay and translate x → ms.
  const plotRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const xToTime = useCallback(
    (clientX: number): number => {
      const el = plotRef.current;
      if (!el) return data.windowEndMs;
      const r = el.getBoundingClientRect();
      const plotLeft = r.left + LABEL_W;
      const plotRight = r.right - lastLineW - NOW_GUTTER;
      const f = Math.max(0, Math.min(1, (clientX - plotLeft) / (plotRight - plotLeft)));
      return data.windowStartMs + f * (data.windowEndMs - data.windowStartMs);
    },
    [data.windowStartMs, data.windowEndMs, lastLineW],
  );

  // Snap-to-live threshold: if the playhead lands within this fraction
  // of the right edge, treat it as live ("follow now"). DAW pattern.
  const SNAP_TO_LIVE_FRAC = 0.02; // 2% of window — generous enough for fat fingers
  const maybeSnap = useCallback(
    (ms: number): number | null => {
      const f = timeToFrac(ms, data.windowStartMs, data.windowEndMs);
      return f >= 1 - SNAP_TO_LIVE_FRAC ? null : ms;
    },
    [data.windowStartMs, data.windowEndMs],
  );

  /** True if the pointerdown originated from a click on an interactive
   *  element (a span/tick/row button). We don't want to start scrubbing
   *  in that case — the click should reach the button instead. */
  const isInteractiveTarget = (el: EventTarget | null): boolean => {
    if (!(el instanceof Element)) return false;
    return el.closest('button, [role="button"], a, input, [data-no-scrub]') !== null;
  };
  const onScrubStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (isInteractiveTarget(e.target)) return;
      // Only main-button drags scrub. Right-clicks etc. are ignored.
      if (e.button !== 0) return;
      draggingRef.current = true;
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      setPlayheadMs(maybeSnap(xToTime(e.clientX)));
    },
    [xToTime, maybeSnap],
  );
  const onScrubMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      setPlayheadMs(maybeSnap(xToTime(e.clientX)));
    },
    [xToTime, maybeSnap],
  );
  const onScrubEnd = useCallback(() => {
    draggingRef.current = false;
  }, []);

  const fracOf = (ms: number) => timeToFrac(ms, data.windowStartMs, data.windowEndMs);
  const playhead = playheadMs ?? data.windowEndMs;
  const followingLatest = playheadMs === null;

  // Debug surface, parallel to window.__pat in App.tsx. Must be declared
  // BEFORE any early return so hook order is stable across renders.
  useEffect(() => {
    setDebugSurface('patTimeline', {
      thread,
      playheadMs,
      windowStartMs: data.windowStartMs,
      windowEndMs: data.windowEndMs,
      effectivePlayhead: playhead,
      followingLatest,
      varCurrent: data.varCurrent,
      eventLastLine: data.eventLastLine,
      voiceAgentLast: data.voiceAgentLast,
      voiceUserLast: data.voiceUserLast,
    });
  });

  // Splitter for the right-side last-line column. Drag this vertical
  // bar to resize the ratio between plot and last-line text.
  const splitterDraggingRef = useRef<{ startX: number; startW: number } | null>(null);
  const onSplitterDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      splitterDraggingRef.current = { startX: e.clientX, startW: lastLineW };
      (e.target as Element).setPointerCapture?.(e.pointerId);
    },
    [lastLineW],
  );
  const onSplitterMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = splitterDraggingRef.current;
    if (!drag) return;
    // Drag right ⇒ last-line shrinks (negative delta), plot grows.
    const next = drag.startW - (e.clientX - drag.startX);
    setLastLineW(Math.max(LASTLINE_W_MIN, Math.min(LASTLINE_W_MAX, next)));
  }, []);
  const onSplitterUp = useCallback(() => {
    splitterDraggingRef.current = null;
  }, []);

  if (!thread) {
    return (
      <div className="px-6 py-10 text-[12px] text-[var(--color-ink-4)]">
        Pick a thread (or wait for one) to see its timeline.
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1 flex-col px-6 pb-6">
      <div
        ref={plotRef}
        className="relative flex min-h-0 flex-1 flex-col rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-sunken)]/70 shadow-[var(--shadow-card)] py-3 overflow-y-auto cursor-ew-resize"
        onPointerDown={onScrubStart}
        onPointerMove={onScrubMove}
        onPointerUp={onScrubEnd}
        onPointerCancel={onScrubEnd}
        aria-label="Scrub playhead (drag) · click spans for details"
      >
        <NowLine lastLineW={lastLineW} live={followingLatest} playhead={playhead} />
        <PlayheadLine
          x={fracOf(playhead) * 100}
          live={followingLatest}
          lastLineW={lastLineW}
          onClickReset={() => setPlayheadMs(null)}
        />

        {/* Ruler — minute/second tick marks across the plot. Sits at the
         *  very top, in the same column geometry as track rows. */}
        <TickRuler
          windowStartMs={data.windowStartMs}
          windowEndMs={data.windowEndMs}
          lastLineW={lastLineW}
        />

        {/* Splitter — vertical bar sitting between plot and last-line
         *  column. Pointer-events on a 6px-wide handle. Suppressed
         *  when the last-line column has been auto-shrunk to 0
         *  (narrow container). */}
        {lastLineW > 0 && (
          <div
            aria-label="Resize last-line column"
            role="separator"
            className="absolute z-25 cursor-col-resize hover:bg-[var(--color-border)]/40"
            style={{
              top: 0,
              bottom: 0,
              width: 6,
              // Sit centered on the seam between plot and last-line.
              right: `calc(${lastLineW + NOW_GUTTER}px - 3px)`,
            }}
            onPointerDown={onSplitterDown}
            onPointerMove={onSplitterMove}
            onPointerUp={onSplitterUp}
            onPointerCancel={onSplitterUp}
          />
        )}

        {/* ─ vars ─ */}
        <SectionHeader label="vars" />
        {VAR_TRACKS.map((v) => (
          <TrackRow
            key={v.key}
            label={v.label}
            lastLineW={lastLineW}
            rightSlot={
              <span className="inline-flex items-center gap-2">
                <span
                  aria-label={data.varCurrent[v.key as VarKey] ? 'on' : 'off'}
                  className={
                    data.varCurrent[v.key as VarKey]
                      ? 'inline-block rounded-full bg-[var(--color-good)] shadow-[0_0_6px_var(--color-good)]'
                      : 'inline-block rounded-full bg-transparent ring-1 ring-[var(--color-border)]'
                  }
                  style={{ width: 9, height: 9 }}
                />
                <span className="text-[12px] uppercase tracking-[0.18em] text-[var(--color-ink-4)]">
                  {data.varCurrent[v.key as VarKey] ? 'on' : 'off'}
                </span>
              </span>
            }
          >
            {data.varIntervals[v.key as VarKey].map((it, i) => {
              const left = fracOf(it.startMs) * 100;
              const right = fracOf(it.endMs) * 100;
              const widthPct = Math.max(0.3, right - left);
              const dur = it.endMs - it.startMs;
              return (
                <button
                  key={`${v.key}-${i}`}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    details.open(it.startRec);
                  }}
                  className="absolute top-1/2 -translate-y-1/2 rounded-sm bg-[var(--color-good-soft)] ring-1 ring-inset ring-[oklch(0.85_0.16_150_/_0.55)] overflow-hidden text-[11px] leading-none text-[var(--color-good)] flex items-center px-1.5 cursor-pointer hover:brightness-110"
                  style={{
                    left: `${left}%`,
                    width: `${widthPct}%`,
                    height: TRACK_H * 0.85,
                    whiteSpace: 'nowrap',
                  }}
                  title={`${v.label} · ${fmtLocalMs(it.startMs)} → ${fmtLocalMs(it.endMs)} (${dur}ms) — click for details`}
                >
                  {v.label}
                </button>
              );
            })}
          </TrackRow>
        ))}

        {/* ─ events: one row per kind, ticks only ─ */}
        <SectionHeader label="events" />
        {EVENT_TRACKS.map((t) => {
          const ticks = data.eventTicks[t.key] ?? [];
          // Greyed out if no events; helps reader scan.
          const muted = ticks.length === 0;
          // PAT: the two timeline bracket lanes (started/finished) keep
          // a distinct violet tick color so the timeline boundaries
          // read at a glance. Per-action enqueue/completed/cancelled
          // events render in the dedicated swimlane section below,
          // NOT here.
          const isTimelineBracket =
            t.key === 'timeline.started' || t.key === 'timeline.finished';
          const tickColorVar = isTimelineBracket
            ? 'var(--color-kind-timeline-bracket)'
            : 'var(--color-front)';
          return (
            <TrackRow
              key={t.key}
              label={t.label}
              lastLineW={lastLineW}
              rightSlot={
                <span className={muted ? 'text-[var(--color-ink-5)]' : ''}>
                  {data.eventLastLine[t.key] || (muted ? '—' : '')}
                </span>
              }
            >
              {ticks.map((ev, i) => {
                const x = fracOf(ev.ts) * 100;
                return (
                  <button
                    key={`${t.key}-${i}`}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      details.open(ev.rec);
                    }}
                    aria-label={`${ev.rec.kind} at ${fmtLocalMs(ev.ts)} — click for details`}
                    className="absolute top-1/2 cursor-pointer p-0 m-0"
                    style={{
                      left: `${x}%`,
                      // Wide invisible hit target with a visible 2px line in the middle.
                      width: 10,
                      height: TRACK_H * 0.85,
                      transform: 'translate(-50%, -50%)',
                      background: 'transparent',
                      border: 'none',
                    }}
                    title={`${fmtLocalMs(ev.ts)}  ${ev.rec.kind}\n${ev.text}\n(click for details)`}
                  >
                    <span
                      aria-hidden
                      className="block mx-auto"
                      style={{ width: 2, height: '100%', background: tickColorVar }}
                    />
                  </button>
                );
              })}
            </TrackRow>
          );
        })}

        {/* ─ timeline action spans — per-category swimlane ─ */}
        {data.timelineCategories.length > 0 && (
          <>
            <SectionHeader label="timeline (front-mind)" />
            {data.timelineCategories.map((cat) => {
              const spans = data.timelineActionSpans[cat] ?? [];
              // Auto-hide empty lanes — most calls won't use wait / qa
              // / other; render only categories with at least one span.
              if (spans.length === 0) return null;
              const last = spans[spans.length - 1]!;
              // Right-side last-line: most-recent span's salient + status.
              const lastSalient = actionSalient(last);
              const rightSlot = (
                <span className="inline-flex items-baseline gap-2 max-w-full">
                  <span className="shrink-0 text-[var(--color-ink-4)]">
                    {last.cancelled ? '✗' : last.open ? '…' : '✓'}{' '}
                    {Math.round(last.endMs - last.startMs)}ms
                  </span>
                  <span
                    className="truncate font-mono text-[11px] text-[var(--color-ink-2)]"
                    title={`${last.kind}${lastSalient ? ` · ${lastSalient}` : ''}`}
                  >
                    {lastSalient || last.kind}
                  </span>
                </span>
              );
              return (
                <TrackRow
                  key={`tl-cat-${cat}`}
                  label={TIMELINE_CATEGORY_LABEL[cat]}
                  rightSlot={rightSlot}
                  lastLineW={lastLineW}
                >
                  {spans.map((s, i) => {
                    const left = fracOf(s.startMs) * 100;
                    const right = fracOf(s.endMs) * 100;
                    // Very short spans (sub-pixel) get a minimum visible
                    // width so the bar is still clickable. Same idiom as
                    // the tool-spans block above.
                    const widthPct = Math.max(0.25, right - left);
                    // Visual treatment by status — keep the violet
                    // family from index.css' --color-kind-timeline*:
                    //  - cancelled: dashed border + bad-color tint
                    //  - open    : dashed border, lighter tint (still in flight)
                    //  - normal  : solid violet
                    const cls = s.cancelled
                      ? 'bg-[var(--color-kind-timeline-soft)] border border-dashed border-[var(--color-bad)] text-[var(--color-bad)]'
                      : s.open
                        ? 'bg-[var(--color-kind-timeline-soft)] border border-dashed border-[var(--color-kind-timeline-bracket)] text-[var(--color-kind-timeline)]'
                        : 'bg-[var(--color-kind-timeline-soft)] ring-1 ring-inset ring-[var(--color-kind-timeline-bracket)] text-[var(--color-kind-timeline)]';
                    // Inline label: category-specific salient (direction
                    // arrow for slide/fragment, text preview for say,
                    // tool name for tool, ms for pause, etc.). For
                    // cancelled actions, prefix ✗ so the cascade reads
                    // at a glance even before the tooltip.
                    const salient = actionSalient(s);
                    const inlineLabel = s.cancelled
                      ? `✗ ${salient || s.kind}`
                      : (salient || s.kind);
                    // Tooltip: kind, status, duration, timeline_id+seq,
                    // and (for say) the full spoken text preview when
                    // available — sayText for completed says, partialText
                    // for cancelled ones. The bar inline label is short
                    // (~28 chars); the tooltip carries up to ~120.
                    const dur = s.endMs - s.startMs;
                    const status = s.cancelled
                      ? `✗ ${s.cancelReason ?? 'cancelled'}`
                      : s.open
                        ? '… in flight'
                        : '✓';
                    const fullSay = s.sayText || s.partialText || '';
                    const sayPreview =
                      s.kind === 'say' && fullSay
                        ? `\n"${clipLine(fullSay, 120)}"`
                        : '';
                    const titleStr =
                      `${s.kind} ${status} · ${dur}ms\n` +
                      `${fmtLocalMs(s.startMs)} → ${fmtLocalMs(s.endMs)}\n` +
                      `${s.timelineId} · seq ${s.seq}${sayPreview}\n` +
                      `(click for details)`;
                    return (
                      <button
                        type="button"
                        key={`tl-${cat}-${i}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          details.open(s.startRec);
                        }}
                        className={`absolute top-1/2 -translate-y-1/2 rounded-sm overflow-hidden text-[11px] leading-none flex items-center px-1.5 cursor-pointer hover:brightness-110 ${cls}`}
                        style={{
                          left: `${left}%`,
                          width: `${widthPct}%`,
                          height: TRACK_H * 0.85,
                          whiteSpace: 'nowrap',
                        }}
                        title={titleStr}
                      >
                        {inlineLabel}
                      </button>
                    );
                  })}
                </TrackRow>
              );
            })}
          </>
        )}

        {/* ─ tools — one row per tool, spans are tool-pre→tool-post ─ */}
        {data.toolNames.length > 0 && (
          <>
            <SectionHeader label="tools (back-mind)" />
            {data.toolNames.map((tool) => {
              const spans = data.toolSpans[tool] ?? [];
              const last = spans[spans.length - 1];
              // Pull the salient field from the LAST call's tool_input —
              // for the right-side last-line. Bash → command, Read →
              // file_path, WebSearch → query, etc.
              const lastInput = last
                ? ((last.preRec.data as { input?: Record<string, unknown> }).input)
                : undefined;
              const lastSalient = last ? salientToolField(tool, lastInput) : '';
              const durLabel = last
                ? `${last.failed ? '✗' : last.open ? '…' : '✓'} ${last.endMs - last.startMs}ms`
                : '';
              const rightSlot = last ? (
                <span className="inline-flex items-baseline gap-2 max-w-full">
                  <span className="shrink-0 text-[var(--color-ink-4)]">{durLabel}</span>
                  {lastSalient && (
                    <span
                      className="truncate font-mono text-[11px] text-[var(--color-ink-2)]"
                      title={lastSalient}
                    >
                      {lastSalient}
                    </span>
                  )}
                </span>
              ) : (
                <span className="text-[var(--color-ink-5)]">—</span>
              );
              return (
                <TrackRow key={`tool-${tool}`} label={tool} rightSlot={rightSlot} lastLineW={lastLineW}>
                  {spans.map((s, i) => {
                    const left = fracOf(s.startMs) * 100;
                    const right = fracOf(s.endMs) * 100;
                    const widthPct = Math.max(0.25, right - left);
                    const cls = s.failed
                      ? 'bg-[var(--color-bad)]/40 ring-1 ring-inset ring-[var(--color-bad)] text-[var(--color-bad)]'
                      : s.open
                        ? 'bg-[var(--color-warn)]/30 ring-1 ring-inset ring-[var(--color-warn)] text-[var(--color-warn)]'
                        : 'bg-[var(--color-back-soft)] ring-1 ring-inset ring-[var(--color-back-line)] text-[var(--color-back)]';
                    const input = (s.preRec.data as { input?: Record<string, unknown> }).input;
                    const salient = salientToolField(tool, input);
                    // Inline bar label: tool name plus a clamped salient
                    // string. The bar's overflow:hidden + whiteSpace:nowrap
                    // already clips, but we hard-clamp here so the modal
                    // tooltip isn't a wall of text.
                    const inlineLabel = salient
                      ? `${tool} · ${clipLine(salient, 80)}`
                      : tool;
                    return (
                      <button
                        type="button"
                        key={`${tool}-${i}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          details.open(s.preRec);
                        }}
                        className={`absolute top-1/2 -translate-y-1/2 rounded-sm overflow-hidden text-[11px] leading-none flex items-center px-1.5 cursor-pointer hover:brightness-110 ${cls}`}
                        style={{
                          left: `${left}%`,
                          width: `${widthPct}%`,
                          height: TRACK_H * 0.85,
                          whiteSpace: 'nowrap',
                        }}
                        title={
                          s.open
                            ? `${tool}${salient ? ` · ${clipLine(salient, 200)}` : ''} (in progress) — ${fmtLocalMs(s.startMs)} — click for details`
                            : `${tool}${salient ? ` · ${clipLine(salient, 200)}` : ''} ${
                                s.failed ? '✗ failed' : '✓'
                              } ${s.endMs - s.startMs}ms — ${fmtLocalMs(s.startMs)} → ${fmtLocalMs(s.endMs)} — click for details`
                        }
                      >
                        {inlineLabel}
                      </button>
                    );
                  })}
                </TrackRow>
              );
            })}
          </>
        )}

        {/* ─ voice (stereo) ─ */}
        <SectionHeader label="voice (cartesia)" />
        <VoiceStereoRow
          fracOf={fracOf}
          agentSpans={data.voiceAgentSpans}
          userSpans={data.voiceUserSpans}
          agentLast={data.voiceAgentLast}
          userLast={data.voiceUserLast}
          onSpanClick={(rec) => details.open(rec)}
          loadedWav={loadedWav}
          setLoadedWav={setLoadedWav}
          callExtent={callExtentOf(buffer, thread)}
          windowStartMs={data.windowStartMs}
          windowEndMs={data.windowEndMs}
          onDropFile={handleWavFile}
          wavError={wavError}
          lastLineW={lastLineW}
        />

        <MinimapZoom
          fullStartMs={data.fullStartMs}
          fullEndMs={data.fullEndMs}
          viewportFrac={viewportFrac}
          onChange={setViewportFrac}
          lastLineW={lastLineW}
        />

        <div style={{ height: SECTION_PAD }} />
      </div>
    </div>
  );
}

interface MinimapZoomProps {
  fullStartMs: number;
  fullEndMs: number;
  viewportFrac: [number, number];
  onChange: (next: [number, number]) => void;
  /** Match the plot column geometry so the minimap aligns under it. */
  lastLineW: number;
}

/**
 * Adobe Premiere-style dual-handle zoom + pan strip. Renders a narrow
 * track spanning the full thread extent, with a draggable viewport box
 * showing the zoomed range. Drag the middle to pan; drag either edge
 * handle to resize. Double-click to fit-all.
 */
function MinimapZoom({
  fullStartMs,
  fullEndMs,
  viewportFrac,
  onChange,
  lastLineW,
}: MinimapZoomProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    mode: 'pan' | 'left' | 'right';
    pointerId: number;
    startClientX: number;
    startVS: number;
    startVE: number;
  } | null>(null);

  const fullDur = Math.max(1, fullEndMs - fullStartMs);
  const [vs, ve] = viewportFrac;

  const xToFrac = useCallback((clientX: number): number => {
    const el = trackRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)));
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      const el = trackRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const dxFrac = (e.clientX - drag.startClientX) / Math.max(1, r.width);
      const minSpan = 0.01; // 1% of full extent — prevents collapsing to zero
      let nextVS = drag.startVS;
      let nextVE = drag.startVE;
      if (drag.mode === 'pan') {
        const span = drag.startVE - drag.startVS;
        nextVS = Math.max(0, Math.min(1 - span, drag.startVS + dxFrac));
        nextVE = nextVS + span;
      } else if (drag.mode === 'left') {
        nextVS = Math.max(0, Math.min(drag.startVE - minSpan, drag.startVS + dxFrac));
      } else {
        nextVE = Math.max(drag.startVS + minSpan, Math.min(1, drag.startVE + dxFrac));
      }
      onChange([nextVS, nextVE]);
    },
    [onChange],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      (e.currentTarget as Element).releasePointerCapture?.(drag.pointerId);
      dragRef.current = null;
    },
    [],
  );

  const startDrag = (
    e: React.PointerEvent<HTMLDivElement>,
    mode: 'pan' | 'left' | 'right',
  ) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    dragRef.current = {
      mode,
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startVS: vs,
      startVE: ve,
    };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };

  // Click on empty track outside the viewport box: jump-pan so the
  // click point becomes the new center, preserving span.
  const onTrackPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current) return;
    if (e.button !== 0) return;
    const f = xToFrac(e.clientX);
    if (f >= vs && f <= ve) return; // inside box — let the box's own handler take over
    const span = ve - vs;
    const nextVS = Math.max(0, Math.min(1 - span, f - span / 2));
    onChange([nextVS, nextVS + span]);
  };

  // Double-click anywhere on the strip resets to fit-all.
  const onDoubleClick = () => onChange([0, 1]);

  const fitAll = vs === 0 && ve === 1;
  const startMs = fullStartMs + vs * fullDur;
  const endMs = fullStartMs + ve * fullDur;
  const span = endMs - startMs;

  return (
    <div
      className="flex items-center"
      style={{ height: 28, marginTop: 8 }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div
        className="text-[10px] font-mono uppercase tracking-[0.04em] text-[var(--color-ink-4)] pr-3 text-right"
        style={{ width: LABEL_W }}
      >
        zoom
      </div>
      <div
        ref={trackRef}
        onPointerDown={onTrackPointerDown}
        onDoubleClick={onDoubleClick}
        className="relative flex-1 h-5 rounded-sm bg-[var(--color-bg-elevated)] border border-[var(--color-border-subtle)] cursor-pointer"
        title="Drag handles to zoom · drag box to pan · double-click to fit"
      >
        {/* Viewport box. PAT: middle is intentionally transparent —
            the track itself is the visual range; the box is just a
            pan handle bounded by the two coloured edge handles. A
            faint inset hairline rim keeps the box still draggable
            without flooding the chart with colour. */}
        <div
          onPointerDown={(e) => startDrag(e, 'pan')}
          className="absolute top-0 bottom-0 cursor-grab active:cursor-grabbing"
          style={{
            left: `${vs * 100}%`,
            width: `${(ve - vs) * 100}%`,
            minWidth: 6,
            background: 'transparent',
            // Hairline outline so the pan-target stays discoverable
            // even when the middle is uncolored.
            boxShadow: 'inset 0 0 0 1px var(--color-border-subtle)',
          }}
          aria-label="Zoom viewport — drag to pan"
        />
        {/* Left handle */}
        <div
          onPointerDown={(e) => startDrag(e, 'left')}
          className="absolute top-0 bottom-0 cursor-ew-resize bg-[var(--color-front)] hover:bg-[var(--color-front-line)]"
          style={{
            left: `calc(${vs * 100}% - 3px)`,
            width: 6,
            borderRadius: 2,
          }}
          aria-label="Resize zoom (start)"
        />
        {/* Right handle */}
        <div
          onPointerDown={(e) => startDrag(e, 'right')}
          className="absolute top-0 bottom-0 cursor-ew-resize bg-[var(--color-front)] hover:bg-[var(--color-front-line)]"
          style={{
            left: `calc(${ve * 100}% - 3px)`,
            width: 6,
            borderRadius: 2,
          }}
          aria-label="Resize zoom (end)"
        />
      </div>
      <div
        className="text-[11px] pl-3 leading-tight font-mono tabular-nums text-[var(--color-ink-3)]"
        style={{ width: lastLineW }}
      >
        <div>
          {fitAll ? (
            <span className="text-[var(--color-ink-5)]">fit · {(fullDur / 1000).toFixed(1)}s</span>
          ) : (
            <>
              <span>{(span / 1000).toFixed(1)}s</span>
              <span className="text-[var(--color-ink-5)]">
                {' '}
                · {(vs * 100).toFixed(0)}–{(ve * 100).toFixed(0)}%
              </span>
            </>
          )}
        </div>
        {!fitAll && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onChange([0, 1]);
            }}
            className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-ink-4)] hover:text-[var(--color-ink-2)]"
          >
            fit all
          </button>
        )}
      </div>
    </div>
  );
}

interface NowLineProps {
  lastLineW: number;
  live: boolean;
  playhead: number;
}

function NowLine({ lastLineW, live, playhead }: NowLineProps) {
  // PAT: Right-justify the NOW line. Previously it was anchored to the
  // right edge of the plot column (just left of the last-line text
  // column), which left a wide gap of empty space to the right of the
  // line. The line now sits a small gutter inside the container's
  // right edge — the latest-event text strips render to the right of
  // the plot but UNDER this overlay, so the visual "right edge of
  // time" matches the actual right edge of the chart. The line
  // crosses the last-line column as a thin overlay; the text labels
  // remain readable because they're z=10 below the now-overlay.
  //
  // PAT: bind the line to the END of the plot column (= where var
  // bars stop) rather than to the wrapper's far-right edge. Earlier
  // it sat 6px in from the absolute right, which was past the last-
  // line column and well past where processing / tts-busy / container
  // bars actually terminate. `right: lastLineW` aligns the line with
  // the boundary between the plot and the last-line text column —
  // exactly where the var-track lines visibly end.
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute z-20"
      style={{
        right: lastLineW,
        top: 0,
        bottom: 0,
        width: 1,
        background: 'var(--color-front-line)',
      }}
    >
      <div className="absolute right-2 top-1 text-[11px] uppercase tracking-[0.22em] text-[var(--color-front)] flex flex-col items-end leading-none">
        <span>now</span>
        {live && (
          <span className="text-[var(--color-ink-2)] tracking-[0.06em] tabular-nums normal-case mt-1 text-[12px] font-mono">
            {fmtLocalSec(playhead)}
          </span>
        )}
      </div>
    </div>
  );
}

interface PlayheadLineProps {
  /** 0..100 — fraction of plot width. */
  x: number;
  /** When true, playhead == now — render in the front-line color. When
   *  false, the user has scrubbed back; render in warn color so it's
   *  obvious the displayed state isn't current. */
  live: boolean;
  lastLineW: number;
  /** Click on the scrub handle to snap back to live. Replaces the old
   *  "follow now" button that used to sit above the timeline. */
  onClickReset: () => void;
}

function PlayheadLine({ x, live, lastLineW, onClickReset }: PlayheadLineProps) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute z-30"
      style={{
        left: `calc(${LABEL_W}px + (100% - ${LABEL_W + lastLineW + NOW_GUTTER}px) * ${x / 100})`,
        top: 0,
        bottom: 0,
        width: 1,
        background: live ? 'transparent' : 'var(--color-warn)',
      }}
    >
      {!live && (
        <>
          {/* Triangle handle at the top — click to snap back to live. */}
          <button
            type="button"
            aria-label="Snap playhead back to live"
            onClick={onClickReset}
            className="absolute -left-[5px] top-0 h-0 w-0 pointer-events-auto"
            style={{
              borderLeft: '5px solid transparent',
              borderRight: '5px solid transparent',
              borderTop: '6px solid var(--color-warn)',
              padding: 0,
              background: 'transparent',
            }}
          />
        </>
      )}
    </div>
  );
}

interface TickRulerProps {
  windowStartMs: number;
  windowEndMs: number;
  lastLineW: number;
}

/** Horizontal tick ruler — minute lines tall, second lines short.
 *  Density auto-adapts to the visible window so the ruler doesn't get
 *  cluttered when the window grows past a few minutes. Sits at the very
 *  top of the plot, in the same column geometry as track rows. */
function TickRuler({ windowStartMs, windowEndMs, lastLineW }: TickRulerProps) {
  const span = Math.max(1, windowEndMs - windowStartMs);
  const fracOf = (ms: number) => Math.min(1, Math.max(0, (ms - windowStartMs) / span));

  // Pick the second-tick step based on visible span.
  // < 30s → every 1s · < 2m → every 5s · < 10m → every 15s · else 60s only
  let secondStep: number;
  if (span < 30_000) secondStep = 1_000;
  else if (span < 120_000) secondStep = 5_000;
  else if (span < 600_000) secondStep = 15_000;
  else secondStep = 60_000;

  const minorTicks: number[] = [];
  const majorTicks: number[] = [];
  // Minor ticks (seconds-grade)
  const firstSec = Math.ceil(windowStartMs / secondStep) * secondStep;
  for (let t = firstSec; t <= windowEndMs; t += secondStep) {
    if (t % 60_000 === 0) continue; // major handles those
    minorTicks.push(t);
  }
  // Major ticks (minutes)
  const firstMin = Math.ceil(windowStartMs / 60_000) * 60_000;
  for (let t = firstMin; t <= windowEndMs; t += 60_000) majorTicks.push(t);

  return (
    <div
      aria-hidden
      className="relative"
      style={{ height: RULER_H, marginLeft: LABEL_W, marginRight: lastLineW + NOW_GUTTER }}
    >
      {/* Top rail — ticks descend from this line. */}
      <div
        className="absolute inset-x-0"
        style={{ top: 4, height: 1, background: 'var(--color-border)' }}
      />
      {minorTicks.map((t) => {
        const x = fracOf(t) * 100;
        return (
          <div
            key={`m-${t}`}
            className="absolute"
            style={{
              left: `${x}%`,
              top: 4,
              width: 1,
              height: 5,
              background: 'var(--color-border)',
              transform: 'translateX(-0.5px)',
            }}
          />
        );
      })}
      {majorTicks.map((t) => {
        const x = fracOf(t) * 100;
        return (
          <div
            key={`M-${t}`}
            className="absolute"
            style={{
              left: `${x}%`,
              top: 4,
              width: 1,
              height: 11,
              background: 'var(--color-ink-4)',
              transform: 'translateX(-0.5px)',
            }}
          />
        );
      })}
    </div>
  );
}

interface VoiceStereoRowProps {
  fracOf: (ms: number) => number;
  agentSpans: VoiceSpan[];
  userSpans: VoiceSpan[];
  agentLast: string;
  userLast: string;
  /** Click handler — receives the span's originating event (turn-boundary
   *  edge='start') so a modal can show all details. */
  onSpanClick: (rec: LogEvent) => void;
  /** Phase 3: dropped wav (or null if none loaded). */
  loadedWav: LoadedWav | null;
  setLoadedWav: (next: LoadedWav | null) => void;
  /** Voice-event extent for the displayed thread, used to position
   *  the waveform across the timeline. Null when no voice events. */
  callExtent: CallExtent | null;
  /** Window bounds — needed to compute pixel coords for the canvas. */
  windowStartMs: number;
  windowEndMs: number;
  /** File handler — wires AudioContext.decodeAudioData. */
  onDropFile: (file: File) => Promise<void>;
  /** Last decode error, if any. */
  wavError: string | null;
  lastLineW: number;
}

/**
 * Single tall row, "stereo" layout: agent spans above the centerline (in the
 * front-mind colorway), user spans below (in a contrasting back-mind tone).
 * Overlapping spans = barge-in / talk-over visible at a glance.
 *
 * If a wav file has been dropped (Phase 3), an additional canvas
 * underneath shows the actual mixed waveform from the recorded call,
 * stretched across the call's voice-event extent.
 */
function VoiceStereoRow({
  fracOf,
  agentSpans,
  userSpans,
  agentLast,
  userLast,
  onSpanClick,
  loadedWav,
  setLoadedWav,
  callExtent,
  windowStartMs,
  windowEndMs,
  onDropFile,
  wavError,
  lastLineW,
}: VoiceStereoRowProps) {
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <div
      className="flex items-center"
      style={{ height: VOICE_H }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragActive(true);
      }}
      onDragLeave={() => setDragActive(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragActive(false);
        const f = e.dataTransfer.files[0];
        if (f) void onDropFile(f);
      }}
    >
      <div
        className="text-[12px] font-mono uppercase tracking-[0.04em] text-[var(--color-ink-4)] pr-3 text-right flex flex-col justify-between py-1"
        style={{ width: LABEL_W, height: VOICE_H }}
      >
        <div>agent ▴</div>
        <div>user ▾</div>
      </div>
      <div className="relative flex-1 h-full">
        {/* Centerline */}
        <div
          aria-hidden
          className="absolute inset-x-0 top-1/2 h-px bg-[var(--color-border)]"
        />

        {/* Phase 3: waveform canvas, time-aligned to callExtent. Sits
         *  BEHIND the spans so they remain readable. */}
        {loadedWav && callExtent && (
          <WaveformCanvas
            audioBuffer={loadedWav.audioBuffer}
            startFrac={fracOf(callExtent.startMs)}
            endFrac={fracOf(callExtent.endMs)}
          />
        )}

        {/* Drag-active overlay — shows when a file is being dragged
         *  over the row. Empty otherwise (no permanent UI clutter). */}
        {dragActive && (
          <div
            aria-hidden
            className="absolute inset-0 z-30 flex items-center justify-center text-[11px] uppercase tracking-[0.18em] text-[var(--color-front)] bg-[var(--color-front-soft)]/40 ring-2 ring-inset ring-[var(--color-front-line)] rounded-sm"
          >
            drop call.wav to overlay waveform
          </div>
        )}
        {/* Agent spans — top half. Each span has a 2px right-margin
         *  via shrinking the rendered width by a small offset so two
         *  back-to-back utterances always show a visible seam (caller
         *  reported them blending into one long bar). The first few
         *  characters of the spoken text render inside the bar with
         *  overflow:hidden so text never escapes the bar boundary. */}
        {agentSpans.map((s, i) => {
          const left = fracOf(s.startMs) * 100;
          const right = fracOf(s.endMs) * 100;
          const widthPct = Math.max(0.3, right - left - 0.15); // -0.15% gap
          return (
            <button
              type="button"
              key={`a-${i}`}
              onClick={(e) => {
                e.stopPropagation();
                onSpanClick(s.startRec);
              }}
              className="absolute rounded-sm bg-[var(--color-front-soft)] ring-1 ring-inset ring-[var(--color-front-line)] overflow-hidden text-[12px] leading-none text-[var(--color-front)] flex items-center px-1 cursor-pointer hover:brightness-110"
              style={{
                left: `${left}%`,
                width: `${widthPct}%`,
                top: '12%',
                height: '36%',
                opacity: s.open ? 0.55 : 1,
                whiteSpace: 'nowrap',
              }}
              title={
                s.open
                  ? `${fmtLocalMs(s.startMs)} — (still speaking) — click for details`
                  : `${fmtLocalMs(s.startMs)} → ${fmtLocalMs(s.endMs)}\n${s.text}\n— click for details`
              }
            >
              {s.text || (s.open ? '…' : '')}
            </button>
          );
        })}
        {/* User spans — bottom half */}
        {userSpans.map((s, i) => {
          const left = fracOf(s.startMs) * 100;
          const right = fracOf(s.endMs) * 100;
          const widthPct = Math.max(0.3, right - left - 0.15);
          return (
            <button
              type="button"
              key={`u-${i}`}
              onClick={(e) => {
                e.stopPropagation();
                onSpanClick(s.startRec);
              }}
              className="absolute rounded-sm bg-[var(--color-back-soft)] ring-1 ring-inset ring-[var(--color-back-line)] overflow-hidden text-[12px] leading-none text-[var(--color-back)] flex items-center px-1 cursor-pointer hover:brightness-110"
              style={{
                left: `${left}%`,
                width: `${widthPct}%`,
                top: '52%',
                height: '36%',
                opacity: s.open ? 0.55 : 1,
                whiteSpace: 'nowrap',
              }}
              title={
                s.open
                  ? `${fmtLocalMs(s.startMs)} — (still speaking) — click for details`
                  : `${fmtLocalMs(s.startMs)} → ${fmtLocalMs(s.endMs)}\n${s.text}\n— click for details`
              }
            >
              {s.text || (s.open ? '…' : '')}
            </button>
          );
        })}
      </div>
      <div
        className="text-[13px] pl-3 leading-tight"
        style={{ width: lastLineW }}
      >
        <div className="truncate text-[var(--color-front)]" title={agentLast}>
          {agentLast || '—'}
        </div>
        <div className="opacity-50 text-[11px] leading-none">··</div>
        <div className="truncate text-[var(--color-back)]" title={userLast}>
          {userLast || '—'}
        </div>
        {/* Wav row: file picker + status + clear. Drop on the plot
         *  works too, but a button is friendlier on touch. */}
        <div className="mt-1 flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-[var(--color-ink-4)]">
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/wav,.wav"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onDropFile(f);
              e.target.value = '';
            }}
          />
          {!loadedWav && (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="hover:text-[var(--color-ink-2)] underline-offset-2 hover:underline"
              title="Or drag the .wav file onto the voice track"
            >
              + load .wav
            </button>
          )}
          {loadedWav && (
            <>
              <span
                className="truncate text-[var(--color-front)]"
                title={loadedWav.fileName}
                style={{ maxWidth: 140 }}
              >
                wav: {loadedWav.fileName}
              </span>
              <button
                type="button"
                onClick={() => setLoadedWav(null)}
                className="hover:text-[var(--color-warn)] underline-offset-2 hover:underline"
              >
                clear
              </button>
            </>
          )}
          {wavError && (
            <span className="text-[var(--color-bad)] truncate" title={wavError}>
              ✗ {wavError}
            </span>
          )}
          {windowEndMs && windowStartMs && callExtent && loadedWav && (
            <span className="text-[var(--color-ink-5)]" title="wav duration vs call extent">
              {(loadedWav.audioBuffer.duration).toFixed(1)}s /{' '}
              {((callExtent.endMs - callExtent.startMs) / 1000).toFixed(1)}s
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

interface WaveformCanvasProps {
  audioBuffer: AudioBuffer;
  /** Fraction of the timeline plot at which the wav starts. */
  startFrac: number;
  /** Fraction of the timeline plot at which the wav ends. */
  endFrac: number;
}

/**
 * Canvas-rendered peak waveform. Sits inside the voice row's plot
 * column, positioned absolute from `startFrac` to `endFrac`. We
 * recompute peaks whenever the canvas pixel-width changes (due to
 * window resize or extent change).
 */
function WaveformCanvas({ audioBuffer, startFrac, endFrac }: WaveformCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Render whenever the buffer or layout fraction changes. We measure
  // the actual pixel width of the canvas DOM element here.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;
    if (cssWidth <= 0 || cssHeight <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(cssWidth * dpr);
    canvas.height = Math.floor(cssHeight * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const peaks = computeWaveformPeaks(audioBuffer, cssWidth);
    const mid = cssHeight / 2;
    // Subtle slate fill so it sits behind the colored spans without
    // competing with them.
    ctx.fillStyle = 'rgba(140, 150, 160, 0.55)';
    for (let x = 0; x < peaks.length; x++) {
      const v = peaks[x] ?? 0;
      const h = Math.max(1, v * (cssHeight / 2 - 2));
      ctx.fillRect(x, mid - h, 1, h * 2);
    }
  }, [audioBuffer, startFrac, endFrac]);

  const left = startFrac * 100;
  const width = Math.max(1, (endFrac - startFrac) * 100);
  return (
    <canvas
      ref={canvasRef}
      className="absolute pointer-events-none"
      style={{
        left: `${left}%`,
        width: `${width}%`,
        top: '8%',
        height: '84%',
        opacity: 0.85,
      }}
    />
  );
}
