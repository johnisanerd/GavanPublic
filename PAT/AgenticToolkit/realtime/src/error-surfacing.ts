/**
 * Error legibility — surface back-mind / host-side failures verbally
 * (when `PAT_ANNOUNCE_ERRORS` is on) AND structurally to the dashboard.
 *
 * Design split (task #36 reframe):
 *   - **Deterministic**: the DECISION to announce (per-source debounce,
 *     flag gate). `decideAnnounce` is unchanged — same shape, same
 *     fallback `spokenText` (the safe one-sentence template). Capturing
 *     the raw error and attaching it to the next outbound utterance is
 *     also deterministic.
 *   - **model-phrased**: the actual SPOKEN line. `phraseErrorAnnounce`
 *     wraps `decideAnnounce`; when announcing, it asks the model to phrase
 *     the verbatim error in PAT's voice ("acknowledge the failure,
 *     surface the error text verbatim, briefly"). Falls back to the
 *     deterministic template on any model failure (circuit breaker).
 *
 * Rationale (user reframe): errors in the back-mind are typically
 * refusals / web issues / tool failures, and the front-mind LLM is
 * better at making them human-readable than a fixed template — but the
 * verbatim error text must reach the listener intact, so the prompt
 * forces it through.
 *
 * Wiring lives in `nanoclaw/src/channels/realtime.ts` (host-side). This
 * file is pure logic — classification, decision, optional phrasing; the
 * caller does the actual broadcast + log emit.
 */
import Anthropic from '@anthropic-ai/sdk';

import type { LlmCallHook } from './banter.js';
import * as errorSurfacingPrompt from './prompts/error-surfacing.js';
import { parseFastModelSlug } from './llm-provider.js';

/** Error-surfacing currently calls the Anthropic SDK directly (it predates
 *  the provider abstraction). It reads `FAST_MODEL` as a slug and strips
 *  the `anthropic/` prefix to recover the bare model id. If `FAST_MODEL`
 *  routes to a non-Anthropic provider (e.g. `meta-llama/...`), this
 *  call site silently keeps using the default Anthropic Haiku — the
 *  verbatim-error contract is too sensitive for an unstested re-route. */
const ERROR_SURFACING_MODEL = (() => {
  const slug = process.env.FAST_MODEL ?? 'anthropic/claude-haiku-4-5-20251001';
  const routing = parseFastModelSlug(slug);
  if (routing.provider !== 'anthropic') return 'claude-haiku-4-5-20251001';
  return routing.model;
})();
const MAX_CONSECUTIVE_FAILURES = 3;

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) _client = new Anthropic();
  return _client;
}

let _consecutiveFailures = 0;
/** Reset model circuit breaker — for tests. */
export function resetErrorSurfacingFailures(): void {
  _consecutiveFailures = 0;
}

/** Categories of error we surface. Used as the debounce key AND to pick
 *  the one-sentence template in `summarizeForVoice`. */
export type ErrorSource =
  | 'back-mind-tool' // PostToolUseFailure / tool-failed detail row
  | 'back-mind-mcp' // MCP server-side failures (subset of back-mind-tool today; reserved)
  | 'back-mind-sandbox' // container exited non-zero / sandbox crash
  | 'host-routing' // host onInbound dispatch threw (line 2117 today)
  | 'rendition' // back-mind→banter rendition failed; falls back to raw text
  | 'banter' // banter model call short-circuited / failed (circuit breaker)
  | 'narration'; // narration model call short-circuited / failed

/** What the caller hands in. Pure data — no function refs, no SDK
 *  objects, so this module stays trivially testable. */
export interface ErrorInput {
  source: ErrorSource;
  /** Tool name when `source === 'back-mind-tool'`. */
  tool?: string;
  /** The error message text. Caller passes the FULL text (no truncation);
   *  this module decides where to cap (one sentence for the deterministic
   *  template; ~1500 chars for the prompt — see SYSTEM_PROMPT). */
  errorText: string;
}

/** Result of `decideAnnounce` / `phraseErrorAnnounce`. The caller emits
 *  `error.surfaced` with `announced` + `spoken_text` set, and broadcasts
 *  when `announced=true`. */
export interface AnnounceDecision {
  /** `true` ⇒ caller should push `spokenText` through the TTS broadcast
   *  path. `false` ⇒ dashboard-only (flag off, debounced, or
   *  source-suppressed). */
  announced: boolean;
  /** The voice line. Empty string when `announced=false`. With
   *  `phraseErrorAnnounce`, this is model output (with deterministic
   *  fallback). With `decideAnnounce`, always the deterministic template. */
  spokenText: string;
  /** `true` ⇒ this is a debounce-window suppress (a same-source error
   *  fired < `DEBOUNCE_WINDOW_MS` ago). The caller should still emit
   *  `error.surfaced` so forensics shows the suppression rather than a
   *  silent drop. */
  debounceSuppressed: boolean;
}

/** Read once at module import so the flag flip costs nothing per call.
 *  Default ON (`1`). Set `PAT_ANNOUNCE_ERRORS=0` to suppress all voice
 *  announces while keeping dashboard emits. */
export const ANNOUNCE_ERRORS = process.env.PAT_ANNOUNCE_ERRORS !== '0';

/** Per-source debounce window. 3s suppresses the "burst of 5 failures in
 *  one tick" case without hiding genuinely separate failures. */
export const DEBOUNCE_WINDOW_MS = 3_000;

// Per-source last-announce timestamp. Module-global because a single
// realtime channel instance runs the whole process; if we ever spawn
// multiple instances, this becomes wrong and we'd want per-channel
// state passed in.
const lastAnnouncedAt = new Map<ErrorSource, number>();

/** Reset debounce state — for tests. */
export function resetDebounce(): void {
  lastAnnouncedAt.clear();
}

/**
 * Deterministic one-sentence voice line for the given error. Used as the
 * fallback when model phrasing fails (circuit-breaker open, no API key,
 * SDK error). Caller can also use this directly if it wants to bypass
 * the LLM path entirely.
 *
 * Tone: factual, brief, names the failure mode. Mirrors the existing
 * routing-failure line at `realtime.ts:2117`.
 */
export function summarizeForVoice(err: ErrorInput): string {
  const tool = err.tool ? ` (${err.tool})` : '';
  const first = firstSentence(err.errorText);
  switch (err.source) {
    case 'back-mind-tool':
      return first
        ? `Hmm, one of my tools just failed${tool} — ${first}`
        : `Hmm, one of my tools just failed${tool}.`;
    case 'back-mind-mcp':
      return first
        ? `Hmm, an external service call just failed${tool} — ${first}`
        : `Hmm, an external service call just failed${tool}.`;
    case 'back-mind-sandbox':
      return `Hmm, my sandbox just dropped — ${first || 'restarting'}.`;
    case 'host-routing':
      return `Hmm, I couldn't route your message internally — ${first || 'check the host logs'}.`;
    case 'rendition':
      return `Hmm, I had trouble phrasing my reply — passing it through plain.`;
    case 'banter':
      return `Hmm, my front-mind hiccuped — ${first || 'continuing without it'}.`;
    case 'narration':
      return `Hmm, my narration just hiccuped — ${first || 'continuing'}.`;
  }
}

/** Cap the error text at one sentence (or ~120 chars) so the spoken
 *  line stays a single utterance. */
const FIRST_SENTENCE_MAX_CHARS = 120;
function firstSentence(text: string): string {
  if (!text) return '';
  const trimmed = text.trim();
  if (!trimmed) return '';
  // Try to find a sentence boundary within the first 120 chars.
  const head = trimmed.slice(0, FIRST_SENTENCE_MAX_CHARS);
  const m = head.match(/^([^.!?\n]+)[.!?\n]/);
  if (m) return m[1]!.trim();
  // No boundary in the window — return the bounded slice as-is.
  return head.trim();
}

/**
 * Decide whether the caller should announce this error. Pure
 * deterministic. Side effect: stamps `lastAnnouncedAt[source]` when
 * `announced=true` is returned, so subsequent calls within the window
 * are debounce-suppressed.
 *
 * Pass `now` for tests; defaults to `Date.now()`.
 */
export function decideAnnounce(err: ErrorInput, now: number = Date.now()): AnnounceDecision {
  if (!ANNOUNCE_ERRORS) {
    return { announced: false, spokenText: '', debounceSuppressed: false };
  }
  const last = lastAnnouncedAt.get(err.source);
  if (last !== undefined && now - last < DEBOUNCE_WINDOW_MS) {
    return { announced: false, spokenText: '', debounceSuppressed: true };
  }
  lastAnnouncedAt.set(err.source, now);
  return {
    announced: true,
    spokenText: summarizeForVoice(err),
    debounceSuppressed: false,
  };
}

// ──────────────────────── model phrasing ─────────────────────────────

/** Max error text we feed to the model. Beyond this we truncate the middle. */
const HAIKU_ERROR_MAX_CHARS = 1500;

function clampErrorForModel(text: string): string {
  if (!text) return '';
  const t = text.trim();
  if (t.length <= HAIKU_ERROR_MAX_CHARS) return t;
  // Keep head + tail; the middle is the part most likely to be
  // boilerplate (stack frames, etc).
  const headLen = Math.floor(HAIKU_ERROR_MAX_CHARS * 0.6);
  const tailLen = HAIKU_ERROR_MAX_CHARS - headLen - 16;
  return `${t.slice(0, headLen)}\n…[truncated]…\n${t.slice(-tailLen)}`;
}

function toErrorSurfacingContext(err: ErrorInput): errorSurfacingPrompt.ErrorSurfacingContext {
  return {
    source: err.source,
    tool: err.tool,
    errorText: clampErrorForModel(err.errorText),
  };
}

/** Strip wrapping fences/quotes the model occasionally adds. Mirrors
 *  `cleanBanterText` in banter.ts. */
function cleanPhrasing(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^```(?:[a-z]+)?\s*\n?/i, '').replace(/\n?\s*```$/i, '');
  s = s.replace(/^["'`]+|["'`]+$/g, '');
  return s.trim();
}

export interface PhrasingCallbacks {
  /** Optional trace hook — same shape as banter / narration / request-layer.
   *  Use to mirror error-phrasing into the dashboard's llm-call timeline. */
  onCall?: LlmCallHook;
}

/**
 * Ask the model to phrase an error for the user, surfacing the verbatim
 * error text. Returns the spoken line.
 *
 * Failure modes (all return the deterministic `summarizeForVoice`
 * fallback, no throw):
 *   - circuit-breaker open (>= 3 consecutive failures)
 *   - no `ANTHROPIC_API_KEY`
 *   - SDK throw
 *   - empty / silent response
 */
export async function phraseErrorForVoice(
  err: ErrorInput,
  cb?: PhrasingCallbacks,
): Promise<string> {
  const t0 = Date.now();
  const { system, user: userMsg } = errorSurfacingPrompt.render(toErrorSurfacingContext(err));
  const trace = (ok: boolean, response: string | null, error?: string): void => {
    cb?.onCall?.({
      layer: 'error-surfacing:phrase',
      model: ERROR_SURFACING_MODEL,
      systemPrompt: system,
      userMessage: userMsg,
      response,
      latencyMs: Date.now() - t0,
      ok,
      error,
    });
  };
  if (_consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    trace(false, null, 'circuit-breaker open');
    return summarizeForVoice(err);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    _consecutiveFailures += 1;
    trace(false, null, 'no API key');
    return summarizeForVoice(err);
  }
  let response: Anthropic.Message;
  try {
    response = await client().messages.create({
      model: ERROR_SURFACING_MODEL,
      max_tokens: 256,
      system,
      messages: [{ role: 'user', content: userMsg }],
    });
  } catch (err2) {
    _consecutiveFailures += 1;
    trace(false, null, `sdk error: ${(err2 as Error).message}`);
    return summarizeForVoice(err);
  }
  const block = response.content.find((b) => b.type === 'text');
  if (!block || block.type !== 'text') {
    _consecutiveFailures += 1;
    trace(false, null, 'no text block');
    return summarizeForVoice(err);
  }
  const cleaned = cleanPhrasing(block.text);
  if (!cleaned) {
    _consecutiveFailures += 1;
    trace(false, block.text, 'cleaned to empty');
    return summarizeForVoice(err);
  }
  _consecutiveFailures = 0;
  trace(true, cleaned);
  return cleaned;
}

/**
 * Convenience: combine the deterministic `decideAnnounce` with the model
 * phrasing. When the decision is to announce, swap the deterministic
 * `spokenText` with model output (verbatim-error-preserving). When the
 * decision is NOT to announce (flag off / debounce-suppressed), the
 * model call is skipped — no spoken line is needed.
 *
 * Same return shape as `decideAnnounce`, just async. Callers that need
 * pure determinism (e.g. tests) can still call `decideAnnounce` directly.
 */
export async function phraseErrorAnnounce(
  err: ErrorInput,
  cb?: PhrasingCallbacks,
  now: number = Date.now(),
): Promise<AnnounceDecision> {
  const decision = decideAnnounce(err, now);
  if (!decision.announced) return decision;
  const spoken = await phraseErrorForVoice(err, cb);
  return { ...decision, spokenText: spoken };
}
