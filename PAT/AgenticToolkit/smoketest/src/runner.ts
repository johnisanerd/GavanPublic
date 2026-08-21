/**
 * Scenario runner — wires up RealtimeClient, Transcript, SimulatedUser
 * and writes artifacts to disk.
 *
 * Artifacts are LOCAL (the runner is a local client driving deployed staging)
 * and land under `smoketest/artifacts/<scenario>-<ts>/` (gitignored; override
 * with SMOKETEST_ARTIFACT_DIR):
 *   - transcript.md       human-readable
 *   - transcript.json     machine-readable (events + metrics)
 *   - result.json         pass/fail summary
 *   - call.wav            both-sides audio (call scenarios)
 */
import fs from 'node:fs';
import path from 'node:path';

import { isBackMindReply, RealtimeClient } from './client.js';
import { Transcript } from './transcript.js';
import { SimulatedUser } from './simulated-user.js';
import { runScenario, type Scenario, type ScenarioResult } from './scenarios/index.js';
import { CartesiaCallClient } from './cartesia-call.js';

export interface RunOptions {
  baseUrl?: string;
  dataRoot?: string;
  /** If false, do not persist artifacts to disk. Useful for vitest runs. */
  persist?: boolean;
  /** If true, also stream every SSE event to stdout for live observation. */
  streamToStdout?: boolean;
  /** Tier 3T — route user turns through Cartesia TTS+STT (CARTESIA_API_KEY required). */
  audio?: boolean;
  /**
   * Tier 3A — open a real WS call against Cartesia (CARTESIA_API_KEY +
   * CARTESIA_AGENT_ID required). User turns are TTS'd and streamed in as
   * PCM; agent audio comes back via the same WS and is recorded to
   * `call.wav`. The SSE tap to nanoclaw stays open in parallel for
   * structural assertions; the assumption is that nanoclaw is the
   * destination Cartesia routes to (via voice-transport on Railway +
   * cloudflared).
   */
  call?: boolean;
  /**
   * Override the per-scenario thread id. Default is `smoke-<scenario>`
   * (stable session per scenario name). Set SMOKETEST_FRESH_SESSION=1 to
   * suffix the timestamp and force a new session per run.
   */
  threadId?: string;
  /**
   * Channel name to target with the dispatch probe (set by
   * `--channel-probe=<name>`). The scenario decides what to do with it
   * — typically used to point an outbound-dispatch assertion at a
   * dummy adapter pre-registered on the running NanoClaw (e.g.
   * `signal-test`). Plumbed through ScenarioContext.channelProbe.
   */
  channelProbe?: string;
}

export async function runOne(scenario: Scenario, opts: RunOptions = {}): Promise<ScenarioResult> {
  const transcript = new Transcript();
  const baseUrl = opts.baseUrl ?? process.env.REALTIME_BASE_URL ?? 'http://127.0.0.1:8765';
  // Floor used to filter out stale events from prior scenarios that might
  // arrive on the SSE channel during this run (a delayed back-mind reply
  // pointing at a previous user turn). 200ms backdate so events that race
  // SSE-connect aren't dropped.
  const scenarioStartedAtMs = Date.now() - 200;

  const client = new RealtimeClient({
    baseUrl,
    onEvent: (e) => {
      if (e.receivedAt < scenarioStartedAtMs) return; // stale, not ours
      // Map SSE kind → transcript source.
      let source: 'agent-utterance' | 'agent-chat' | 'agent-other' | 'trace';
      if (e.kind === 'realtime-utterance') source = 'agent-utterance';
      // PAT: streaming-rendition deployments deliver the back-mind reply as
      // utterance-end/source='banter-rendition', never kind='chat'. Classify
      // both as agent-chat so judges + scenarios see the actual answer.
      else if (isBackMindReply(e)) source = 'agent-chat';
      else if (e.kind === 'trace') source = 'trace';
      else source = 'agent-other';

      // Trace events carry the full LLM call (system prompt + user msg +
      // response). Use raw payload's `content` as the entry's metadata so
      // the viewer can render system/user/response without parsing text.
      let text: string;
      let metadata: Record<string, unknown>;
      if (source === 'trace') {
        const traceContent = (e.raw as { content?: { layer?: string; latencyMs?: number; ok?: boolean; response?: string | null } })?.content ?? {};
        text = `${traceContent.layer ?? 'llm-call'} (${traceContent.latencyMs ?? '?'}ms${traceContent.ok ? '' : ' FAILED'})`;
        metadata = { trace: traceContent };
      } else {
        text = e.text;
        metadata = { kind: e.kind, sender: e.sender, raw: e.raw };
      }
      transcript.add(source, text, metadata);
      if (opts.streamToStdout) {
        const tag = source === 'agent-utterance' ? '\x1b[33m' : source === 'agent-chat' ? '\x1b[32m' : source === 'trace' ? '\x1b[36m' : '\x1b[90m';
        process.stdout.write(`${tag}[${e.kind}]\x1b[0m ${text}\n`);
      }
    },
  });

  transcript.add('system', `scenario start: ${scenario.name}`, { baseUrl });
  // Live-prod scenarios opt out of the local-SSE tap. The customRun
  // drives a remote host directly via HTTP polling (no /outbound feed).
  if (scenario.requiresLocalClient === false) {
    transcript.add('system', 'SSE connect skipped (requiresLocalClient=false)');
  } else {
    await client.connect();
    transcript.add('system', 'SSE connected');
  }

  const user = scenario.user
    ? new SimulatedUser({ ...scenario.user })
    : null;

  // Reserve the artifact directory up-front so audio recordings can be
  // written into it as turns happen (rather than only at scenario end).
  const artifactDir = opts.persist === false ? undefined : reserveArtifactDir(scenario, opts);

  // Tier 3A — open the Cartesia WS up-front so the call clock starts at
  // scenario t=0. close() at end flushes call.wav into artifactDir.
  let call: CartesiaCallClient | undefined;
  if (opts.call) {
    call = new CartesiaCallClient({ persistDir: artifactDir });
    transcript.add('system', 'Cartesia WS connecting…', { agentId: process.env.CARTESIA_AGENT_ID ?? process.env.CARTESIA_AGENT_ID_STAGING });
    await call.connect();
    transcript.add('system', 'Cartesia WS connected');
    // Wait for the agent's greeting to finish before the first user turn —
    // otherwise we clobber "Hey, you've got Pat" and Cartesia STT has to
    // deal with overlapping speech.
    const greetingResult = await call.waitForGreetingToFinish();
    transcript.add('system', `greeting wait: ${greetingResult.reason} (${greetingResult.durationMs}ms)`);
  }

  let result: ScenarioResult;
  try {
    // Stable thread id per scenario name → stable session → warm container
    // across reruns, but isolated from other scenarios. Override via env if
    // a test wants a fresh session each run (e.g., to verify cold-start
    // behaviour).
    const threadId =
      opts.threadId ?? `smoke-${scenario.name}` + (process.env.SMOKETEST_FRESH_SESSION ? `-${Date.now()}` : '');
    result = await runScenario(scenario, {
      client,
      transcript,
      user,
      call,
      audio: opts.audio ? { enabled: true, persistDir: artifactDir } : undefined,
      turnIndex: { value: 0 },
      // Initial floor = scenario start; first user turn updates this.
      lastTurnAt: { ms: Date.now() },
      threadId,
      channelProbe: opts.channelProbe,
    });
  } finally {
    // Tier 3A — let the agent finish its current utterance before tearing
    // down the WS. Without this the recorded call.wav cuts off mid-
    // sentence whenever the scenario's last step (judge, sleep, etc.)
    // completes faster than Cartesia finishes TTSing the chat reply.
    if (call) {
      const trail = await call.waitForAgentToFinishSpeaking();
      transcript.add('system', `agent end-of-speech: ${trail.reason} (${trail.durationMs}ms)`);
    }
    client.close();
    if (call) {
      const wavPath = await call.close();
      if (wavPath) transcript.add('system', `call audio: ${wavPath}`);
    }
  }

  transcript.add('system', `scenario end: ${result.passed ? 'PASS' : 'FAIL'} (${result.durationMs}ms)`);

  // Stamp when this run started (unless a customRun already set it) so the
  // CLI can emit a time-scoped log query pointing at exactly this run.
  if (result.startedAtMs === undefined) result.startedAtMs = scenarioStartedAtMs;

  if (artifactDir) {
    await persistArtifacts(scenario, result, transcript, artifactDir);
  }
  return result;
}

function reserveArtifactDir(scenario: Scenario, opts: RunOptions): string {
  // The runner is a LOCAL client driving deployed staging — artifacts are
  // local. Default to `smoketest/artifacts/` (gitignored), NOT the local
  // nanoclaw checkout's data dir (we don't run a local nanoclaw; that was a
  // confusing legacy default). Override with SMOKETEST_ARTIFACT_DIR.
  const root = opts.dataRoot ?? process.env.SMOKETEST_ARTIFACT_DIR ?? path.resolve(process.cwd(), 'artifacts');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(root, `${scenario.name}-${ts}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function runAll(scenarios: Scenario[], opts: RunOptions = {}): Promise<{
  results: ScenarioResult[];
  passed: number;
  failed: number;
}> {
  const results: ScenarioResult[] = [];
  let passed = 0;
  let failed = 0;
  // Pause between scenarios so the back-mind container has time to finish
  // any in-flight chat from the previous scenario. Without this, a delayed
  // reply lands during the next scenario's window — mostly harmless thanks
  // to the per-turn `lastTurnAt` gate, but still pollutes the transcript.
  // Override via SMOKETEST_INTER_SCENARIO_PAUSE_MS for slow back-minds.
  const pauseMs = Number(process.env.SMOKETEST_INTER_SCENARIO_PAUSE_MS ?? 5000);
  for (let i = 0; i < scenarios.length; i++) {
    if (i > 0 && pauseMs > 0) {
      await new Promise((r) => setTimeout(r, pauseMs));
    }
    const r = await runOne(scenarios[i]!, opts);
    results.push(r);
    if (r.passed) passed++;
    else failed++;
  }
  return { results, passed, failed };
}

function persistArtifacts(
  scenario: Scenario,
  result: ScenarioResult,
  transcript: Transcript,
  dir: string,
): void {
  const title = `${scenario.name} — ${result.passed ? 'PASS' : 'FAIL'}`;
  fs.writeFileSync(path.join(dir, 'transcript.md'), transcript.toMarkdown(title));
  fs.writeFileSync(path.join(dir, 'transcript.json'), JSON.stringify(transcript.toJson(), null, 2));
  fs.writeFileSync(
    path.join(dir, 'result.json'),
    JSON.stringify(
      {
        scenario: scenario.name,
        passed: result.passed,
        durationMs: result.durationMs,
        outcomes: result.outcomes.map((o) => ({
          stepKind: o.step.kind,
          ok: o.ok,
          details: o.details,
          error: o.error,
          judge: o.judgeVerdict,
        })),
      },
      null,
      2,
    ),
  );
  if (process.stdout.isTTY) {
    process.stdout.write(`[smoketest] artifacts: ${dir}\n`);
  }
}
