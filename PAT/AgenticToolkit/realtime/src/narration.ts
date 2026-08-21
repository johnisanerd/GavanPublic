/**
 * Narrator — front-mind layer that fills silence while the
 * back-mind is processing.
 *
 * One Narrator per active back-mind session. Watches a stream of detail
 * events from the back-mind (PreToolUse, PostToolUse, etc.) and emits
 * short spoken progress updates so the caller doesn't sit in silence
 * while the back-mind grinds.
 *
 * Cadence is "max silence" — speak at most every MAX_SILENCE_MS
 * (measured from the projected end of the last utterance). Gates:
 *
 *   - isProcessingNarration (host-driven; on at request-layer forward,
 *     off at container query-end)
 *   - !isTtsBusy (don't speak over the agent already speaking — banter,
 *     chat rendition, prior narration)
 *   - !isGeneratingNarration (no concurrent model call)
 *   - now >= nextFireEarliestAt (max-silence has elapsed)
 *
 * The Narrator is transport-agnostic — events in, utterances out via
 * callback. Wiring into nanoclaw's outbound.db poller happens in
 * nanoclaw/src/channels/realtime.ts.
 */
import type { BanterStreamCallbacks, BanterHistoryEntry, LlmCallHook } from './banter.js';
import { formatHistory, streamBanterToSse } from './banter.js';
import { getFastProvider, awaitFullResponse } from './llm-provider.js';
import * as banterNarration from './prompts/banter-narration.js';
import type { CallerContext } from './prompts/_capability-context.js';
import type { ScenarioContext } from './prompts/_scenario-context.js';

const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Max silence between narration utterances while back-mind is processing.
 * Measured from the projected end of the last narration utterance — so
 * a long line gets a long quiet beat after it, a short line a shorter
 * beat. Default 3.5s.
 */
export const MAX_SILENCE_MS = 3500;
/**
 * Cartesia TTS rendering rate, used to project when a just-emitted
 * utterance will finish playing. Mirrors the same constant on the host
 * side (nanoclaw/src/channels/realtime.ts) and the python side
 * (transports/main.py). Janky but consistent across all three.
 */
export const TTS_CHARS_PER_SEC = 11;
/** Static tail padding added to projected utterance duration. */
export const TTS_TAIL_PAD_MS = 1000;
/** Recent-events ring size handed to the model. */
export const EVENT_BUFFER_MAX = 12;

// PAT: after a dropped/failed narration, back off this long instead of
// re-firing on the next 500ms tick — a failing narrator otherwise spins the
// fast-LLM every tick (log storm) and can trip the shared circuit breaker.
const NARRATION_FAILURE_BACKOFF_MS = 1500;

/**
 * A single back-mind detail event. The shape comes from claude.ts hooks:
 *   { type: 'tool-pre',     tool, input, toolUseId }
 *   { type: 'tool-post',    tool, result, toolUseId }
 *   { type: 'tool-failed',  tool, error, toolUseId }
 *   { type: 'token-delta',  text }
 *   { type: 'compact',      sessionId }
 */
export interface DetailEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * "Real work" events. token-delta is the back-mind streaming its OUTPUT
 * text, not doing fresh work — and token-deltas keep arriving past the
 * chat-row marker (trailing tokens of the same response). Treating them
 * as activity made the Narrator keep firing for seconds *after* the
 * answer was delivered. We drop them entirely — they never reach the
 * events buffer the model reads.
 *
 * `query-start` / `query-end` are agent-runner lifecycle events that
 * the host uses to drive `isProcessingNarration` on/off. They're
 * dropped here too — the Narrator's gate is host-driven via the
 * isProcessingNarration callback, not inferred from observed events.
 */
function isSubstantive(ev: DetailEvent): boolean {
  return ev.type === 'tool-pre' || ev.type === 'tool-post' || ev.type === 'tool-failed';
}

export interface NarrationCallRequest {
  recentEvents: DetailEvent[];
  /**
   * Unified conversation history (same shape banter and rendition see).
   * Lets the narrator avoid repeating itself across turns and stay
   * coherent with what Pat already said.
   */
  history?: BanterHistoryEntry[];
  /**
   * Truncated summary of the back-mind's current in-progress activity
   * (deltas the narrator is reacting to). Sibling of `history`, NOT a
   * synthetic row inside it — semantically distinct from "what's been
   * said." Used to ground the narrator's choice of utterance.
   */
  currentBackMindProgress?: string;
  /**
   * Trace hook called once with the full model response metadata
   * (model, latency, ok, error). Mirrors the banter / rendition
   * shapes so the streaming variant can broadcast the same SSE
   * `trace` event for the dashboard.
   */
  onCall?: LlmCallHook;
  /** Optional: scenario meta when running in scenario mode. Threaded
   *  into banter-narration's SYSTEM prompt so progress utterances
   *  stay in scenario voice (not default Pat voice). */
  scenario?: ScenarioContext | null;
  /** Agent group identifier for this session. Drives the install-side
   *  capability lookup inside the prompt's render() — the install
   *  block lives in SYSTEM and is cached per agent group, so narration
   *  inherits the install surface for free without a per-inbound
   *  resolver call. */
  agentGroupId?: string | null;
  /** Optional: per-inbound caller context — threaded through for
   *  symmetry with the other front-mind call sites; narrator rarely
   *  needs it but carrying the caller block keeps progress utterances
   *  consistent in addressing the user. */
  callerContext?: CallerContext | null;
}

export interface NarrationCallResponse {
  utterance: string | null;
}

let _consecutiveFailures = 0;

/**
 * Trim a plain-text narration line. Strips wrapping whitespace, surrounding
 * quotes the model occasionally adds, and an accidental markdown fence —
 * but does NOT JSON-parse. The prompt instructs plain text; we keep this
 * helper minimal so streaming consumers can speak the raw text deltas
 * directly without waiting for a closing brace.
 */
export function cleanUtterance(raw: string): NarrationCallResponse {
  let trimmed = raw.trim();
  // Strip code fences if the model emits one despite the prompt.
  trimmed = trimmed.replace(/^```(?:\w+)?\s*/i, '').replace(/\s*```$/i, '').trim();
  // Strip a single pair of wrapping quotes ("..." or '...').
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  if (trimmed.length === 0) return { utterance: null };
  return { utterance: trimmed };
}

/**
 * Render `recentEvents` as a one-line-per-event textual summary suitable
 * for the narrator's "current back-mind progress" prompt block. Truncates
 * each string field to ~120 chars to keep the prompt bounded. Exported
 * so the channel adapter can stamp `basedOnBackMindProgress` on
 * narration-utterance turns it pushes to history.
 */
export function renderRecentEventsAsText(events: DetailEvent[]): string {
  if (!events.length) return '';
  return events
    .map((ev) => {
      const rest: string[] = [];
      for (const [k, v] of Object.entries(ev)) {
        if (k === 'type') continue;
        if (typeof v === 'string') {
          const trimmed = v.length > 120 ? v.slice(0, 120) + '…' : v;
          rest.push(`${k}="${trimmed}"`);
        } else if (typeof v === 'number' || typeof v === 'boolean') {
          rest.push(`${k}=${v}`);
        }
      }
      return `- ${ev.type}${rest.length ? ' ' + rest.join(' ') : ''}`;
    })
    .join('\n');
}

async function narrationCall(req: NarrationCallRequest): Promise<NarrationCallResponse> {
  if (_consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return { utterance: null };
  const { system, user: userMsg } = banterNarration.render(toNarrationContext(req));

  const provider = getFastProvider('banter-narration');
  const result = await awaitFullResponse(provider, {
    system,
    user: userMsg,
    maxTokens: 200,
  });
  if (!result.ok || result.text === null) {
    _consecutiveFailures += 1;
    return { utterance: null };
  }
  const parsed = cleanUtterance(result.text);
  if (parsed.utterance === null) {
    _consecutiveFailures += 1;
    return { utterance: null };
  }
  _consecutiveFailures = 0;
  return parsed;
}

/** Adapt the rich `NarrationCallRequest` to the prompt-layer context. */
function toNarrationContext(req: NarrationCallRequest): banterNarration.BanterNarrationContext {
  return {
    history: req.history && req.history.length > 0 ? formatHistory(req.history) : '',
    currentBackMindProgress:
      req.currentBackMindProgress ?? renderRecentEventsAsText(req.recentEvents),
    scenario: req.scenario,
    agentGroupId: req.agentGroupId,
    callerContext: req.callerContext,
  };
}

export interface NarrationStreamRequest extends NarrationCallRequest, BanterStreamCallbacks {
  abortSignal?: AbortSignal;
}

/**
 * Streaming variant of `narrationCall`. Same prompt + circuit-breaker
 * behavior as the blocking variant, but text deltas land via
 * `onDelta` as the model produces them, and `onEnd` fires once with the
 * full text cleaned via `cleanUtterance` (trim + strip wrapping quotes
 * + strip code fences). Returns the cleaned `{utterance}` shape so
 * callers can share post-stream logic with the blocking path.
 *
 * The plain-text prompt (since outbound-mcp's prompt rewrite) makes
 * this a drop-in: every delta is speakable text — no JSON braces to
 * wait for before emitting first audio. Caller wires `onDelta` to
 * broadcast SSE `utterance-delta` events for voice-transport.
 */
export async function streamBanterNarration(
  req: NarrationStreamRequest,
): Promise<NarrationCallResponse> {
  const { system, user: userMsg } = banterNarration.render(toNarrationContext(req));
  const result = await streamBanterToSse({
    systemPrompt: system,
    userMessage: userMsg,
    source: 'banter-narration',
    maxTokens: 200,
    abortSignal: req.abortSignal,
    onCall: req.onCall,
    traceLayer: 'narration',
    onDelta: req.onDelta,
    onEnd: req.onEnd,
    onCancelled: req.onCancelled,
  });
  // streamBanterToSse returns {text, silent}. Translate to narration's
  // {utterance} shape — text === null (failure or silent) → utterance
  // null. Otherwise pipe the text through cleanUtterance to strip
  // any wrapping quotes / fences the model leaked despite the prompt.
  if (result.text === null) return { utterance: null };
  return cleanUtterance(result.text);
}

export interface NarratorOptions {
  /** Called when the brain has a line ready to speak. Caller broadcasts it. */
  onUtterance: (text: string) => void;
  /** Optional logger for diagnostics. */
  log?: (msg: string, meta?: Record<string, unknown>) => void;
  /**
   * Inject the narration model call. Default = the real one. Tests pass a
   * mock so they can run synchronously without network.
   */
  narrationCall?: (req: NarrationCallRequest) => Promise<NarrationCallResponse>;
  /**
   * Inject `now()` and the tick interval — tests run virtual time. Defaults
   * to real wall clock + 500ms tick.
   */
  now?: () => number;
  tickIntervalMs?: number;
  /** When false, don't auto-start the periodic tick. Default true. */
  autoTick?: boolean;
  /**
   * Authoritative "is TTS currently playing?" callback. When supplied, the
   * brain prefers this over its own `len(text) / TTS_CHARS_PER_SEC`
   * estimation. The estimation is still used as a fallback (in case the
   * real-signal source is offline) — both gates must pass before a pending
   * line is drained.
   *
   * Wire this from a TTS-end-of-speech event source (Cartesia
   * AgentTurnEnded for the realtime adapter; tests can pass a controlled
   * mock).
   */
  isTtsBusy?: () => boolean;
  /**
   * Wall-clock timestamp (ms) of the most recent end-of-TTS signal for
   * this thread. When supplied, the brain gates next-fire on
   * `getLastTtsEndedAt() + MAX_SILENCE_MS` instead of its own
   * length-projection (`now + len/TTS_CHARS_PER_SEC + MAX_SILENCE_MS`).
   * Returns 0 until the first utterance has finished playing — which
   * means "fire immediately if isProcessingNarration is true and TTS
   * isn't busy."
   *
   * Wire from a real end-of-speech source (Cartesia AgentTurnEnded
   * → host TTS-busy tracker `getLastEndedAt(threadId)`). The
   * estimator-based projection is still kept as a fallback for the
   * window between broadcast and the first real signal arrival.
   */
  getLastTtsEndedAt?: () => number;
  /**
   * Pull the current unified conversation history. Same shape banter and
   * rendition see — lets the narrator avoid repeating itself across turns
   * and stay coherent with what Pat has already said.
   *
   * Called once per model invocation; channel adapter owns the ring.
   */
  getHistory?: () => BanterHistoryEntry[];
  /**
   * Authoritative "should I be filling silence?" gate. Read on every
   * tick. The host map is the single source of truth: the request layer
   * also reads it, and a single store avoids dual-write sync bugs.
   *
   * Host flips it true the moment the request layer decides to forward
   * (covers cold-spawn / SDK init), and false on container query-end.
   * The Narrator itself never infers this from back-mind activity.
   */
  isProcessingNarration?: () => boolean;
  /**
   * PAT: hard-suppress narration during scripted delivery. Returns true
   * iff a `<timeline>` wrapper is currently active for this thread —
   * meaning the back-mind is mid-stream emitting authored content the
   * audience is hearing. The narrator must stay silent then; filler
   * over scripted speech is the failure mode we keep tripping on.
   *
   * Wired by the channel adapter from
   * `orchestrator.isDelivering(threadKey)`. Read on every tick BEFORE
   * the other gates — short-circuits the entire decision tree.
   */
  isDelivering?: () => boolean;
}

/**
 * One Narrator per active back-mind session. Continuous tick-based observer.
 *
 *   const narrator = new Narrator({ onUtterance: (text) => sse.broadcast(text) });
 *   ...whenever a detail row arrives:
 *   narrator.observe(event);
 *   ...on session end:
 *   narrator.stop();
 *
 * Cadence model is "max silence", not "min spacing":
 *
 *   tick (every ~500ms):
 *     if isProcessingNarration (host-driven gate)
 *        AND TTS is free
 *        AND no model call already in flight (isGeneratingNarration)
 *        AND we're past (projected end of last utterance + MAX_SILENCE_MS):
 *       fire the model → on return, if TTS still free: broadcast; else drop.
 *
 * "Projected end of last utterance" uses length / TTS_CHARS_PER_SEC +
 * TTS_TAIL_PAD_MS — same estimate the host uses to gate isTtsBusy.
 * Janky but consistent across host, narrator, and voice-transport.
 *
 * Notes:
 *   - No event-freshness gate. Narrator fires on max-silence whether or
 *     not new tool events arrived; the prompt has fallback lines for
 *     "no new events" cases (e.g. "still working on this").
 *   - No event-count gate. Empty buffer is fine — Narrator still says
 *     something while back-mind is in cold-spawn / SDK init / pure-prose
 *     thinking (where there are no tool events to narrate over).
 *   - No "pending queue": narrations are filler whose value is "fill
 *     silence right now." Queueing them so they speak after the moment
 *     passes produces stale lines.
 *   - No "resetTurn": with unified `history` passed to the model call,
 *     the Narrator can see chat rows itself and decide not to narrate
 *     about already-delivered work.
 */
export class Narrator {
  private events: DetailEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  // PAT: a narration model call is currently in flight. Prevents two
  // concurrent calls when ticks arrive faster than the model can respond.
  private isGeneratingNarration = false;
  private stopped = false;
  // PAT: timestamp at which the next narration is allowed to fire.
  // Set on every emitted utterance to (now + estTtsDurMs + MAX_SILENCE_MS)
  // so the silence beat is measured from the projected *end* of the last
  // spoken line, not the start of the model call. Stays at 0 until the
  // first utterance, so the first fire happens as soon as
  // isProcessingNarration goes true and TTS is free.
  private nextFireEarliestAt = 0;
  private readonly onUtterance: (text: string) => void;
  private readonly log: (msg: string, meta?: Record<string, unknown>) => void;
  private readonly narrationCallFn: (req: NarrationCallRequest) => Promise<NarrationCallResponse>;
  private readonly nowFn: () => number;
  private readonly tickIntervalMs: number;
  private readonly isTtsBusyFn: (() => boolean) | null;
  private readonly getLastTtsEndedAtFn: (() => number) | null;
  private readonly getHistoryFn: (() => BanterHistoryEntry[]) | null;
  private readonly isProcessingNarrationFn: (() => boolean) | null;
  /** PAT: short-circuits the entire tick. True while a `<timeline>`
   *  wrapper is active for this thread — i.e. scripted delivery is
   *  in flight. Wired from `orchestrator.isDelivering(threadKey)`. */
  private readonly isDeliveringFn: (() => boolean) | null;

  constructor(opts: NarratorOptions) {
    this.onUtterance = opts.onUtterance;
    this.log = opts.log ?? (() => {});
    this.narrationCallFn = opts.narrationCall ?? narrationCall;
    this.nowFn = opts.now ?? Date.now;
    this.tickIntervalMs = opts.tickIntervalMs ?? 500;
    this.isTtsBusyFn = opts.isTtsBusy ?? null;
    this.getLastTtsEndedAtFn = opts.getLastTtsEndedAt ?? null;
    this.getHistoryFn = opts.getHistory ?? null;
    this.isProcessingNarrationFn = opts.isProcessingNarration ?? null;
    this.isDeliveringFn = opts.isDelivering ?? null;
    if (opts.autoTick !== false) {
      // start() is idempotent; defer one frame so subclassers can finish init.
      queueMicrotask(() => this.start());
    }
  }

  private isTtsBusy(): boolean {
    return this.isTtsBusyFn?.() === true;
  }

  private isProcessingNarration(): boolean {
    return this.isProcessingNarrationFn?.() === true;
  }

  private isDelivering(): boolean {
    return this.isDeliveringFn?.() === true;
  }

  /**
   * Snapshot the brain's current event buffer rendered as text. Channel
   * adapter uses this from inside its `onUtterance` callback to stamp
   * the just-broadcast narration entry with `basedOnBackMindProgress` —
   * grounds the line in what the back-mind was doing at the moment.
   */
  peekProgressText(): string {
    return renderRecentEventsAsText(this.events);
  }

  /** Start the periodic tick. Idempotent. */
  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => this.tick().catch(() => {}), this.tickIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Ingest a new detail event from the back-mind. Token-deltas are
   * dropped entirely — see `isSubstantive` for the why. Only tool-level
   * events reach the buffer.
   *
   * Lifecycle events (query-start/query-end) are NOT handled here —
   * they're host-side signals on `processingByThread` (see
   * `isProcessingNarrationFn`). The Narrator never infers "is back-mind
   * working?" from observed events.
   */
  observe(event: DetailEvent): void {
    if (this.stopped) return;
    if (event.type === 'query-start' || event.type === 'query-end') {
      // Host-side signals — the Narrator's gate is driven by the
      // isProcessingNarration callback, not by these events.
      // PAT: on query-end, clear the events buffer — that query's tool events
      // are now stale and were otherwise re-rendered as
      // <current_back_mind_progress> on every subsequent fire (and into the
      // NEXT query), a primary driver of the narrator-repetition bug.
      if (event.type === 'query-end') {
        this.events = [];
        this.log('observe: query-end — cleared stale events buffer');
      }
      return;
    }
    if (!isSubstantive(event)) {
      this.log('observe: dropped non-substantive', { type: event.type });
      return;
    }
    this.events.push(event);
    if (this.events.length > EVENT_BUFFER_MAX) this.events.shift();
    this.log('observe', { type: event.type, bufLen: this.events.length });
  }

  private now(): number {
    return this.nowFn();
  }

  /**
   * Tests hook: run one tick synchronously, awaiting any in-flight
   * model call so the test can assert deterministically.
   */
  async tickOnce(): Promise<void> {
    await this.tick();
    while (this.isGeneratingNarration) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.isGeneratingNarration) return;
    // PAT: scripted delivery active → hard-suppress narration. Highest
    // gate; runs before any other check so we don't even consider firing.
    if (this.isDelivering()) return;
    if (!this.isProcessingNarration()) return;
    if (this.isTtsBusy()) return;
    const now = this.now();
    // Max-silence gate. Real signal preferred: gate from the most
    // recent end-of-TTS timestamp the host saw. Falls back to the
    // length-projected `nextFireEarliestAt` (set in `fire()` after
    // every broadcast) when no real signal source is wired or before
    // the first end-of-speech arrives.
    const realLastEnd = this.getLastTtsEndedAtFn?.() ?? 0;
    const realGate = realLastEnd > 0 ? realLastEnd + MAX_SILENCE_MS : 0;
    const projectedGate = this.nextFireEarliestAt;
    // Take the max so that:
    //  - we never fire before MAX_SILENCE_MS after the real last end
    //  - if no real signal yet, the projected gate from `fire()` rules
    //  - if a stale projected-gate is still in the future, we honor it
    //    (covers the window between broadcast and first real end-of-TTS)
    const earliest = Math.max(realGate, projectedGate);
    if (now < earliest) return;
    void this.fire();
  }

  private async fire(): Promise<void> {
    this.isGeneratingNarration = true;
    this.log('model call: start', { events: this.events.map((e) => e.type) });
    try {
      const resp = await this.narrationCallFn({
        recentEvents: [...this.events],
        history: this.getHistoryFn ? this.getHistoryFn() : undefined,
      });
      this.log('model call: result', { utterance: resp.utterance?.slice(0, 80) ?? null });
      if (!resp.utterance || resp.utterance.trim().length === 0) {
        // Prompt forbids null/empty. Log if it happens anyway.
        this.log('model call: returned null/empty utterance (prompt forbids — investigate)');
        this.nextFireEarliestAt = this.now() + NARRATION_FAILURE_BACKOFF_MS;
        return;
      }
      // Speak-now-or-skip: re-check TTS state at result time. If TTS got
      // busy while the model was thinking (e.g. chat rendition slipped in
      // ahead of us), drop the line — it's stale.
      if (this.isTtsBusy()) {
        this.log('model call: dropped, TTS became busy during call');
        this.nextFireEarliestAt = this.now() + NARRATION_FAILURE_BACKOFF_MS;
        return;
      }
      try {
        this.onUtterance(resp.utterance);
      } catch (err) {
        this.log('onUtterance threw', { err: String(err) });
      }
      // Project when this utterance will finish playing and gate the
      // next fire on (projected end + MAX_SILENCE_MS). Janky estimation
      // but consistent with the host's isTtsBusy projection.
      const estDurMs = (resp.utterance.length / TTS_CHARS_PER_SEC) * 1000 + TTS_TAIL_PAD_MS;
      this.nextFireEarliestAt = this.now() + estDurMs + MAX_SILENCE_MS;
    } catch (err) {
      this.log('narration call threw', { err: String(err) });
      this.nextFireEarliestAt = this.now() + NARRATION_FAILURE_BACKOFF_MS;
    } finally {
      this.isGeneratingNarration = false;
    }
  }
}
