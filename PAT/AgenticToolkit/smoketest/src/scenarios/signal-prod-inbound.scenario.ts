/**
 * signal-prod-inbound — drive PAT's PROD Signal channel end-to-end using
 * the deployed signal-test-rig as the "other party," then assert against
 * pat-frontend's `/api/logs.jsonl` proxy that the inbound hit PAT's
 * router AND the back-mind produced an outbound delivery.
 *
 * One of the rare scenarios that doesn't drive the local NanoClaw — it
 * exercises the production rig directly. Opted out of the runner's
 * local-SSE tap via `requiresLocalClient = false`.
 *
 * Flow:
 *   1. Resolve rig A's address (E164) via `GET <rig>/address`.
 *   2. Snapshot the wall-clock now; everything after this is "ours" in
 *      the prod log stream.
 *   3. Send "ping <corr>" from rig A to PAT's Signal number (E164,
 *      not UUID — PAT is a real Signal client, not signal-cli-only).
 *   4. Poll PAT's `/api/logs.jsonl?since=<snapshot>` until we see:
 *        - `routing.message-routed` whose `data.user_id` matches
 *          `signal:<rigE164>` and `data.msg_kind === 'chat'`. Confirms
 *          PAT received the message and routed it to the back-mind.
 *        - `routing.message-delivered` whose `data.channel_type ===
 *          'signal'` AND `data.platform_id === <rigE164>` on the same
 *          session_id as the routed event. Confirms PAT's back-mind
 *          produced a reply that the host's delivery loop pushed back
 *          out through the Signal adapter.
 *   5. (Optional) tail the rig's WS to capture PAT's reply text. Best-
 *      effort; absence doesn't fail the scenario because Signal
 *      delivery timing depends on the receiver's online state.
 *
 * Deviation from the brief's `inbound.received` / `banter.called` /
 * `request-layer.decided`:
 *   Those kinds are emitted only by `realtime/src/channel-orchestrator.ts`
 *   for realtime channels (anam-web, phone-call). Signal is a chat
 *   channel — its inbound path goes through `nanoclaw/src/router.ts`
 *   which emits `routing.message-routed` instead, and there's no
 *   front-mind / back-mind split (the container itself produces the
 *   reply). The substitution above (`routing.message-routed` for
 *   inbound, `routing.message-delivered` for the back-mind reply)
 *   asserts the equivalent chat-channel chain. See AGENTS.md "Trace-
 *   based end-to-end tests" — the assertion vocabulary is "the right
 *   thing happened in the right order under real conditions", not
 *   "this specific kind name."
 *
 * Opt-in: requires PAT_VIEWER_TOKEN + PAT_SIGNAL_RIG_TOKEN. Missing
 * either short-circuits to a PASS-with-skip-note so the broader smoke
 * suite stays green on dev machines without prod credentials. Cost is
 * ~$0.001/run (one Haiku banter call host-side; back-mind is opus
 * because the container's wired model is opus, ~$0.01-0.05 amortized).
 */
import type { Scenario, ScenarioContext, ScenarioResult, StepOutcome } from './index.js';
import http from 'node:http';
import https from 'node:https';
// Node 22's built-in WebSocket — avoids the `ws` package dependency.
// Smoketest tsconfig has `lib: ["ES2022", "DOM"]` so the global type
// resolves from the DOM lib.
declare const WebSocket: typeof globalThis.WebSocket;

// ── Constants / env ──────────────────────────────────────────────────────

const DEFAULT_FRONTEND = 'https://pat-frontend.fly.dev';
const DEFAULT_RIG_A = 'https://pat-signal-rig.fly.dev';
const DEFAULT_PAT_SIGNAL_E164 = '+15550100003';
const DEFAULT_OVERALL_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 2_500;
const DEFAULT_REPLY_TAIL_MS = 30_000;

// ── Scenario shape ───────────────────────────────────────────────────────

export const signalProdInbound: Scenario = {
  name: 'signal-prod-inbound',
  description:
    "drives PAT's PROD Signal channel via signal-test-rig: rig sends 'ping <corr>' to PAT, asserts pat-frontend /api/logs.jsonl shows routing.message-routed + routing.message-delivered for the same session within 120s.",
  steps: [
    // Decorative — the work is in customRun. Listed for `pnpm scenario --help`.
    { kind: 'turn', text: '(rig sends "ping <corr>" to PAT via Signal)' },
    { kind: 'sleep', ms: DEFAULT_OVERALL_TIMEOUT_MS },
  ],
  acceptanceMs: DEFAULT_OVERALL_TIMEOUT_MS + 30_000,
  requiresLocalClient: false,
  customRun: runSignalProdInbound,
};

// ── Custom runner ────────────────────────────────────────────────────────

async function runSignalProdInbound(ctx: ScenarioContext): Promise<ScenarioResult> {
  const start = Date.now();
  const outcomes: StepOutcome[] = [];

  const cfg = readConfig();
  if (!cfg.viewerToken || !cfg.rigToken) {
    const missing = [
      !cfg.viewerToken && 'PAT_VIEWER_TOKEN',
      !cfg.rigToken && 'PAT_SIGNAL_RIG_TOKEN',
    ]
      .filter(Boolean)
      .join(', ');
    ctx.transcript.add(
      'system',
      `signal-prod-inbound SKIPPED — missing env: ${missing}. Set both to run live.`,
    );
    outcomes.push({
      step: { kind: 'turn', text: '(skipped — env not set)' },
      ok: true,
      details: `skipped: missing ${missing}`,
    });
    return {
      scenario: signalProdInbound,
      passed: true,
      outcomes,
      durationMs: Date.now() - start,
    };
  }

  const corr = randomCorr();
  const body = `ping ${corr}`;
  ctx.transcript.add('system', `corr=${corr}; frontend=${cfg.frontendUrl}; rig=${cfg.rigUrl}; pat=${cfg.patSignalE164}`);

  // 1. Resolve rig's E164. The /address endpoint returns the burner's
  //    own number + ACI UUID; we send AS this number, so we filter the
  //    prod log stream by `signal:<thisNumber>` to identify our inbound.
  let rigIds: string[];
  try {
    const addr = await httpGetJson(`${cfg.rigUrl}/address`, cfg.rigToken);
    rigIds = pickAccountIdentities(addr);
    if (rigIds.length === 0) throw new Error('rig /address returned no usable account identities');
  } catch (err) {
    outcomes.push({
      step: { kind: 'turn', text: '(rig /address)' },
      ok: false,
      error: `rig /address failed: ${(err as Error).message}`,
    });
    return failNow(start, outcomes);
  }
  ctx.transcript.add('system', `rig identities: ${rigIds.join(', ')}`);

  // 2. Snapshot now so we don't match prior log lines. The since= floor
  //    on /api/logs.jsonl is wall-clock ms; we backdate by 5s so a tiny
  //    clock skew between this host and Fly doesn't drop our event.
  const sinceMs = Date.now() - 5_000;

  // 3. Optional WS tap for the rig's view of PAT's reply. Start BEFORE
  //    sending so we don't race the inbound + reply round-trip.
  const replyWatcher = openRigReplyWatcher({
    rigUrl: cfg.rigUrl,
    rigToken: cfg.rigToken,
    expectedSender: cfg.patSignalE164,
  });
  ctx.transcript.add('system', `rig WS watcher: ${replyWatcher.status}`);

  // 4. Send "ping <corr>" from rig A to PAT's Signal number. PAT runs
  //    a real Signal client (signal-cli daemon with ACI/PNI sync), so
  //    E164 routing works. Per the brief + memory note
  //    reference_signal_cli_aci_pni_quirk.md: the ACI/PNI bug only
  //    affects signal-cli-only-to-signal-cli-only pairs.
  let sendKind: string | undefined;
  try {
    const sendResp = await httpPostJson(
      `${cfg.rigUrl}/send`,
      cfg.rigToken,
      { recipient: cfg.patSignalE164, text: body },
    );
    sendKind = String((sendResp as { kind?: string }).kind ?? '');
    if (sendKind !== 'sent') {
      throw new Error(`rig /send returned kind=${sendKind} (expected 'sent'): ${JSON.stringify(sendResp).slice(0, 200)}`);
    }
  } catch (err) {
    replyWatcher.close();
    outcomes.push({
      step: { kind: 'turn', text: body },
      ok: false,
      error: `rig /send failed: ${(err as Error).message}`,
    });
    return failNow(start, outcomes);
  }
  ctx.transcript.add('user', body, { source: 'signal-rig', corr, kind: sendKind });
  outcomes.push({
    step: { kind: 'turn', text: body },
    ok: true,
    details: `rig sent (corr=${corr})`,
  });

  // 5. Poll pat-frontend /api/logs.jsonl until we see both events. The
  //    JSONL endpoint is a snapshot of the day file filtered by query;
  //    poll cadence is intentionally lazy (every 2.5s) — we're racing
  //    against signal-cli's receive loop + container cold-start, both
  //    measured in seconds, not ms.
  const deadline = start + cfg.overallTimeoutMs;
  let routed: LogEvent | null = null;
  let delivered: LogEvent | null = null;
  let allEventsForCorr: LogEvent[] = [];

  while (Date.now() < deadline) {
    let events: LogEvent[];
    try {
      events = await fetchLogsJsonl({
        frontendUrl: cfg.frontendUrl,
        viewerToken: cfg.viewerToken,
        sinceMs,
        // No `kind=` filter — we want the full slice so a delivery
        // failure shows up in the transcript even though the assertion
        // only gates on routed + delivered.
      });
    } catch (err) {
      ctx.transcript.add('system', `logs.jsonl fetch error (retrying): ${(err as Error).message}`);
      await sleep(cfg.pollIntervalMs);
      continue;
    }

    allEventsForCorr = events;

    if (!routed) {
      routed = events.find(
        (ev) =>
          ev.kind === 'routing.message-routed' &&
          rigIds.some((id) => ev.data?.user_id === `signal:${id}`) &&
          ev.data?.msg_kind === 'chat',
      ) ?? null;
      if (routed) {
        ctx.transcript.add('system', `routed: session=${routed.session_id} agent_group=${routed.data?.agent_group} wake=${routed.data?.wake}`);
      }
    }

    if (routed && !delivered) {
      delivered = events.find(
        (ev) =>
          ev.kind === 'routing.message-delivered' &&
          ev.session_id === routed!.session_id &&
          ev.data?.channel_type === 'signal' &&
          rigIds.includes(String(ev.data?.platform_id ?? '')),
      ) ?? null;
      if (delivered) {
        ctx.transcript.add('system', `delivered: msg_id=${delivered.data?.msg_id} kind=${delivered.data?.msg_kind}`);
        break;
      }
    }

    await sleep(cfg.pollIntervalMs);
  }

  // 6. Score the two log assertions.
  outcomes.push({
    step: { kind: 'judge', rubric: 'routing.message-routed for signal inbound', label: 'inbound-routed' },
    ok: routed !== null,
    details: routed
      ? `routed at ${routed.ts} (session=${routed.session_id})`
      : `no routing.message-routed for user_id in signal:{${rigIds.join('|')}} within ${cfg.overallTimeoutMs}ms ` +
        `(saw ${allEventsForCorr.length} total events since ${new Date(sinceMs).toISOString()})`,
  });
  outcomes.push({
    step: { kind: 'judge', rubric: 'routing.message-delivered on same session', label: 'reply-delivered' },
    ok: delivered !== null,
    details: delivered
      ? `delivered at ${delivered.ts} (msg_id=${delivered.data?.msg_id})`
      : routed
        ? `back-mind never produced an outbound delivery on session ${routed.session_id} within ${cfg.overallTimeoutMs}ms`
        : 'no inbound routed → can\'t check delivery',
  });

  // 7. Optional: harvest PAT's reply text from the rig's WS tap.
  //    Best-effort; absence is noted but doesn't fail the scenario.
  const replyText = await replyWatcher.harvest(cfg.replyTailMs);
  replyWatcher.close();
  if (replyText) {
    ctx.transcript.add('agent-chat', replyText, { source: 'signal-rig-ws', sender: cfg.patSignalE164 });
    outcomes.push({
      step: { kind: 'judge', rubric: 'rig WS captured a reply', label: 'reply-captured' },
      ok: true,
      details: `${replyText.length} chars from ${cfg.patSignalE164}`,
    });
  } else {
    ctx.transcript.add('system', `no reply observed on rig WS within ${cfg.replyTailMs}ms (best-effort; not a fail)`);
  }

  const passed = outcomes.every((o) => o.ok);
  return {
    scenario: signalProdInbound,
    passed,
    outcomes,
    durationMs: Date.now() - start,
  };
}

// ── Pure helpers (exported for unit tests) ───────────────────────────────

/** Structured-log event shape; loose because we read across many kinds. */
export interface LogEvent {
  ts: string;
  kind: string;
  level?: string;
  source?: string;
  thread_id?: string | null;
  session_id?: string | null;
  platform_id?: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
}

export interface SignalProdAssertionInput {
  /** All identities PAT may know the rig by: E164 and/or ACI UUID. */
  rigIdentities: string[];
  events: LogEvent[];
}

export interface SignalProdAssertion {
  routed: LogEvent | null;
  delivered: LogEvent | null;
  ok: boolean;
  reason: string;
}

/** Pure-function version of the runner's match logic. Used by unit
 *  tests against fixture events; the live runner uses the same shape
 *  inline so the loop can short-circuit as soon as both events are
 *  present. */
export function assertSignalProdInboundChain(input: SignalProdAssertionInput): SignalProdAssertion {
  const routed =
    input.events.find(
      (ev) =>
        ev.kind === 'routing.message-routed' &&
        input.rigIdentities.some((id) => ev.data?.user_id === `signal:${id}`) &&
        ev.data?.msg_kind === 'chat',
    ) ?? null;

  if (!routed) {
    return {
      routed: null,
      delivered: null,
      ok: false,
      reason: `no routing.message-routed for user_id in signal:{${input.rigIdentities.join('|')}}`,
    };
  }

  const delivered =
    input.events.find(
      (ev) =>
        ev.kind === 'routing.message-delivered' &&
        ev.session_id === routed.session_id &&
        ev.data?.channel_type === 'signal' &&
        input.rigIdentities.includes(String(ev.data?.platform_id ?? '')),
    ) ?? null;

  if (!delivered) {
    return {
      routed,
      delivered: null,
      ok: false,
      reason: `routed on session ${routed.session_id} but no matching routing.message-delivered`,
    };
  }

  // Sanity ordering — delivered must be at-or-after routed.
  if (new Date(delivered.ts).getTime() < new Date(routed.ts).getTime()) {
    return {
      routed,
      delivered,
      ok: false,
      reason: `delivered (${delivered.ts}) precedes routed (${routed.ts}) — log ordering violated`,
    };
  }

  return {
    routed,
    delivered,
    ok: true,
    reason: `routed @${routed.ts} → delivered @${delivered.ts} on session ${routed.session_id}`,
  };
}

/** Extract the burner's identities from the rig's /address response. Matches
 *  the shape signal-test-rig main.py:address_endpoint returns:
 *    { accounts: [{number, uuid, profile_name}, ...], default: {...} }
 *  Prefers `default`, falls back to `accounts[0]`.
 *
 *  PAT: BOTH identities matter — PAT is a real Signal client, but a signal-cli
 *  peer that has never shared its profile shows up as its ACI UUID, not its
 *  E164 (found live 2026-07-02: the rig's inbound created a messaging group
 *  keyed by UUID). Assertions must accept either. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function pickAccountIdentities(addr: any): string[] {
  const acct = addr?.default ?? (Array.isArray(addr?.accounts) ? addr.accounts[0] : undefined);
  return [acct?.number, acct?.uuid].filter((x): x is string => typeof x === 'string' && x.length > 0).map(String);
}

function randomCorr(): string {
  // 6 hex chars (24 bits). Enough to disambiguate parallel runs
  // without polluting the user-visible "ping <corr>" text.
  return Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, '0');
}

// ── IO plumbing ──────────────────────────────────────────────────────────

interface RunConfig {
  frontendUrl: string;
  rigUrl: string;
  patSignalE164: string;
  viewerToken: string;
  rigToken: string;
  overallTimeoutMs: number;
  pollIntervalMs: number;
  replyTailMs: number;
}

function readConfig(): RunConfig {
  return {
    frontendUrl: (process.env.PAT_FRONTEND_URL ?? DEFAULT_FRONTEND).replace(/\/$/, ''),
    rigUrl: (process.env.PAT_SIGNAL_RIG_A_URL ?? DEFAULT_RIG_A).replace(/\/$/, ''),
    patSignalE164: process.env.PAT_SIGNAL_E164 ?? DEFAULT_PAT_SIGNAL_E164,
    viewerToken: process.env.PAT_VIEWER_TOKEN ?? '',
    rigToken: process.env.PAT_SIGNAL_RIG_TOKEN ?? '',
    overallTimeoutMs: numEnv('SMOKETEST_SIGNAL_TIMEOUT_MS', DEFAULT_OVERALL_TIMEOUT_MS),
    pollIntervalMs: numEnv('SMOKETEST_SIGNAL_POLL_MS', DEFAULT_POLL_INTERVAL_MS),
    replyTailMs: numEnv('SMOKETEST_SIGNAL_REPLY_TAIL_MS', DEFAULT_REPLY_TAIL_MS),
  };
}

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function httpGetJson(url: string, bearer: string): Promise<any> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        headers: { Authorization: `Bearer ${bearer}` },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => {
          if ((res.statusCode ?? 0) >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error(`bad JSON: ${(err as Error).message}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function httpPostJson(url: string, bearer: string, payload: unknown): Promise<any> {
  const u = new URL(url);
  const data = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bearer}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data).toString(),
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => {
          if ((res.statusCode ?? 0) >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error(`bad JSON: ${(err as Error).message}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

interface FetchLogsArgs {
  frontendUrl: string;
  viewerToken: string;
  sinceMs: number;
  /** Comma-separated kind allowlist. Omitted = no filter. */
  kindFilter?: string;
}

/** Fetch a slice of the structured-log JSONL stream from pat-frontend.
 *  The proxy forwards every param through to nanoclaw's /admin/logs.jsonl.
 *  Returns parsed events in ts order (whatever the server emits). */
async function fetchLogsJsonl(args: FetchLogsArgs): Promise<LogEvent[]> {
  const url = new URL('/api/logs.jsonl', args.frontendUrl);
  url.searchParams.set('token', args.viewerToken);
  url.searchParams.set('since', String(args.sinceMs));
  if (args.kindFilter) url.searchParams.set('kind', args.kindFilter);
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'GET',
        headers: { accept: 'application/x-ndjson' },
      },
      (res) => {
        if ((res.statusCode ?? 0) >= 400) {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => (body += c));
          res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`)));
          return;
        }
        let buf = '';
        const events: LogEvent[] = [];
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buf += chunk;
          let idx: number;
          while ((idx = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            try {
              const parsed = JSON.parse(line) as LogEvent;
              if (parsed.kind) events.push(parsed);
            } catch {
              // Pass-through unparseable lines per admin/logs.jsonl contract.
            }
          }
        });
        res.on('end', () => {
          if (buf.trim()) {
            try {
              const parsed = JSON.parse(buf.trim()) as LogEvent;
              if (parsed.kind) events.push(parsed);
            } catch {
              /* ignore tail */
            }
          }
          resolve(events);
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ── Optional rig WS tap ──────────────────────────────────────────────────

interface ReplyWatcherArgs {
  rigUrl: string;
  rigToken: string;
  expectedSender: string;
}

interface ReplyWatcher {
  status: string;
  harvest(timeoutMs: number): Promise<string | null>;
  close(): void;
}

/** Open the rig's WS and remember the first inbound.text whose
 *  `data.source` matches PAT's Signal E164 (the rig sees PAT's reply
 *  as an inbound). Returns a watcher with `harvest()` to await it. */
function openRigReplyWatcher(args: ReplyWatcherArgs): ReplyWatcher {
  const wsUrl = `${args.rigUrl.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(args.rigToken)}&kind=inbound.text&from=${encodeURIComponent(args.expectedSender)}`;
  let ws: globalThis.WebSocket | null = null;
  let firstReply: string | null = null;
  let closed = false;
  const waiters: Array<(t: string | null) => void> = [];
  let status = 'connecting';

  try {
    ws = new WebSocket(wsUrl);
    ws.addEventListener('open', () => {
      status = 'open';
    });
    ws.addEventListener('message', (ev: MessageEvent) => {
      if (firstReply) return;
      try {
        const raw = typeof ev.data === 'string' ? ev.data : '';
        if (!raw) return;
        const parsed = JSON.parse(raw) as { kind?: string; data?: { text?: string; source?: string } };
        if (parsed.kind !== 'inbound.text') return;
        const text = parsed.data?.text;
        if (typeof text === 'string' && text.length > 0) {
          firstReply = text;
          for (const w of waiters.splice(0)) w(text);
        }
      } catch {
        /* ignore non-JSON */
      }
    });
    ws.addEventListener('error', () => {
      status = 'error';
    });
    ws.addEventListener('close', () => {
      status = closed ? 'closed' : 'unexpectedly-closed';
    });
  } catch (err) {
    status = `failed: ${(err as Error).message}`;
  }

  return {
    get status() {
      return status;
    },
    harvest(timeoutMs: number): Promise<string | null> {
      if (firstReply !== null) return Promise.resolve(firstReply);
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => {
        const t = setTimeout(() => {
          const idx = waiters.indexOf(resolve);
          if (idx >= 0) waiters.splice(idx, 1);
          resolve(firstReply);
        }, timeoutMs);
        waiters.push((text) => {
          clearTimeout(t);
          resolve(text);
        });
      });
    },
    close() {
      closed = true;
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      for (const w of waiters.splice(0)) w(firstReply);
    },
  };
}

// ── tiny helpers ─────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function failNow(start: number, outcomes: StepOutcome[]): ScenarioResult {
  return {
    scenario: signalProdInbound,
    passed: false,
    outcomes,
    durationMs: Date.now() - start,
  };
}
