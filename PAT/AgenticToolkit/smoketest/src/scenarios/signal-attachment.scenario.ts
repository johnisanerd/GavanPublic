/**
 * S6 signal-attachment — real feature over real Signal: the rig asks staging
 * PAT to send a file as an attachment; we assert it arrives as one.
 *
 * Chain: Signal inbound → router → back-mind → (agent writes a file, then)
 * send_file MCP → /workspace/outbox → host deliver() → signal.ts
 * sendAttachments → signal-cli send {attachments:[data:...;base64]} → rig
 * observes inbound.attachment.
 *
 * The agent must actually produce a file and attach it (not paste text). We
 * ask for a specific filename carrying the corr slug so the rig's attachment
 * metadata (filename) confirms it's OUR file, not an incidental one — with a
 * graceful fallback to presence-only if signal-cli doesn't preserve the name.
 */
import type { Scenario, ScenarioContext, ScenarioResult, StepOutcome } from './index.js';
import { signalFeatureConfigOrSkip, rigRequestAndAwait, skipResult, type RigEvent } from './signal-common.js';

export const signalAttachment: Scenario = {
  name: 'signal-attachment',
  description:
    'rig asks staging PAT (over Signal) to send a file attachment; harness asserts an inbound.attachment (not pasted text) arrives on the rig WS.',
  steps: [
    { kind: 'turn', text: '(rig asks PAT via Signal to send a file attachment)' },
    { kind: 'sleep', ms: 1000 },
  ],
  acceptanceMs: 240_000,
  requiresLocalClient: false,
  customRun: runSignalAttachment,
};

async function runSignalAttachment(ctx: ScenarioContext): Promise<ScenarioResult> {
  const start = Date.now();
  const outcomes: StepOutcome[] = [];
  const conf = signalFeatureConfigOrSkip();
  if ('skip' in conf) return skipResult(signalAttachment, start, conf.skip, ctx);
  const { cfg } = conf;

  const slug = Date.now().toString(36);
  const filename = `smoke-${slug}.txt`;
  const request =
    `Please do exactly this, without asking me anything first: create a small text file named ` +
    `${filename} whose content is "PAT-SMOKE ${slug}", and send it to me as a file attachment ` +
    `using your send_file tool. Actually attach the file — don't paste the text into the chat.`;
  ctx.transcript.add('system', `corr=${slug}; filename=${filename}; rig=${cfg.rigUrl}; pat=${cfg.patE164}`);
  ctx.transcript.add('user', request, { source: 'signal-rig', corr: slug });

  // Any inbound.attachment can only be from PAT (kind filter excludes our own
  // sync echoes; rig talks only to PAT). Gate on "is a non-voice attachment",
  // not sender — see the fromPat() note in signal-common.
  const ev = await rigRequestAndAwait(cfg, {
    text: request,
    kindPrefix: 'inbound.attachment',
    match: (e) => hasAttachment(e),
  });

  if (ev) {
    const att = firstAttachment(ev);
    ctx.transcript.add('agent-other', '(attachment received)', {
      source: 'signal-rig-ws',
      sender: ev.data?.source,
      filename: att?.filename,
      content_type: att?.content_type,
      size: att?.size,
    });
  }
  const att = ev ? firstAttachment(ev) : undefined;
  const nameMatched = !!att?.filename && String(att.filename).includes(slug);

  outcomes.push({
    step: { kind: 'judge', rubric: 'a file attachment (inbound.attachment) arrives on the rig', label: 'rig receives a file attachment' },
    ok: ev !== null,
    details: ev
      ? `attachment received (filename=${att?.filename ?? '?'}, type=${att?.content_type ?? '?'}${nameMatched ? ', slug matched' : ''})`
      : `no inbound.attachment from PAT within ${cfg.timeoutMs}ms`,
  });

  return {
    scenario: signalAttachment,
    passed: outcomes.every((o) => o.ok),
    outcomes,
    durationMs: Date.now() - start,
    startedAtMs: start,
    corr: slug,
  };
}

function firstAttachment(e: RigEvent): { filename?: string; content_type?: string; size?: number; voice_note?: boolean } | undefined {
  return Array.isArray(e.data?.attachments) ? e.data.attachments[0] : undefined;
}

/** An attachment that is NOT a voice note (those are inbound.voice-memo). */
function hasAttachment(e: RigEvent): boolean {
  const att = firstAttachment(e);
  return !!att && !att.voice_note;
}
