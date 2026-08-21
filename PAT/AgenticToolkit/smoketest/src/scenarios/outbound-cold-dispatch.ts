/**
 * Outbound cold-dispatch scenario.
 *
 * Tests Wave 2.B + Task #17 + Task #34 (now consolidated into the
 * send_message auto-route — outbound-mcp's standalone tool is retired).
 *
 * Coverage gap (per audit, SESSION-REVIEW-2026-05-12.md §10):
 *   - send_message auto-route → outbound_initiate system action →
 *     host's outbound-initiate handler → adapter.deliver — never
 *     exercised end-to-end before this scenario.
 *
 * What this scenario does:
 *   - Posts a user turn telling PAT to ping a number on a probe
 *     channel (default `signal-test`).
 *   - Asserts via the host's `/admin/logs.tail` SSE that a
 *     `routing.message-delivered` log event arrives within 30s
 *     carrying `channel_type` == probe channel.
 *
 * Pre-conditions (NOT enforced here; documented for the operator):
 *   - Local NanoClaw running with a recorder adapter registered for
 *     the probe channel. The simplest way is a small src/channels/
 *     module gated by `PAT_TEST_OUTBOUND_ADAPTER=1` that does
 *     `registerChannelAdapter({name: 'signal-test', channelType:
 *     'signal-test', deliver: () => Promise.resolve(undefined)})`.
 *     Without that, the back-mind's send_message will fail with
 *     "no channel adapter registered" and the scenario will time out.
 *   - Smoketest invoked with `--channel-probe=signal-test
 *     outbound-cold-dispatch`.
 *
 * Why log-events instead of polling outbound.db:
 *   - The audit explicitly asked for "the existing log-event stream
 *     for the assertion." `routing.message-delivered` (emitted by
 *     delivery.ts line ~371) is the unambiguous signal that the
 *     adapter's deliver() actually fired — earlier events
 *     (`request-layer.decided` etc.) could fire without delivery
 *     succeeding. Outbound.db rows are written before the adapter
 *     call; a row exists even when delivery throws.
 */
import type { Scenario, ScenarioContext, ScenarioResult, StepOutcome } from './index.js';
import { openLogTail } from '../log-tail.js';

const DEFAULT_PROBE_CHANNEL = 'signal-test';
const DEFAULT_PROBE_NUMBER = '+15550100000';
const DELIVERY_TIMEOUT_MS = 30000;

/**
 * The scenario is structurally simple but its assertion crosses
 * processes (the live host's log-events SSE), so we drop the standard
 * step-based scenario and inline a custom runner instead. Mirrors how
 * `cartesia-call.ts` extends the engine with a side-channel.
 *
 * Engine fall-back: when invoked WITHOUT the probe mode, run the
 * scripted step list which just exits with a clear "probe channel
 * required" failure. That's the path the no-flag default invocation
 * hits (so `pnpm scenario outbound-cold-dispatch` doesn't accidentally
 * hang for 30s if the operator forgot the flag).
 */
export const outboundColdDispatch: Scenario & {
  customRun?: (ctx: ScenarioContext) => Promise<ScenarioResult>;
} = {
  name: 'outbound-cold-dispatch',
  description:
    'cold-DM auto-route: back-mind calls send_message({to:"<channel>:+E164"}) — host translates to outbound_initiate, dispatches via dummy adapter, log-event seen.',
  steps: [
    // Placeholder — the real work happens in customRun.
    { kind: 'sleep', ms: 1 },
  ],
  acceptanceMs: DELIVERY_TIMEOUT_MS + 60000,
  customRun: runOutboundColdDispatch,
};

async function runOutboundColdDispatch(ctx: ScenarioContext): Promise<ScenarioResult> {
  const start = Date.now();
  const outcomes: StepOutcome[] = [];
  const probeChannel = ctx.channelProbe ?? DEFAULT_PROBE_CHANNEL;
  const probeNumber = process.env.SMOKETEST_PROBE_NUMBER ?? DEFAULT_PROBE_NUMBER;
  const baseUrl = process.env.REALTIME_BASE_URL ?? 'http://127.0.0.1:8765';

  if (!ctx.channelProbe) {
    const step = { kind: 'turn' as const, text: '(no-op — channel-probe not set)' };
    outcomes.push({
      step,
      ok: false,
      error:
        `outbound-cold-dispatch requires --channel-probe=<channel>; ` +
        `default probe channel is "${DEFAULT_PROBE_CHANNEL}", which must already ` +
        `be registered on the running NanoClaw (PAT_TEST_OUTBOUND_ADAPTER=1).`,
    });
    return {
      scenario: outboundColdDispatch,
      passed: false,
      outcomes,
      durationMs: Date.now() - start,
    };
  }

  ctx.transcript.add('system', `probe channel: ${probeChannel} → ${probeNumber}`);

  // 1. Open the log-events tail BEFORE posting so we don't miss the
  //    delivery event if the back-mind races us. `since=now-500` keeps
  //    the stream live-only (no historical backlog) while still catching
  //    events that race the SSE open.
  const tailWatcher = await openLogTail({ baseUrl, sinceMs: Date.now() - 500 });
  ctx.transcript.add('system', 'admin /logs.tail connected');

  // 2. Post the user turn. The back-mind reads it and (we hope) calls
  //    send_message with a namespaced platform-id → core.ts auto-route
  //    → system row → host outbound-initiate handler → adapter.deliver
  //    → routing.message-delivered log event.
  const userText = `please ping ${probeChannel}:${probeNumber} on ${probeChannel} with the text "hello from PAT smoke"`;
  ctx.transcript.add('user', userText, { source: 'scripted', probeChannel, probeNumber });
  const postOutcome: StepOutcome = {
    step: { kind: 'turn', text: userText },
    ok: false,
  };
  try {
    if (ctx.lastTurnAt) ctx.lastTurnAt.ms = Date.now() - 50;
    await ctx.client.postTurn(userText, 'smoke-test', ctx.threadId);
    postOutcome.ok = true;
    postOutcome.details = 'turn posted';
  } catch (err) {
    postOutcome.error = `postTurn failed: ${(err as Error).message}`;
    tailWatcher.close();
    outcomes.push(postOutcome);
    return {
      scenario: outboundColdDispatch,
      passed: false,
      outcomes,
      durationMs: Date.now() - start,
    };
  }
  outcomes.push(postOutcome);

  // 3. Wait for the delivery log event. `routing.message-delivered` is
  //    the deterministic signal that adapter.deliver() resolved
  //    without throwing.
  const waitOutcome: StepOutcome = {
    step: { kind: 'turn', text: 'wait for routing.message-delivered' },
    ok: false,
  };
  try {
    const event = await tailWatcher.waitFor(
      (ev) =>
        ev.kind === 'routing.message-delivered' &&
        typeof ev.data === 'object' &&
        ev.data !== null &&
        (ev.data as Record<string, unknown>).channel_type === probeChannel,
      DELIVERY_TIMEOUT_MS,
      `routing.message-delivered for channel_type=${probeChannel}`,
    );
    waitOutcome.ok = true;
    waitOutcome.details = `delivered: ${JSON.stringify(event.data).slice(0, 120)}`;
    ctx.transcript.add('system', `delivery event seen: ${waitOutcome.details}`);
  } catch (err) {
    waitOutcome.error = (err as Error).message;
    ctx.transcript.add('system', `delivery wait failed: ${waitOutcome.error}`);
  } finally {
    tailWatcher.close();
  }
  outcomes.push(waitOutcome);

  return {
    scenario: outboundColdDispatch,
    passed: outcomes.every((o) => o.ok),
    outcomes,
    durationMs: Date.now() - start,
  };
}

// /admin/logs.tail consumer + LogEvent type live in ../log-tail.ts (shared).
