/**
 * Banter dispatch — per-`<say>` Haiku rewrite.
 *
 * Each spoken beat inside a `<timeline>` runs through this layer before
 * being broadcast to TTS. The authored line (written by a slide
 * author or emitted by the back-mind) becomes a Pat-voiced delivery
 * with optional inline emotion / pause tags layered on. Meaning and
 * every precise claim are preserved — the prompt enforces this.
 *
 * Replaces today's "rewrite the whole chat row" rendition path for
 * tag-stream scenarios. See `plans/timeline-runtime-and-scenarios.md`
 * §3.4 (Banter Dispatch) and §4 Phase 3 for the architectural role.
 *
 * Contract:
 *   - `ok: true`  → broadcast `rewritten`.
 *   - `ok: false` → caller falls back to the raw say.text (no API key,
 *                   circuit breaker open, SDK error, empty output).
 *   - Always emits a `banter-dispatch.called` structured log event.
 *
 * The Anthropic SDK is the same client `banter.ts` uses. Failures here
 * do NOT participate in `banter.ts`'s circuit breaker — banter-dispatch
 * has its own consecutive-failure counter so a TTS-side outage doesn't
 * also blank the ack layer (and vice versa).
 */
import Anthropic from '@anthropic-ai/sdk';

import type { BanterHistoryEntry, LlmCallHook } from './banter.js';
import { formatHistory } from './banter.js';
import * as banterDispatchPrompt from './prompts/banter-dispatch.js';
import type { ScenarioContext } from './prompts/_scenario-context.js';
import { parseFastModelSlug } from './llm-provider.js';

/** banter-dispatch predates the provider abstraction and calls the
 *  Anthropic SDK directly. It reads `FAST_MODEL` as a slug and uses
 *  the model id portion. If `FAST_MODEL` is non-Anthropic, falls
 *  back to the prod Haiku id rather than risk a mid-rewrite failure. */
const BANTER_DISPATCH_MODEL = (() => {
  const slug = process.env.FAST_MODEL ?? 'anthropic/claude-haiku-4-5-20251001';
  const routing = parseFastModelSlug(slug);
  if (routing.provider !== 'anthropic') return 'claude-haiku-4-5-20251001';
  return routing.model;
})();
const MAX_TOKENS = 512;
const MAX_CONSECUTIVE_FAILURES = 3;

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) _client = new Anthropic();
  return _client;
}

let _consecutiveFailures = 0;
/** Test helper — reset the circuit-breaker counter between tests. */
export function resetBanterDispatchFailures(): void {
  _consecutiveFailures = 0;
}

/** One authored beat handed to the dispatcher. */
export interface BanterDispatchSay {
  /** Authored prose — the substance of this spoken beat. */
  text: string;
  /** Optional element id this say is ABOUT. Threaded into the prompt
   *  as a delivery hint; no behavior depends on it. */
  target?: string;
}

export interface BanterDispatchInput {
  /** The authored say to rewrite. */
  say: BanterDispatchSay;
  /** Optional scenario meta when running in scenario mode — threads
   *  tone/persona into the prompt (overrides default Pat voice). */
  scenario?: ScenarioContext | null;
  /** Recent conversation history for continuity. Oldest first.
   *  Rendered via `formatHistory` into the prompt's <history> block. */
  recentHistory?: BanterHistoryEntry[];
  /** Optional trace hook — same `LlmCallTrace` shape banter / narration
   *  emit. The dashboard renders the system+user prompts and the
   *  response for forensics. */
  onCall?: LlmCallHook;
  /** Optional abort signal — e.g. barge-in cancels the in-flight
   *  rewrite. AbortError is mapped to `ok: false` with the raw text. */
  signal?: AbortSignal;
}

export interface BanterDispatchOutput {
  /** The Pat-voiced rewrite (with optional inline voice tags) on
   *  success. On failure equals `raw` so callers that always
   *  broadcast `rewritten` still get sensible output — but they
   *  SHOULD branch on `ok` and log the difference. */
  rewritten: string;
  /** The authored input text — handed back unchanged so callers and
   *  log consumers can compare what came in vs what got broadcast. */
  raw: string;
  /** Wall-clock ms from call start to result (or failure). */
  latency_ms: number;
  /** True iff the rewrite came from a healthy model call. False on
   *  no-API-key, circuit-breaker open, SDK error, empty output, or
   *  AbortError. Caller falls back to `raw` when false. */
  ok: boolean;
  /** Failure reason when `ok=false`. Omitted on success. */
  error?: string;
}

/**
 * Banter-dispatch.called structured log event payload — what the
 * caller pushes through its structured logger. The event kind is
 * declared in `realtime/src/log-events.ts`.
 */
export interface BanterDispatchCalledLogData {
  input_text: string;
  output_text: string;
  latency_ms: number;
  ok: boolean;
  /** Failure reason when ok=false. */
  error?: string;
}

/**
 * Rewrite one authored `<say>` in Pat's voice via a Haiku call.
 * Pure function on the input shape; the caller is responsible for
 * any structured-log emit (see `BanterDispatchCalledLogData`).
 *
 * Failure modes (all return `{ ok: false, rewritten: raw, ... }`):
 *   - `ANTHROPIC_API_KEY` missing
 *   - Consecutive-failure circuit breaker open (3+ failures)
 *   - SDK throw (network, rate-limit, validation)
 *   - Model returned no text block
 *   - Cleaned output is empty
 *   - Caller aborted (signal.aborted)
 */
export async function banterDispatch(input: BanterDispatchInput): Promise<BanterDispatchOutput> {
  const t0 = Date.now();
  const raw = input.say.text;
  const ctx: banterDispatchPrompt.BanterDispatchContext = {
    authoredText: raw,
    target: input.say.target,
    history:
      input.recentHistory && input.recentHistory.length > 0
        ? formatHistory(input.recentHistory)
        : '',
    scenario: input.scenario ?? null,
  };
  const { system, user: userMsg } = banterDispatchPrompt.render(ctx);

  const trace = (ok: boolean, response: string | null, error?: string): void => {
    input.onCall?.({
      layer: 'banter:dispatch',
      model: BANTER_DISPATCH_MODEL,
      systemPrompt: system,
      userMessage: userMsg,
      response,
      latencyMs: Date.now() - t0,
      // banter-dispatch uses Anthropic SDK directly (not FastLlmProvider),
      // so HTTP-level timing (ttfb / connection_reused / connect_ms) is
      // not available here. promptChars IS — it's the prompt length we
      // computed locally above.
      promptChars: system.length + userMsg.length,
      provider: 'anthropic',
      ok,
      error,
    });
  };

  const fail = (reason: string): BanterDispatchOutput => {
    return { rewritten: raw, raw, latency_ms: Date.now() - t0, ok: false, error: reason };
  };

  if (input.signal?.aborted) {
    trace(false, null, 'aborted');
    // Don't count caller-cancels toward the circuit breaker.
    return fail('aborted');
  }

  if (_consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    trace(false, null, 'circuit-breaker open');
    return fail('circuit-breaker open');
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    _consecutiveFailures += 1;
    trace(false, null, 'no API key');
    return fail('no API key');
  }

  let response: Anthropic.Message;
  try {
    response = await client().messages.create(
      {
        model: BANTER_DISPATCH_MODEL,
        max_tokens: MAX_TOKENS,
        system,
        messages: [{ role: 'user', content: userMsg }],
      },
      input.signal ? { signal: input.signal } : undefined,
    );
  } catch (err) {
    const e = err as Error;
    if (e?.name === 'AbortError' || input.signal?.aborted) {
      // Don't count cancels toward the breaker.
      trace(false, null, 'aborted');
      return fail('aborted');
    }
    _consecutiveFailures += 1;
    trace(false, null, `sdk error: ${e.message}`);
    return fail(`sdk error: ${e.message}`);
  }

  const block = response.content.find((b) => b.type === 'text');
  if (!block || block.type !== 'text') {
    _consecutiveFailures += 1;
    trace(false, null, 'no text block');
    return fail('no text block');
  }
  const cleaned = cleanDispatchText(block.text);
  if (!cleaned) {
    _consecutiveFailures += 1;
    trace(false, block.text, 'cleaned to empty');
    return fail('cleaned to empty');
  }

  _consecutiveFailures = 0;
  trace(true, cleaned);
  return { rewritten: cleaned, raw, latency_ms: Date.now() - t0, ok: true };
}

/**
 * Strip outer code fences and wrapping quotes the model occasionally
 * emits despite the prompt telling it not to. Preserves inline voice
 * tags (`<emotion>`, `<break/>`, `<spell>`, `[laughter]`) verbatim.
 *
 * Multi-line output is preserved — a beat may legitimately want a
 * paragraph break. The downstream TTS path handles newlines fine.
 */
function cleanDispatchText(raw: string): string {
  let s = raw.trim();
  // Code fence wrap (opening + closing).
  s = s.replace(/^```(?:[a-z]+)?\s*\n?/i, '').replace(/\n?\s*```$/i, '');
  // Wrapping straight quotes / backticks. We only strip OUTER quotes —
  // inner punctuation (apostrophes, em-dashes, quoted words mid-line)
  // is untouched.
  s = s.replace(/^["'`]+|["'`]+$/g, '');
  return s.trim();
}
