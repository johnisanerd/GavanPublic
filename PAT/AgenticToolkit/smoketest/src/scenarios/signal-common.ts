/**
 * Shared plumbing for the STAGING Signal feature scenarios .
 *
 * Design: assertions live on the RIG side. The rig ("Smoke McGee",
 * pat-signal-rig) sends a request to staging PAT over real Signal, and we
 * observe what PAT SENDS BACK on the rig's WS (PAT's outbound arrives at the
 * rig as an `inbound.*` event). That keeps these scenarios self-contained —
 * they need only the rig bearer token, no log tunnel / viewer token / local
 * NanoClaw SSE. So every one runs with `requiresLocalClient = false`.
 *
 * Why observe on the rig instead of the logs: for voice memos especially,
 * the rig's `inbound.voice-memo` classification (a voiceNote-flagged
 * attachment) is the ONLY signal that distinguishes a true native voice note
 * from PAT's two silent fallbacks (Cartesia-fail → plain text;
 * staging-sidecar-down → generic audio tile). See
 * `nanoclaw/src/channels/signal.ts` sendVoiceNote + KNOWN_ISSUES.
 *
 * Addressing: the rig sends TO staging PAT's E.164 (`HOST_SIGNAL_ACCOUNT` =
 * +15550100004). PAT replies FROM that identity; we match the rig event's
 * sender against PAT's known ids (E.164 and optional ACI UUID). The kind
 * filter (`inbound.text`/`.voice-memo`/`.attachment`) already excludes our
 * own echoed sends (which classify as `inbound.sync.*`), so sender-matching
 * is belt-and-suspenders, not load-bearing.
 */
import type { ScenarioContext, ScenarioResult, StepOutcome, Scenario } from './index.js';
import { SignalRig, eventFromSender, type RigEvent } from '../signal-rig.js';

const DEFAULT_RIG_URL = 'https://pat-signal-rig.fly.dev';
const DEFAULT_PAT_STAGING_E164 = '+15550100004';
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_WS_WARMUP_MS = 1_500;

export interface SignalFeatureConfig {
  rig: SignalRig;
  rigUrl: string;
  /** Staging PAT's Signal number the rig sends TO. */
  patE164: string;
  /** All ids we may see PAT's replies come FROM (E.164 + optional ACI UUID). */
  patSenderIds: string[];
  /** Overall per-scenario budget for the request→reply round trip. */
  timeoutMs: number;
  /** Grace period to let the rig WS finish connecting before we send, so we
   *  don't miss a fast reply. Reply is seconds away (cold start + LLM +
   *  synth), so a ~1.5s warmup is ample. */
  wsWarmupMs: number;
}

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Build the config, or return a skip reason if the rig token is absent (so
 * the broader suite stays green on machines without staging creds).
 */
export function signalFeatureConfigOrSkip(): { cfg: SignalFeatureConfig } | { skip: string } {
  const rigToken = process.env.PAT_SIGNAL_RIG_TOKEN ?? '';
  if (!rigToken) return { skip: 'PAT_SIGNAL_RIG_TOKEN not set' };

  const rigUrl = (process.env.PAT_SIGNAL_RIG_A_URL ?? DEFAULT_RIG_URL).replace(/\/$/, '');
  const patE164 = process.env.PAT_SIGNAL_STAGING_E164 ?? DEFAULT_PAT_STAGING_E164;
  const patUuid = process.env.PAT_SIGNAL_STAGING_UUID; // optional ACI UUID
  const patSenderIds = [patE164, patUuid].filter((x): x is string => !!x);

  return {
    cfg: {
      rig: new SignalRig({ url: rigUrl, token: rigToken }),
      rigUrl,
      patE164,
      patSenderIds,
      timeoutMs: numEnv('SMOKETEST_SIGNAL_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
      wsWarmupMs: numEnv('SMOKETEST_SIGNAL_WS_WARMUP_MS', DEFAULT_WS_WARMUP_MS),
    },
  };
}

/**
 * Open the rig's WS tap for `kindPrefix`, wait a warmup beat so it's
 * connected, then send `text` from the rig to staging PAT and resolve with
 * the FIRST matching event (or null on timeout). Opening BEFORE sending
 * avoids racing a fast reply.
 */
export async function rigRequestAndAwait(
  cfg: SignalFeatureConfig,
  opts: { text: string; kindPrefix: string; match: (e: RigEvent) => boolean; timeoutMs?: number },
): Promise<RigEvent | null> {
  const waiting = cfg.rig.waitForEvent({
    kindPrefix: opts.kindPrefix,
    timeoutMs: opts.timeoutMs ?? cfg.timeoutMs,
    match: opts.match,
  });
  await sleep(cfg.wsWarmupMs);
  await cfg.rig.sendText(cfg.patE164, opts.text);
  return waiting;
}

/** Does this rig event come from staging PAT (vs. some other party)? */
export function fromPat(e: RigEvent, cfg: SignalFeatureConfig): boolean {
  // If we have no ids to match against, don't gate on sender (kind filter
  // already excludes our own sync echoes).
  return cfg.patSenderIds.length === 0 || eventFromSender(e, cfg.patSenderIds);
}

/** Build a skip-as-pass result (missing creds — don't redden the suite). */
export function skipResult(scenario: Scenario, start: number, reason: string, ctx: ScenarioContext): ScenarioResult {
  ctx.transcript.add('system', `${scenario.name} SKIPPED — ${reason}`);
  return {
    scenario,
    passed: true,
    outcomes: [{ step: { kind: 'turn', text: '(skipped — env not set)' }, ok: true, details: `skipped: ${reason}` }],
    durationMs: Date.now() - start,
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type { RigEvent, StepOutcome };
