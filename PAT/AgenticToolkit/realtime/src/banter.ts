/**
 * Banter layer (fast LLM) — generates the agent's spoken response each
 * time the user sends a message. Personality lives here. No
 * classification, no routing decisions; just produce something Pat
 * would say in the moment.
 *
 * The banter layer always responds. The user never waits in silence for
 * a routing decision — that's the request layer's job
 * (`request-layer.ts`), which runs after banter to decide whether the
 * back-mind needs to be woken.
 */
import * as banterAck from './prompts/banter-ack.js';
import * as banterRender from './prompts/banter-render.js';
import type { CallerContext } from './prompts/_capability-context.js';
import type { ScenarioContext } from './prompts/_scenario-context.js';
import type { BackMindState } from './state.js';
import { renderBackMindState } from './state.js';
import { getFastProvider, awaitFullResponse, type FastLlmLayer, type FastLlmResult } from './llm-provider.js';

const MAX_CONSECUTIVE_FAILURES = 3;
// PAT: half-open cooldown. Once the breaker trips it stays open only this long,
// then lets ONE probe call through (half-open). Without this the breaker latched
// open permanently — a ~1.5s dual-provider blip silenced banter/rendition/
// narration until the process restarted, because the only reset ran after a
// successful provider call that the open breaker short-circuited before.
const BREAKER_COOLDOWN_MS = 30_000;

let _consecutiveFailures = 0;
let _breakerOpenedAt = 0;
export function resetBanterFailures(): void {
  _consecutiveFailures = 0;
  _breakerOpenedAt = 0;
}

/** True while the breaker is open AND within its cooldown. After the cooldown it
 *  returns false so calls flow again (half-open) — the first failure re-opens it
 *  via recordFastFailure, a success resets the counter. Under concurrency more
 *  than one call can slip through before the re-stamp; acceptable (cheap probes). */
function breakerOpen(): boolean {
  if (_consecutiveFailures < MAX_CONSECUTIVE_FAILURES) return false;
  return Date.now() - _breakerOpenedAt < BREAKER_COOLDOWN_MS;
}

/** Count a fast-LLM failure; (re)stamp the breaker-open time when at/over the
 *  threshold so the cooldown window restarts on each fresh failure. */
function recordFastFailure(): void {
  _consecutiveFailures++;
  // NOTE: stamp on the raw threshold, NOT breakerOpen() — breakerOpen() needs an
  // already-stamped time to be true, so keying off it would never open (the
  // stamp would never get written). Re-stamp on each failure at/over threshold
  // so the cooldown restarts.
  if (_consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    _breakerOpenedAt = Date.now();
  }
}

/**
 * One entry in the unified conversation history shared across all
 * fast-LLM call sites (banter-ack, banter-render, banter-narration).
 *
 * Roles:
 * - `'user'`: a user message.
 * - `'pat'`: something Pat said (banter-ack / banter-narration utterance / rendered back-mind result).
 * - `'forwarded'`: a directive the request layer pushed to the back-mind.
 *   NOT spoken — visible only to the front-mind layers so they can
 *   see what's already in flight and avoid duplicates.
 *
 * `basedOn*` fields:
 * - Plain banter-ack / banter-narration entries have no `basedOn*`.
 * - Rendition entries (back-mind output re-rendered in Pat's voice)
 *   carry `basedOnBackMindResults` = the raw back-mind text they're
 *   rendering.
 * - Narration entries carry `basedOnBackMindProgress` = a truncated
 *   summary of the back-mind detail rows that motivated the line.
 *
 * At prompt-render time, both `basedOn*` fields are kept on at most
 * the most recent 3 entries of each kind (independently); older ones
 * get stripped to keep the prompt compact.
 */
export interface BanterHistoryEntry {
  role: 'user' | 'pat' | 'forwarded';
  text: string;
  /** ISO 8601 UTC. */
  ts?: string;
  /** Raw back-mind text this Pat line was rendering. Rendition entries only. */
  basedOnBackMindResults?: string;
  /** Truncated delta-summary the narrator was reacting to. Narration entries only. */
  basedOnBackMindProgress?: string;
}

/** Cap on how many Pat entries retain each `basedOn*` field in the prompt. Older ones render plain. */
export const BASED_ON_RECENT_MAX = 3;

/**
 * Render a unified conversation history for any fast-LLM call site.
 * Walks newest-first to apply per-kind caps for `basedOnBackMindResults`
 * and `basedOnBackMindProgress` independently, then re-emits oldest-first.
 */
export function formatHistory(history: BanterHistoryEntry[]): string {
  if (history.length === 0) return '';
  let resultsRemaining = BASED_ON_RECENT_MAX;
  let progressRemaining = BASED_ON_RECENT_MAX;
  // Walk newest-first to decide which `basedOn*` fields survive.
  const decided: Array<{ entry: BanterHistoryEntry; keepResults: boolean; keepProgress: boolean }> = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const t = history[i]!;
    let keepResults = false;
    let keepProgress = false;
    if (t.basedOnBackMindResults && resultsRemaining > 0) {
      keepResults = true;
      resultsRemaining -= 1;
    }
    if (t.basedOnBackMindProgress && progressRemaining > 0) {
      keepProgress = true;
      progressRemaining -= 1;
    }
    decided.push({ entry: t, keepResults, keepProgress });
  }
  decided.reverse();
  const lines: string[] = [];
  for (const { entry, keepResults, keepProgress } of decided) {
    const tag =
      entry.role === 'user' ? '[user]' : entry.role === 'forwarded' ? '[→ back-mind]' : '[you]';
    lines.push(`${tag} ${entry.text}`);
    // Preserve the FACT that grounding existed even when truncating the
    // payload — older Pat entries shouldn't look like free banter when
    // they were actually grounded. Just `...` keeps the signal.
    if (entry.basedOnBackMindResults) {
      const body = keepResults ? entry.basedOnBackMindResults : '...';
      lines.push(`  └─ based on back-mind result: ${body}`);
    }
    if (entry.basedOnBackMindProgress) {
      const body = keepProgress ? entry.basedOnBackMindProgress : '...';
      lines.push(`  └─ based on back-mind progress: ${body}`);
    }
  }
  return lines.join('\n');
}

/** Trace event for an LLM call — emitted via the optional `onCall` hook for debugging. */
export interface LlmCallTrace {
  /** Layer that made the call (e.g. 'banter:ack', 'banter:render', 'request-layer'). */
  layer: string;
  model: string;
  systemPrompt: string;
  userMessage: string;
  response: string | null;
  latencyMs: number;
  /** Time from call start to first response signal (response headers for
   *  raw fetch / first stream event for SDK). High `ttfbMs` paired with
   *  `connectionReused: false` indicates a TLS handshake cost. Absent
   *  on call sites that bail before the API call (circuit-breaker, no
   *  API key, aborted-pre-call). */
  ttfbMs?: number;
  /** True iff this call rode on a kept-alive socket. False ⇒ a fresh
   *  TCP/TLS handshake was performed. Absent ⇒ the provider couldn't
   *  determine (e.g. trace was built without a provider call). */
  connectionReused?: boolean;
  /** TCP+TLS handshake duration when `connectionReused === false`,
   *  ms. Absent on warm-reused calls. */
  connectMs?: number;
  /** Provider that actually served the request (`anthropic` /
   *  `openrouter` / `cerebras`). Absent on circuit-breaker / pre-call
   *  abort paths. */
  provider?: string;
  /** Upstream backend reported by OpenRouter (e.g. 'Groq', 'Cerebras').
   *  Only present when `provider === 'openrouter'`. */
  upstreamProvider?: string;
  /** Input + output token counts reported by the provider. Absent
   *  when the provider didn't report usage (some streaming paths) or
   *  the call failed before usage landed. */
  inputTokens?: number;
  outputTokens?: number;
  /** Combined system + user prompt size in characters. Absent on
   *  pre-call short circuits (circuit-breaker, no API key). */
  promptChars?: number;
  ok: boolean;
  /** Why the call failed, if it did. */
  error?: string;
}

export type LlmCallHook = (trace: LlmCallTrace) => void;

export interface BanterRequest {
  /** What the user just said. */
  userText: string;
  /** Working-memory snapshot — what's in flight, completed steps, etc. */
  backMindState: BackMindState;
  /** Unified conversation history (oldest first, most recent last). */
  history?: BanterHistoryEntry[];
  /** Optional: scenario meta when running in scenario mode. Threaded
   *  into the banter-ack SYSTEM prompt via the partial in
   *  `prompts/_scenario-context.ts`. Front-mind responds in-character
   *  for the scenario (persona, tone, scripted vs improv awareness). */
  scenario?: ScenarioContext | null;
  /** Agent group identifier for this inbound. Drives the install-side
   *  capability lookup inside the prompt's `render()` — the rendered
   *  install block lives in the SYSTEM prompt (cached at boot per
   *  agent group; same value across inbounds), keeping the Anthropic
   *  prompt cache effective. */
  agentGroupId?: string | null;
  /** Optional: per-inbound caller context — identity, known handles,
   *  permissions. Threaded into the banter-ack USER message via
   *  `prompts/_capability-context.ts`. Varies per inbound; the
   *  agent-group-wide install surface is reached via `agentGroupId`. */
  callerContext?: CallerContext | null;
  /** Optional: receive a trace of the LLM call (system prompt + user msg + response + timing). */
  onCall?: LlmCallHook;
}

export interface BanterResponse {
  /**
   * Banter line. `null` is the not-spoken case — always an error path
   * now (SDK/JSON failure, no API key, circuit-breaker open). The
   * legacy `silent: true` intentional-quiet path was removed; prompts
   * forbid sentinel responses, so the model always produces real text.
   */
  text: string | null;
  /**
   * True iff the layer DELIBERATELY chose to be silent. False on error
   * paths (no API key, network throw, JSON corruption, circuit-breaker
   * open). The channel adapter uses this to decide whether to speak a
   * fallback line: speak it on error, stay quiet on intentional silence.
   */
  silent: boolean;
}

/** Adapt the rich `BanterRequest` to the prompt-layer's typed context. */
function toBanterAckContext(req: BanterRequest): banterAck.BanterAckContext {
  return {
    backMindState: renderBackMindState(req.backMindState),
    history: req.history && req.history.length > 0 ? formatHistory(req.history) : '',
    userText: req.userText,
    scenario: req.scenario,
    agentGroupId: req.agentGroupId,
    callerContext: req.callerContext,
  };
}

/**
 * Make one model call to produce the banter response.
 *
 * Returns `{ text: null }` on any failure path. Tracks consecutive failures
 * and short-circuits the API call once we hit 3 — silence is the design-doc
 * fallback. Caller should provide a generic spoken fallback ("hmm, let me
 * think") when text is null and the user is mid-conversation.
 */
export async function runBanterAck(req: BanterRequest): Promise<BanterResponse> {
  const t0 = Date.now();
  const { system, user: userMsg } = banterAck.render(toBanterAckContext(req));
  const provider = getFastProvider('banter-ack');
  // Filled by the provider call — propagates ttfbMs + connectionReused
  // into every trace fire, including pre-call short-circuit paths
  // (where they stay undefined as designed).
  let lastResult: FastLlmResult | null = null;
  const trace = (ok: boolean, response: string | null, error?: string): void => {
    req.onCall?.({
      layer: 'banter:ack',
      model: provider.model,
      systemPrompt: system,
      userMessage: userMsg,
      response,
      latencyMs: Date.now() - t0,
      ttfbMs: lastResult?.ttfbMs,
      connectionReused: lastResult?.connectionReused,
      connectMs: lastResult?.connectMs,
      provider: lastResult?.provider,
      upstreamProvider: lastResult?.upstreamProvider,
      inputTokens: lastResult?.usage?.inputTokens,
      outputTokens: lastResult?.usage?.outputTokens,
      promptChars: lastResult?.promptChars ?? system.length + userMsg.length,
      ok,
      error,
    });
  };
  if (breakerOpen()) {
    trace(false, null, 'circuit-breaker open');
    return { text: null, silent: false };
  }
  const result = await awaitFullResponse(provider, { system, user: userMsg, maxTokens: 256 });
  lastResult = result;
  if (!result.ok || result.text === null) {
    recordFastFailure();
    trace(false, result.text, result.error);
    return { text: null, silent: false };
  }
  const cleaned = cleanBanterText(result.text);
  if (!cleaned) {
    // model output something but it cleaned to empty after stripping —
    // that IS prompt drift / noise. Treat as failure.
    recordFastFailure();
    trace(false, result.text, 'cleaned to empty');
    return { text: null, silent: false };
  }
  _consecutiveFailures = 0;
  trace(true, cleaned);
  return { text: cleaned, silent: false };
}

/**
 * Strip outer fences and wrapping quotes. Preserve everything else,
 * including newlines and multi-line content. The LLM legitimately wants
 * to emit multi-line output sometimes (a bulleted list, a paragraph
 * break) — collapsing to firstLine eats real content.
 */
function cleanBanterText(raw: string): string {
  let s = raw.trim();
  // PAT: strip leaked thinking tokens from Cerebras zai-glm-4.7.
  // The model sometimes emits </think> followed by internal reasoning
  // even with reasoning_effort='none'. Truncate at the first </think>.
  const thinkClose = s.indexOf('</think>');
  if (thinkClose >= 0) s = s.slice(0, thinkClose);
  s = s.replace(/^```(?:[a-z]+)?\s*\n?/i, '').replace(/\n?\s*```$/i, '');
  s = s.replace(/^["'`]+|["'`]+$/g, '');
  return s.trim();
}

// ─────────────────────── Streaming wrappers ──────────────────────────
//
// Per-call-site streaming variants of runBanterAck /
// runBanterRender / narrationCall. Each accepts the same
// request shape as its blocking sibling, but emits text deltas
// progressively via callbacks. Internally calls `streamBanterToSse`
// (defined below). Callers (nanoclaw realtime channel) wire the
// onDelta to broadcast SSE `utterance-delta` events.
//
// These are thin — they build the same system+user prompts as the
// blocking variants and forward to the streaming primitive. Keeping
// the prompt-building inside the realtime library (rather than asking
// callers to build them) means future prompt edits land in one place.

export interface BanterStreamCallbacks {
  /** Fired per text delta (after pre-broadcast silence-detection
   *  buffer flush). `seq` is 0-indexed. */
  onDelta: (text_delta: string, seq: number) => void;
  onEnd?: (fullText: string, deltaCount: number, streamMs: number, firstDeltaMs: number) => void;
  onCancelled?: (reason: 'bargein' | 'superseded' | 'error', partialText: string, deltaCount: number) => void;
}

export interface BanterStreamAckRequest extends BanterRequest, BanterStreamCallbacks {
  abortSignal?: AbortSignal;
}

/**
 * Streaming variant of `runBanterAck`. Same prompt logic,
 * same circuit-breaker, same return shape — but text deltas land
 * via `onDelta` as the model produces them. No sentinel suppression;
 * the prompt forbids `<silent>` so we forward every delta as-is.
 */
export async function streamBanterAck(
  req: BanterStreamAckRequest,
): Promise<BanterResponse> {
  const { system, user: userMsg } = banterAck.render(toBanterAckContext(req));
  return streamBanterToSse({
    systemPrompt: system,
    userMessage: userMsg,
    source: 'banter-ack',
    maxTokens: 256,
    abortSignal: req.abortSignal,
    onCall: req.onCall,
    traceLayer: 'banter:ack',
    onDelta: req.onDelta,
    onEnd: req.onEnd,
    onCancelled: req.onCancelled,
  });
}

export interface BanterStreamRenderRequest extends RenderBackMindRequest, BanterStreamCallbacks {
  abortSignal?: AbortSignal;
}

/**
 * Streaming variant of `runBanterRender`. Same prompt
 * logic, same return shape; deltas via onDelta.
 */
export async function streamBanterRender(
  req: BanterStreamRenderRequest,
): Promise<BanterResponse> {
  const { system, user: userMsg } = banterRender.render(toBanterRenderContext(req));
  return streamBanterToSse({
    systemPrompt: system,
    userMessage: userMsg,
    source: 'banter-rendition',
    maxTokens: 512,
    abortSignal: req.abortSignal,
    onCall: req.onCall,
    traceLayer: 'banter:render',
    onDelta: req.onDelta,
    onEnd: req.onEnd,
    onCancelled: req.onCancelled,
  });
}

// ─────────────────────── Streaming primitive ─────────────────────────
//
// `streamBanterToSse` is the unified streaming primitive for every
// front-mind utterance: banter acks, back-mind renditions, and
// narration filler. Three call sites, one streaming pipeline. See
// plans/streaming-banter-pipeline.md for the architecture.
//
// Anthropic SDK `messages.stream(...)` is the underlying call. We
// listen for text deltas and forward each one via the caller-supplied
// `onDelta` as soon as it arrives — zero buffering. On stream end we
// resolve with the full cleaned text and `onEnd` fires; on abort
// (controller.abort() from caller — typically /barge-in handler),
// `onCancelled` fires with whatever partial we'd accumulated.
//
// Failure circuit-breaker shares state with the blocking variants
// (`runBanterAck` / `runBanterRender`) so we
// don't separately track "streaming failed N times in a row".

/** What kind of utterance is this? Mirrors `UtteranceSource` in
 *  `log-events.ts`. Lets onDelta callbacks tag SSE events for
 *  voice-transport to route appropriately. */
export type BanterUtteranceSource = 'banter-ack' | 'banter-rendition' | 'banter-narration';

export interface StreamBanterRequest {
  /** Pat's persona / instructions for this stream. Same string we'd
   *  pass to messages.create({system: ...}). */
  systemPrompt: string;
  /** The user content for this stream. Same string we'd pass to
   *  messages.create({messages: [{role: 'user', content: ...}]}). */
  userMessage: string;
  /** Source discriminator — propagates to logs and SSE events so
   *  voice-transport / dashboards can distinguish call sites. */
  source: BanterUtteranceSource;
  /** max_tokens for the stream. Banter ack: 256. Rendition: 512.
   *  Narration: 200. Match the existing blocking calls. */
  maxTokens: number;
  /** Cancel signal. /barge-in handler aborts to stop mid-stream. */
  abortSignal?: AbortSignal;
  /** Existing trace hook — called once with the full model response
   *  metadata (latency, ok, error) to maintain dashboard parity. */
  onCall?: LlmCallHook;
  /** Layer label for the trace hook (e.g. 'banter:ack',
   *  'banter:render', 'narration'). Mirrors the existing wrapper
   *  functions' `layer` strings. */
  traceLayer: string;
  /** Fired for every accumulated text fragment AFTER the
   *  pre-broadcast buffer (~20 chars) is past. Each call hands the
   *  caller a `text_delta` to broadcast as SSE `utterance-delta`. */
  onDelta: (text_delta: string, seq: number) => void;
  /** Fired once when the stream finishes successfully. `fullText`
   *  is the post-cleanBanterText final string. */
  onEnd?: (fullText: string, deltaCount: number, streamMs: number, firstDeltaMs: number) => void;
  /** Fired once when the stream is aborted or errors. The caller
   *  is responsible for broadcasting SSE `utterance-cancel`. */
  onCancelled?: (reason: 'bargein' | 'superseded' | 'error', partialText: string, deltaCount: number) => void;
}

export interface StreamBanterResponse {
  /** Same shape as the blocking BanterResponse so call sites can
   *  share post-stream logic (push to history, etc.). */
  text: string | null;
  silent: boolean;
}

/**
 * Stream a model response into the caller's onDelta callback. Every
 * delta forwards immediately — no buffering, no sentinel-detection.
 * Banter / rendition / narration prompts disallow the previous
 * `<silent>` sentinel; if a model call genuinely produces empty text
 * we surface `{text: null, silent: false}` via the cancel path.
 *
 * Returns the same `{text, silent}` shape `runBanterAck` does
 * once the stream completes, so the caller's post-stream logic
 * (push to history, etc.) is unchanged from the blocking path.
 */
/** Map streaming source → layer key for provider resolution. */
function sourceToLayer(source: BanterUtteranceSource): FastLlmLayer {
  if (source === 'banter-ack') return 'banter-ack';
  if (source === 'banter-rendition') return 'banter-render';
  return 'banter-narration';
}

export async function streamBanterToSse(req: StreamBanterRequest): Promise<StreamBanterResponse> {
  const t0 = Date.now();
  let firstDeltaMs = -1;
  let deltaCount = 0;
  let buffered = '';

  const layer = sourceToLayer(req.source);
  const provider = getFastProvider(layer);

  let lastResult: FastLlmResult | null = null;
  const trace = (ok: boolean, response: string | null, error?: string): void => {
    req.onCall?.({
      layer: req.traceLayer,
      model: provider.model,
      systemPrompt: req.systemPrompt,
      userMessage: req.userMessage,
      response,
      latencyMs: Date.now() - t0,
      ttfbMs: lastResult?.ttfbMs,
      connectionReused: lastResult?.connectionReused,
      connectMs: lastResult?.connectMs,
      provider: lastResult?.provider,
      upstreamProvider: lastResult?.upstreamProvider,
      inputTokens: lastResult?.usage?.inputTokens,
      outputTokens: lastResult?.usage?.outputTokens,
      promptChars: lastResult?.promptChars ?? req.systemPrompt.length + req.userMessage.length,
      ok,
      error,
    });
  };

  // Existing failure-mode short circuits — keep parity with blocking variants.
  if (breakerOpen()) {
    trace(false, null, 'circuit-breaker open');
    req.onCancelled?.('error', '', 0);
    return { text: null, silent: false };
  }

  // Already-aborted check before we even open the stream — caller can
  // pass an aborted signal as a no-op.
  if (req.abortSignal?.aborted) {
    req.onCancelled?.('bargein', '', 0);
    return { text: null, silent: false };
  }

  // First-chunk fixup: strip code-fence / quote-prefix on the very first
  // delta only. Subsequent deltas pass through. We can't observe the
  // accumulated text from the provider's onDelta easily without
  // re-implementing, so we wrap the onDelta and track whether we've
  // flushed yet ourselves.
  let firstChunkFlushed = false;
  const result: FastLlmResult = await provider.stream({
    system: req.systemPrompt,
    user: req.userMessage,
    maxTokens: req.maxTokens,
    signal: req.abortSignal,
    onDelta: (delta: string, _seq: number) => {
      if (firstDeltaMs < 0) firstDeltaMs = Date.now() - t0;
      buffered += delta;
      if (!firstChunkFlushed) {
        firstChunkFlushed = true;
        let firstChunk = delta;
        firstChunk = firstChunk.replace(/^```(?:[a-z]+)?\s*\n?/i, '');
        firstChunk = firstChunk.replace(/^["'`]+/g, '');
        if (firstChunk.length === 0) return; // entire delta was strippable — wait for next
        deltaCount += 1;
        req.onDelta(firstChunk, 0);
        return;
      }
      deltaCount += 1;
      req.onDelta(delta, deltaCount - 1);
    },
  });
  lastResult = result;

  if (result.aborted) {
    // Don't count cancels toward circuit-breaker.
    _consecutiveFailures = 0;
    trace(false, buffered || null, 'aborted');
    req.onCancelled?.('bargein', buffered, deltaCount);
    return { text: null, silent: false };
  }
  if (!result.ok || result.text === null) {
    recordFastFailure();
    trace(false, buffered || null, result.error ?? 'stream failed');
    req.onCancelled?.('error', buffered, deltaCount);
    return { text: null, silent: false };
  }
  const cleaned = cleanBanterText(result.text);
  if (!cleaned) {
    recordFastFailure();
    trace(false, result.text, 'cleaned to empty');
    req.onCancelled?.('error', buffered, deltaCount);
    return { text: null, silent: false };
  }
  _consecutiveFailures = 0;
  trace(true, cleaned);
  req.onEnd?.(cleaned, deltaCount, Date.now() - t0, firstDeltaMs < 0 ? 0 : firstDeltaMs);
  return { text: cleaned, silent: false };
}

// ─────────────────────── Render back-mind result ─────────────────────────
//
// The back-mind produces "results" — factual, possibly verbose, possibly
// not in Pat's voice. Per the architecture, banter is the only voice the
// user hears, so back-mind output is re-rendered through Pat's voice
// before reaching TTS. This function does that translation.

export interface RenderBackMindRequest {
  /** The raw text the back-mind produced. */
  backMindText: string;
  /**
   * Unified conversation history (oldest first, most recent last). The
   * renderer reads this to figure out which user message the back-mind
   * was answering AND to notice cancel / refine signals from later
   * user messages. We deliberately do NOT also pass a separate
   * `userText` "this is the directive" hint — without `in_reply_to`
   * correlation it was always a guess and frequently wrong, lying to
   * the renderer. Better to trust the model to pick the directive from
   * full context than to spoon-feed it the wrong answer.
   */
  history?: BanterHistoryEntry[];
  /** Optional: back-mind state snapshot. */
  backMindState?: BackMindState;
  /** Optional: scenario meta when running in scenario mode. Threaded
   *  into banter-render so renditions of back-mind output respect
   *  scenario tone/persona (not default Pat voice) for non-tag-stream
   *  back-mind output (e.g. audience-Q&A responses during a scenario
   *  session). Tag-stream scripted delivery bypasses banter-render
   *  entirely — see plans/presenter-orchestration-locus.md. */
  scenario?: ScenarioContext | null;
  /** Agent group identifier for this rendition. Drives the install-side
   *  capability lookup inside the prompt's render(). */
  agentGroupId?: string | null;
  /** Optional: per-inbound caller context. See `BanterRequest`. */
  callerContext?: CallerContext | null;
  /** Optional: receive a trace of the LLM call. */
  onCall?: LlmCallHook;
}

/** Adapt the rich `RenderBackMindRequest` to the prompt-layer context. */
function toBanterRenderContext(req: RenderBackMindRequest): banterRender.BanterRenderContext {
  return {
    backMindText: req.backMindText,
    history: req.history && req.history.length > 0 ? formatHistory(req.history) : '',
    backMindState: req.backMindState ? renderBackMindState(req.backMindState) : '',
    scenario: req.scenario,
    agentGroupId: req.agentGroupId,
    callerContext: req.callerContext,
  };
}

export async function runBanterRender(req: RenderBackMindRequest): Promise<BanterResponse> {
  const t0 = Date.now();
  const { system, user: userMsg } = banterRender.render(toBanterRenderContext(req));
  const provider = getFastProvider('banter-render');
  let lastResult: FastLlmResult | null = null;
  const trace = (ok: boolean, response: string | null, error?: string): void => {
    req.onCall?.({
      layer: 'banter:render',
      model: provider.model,
      systemPrompt: system,
      userMessage: userMsg,
      response,
      latencyMs: Date.now() - t0,
      ttfbMs: lastResult?.ttfbMs,
      connectionReused: lastResult?.connectionReused,
      connectMs: lastResult?.connectMs,
      provider: lastResult?.provider,
      upstreamProvider: lastResult?.upstreamProvider,
      inputTokens: lastResult?.usage?.inputTokens,
      outputTokens: lastResult?.usage?.outputTokens,
      promptChars: lastResult?.promptChars ?? system.length + userMsg.length,
      ok,
      error,
    });
  };
  if (breakerOpen()) {
    trace(false, null, 'circuit-breaker open');
    return { text: null, silent: false };
  }
  const result = await awaitFullResponse(provider, { system, user: userMsg, maxTokens: 512 });
  lastResult = result;
  if (!result.ok || result.text === null) {
    recordFastFailure();
    trace(false, result.text, result.error);
    return { text: null, silent: false };
  }
  const cleaned = cleanBanterText(result.text);
  if (!cleaned) {
    recordFastFailure();
    trace(false, result.text, 'cleaned to empty');
    return { text: null, silent: false };
  }
  _consecutiveFailures = 0;
  trace(true, cleaned);
  return { text: cleaned, silent: false };
}
