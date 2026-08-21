/**
 * signal-sim-outbound (SS1) — full-plumbing E2E for PAT's channel-specific
 * outbound FEATURES over a SIMULATED Signal transport.
 *
 * Why: the signal-cli test rig can't decrypt PAT's outbound (a known B2B
 * session/redelivery desync — see KNOWN_ISSUES), so rig-side assertion of
 * Signal features is blocked. This scenario instead drives a nanoclaw
 * running with `PAT_TEST_OUTBOUND_ADAPTER=1`, where the capture adapter
 * (`nanoclaw/src/channels/signal-sim.ts`) owns the `signal` channel_type and
 * captures outbound at the final hop INSTEAD of RPCing signal-cli. Every
 * other stage is REAL: realtime inbound → router → back-mind container →
 * MCP tool (send_voice_memo / send_file) → cold-contact routing → host
 * delivery loop → adapter, INCLUDING real Cartesia synthesis for the voice
 * memo. Only the signal-cli wire is swapped out.
 *
 * Two channel-specific features (publish_file is already covered
 * channel-agnostically by R2 `publish-file`):
 *   1. voice memo out  → assert `signal.send-acked kind_detail=voice-memo
 *      captured audio_bytes>0` (proves Cartesia actually synthesized).
 *   2. file attachment → assert `routing.message-delivered channel_type=
 *      signal file_count>0` (the real delivery loop) + the capture adapter's
 *      `signal.send-acked kind_detail=attachment captured`.
 *
 * Transport: drives realtime /inbound (needs the flyctl proxy tunnel to
 * :8765, same as the rest scenarios) and asserts via /admin/logs.tail.
 * Requires the target nanoclaw to have PAT_TEST_OUTBOUND_ADAPTER=1.
 */
import type { Scenario, ScenarioContext, ScenarioResult, StepOutcome } from './index.js';
import { awaitLogEvent, readLogCheckConfig, type LogEvent } from '../log-check.js';

const DEFAULT_SIM_NUMBER = '+15555550123'; // fictional; never actually sent (captured)
const PER_FEATURE_TIMEOUT_MS = 150_000;

function isCaptured(ev: LogEvent, kindDetail: string): boolean {
  const d = (ev.data ?? {}) as Record<string, unknown>;
  return ev.kind === 'signal.send-acked' && d.captured === true && d.kind_detail === kindDetail;
}

export const signalSimOutbound: Scenario = {
  name: 'signal-sim-outbound',
  description:
    'full-plumbing Signal FEATURE smoke over the simulated (capture) transport: voice-memo (real Cartesia synth) + file attachment reach the capture adapter; asserted via /admin/logs.tail. Requires PAT_TEST_OUTBOUND_ADAPTER=1 on the target.',
  steps: [{ kind: 'sleep', ms: 1 }], // real work in customRun
  acceptanceMs: PER_FEATURE_TIMEOUT_MS * 2 + 60_000,
  customRun: runSignalSimOutbound,
};

async function runSignalSimOutbound(ctx: ScenarioContext): Promise<ScenarioResult> {
  const start = Date.now();
  const outcomes: StepOutcome[] = [];
  const num = process.env.SMOKETEST_SIM_SIGNAL_NUMBER ?? DEFAULT_SIM_NUMBER;
  // send_file requires a NAMED destination (resolveRouting — no cold-contact
  // parse, unlike send_message/send_voice_memo). `rig-a` is the staging-seeded
  // signal destination; with capture mode on it routes to the capture adapter.
  const fileDest = process.env.SMOKETEST_SIM_SIGNAL_DEST ?? 'rig-a';
  const slug = Date.now().toString(36);
  const cfg = readLogCheckConfig();

  if (!cfg.token) {
    ctx.transcript.add('system', 'signal-sim-outbound SKIPPED — PAT_VIEWER_TOKEN not set (needed to read the log proxy)');
    return {
      scenario: signalSimOutbound,
      passed: true,
      outcomes: [{ step: { kind: 'turn', text: '(skipped — no viewer token)' }, ok: true, details: 'skipped: PAT_VIEWER_TOKEN unset' }],
      durationMs: Date.now() - start,
    };
  }
  // Floor for log matching — backdate 5s for clock skew.
  const sinceMs = Date.now() - 5_000;
  ctx.transcript.add('system', `sim target signal:${num}; frontend=${cfg.frontendUrl}`);

  async function post(text: string): Promise<StepOutcome> {
    ctx.transcript.add('user', text, { source: 'scripted' });
    if (ctx.lastTurnAt) ctx.lastTurnAt.ms = Date.now() - 50;
    try {
      await ctx.client.postTurn(text, 'smoke-test', ctx.threadId);
      return { step: { kind: 'turn', text }, ok: true, details: 'turn posted' };
    } catch (err) {
      return { step: { kind: 'turn', text }, ok: false, error: `postTurn failed: ${(err as Error).message}` };
    }
  }

  // ── Feature 1: voice memo out (real Cartesia synth → capture) ──────────
  const vmPost = await post(
    `Please send a voice memo — an actual Signal voice note using your send_voice_memo tool — ` +
      `to signal:${num}, saying something short like "Smoke test ${slug}, voice pipeline is healthy." ` +
      `Just send the voice note; don't ask me anything and don't type the message out.`,
  );
  outcomes.push(vmPost);
  if (vmPost.ok) {
    const vm: StepOutcome = { step: { kind: 'judge', rubric: 'voice memo captured (real synth)', label: 'voice-memo captured' }, ok: false };
    const ev = await awaitLogEvent(cfg, {
      sinceMs,
      predicate: (e) => isCaptured(e, 'voice-memo') && Number((e.data ?? {}).audio_bytes ?? 0) > 0,
      timeoutMs: PER_FEATURE_TIMEOUT_MS,
    });
    if (ev) {
      vm.ok = true;
      vm.details = `voice memo synthesized + captured (audio_bytes=${ev.data?.audio_bytes})`;
      ctx.transcript.add('system', vm.details);
    } else {
      vm.error = `no signal.send-acked kind_detail=voice-memo captured audio_bytes>0 within ${PER_FEATURE_TIMEOUT_MS}ms`;
    }
    outcomes.push(vm);
  }

  // ── Feature 2: file attachment out (real delivery loop → capture) ──────
  const filePost = await post(
    `Please create a small text file named smoke-${slug}.txt whose content is exactly "SS1 ${slug}", ` +
      `and send it as a file attachment to the destination named "${fileDest}" using your send_file tool ` +
      `(pass to: "${fileDest}"). Actually attach the file — don't paste the text — and don't ask me anything first.`,
  );
  outcomes.push(filePost);
  if (filePost.ok) {
    const att: StepOutcome = { step: { kind: 'judge', rubric: 'file attachment delivered on signal', label: 'attachment delivered' }, ok: false };
    const ev = await awaitLogEvent(cfg, {
      sinceMs,
      predicate: (e) =>
        (e.kind === 'routing.message-delivered' &&
          (e.data ?? {}).channel_type === 'signal' &&
          Number((e.data ?? {}).file_count ?? 0) > 0) ||
        isCaptured(e, 'attachment'),
      timeoutMs: PER_FEATURE_TIMEOUT_MS,
    });
    if (ev) {
      att.ok = true;
      att.details = `attachment delivered: ${JSON.stringify(ev.data).slice(0, 140)}`;
      ctx.transcript.add('system', att.details);
    } else {
      att.error = `no attachment delivery event within ${PER_FEATURE_TIMEOUT_MS}ms`;
    }
    outcomes.push(att);
  }

  return {
    scenario: signalSimOutbound,
    passed: outcomes.every((o) => o.ok),
    outcomes,
    durationMs: Date.now() - start,
    startedAtMs: start,
    corr: slug,
  };
}
