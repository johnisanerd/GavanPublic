/**
 * Scenario types + the scenario engine.
 *
 * A scenario is a sequence of `Step`s — turns (literal or LLM-driven), waits
 * for SSE events, sleeps, and judge calls. The engine wires up a
 * RealtimeClient and a Transcript, runs each step, and returns the result.
 */
import { isBackMindReply, type RealtimeClient, type SseEvent } from '../client.js';
import { SimulatedUser } from '../simulated-user.js';
import { judge, type JudgeVerdict } from '../judge.js';
import type { Transcript } from '../transcript.js';
import { audioModeAvailable, roundTrip } from '../audio.js';
import type { CartesiaCallClient } from '../cartesia-call.js';

export interface ScenarioContext {
  client: RealtimeClient;
  transcript: Transcript;
  user: SimulatedUser | null;
  /**
   * Routes user turns to a specific NanoClaw session (and thus a specific
   * back-mind container). Stable per scenario name keeps each scenario's
   * memory isolated while reusing warm containers across reruns.
   */
  threadId?: string;
  /**
   * Tier 3A — when set, user turns route through Cartesia's WS Calls API
   * (TTS user audio in, capture agent audio out). The SSE tap to nanoclaw
   * stays open in parallel for structural assertions; this just changes
   * how user turns reach the system.
   */
  call?: CartesiaCallClient;
  /** Tier 3T-only — TTS+STT round-trip user turns before POSTing. */
  audio?: { enabled: boolean; persistDir?: string };
  /**
   * Channel name from `--channel-probe=<name>` — scenarios that opt
   * into dispatch-probe mode use this to know which dummy adapter on
   * the host they should be asserting against (e.g. `signal-test`).
   */
  channelProbe?: string;
  /** Mutated by the engine; used by audio.ts for per-turn filenames. */
  turnIndex?: { value: number };
  /**
   * Wall-clock timestamp of the most recent user turn. wait-* steps use
   * this as the floor for which events count, so a stale chat from a
   * previous turn that's still buffered in the SSE channel can't
   * auto-satisfy a fresh wait against this turn.
   */
  lastTurnAt?: { ms: number };
}

export type Step =
  | { kind: 'turn'; text: string }                                          // hard-coded user turn
  | { kind: 'sim-turn' }                                                    // ask sim user for next turn
  | { kind: 'wait-utterance'; within: number; matching?: RegExp; label?: string }
  | { kind: 'wait-chat'; within: number; matching?: RegExp; label?: string }
  | { kind: 'sleep'; ms: number }
  | { kind: 'judge'; rubric: string; label?: string }
  | { kind: 'expect-no-event'; within: number; eventKind?: string; label?: string }
  // PAT: arbitrary async assertion over the live context (fetch a URL the
  // agent produced, query patobs, poke an endpoint). Return ok:false with
  // details to fail the scenario. Keeps side-effect checks OUT of judge
  // rubrics — the judge reads transcripts, checks touch the world.
  | { kind: 'check'; label?: string; fn: (ctx: ScenarioContext) => Promise<{ ok: boolean; details?: string }> };

/** Which transport a scenario drives. Selects env setup + how the runner
 *  scopes the emitted log query. rest = /inbound+/outbound SSE (text);
 *  call = real Cartesia voice WS; signal = rig → PAT over Signal. */
export type SmokeChannel = 'rest' | 'call' | 'signal';
/** Coverage tier: quick = one liveness path; thorough = full feature set. */
export type SmokeTier = 'quick' | 'thorough';

export interface Scenario {
  name: string;
  /** Stable short test ID (e.g. 'R1','C1','S4') — how the runner selects a
   *  single test. Set in the registry's SCENARIO_META. */
  sid?: string;
  /** Channel this scenario drives (set in SCENARIO_META). */
  channel?: SmokeChannel;
  /** Tiers this scenario belongs to (set in SCENARIO_META). */
  tiers?: SmokeTier[];
  description: string;
  /** Persona / goal for the simulated user (only used when `sim-turn` steps are present). */
  user?: { persona: string; goal: string; maxTurns?: number; model?: string };
  steps: Step[];
  /** Overall budget — engine aborts after this many ms. */
  acceptanceMs: number;
  /** If any judge step fails, the scenario fails as a whole. */
  /**
   * Optional override — scenarios that need to drive a side-channel
   * (Cartesia WS, admin SSE, dispatch probe, etc.) can implement their
   * own runner and the engine will delegate. `steps` becomes
   * decorative in that case; the engine still publishes it for the CLI
   * `pnpm scenario --help` output.
   */
  customRun?: (ctx: ScenarioContext) => Promise<ScenarioResult>;
  /**
   * When false, the runner skips connecting to the local NanoClaw
   * `/outbound` SSE before invoking `customRun`. Use for scenarios that
   * target a remote (e.g. prod) host entirely through HTTP polling and
   * don't need the realtime SSE tap. Default is true (every other
   * scenario in this package drives the local channel).
   *
   * `ctx.client` is still constructed so customRun has access to
   * postTurn / waitFor surface area if it opts in, but `connect()` is
   * not called.
   */
  requiresLocalClient?: boolean;
}

export interface StepOutcome {
  step: Step;
  ok: boolean;
  details?: string;
  judgeVerdict?: JudgeVerdict;
  event?: SseEvent;
  error?: string;
}

export interface ScenarioResult {
  scenario: Scenario;
  passed: boolean;
  outcomes: StepOutcome[];
  durationMs: number;
  /** Epoch ms when this scenario started — used to scope the log query. */
  startedAtMs?: number;
  /** Correlation token the scenario stamped into its messages (if any),
   *  so the emitted log query can text-match this exact run. */
  corr?: string;
}

async function postTurnMaybeAudio(
  ctx: ScenarioContext,
  text: string,
  source: string,
  extraMeta: Record<string, unknown> = {},
): Promise<{ ok: true; posted: string } | { ok: false; error: string }> {
  // Stamp the turn time so subsequent wait-* steps gate on it. Slight
  // backdate (50ms) so SSE events that race the POST don't get filtered.
  if (ctx.lastTurnAt) ctx.lastTurnAt.ms = Date.now() - 50;
  // Tier 3A — Cartesia WS Calls transport. User turn becomes TTS'd PCM
  // streamed into the WS. The SSE tap to nanoclaw still observes /outbound
  // for structural assertions, so wait-* steps work unchanged.
  if (ctx.call) {
    ctx.transcript.add('user', text, { source, ...extraMeta, transport: 'cartesia-ws' });
    try {
      await ctx.call.sendUserTurn(text);
      return { ok: true, posted: text };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
  // Default to text mode. Audio mode rewrites the user's text by routing it
  // through Cartesia TTS+STT, capturing the WAV + transcript artifacts.
  let toPost = text;
  let metadata: Record<string, unknown> = { source, ...extraMeta };
  if (ctx.audio?.enabled) {
    if (!audioModeAvailable()) {
      ctx.transcript.add('system', 'audio mode requested but CARTESIA_API_KEY not set; falling back to text');
    } else {
      try {
        const turnIdx = ctx.turnIndex ? ctx.turnIndex.value++ : 0;
        const r = await roundTrip(text, { persistDir: ctx.audio.persistDir, turnIndex: turnIdx });
        toPost = r.transcribedText || text;
        metadata = {
          ...metadata,
          audio: { input: text, transcribed: r.transcribedText, latencyMs: r.latencyMs, wav: r.audioPath },
        };
      } catch (err) {
        ctx.transcript.add('system', `audio mode error (falling back to text): ${(err as Error).message}`);
      }
    }
  }
  ctx.transcript.add('user', toPost, metadata);
  try {
    await ctx.client.postTurn(toPost, 'smoke-test', ctx.threadId);
    return { ok: true, posted: toPost };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function runScenario(scenario: Scenario, ctx: ScenarioContext): Promise<ScenarioResult> {
  // Custom-run scenarios drive their own side-channels (admin SSE, live
  // prod log proxy, Cartesia WS, dispatch probe) and replace the step
  // engine entirely. `steps` is decorative in that case — listed only
  // so `pnpm scenario --help` shows what the scenario probes.
  if (scenario.customRun) {
    return scenario.customRun(ctx);
  }

  const start = Date.now();
  const outcomes: StepOutcome[] = [];
  let aborted = false;

  for (const step of scenario.steps) {
    if (Date.now() - start > scenario.acceptanceMs) {
      outcomes.push({ step, ok: false, error: 'scenario budget exceeded' });
      aborted = true;
      break;
    }

    const outcome = await runStep(step, ctx, scenario);
    outcomes.push(outcome);
    if (!outcome.ok && step.kind !== 'expect-no-event') {
      // wait-* timeouts and judge failures are scenario-level fails.
      // We continue executing remaining steps so the transcript is full,
      // but flag aborted so the final verdict is fail.
      aborted = true;
    }
  }

  return {
    scenario,
    passed: !aborted && outcomes.every((o) => o.ok),
    outcomes,
    durationMs: Date.now() - start,
  };
}

async function runStep(step: Step, ctx: ScenarioContext, _scenario: Scenario): Promise<StepOutcome> {
  switch (step.kind) {
    case 'turn': {
      const posted = await postTurnMaybeAudio(ctx, step.text, 'scripted');
      if (!posted.ok) return { step, ok: false, error: posted.error };
      ctx.user?.noteScriptedTurn();
      return { step, ok: true, details: posted.posted };
    }
    case 'sim-turn': {
      if (!ctx.user) {
        return { step, ok: false, error: 'sim-turn requested but scenario has no user persona' };
      }
      const resp = await ctx.user.respondTo(ctx.transcript.all());
      if (resp.type === 'end') {
        ctx.transcript.add('system', `sim user ended: ${resp.reason}`);
        return { step, ok: true, details: `end: ${resp.reason}` };
      }
      const posted = await postTurnMaybeAudio(ctx, resp.text, 'sim-user', { reason: resp.reason });
      if (!posted.ok) return { step, ok: false, error: posted.error };
      return { step, ok: true, details: posted.posted };
    }
    case 'wait-utterance': {
      try {
        const ev = await ctx.client.waitFor(
          (e) => e.kind === 'realtime-utterance' && (!step.matching || step.matching.test(e.text)),
          step.within,
          step.label ?? `utterance${step.matching ? ` matching ${step.matching}` : ''}`,
          ctx.lastTurnAt?.ms,
        );
        return { step, ok: true, event: ev };
      } catch (err) {
        return { step, ok: false, error: (err as Error).message };
      }
    }
    case 'wait-chat': {
      try {
        // PAT: accept both wire shapes of a back-mind reply — kind='chat'
        // (non-streaming) and utterance-end/source='banter-rendition'
        // (PAT_STREAMING_BANTER deployments; staging+prod). See
        // client.isBackMindReply.
        const ev = await ctx.client.waitFor(
          (e) => isBackMindReply(e) && (!step.matching || step.matching.test(e.text)),
          step.within,
          step.label ?? `chat${step.matching ? ` matching ${step.matching}` : ''}`,
          ctx.lastTurnAt?.ms,
        );
        return { step, ok: true, event: ev };
      } catch (err) {
        return { step, ok: false, error: (err as Error).message };
      }
    }
    case 'sleep': {
      await new Promise((r) => setTimeout(r, step.ms));
      return { step, ok: true };
    }
    case 'check': {
      // PAT: see the Step union — world-touching assertion, transcript-logged.
      try {
        const r = await step.fn(ctx);
        ctx.transcript.add('system', `check ${step.label ?? ''}: ${r.ok ? 'PASS' : 'FAIL'} — ${r.details ?? ''}`);
        return { step, ok: r.ok, details: r.details };
      } catch (err) {
        return { step, ok: false, error: (err as Error).message };
      }
    }
    case 'judge': {
      const verdict = await judge(step.rubric, ctx.transcript.all());
      ctx.transcript.add('judge', `${step.label ?? 'rubric'}: ${verdict.passed ? 'PASS' : 'FAIL'} — ${verdict.reason}`, {
        rubric: step.rubric,
        verdict,
      });
      return { step, ok: verdict.passed, judgeVerdict: verdict };
    }
    // No-op closing brace continues into expect-no-event below.
    case 'expect-no-event': {
      // Inverse: success iff no matching event arrives within the window.
      try {
        const ev = await ctx.client.waitFor(
          (e) => !step.eventKind || e.kind === step.eventKind,
          step.within,
          step.label ?? `unexpected ${step.eventKind ?? 'event'}`,
        );
        return { step, ok: false, error: `unexpected event: kind=${ev.kind} text=${ev.text.slice(0, 80)}`, event: ev };
      } catch {
        return { step, ok: true };
      }
    }
  }
}
