/**
 * S3 signal-publish — real feature over real Signal: the rig asks staging PAT
 * to publish a file and send the link; PAT calls publish_file then
 * send_message; we observe the link arrive on the rig's WS and FETCH it.
 *
 * Chain exercised: Signal inbound → router → back-mind container → publish_file
 * MCP → ncl files publish (HMAC sign) → agent send_message → Signal outbound →
 * rig observes inbound.text → real HTTP GET of the public pat-staging.plsd.app
 * URL. The nonce makes the content check exact (no stale-file false-pass).
 *
 * Note publish_file only RETURNS the URL to the agent — the agent must then
 * send_message it, so a pass proves both the tool AND that the agent completed
 * the two-step hand-off on the origin channel.
 */
import type { Scenario, ScenarioContext, ScenarioResult, StepOutcome } from './index.js';
import { signalFeatureConfigOrSkip, rigRequestAndAwait, skipResult } from './signal-common.js';

const FILES_PUB_RE = /https?:\/\/\S+\/files\/pub\/\S+/;

export const signalPublish: Scenario = {
  name: 'signal-publish',
  description:
    'rig asks staging PAT (over Signal) to publish a file + send the link; harness observes the /files/pub/ URL on the rig WS and fetches it (200 + nonce).',
  steps: [
    { kind: 'turn', text: '(rig asks PAT via Signal to publish a file and send the link)' },
    { kind: 'sleep', ms: 1000 },
  ],
  acceptanceMs: 240_000,
  requiresLocalClient: false,
  customRun: runSignalPublish,
};

async function runSignalPublish(ctx: ScenarioContext): Promise<ScenarioResult> {
  const start = Date.now();
  const outcomes: StepOutcome[] = [];
  const conf = signalFeatureConfigOrSkip();
  if ('skip' in conf) return skipResult(signalPublish, start, conf.skip, ctx);
  const { cfg } = conf;

  const nonce = `PAT-SMOKE-${Date.now().toString(36)}`;
  const request =
    `Please do exactly this, without asking me anything first: create a file in your ` +
    `workspace named smoke-signal.md whose entire content is the single line "${nonce}", ` +
    `publish it with your publish_file tool with a 2 hour expiry, and send me the resulting link.`;
  ctx.transcript.add('system', `corr=${nonce}; rig=${cfg.rigUrl}; pat=${cfg.patE164}`);
  ctx.transcript.add('user', request, { source: 'signal-rig', corr: nonce });

  // 1. Round-trip: send + await PAT's reply carrying a /files/pub/ link.
  // Match on the URL content only. Sender-gating is unnecessary (and harmful):
  // the kind filter excludes our own echoes (inbound.sync.*), the rig only
  // talks to PAT, and PAT may appear to the rig by UUID rather than E164 — so
  // gating on E164 would false-miss. See fromPat() note in signal-common.
  const ev = await rigRequestAndAwait(cfg, {
    text: request,
    kindPrefix: 'inbound.text',
    match: (e) => FILES_PUB_RE.test(String(e.data?.text ?? '')),
  });

  outcomes.push({
    step: { kind: 'wait-chat', within: cfg.timeoutMs, label: 'rig receives a /files/pub/ link from PAT' },
    ok: ev !== null,
    details: ev ? `link message received` : `no /files/pub/ link from PAT within ${cfg.timeoutMs}ms`,
  });
  if (!ev) return finalize(start, outcomes, nonce);

  const replyText = String(ev.data?.text ?? '');
  ctx.transcript.add('agent-chat', replyText, { source: 'signal-rig-ws', sender: ev.data?.source });
  const url = (FILES_PUB_RE.exec(replyText)?.[0] ?? '').replace(/[)\]>.,]+$/, '');

  // 2. Fetch the signed URL — 200 + exact nonce content.
  try {
    const res = await fetch(url);
    const body = await res.text();
    const okStatus = res.status === 200;
    const okBody = body.includes(nonce);
    outcomes.push({
      step: { kind: 'judge', rubric: 'published URL fetches 200 with nonce content', label: 'fetch published URL → 200 + nonce' },
      ok: okStatus && okBody,
      details: !okStatus
        ? `GET ${url} → ${res.status}: ${body.slice(0, 160)}`
        : okBody
          ? `${url} → 200, nonce matched`
          : `200 but content mismatch: expected "${nonce}", got "${body.slice(0, 120)}"`,
    });
  } catch (err) {
    outcomes.push({
      step: { kind: 'judge', rubric: 'published URL fetches 200 with nonce content', label: 'fetch published URL → 200 + nonce' },
      ok: false,
      details: `fetch ${url} threw: ${(err as Error).message}`,
    });
  }

  // 3. Tampered expiry is refused (signature covers exp).
  try {
    const tampered = new URL(url);
    tampered.searchParams.set('exp', '9999999999');
    const res = await fetch(tampered.toString());
    outcomes.push({
      step: { kind: 'judge', rubric: 'tampered expiry is refused (404)', label: 'tampered expiry → 404' },
      ok: res.status === 404,
      details: res.status === 404 ? 'tampered exp → 404' : `tampered exp → ${res.status} (expected 404)`,
    });
  } catch (err) {
    outcomes.push({
      step: { kind: 'judge', rubric: 'tampered expiry is refused (404)', label: 'tampered expiry → 404' },
      ok: false,
      details: `tamper fetch threw: ${(err as Error).message}`,
    });
  }

  return finalize(start, outcomes, nonce);
}

function finalize(start: number, outcomes: StepOutcome[], corr: string): ScenarioResult {
  return {
    scenario: signalPublish,
    passed: outcomes.every((o) => o.ok),
    outcomes,
    durationMs: Date.now() - start,
    startedAtMs: start,
    corr,
  };
}
