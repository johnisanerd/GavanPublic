/**
 * Request layer (Sonnet) — observes the conversation and decides when
 * something has crossed the threshold from banter into "actionable
 * request" that needs the back-mind.
 *
 * Runs AFTER the banter layer has produced its response (so the request
 * layer can judge whether the banter response covered the user's intent).
 * If banter was inadequate, the request layer emits a `clarifyHint` for
 * the orchestrator to invoke the banter layer again with.
 *
 * Architectural invariant: the request layer NEVER speaks directly to the
 * user. Any clarifying speech is cued through the banter layer (which
 * holds Pat's personality + voice).
 *
 * This first cut handles two outcomes: noop (still banter, no
 * back-mind work) and forward (write a chat row, wake the back-mind).
 * Cancel / refine / new-task semantics will land separately when the
 * cancel-call API exists.
 */
import * as requestLayerPrompt from './prompts/request-layer.js';
import type { CallerContext } from './prompts/_capability-context.js';
import type { ScenarioContext } from './prompts/_scenario-context.js';
import type { BackMindState } from './state.js';
import { renderBackMindState } from './state.js';
import type { BanterHistoryEntry, LlmCallHook } from './banter.js';
import { formatHistory } from './banter.js';
import { getFastProvider, awaitJson } from './llm-provider.js';

const MAX_CONSECUTIVE_FAILURES = 3;

let _consecutiveFailures = 0;
export function resetRequestLayerFailures(): void {
  _consecutiveFailures = 0;
}

export interface RequestLayerRequest {
  /** What the user just said. */
  userText: string;
  /** Working-memory snapshot — what's in flight on the back-mind side. */
  backMindState: BackMindState;
  /** Unified conversation history (oldest first, most recent last). */
  history?: BanterHistoryEntry[];
  /**
   * The banter response Pat just produced for this user message. Used
   * to judge whether banter adequately covered the user's intent.
   */
  banterResponse: string | null;
  /**
   * Authoritative "is the back-mind currently processing a query?" flag,
   * sourced from the agent-runner's `query-start`/`query-end` lifecycle
   * events. When false, no back-mind work is in flight regardless of
   * what the conversation history might suggest. This trumps any
   * inference Sonnet might make from banter promises like "lemme look
   * that up" — banter saying it doesn't make it true.
   *
   * Default false: callers that don't (yet) plumb the bit through get
   * the safer "assume idle, forward freely" behavior, which is closer
   * to the right answer than the previous "infer from prose" path.
   */
  isProcessing?: boolean;
  /** Optional: scenario meta when running in scenario mode. Threaded
   *  into the request-layer's SYSTEM prompt via the partial in
   *  `prompts/_scenario-context.ts`. When set, the model is told
   *  that "begin" / "go ahead" / "audience ready" are SCENARIO CUES
   *  to forward, not chitchat to noop. */
  scenario?: ScenarioContext | null;
  /** Agent group identifier for this inbound. Drives the install-side
   *  capability lookup inside the prompt's render(). */
  agentGroupId?: string | null;
  /** Optional: per-inbound caller context — identity, known handles,
   *  permissions. Threaded into the request-layer USER message via
   *  `prompts/_capability-context.ts`. */
  callerContext?: CallerContext | null;
  /** Optional: receive a trace of the LLM call. */
  onCall?: LlmCallHook;
}

export type RequestLayerDecision =
  | { decision: 'noop'; reason?: string }
  | {
      decision: 'forward';
      /**
       * The directive forwarded to the back-mind. Should read as the user
       * still speaking (literal user words OR first-person user-voice
       * paraphrase). NEVER first-person agent voice ("I'll do X").
       */
      invokeText: string;
      reason?: string;
    }
  | { decision: 'silent'; reason?: string };

function toRequestLayerContext(req: RequestLayerRequest): requestLayerPrompt.RequestLayerContext {
  return {
    backMindState: renderBackMindState(req.backMindState),
    history: req.history && req.history.length > 0 ? formatHistory(req.history) : '',
    isProcessing: req.isProcessing === true,
    userText: req.userText,
    banterResponse: req.banterResponse,
    scenario: req.scenario,
    agentGroupId: req.agentGroupId,
    callerContext: req.callerContext,
  };
}

/**
 * One Sonnet call to decide noop / forward / silent. Returns a `silent`
 * decision on any failure path (network, JSON corruption, model returned
 * unparseable shape, missing API key, rate-limited). Tracks consecutive
 * failures and short-circuits after 3 — silence is the safe fallback,
 * the user already heard the banter response.
 */
export async function requestLayerOnUserMessage(req: RequestLayerRequest): Promise<RequestLayerDecision> {
  const t0 = Date.now();
  const { system, user: userMsg } = requestLayerPrompt.render(toRequestLayerContext(req));
  const provider = getFastProvider('request-layer');
  let lastRaw: import('./llm-provider.js').FastLlmResult | null = null;
  const trace = (ok: boolean, response: string | null, error?: string): void => {
    req.onCall?.({
      layer: 'request-layer',
      model: provider.model,
      systemPrompt: system,
      userMessage: userMsg,
      response,
      latencyMs: Date.now() - t0,
      ttfbMs: lastRaw?.ttfbMs,
      connectionReused: lastRaw?.connectionReused,
      connectMs: lastRaw?.connectMs,
      provider: lastRaw?.provider,
      upstreamProvider: lastRaw?.upstreamProvider,
      inputTokens: lastRaw?.usage?.inputTokens,
      outputTokens: lastRaw?.usage?.outputTokens,
      promptChars: lastRaw?.promptChars ?? system.length + userMsg.length,
      ok,
      error,
    });
  };
  if (_consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    trace(false, null, 'circuit-breaker open');
    return { decision: 'silent', reason: 'circuit-breaker open' };
  }
  const result = await awaitJson(provider, {
    system,
    user: userMsg,
    maxTokens: 512,
  });
  lastRaw = result.raw;
  if (!result.ok) {
    _consecutiveFailures += 1;
    trace(false, result.raw.text, result.error);
    return { decision: 'silent', reason: result.error };
  }
  const validated = validate(result.data);
  if (!validated) {
    _consecutiveFailures += 1;
    trace(false, result.raw.text, 'failed validation');
    return { decision: 'silent', reason: 'failed validation' };
  }
  _consecutiveFailures = 0;
  trace(true, result.raw.text);
  return validated;
}

function validate(raw: unknown): RequestLayerDecision | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const d = o.decision;
  if (d === 'noop' || d === 'silent') {
    return { decision: d, reason: typeof o.reason === 'string' ? o.reason : undefined };
  }
  if (d === 'forward') {
    if (typeof o.invokeText !== 'string' || o.invokeText.length === 0) return null;
    return {
      decision: 'forward',
      invokeText: o.invokeText,
      reason: typeof o.reason === 'string' ? o.reason : undefined,
    };
  }
  return null;
}

