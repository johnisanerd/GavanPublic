/**
 * S4 signal-voice-memo — real feature over real Signal: the rig asks staging
 * PAT to send a voice note; we assert a TRUE native voice note arrives.
 *
 * Chain: Signal inbound → router → back-mind → send_voice_memo MCP → host
 * send_voice_memo action → Cartesia Sonic synth → opus/ogg → pat-transports
 * staging sidecar (staged /tmp path) → signal-cli send {voiceNote:true} →
 * rig observes inbound.voice-memo.
 *
 * Why assert on inbound.voice-memo specifically: send_voice_memo has two
 * silent fallbacks that both still "deliver" — Cartesia-fail → plain TEXT,
 * sidecar-down → a generic audio TILE (not the native bubble). The rig only
 * classifies inbound.voice-memo when the attachment carries the voiceNote
 * flag, so this kind is the exact discriminator for a real success. A text
 * fallback shows as inbound.text; a tile shows as inbound.attachment — neither
 * matches, so this scenario fails loudly on a degraded path instead of
 * green-washing it. (See KNOWN_ISSUES + signal.ts sendVoiceNote.)
 *
 * Content can't be asserted (it's audio, no STT here) — presence of a true
 * voice note IS the assertion.
 */
import type { Scenario, ScenarioContext, ScenarioResult, StepOutcome } from './index.js';
import { signalFeatureConfigOrSkip, rigRequestAndAwait, skipResult } from './signal-common.js';

export const signalVoiceMemo: Scenario = {
  name: 'signal-voice-memo',
  description:
    'rig asks staging PAT (over Signal) to send a voice note; harness asserts a TRUE native voice memo (inbound.voice-memo, not a text/tile fallback) arrives on the rig WS.',
  steps: [
    { kind: 'turn', text: '(rig asks PAT via Signal to send a voice note)' },
    { kind: 'sleep', ms: 1000 },
  ],
  acceptanceMs: 240_000,
  requiresLocalClient: false,
  customRun: runSignalVoiceMemo,
};

async function runSignalVoiceMemo(ctx: ScenarioContext): Promise<ScenarioResult> {
  const start = Date.now();
  const outcomes: StepOutcome[] = [];
  const conf = signalFeatureConfigOrSkip();
  if ('skip' in conf) return skipResult(signalVoiceMemo, start, conf.skip, ctx);
  const { cfg } = conf;

  const corr = `vm-${Date.now().toString(36)}`;
  const request =
    `Please send me a voice memo — an actual Signal voice note using your send_voice_memo ` +
    `tool, not a typed message. Have it say something short and friendly like ` +
    `"Hey, this is a smoke-test voice note from PAT — everything's working." ` +
    `Just the voice note, nothing else. Don't ask me anything first.`;
  ctx.transcript.add('system', `corr=${corr}; rig=${cfg.rigUrl}; pat=${cfg.patE164}`);
  ctx.transcript.add('user', request, { source: 'signal-rig', corr });

  // Any inbound.voice-memo can only be from PAT (the kind filter excludes our
  // own sync echoes, and the rig talks only to PAT). No sender gate — see the
  // fromPat() note in signal-common.
  const ev = await rigRequestAndAwait(cfg, {
    text: request,
    kindPrefix: 'inbound.voice-memo',
    match: () => true,
  });

  if (ev) {
    const att = Array.isArray(ev.data?.attachments) ? ev.data.attachments[0] : undefined;
    ctx.transcript.add('agent-other', '(voice memo received)', {
      source: 'signal-rig-ws',
      sender: ev.data?.source,
      content_type: att?.content_type,
      voice_note: att?.voice_note,
      size: att?.size,
    });
  }

  outcomes.push({
    step: { kind: 'judge', rubric: 'a native voice note (inbound.voice-memo) arrives on the rig', label: 'rig receives a native voice note (inbound.voice-memo)' },
    ok: ev !== null,
    details: ev
      ? `voice-note received (content_type=${ev.data?.attachments?.[0]?.content_type ?? '?'})`
      : `no inbound.voice-memo from PAT within ${cfg.timeoutMs}ms ` +
        `(a text/tile fallback would NOT match — check Cartesia host key + transports-staging sidecar :7584)`,
  });

  return {
    scenario: signalVoiceMemo,
    passed: outcomes.every((o) => o.ok),
    outcomes,
    durationMs: Date.now() - start,
    startedAtMs: start,
    corr,
  };
}
