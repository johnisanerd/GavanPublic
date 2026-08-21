/**
 * smoke-call — the AGENTIC voice-smoke primitive (operator directive
 * 2026-07-04: voice testing is closed-loop; the agent drives, listens,
 * judges). This tool gives a driving agent a live phone call as four
 * print-and-exit verbs, so a whole conversation can be run turn-by-turn
 * from a terminal:
 *
 *   npx tsx src/call.ts start                # dial; prints thread_id when ready
 *   npx tsx src/call.ts say "what's 2+2?"    # speak (real TTS leg)
 *   npx tsx src/call.ts listen                # block until PAT's NEXT spoken
 *                                            # utterance appears in the trace;
 *                                            # prints it. Repeatable.
 *   npx tsx src/call.ts status               # session state
 *   npx tsx src/call.ts hangup               # end call, flush call.wav
 *
 * Design:
 *  - `start` detaches a daemon (this same file, verb `_daemon`) that owns the
 *    CartesiaCallClient WS (continuous-mic keepalive on) and a tiny localhost
 *    control server (POST /say, /hangup, GET /status). State lives in
 *    `.call-session.json` next to this file.
 *  - `listen` does NOT ask the daemon — it reads the structured-log
 *    trace (pat-frontend /api/logs.jsonl, viewer token) for `tts.agent-said`
 *    on the session's thread, exactly the stream a human debugger greps.
 *    Utterances stream as deltas; we collect until a quiet gap then print the
 *    joined text. A cursor in the state file makes successive calls return
 *    successive utterances.
 *  - Env self-bootstraps from ../.env.agent (CARTESIA_API_KEY,
 *    CARTESIA_AGENT_ID ← _STAGING, PAT_VIEWER_TOKEN) — no manual exports.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CartesiaCallClient } from './cartesia-call.js';
import { ensureEnvFromAgentSecrets } from './env-bootstrap.js';
import { fetchLogs, readLogCheckConfig } from './log-check.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(HERE, '..', '.call-session.json');
const CONTROL_PORT = Number(process.env.SMOKE_CALL_PORT ?? 8788);
const DAEMON_MAX_MINUTES = Number(process.env.SMOKE_CALL_MAX_MINUTES ?? 30);

interface SessionState {
  pid: number;
  port: number;
  threadId: string | null;
  startedMs: number;
  /** Log cursor (ms epoch): listen reads tts.agent-said after this. */
  cursorMs: number;
  artifactDir: string;
}

function loadEnv(): void {
  // SMOKE_PREAUTH_TOKEN: shared secret for smoke-caller pre-auth (see
  // cartesia-call.ts connect()). Present in .env.agent ⇒ smoke calls are
  // admitted as the person-linked smoke number; SMOKE_PREAUTH=0 opts out
  // (e.g. to verify the tokenless realtime:websocket path).
  ensureEnvFromAgentSecrets(['CARTESIA_API_KEY', 'CARTESIA_AGENT_ID_STAGING', 'PAT_VIEWER_TOKEN', 'SMOKE_PREAUTH_TOKEN']);
  if (!process.env.CARTESIA_AGENT_ID && process.env.CARTESIA_AGENT_ID_STAGING) {
    process.env.CARTESIA_AGENT_ID = process.env.CARTESIA_AGENT_ID_STAGING;
  }
}

function readState(): SessionState | null {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as SessionState;
  } catch {
    return null;
  }
}

function writeState(s: SessionState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function control(pathname: string, body?: unknown): Promise<{ status: number; json: any }> {
  const s = readState();
  if (!s) throw new Error('no call session (run: start)');
  const res = await fetch(`http://127.0.0.1:${s.port}${pathname}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

// ─────────────────────────── daemon ───────────────────────────

async function runDaemon(): Promise<void> {
  process.on('exit', (code) => console.error(`[daemon] exit code=${code}`));
  process.on('uncaughtException', (err) => {
    console.error('[daemon] UNCAUGHT:', err);
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    console.error('[daemon] UNHANDLED REJECTION:', err);
    process.exit(1);
  });
  loadEnv();
  const startedMs = Date.now();
  const artifactDir = path.join(HERE, '..', 'artifacts', `call-session-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const client = new CartesiaCallClient({ persistDir: artifactDir });

  await client.connect();
  const greet = await client.waitForGreetingToFinish();

  // Discover our thread_id from the trace: newest call.started since we
  // dialed. Small race window if two calls start simultaneously — smoke
  // sessions are one-at-a-time, and status shows the resolved id for a
  // human to sanity-check.
  const logCfg = readLogCheckConfig();
  let threadId: string | null = null;
  if (logCfg.token) {
    const deadline = Date.now() + 20_000;
    while (!threadId && Date.now() < deadline) {
      const evs = await fetchLogs(logCfg, startedMs - 5_000, 'call.started').catch(() => []);
      const mine = evs.filter((e) => (e.thread_id ?? '').startsWith('call-'));
      if (mine.length) threadId = mine[mine.length - 1]!.thread_id ?? null;
      if (!threadId) await new Promise((r) => setTimeout(r, 1_000));
    }
  }

  const state: SessionState = {
    pid: process.pid,
    port: CONTROL_PORT,
    threadId,
    startedMs,
    cursorMs: Date.now(),
    artifactDir,
  };
  writeState(state);

  // Serialize say() calls — one speech clip on the wire at a time. Each
  // say is TRACKED: `say --wait` (or /says) surfaces failures/interrupts
  // instead of them vanishing into a fire-and-forget void.
  interface SayRecord {
    id: number;
    text: string;
    state: 'queued' | 'speaking' | 'done' | 'error';
    error?: string;
  }
  const says: SayRecord[] = [];
  let sayChain: Promise<void> = Promise.resolve();
  let closing = false;

  const flushAndExit = async (code: number): Promise<never> => {
    if (!closing) {
      closing = true;
      for (const r of says) {
        if (r.state === 'queued' || r.state === 'speaking') {
          r.state = 'error';
          r.error = 'interrupted: call ended before clip finished';
        }
      }
      try {
        const wav = await client.close();
        console.error(`[daemon] flushed: ${wav}`);
      } catch (err) {
        console.error('[daemon] close/flush FAILED:', err);
      }
    }
    process.exit(code);
  };
  process.on('SIGTERM', () => void flushAndExit(0));
  process.on('SIGINT', () => void flushAndExit(0));

  const server = http.createServer((req, res) => {
    const reply = (code: number, obj: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'GET' && req.url === '/status') {
      reply(200, { ok: true, threadId, greeting: greet.reason, upMs: Date.now() - startedMs });
      return;
    }
    if (req.method === 'POST' && req.url === '/say') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const text = String(JSON.parse(body || '{}').text ?? '');
        if (!text) {
          reply(400, { ok: false, error: 'missing text' });
          return;
        }
        const spokeAt = Date.now();
        const rec: SayRecord = { id: says.length + 1, text, state: 'queued' };
        says.push(rec);
        sayChain = sayChain
          .then(async () => {
            if (closing) throw new Error('interrupted: call closing');
            rec.state = 'speaking';
            await client.sendUserTurn(text);
            rec.state = 'done';
            const s = readState();
            if (s) writeState({ ...s, cursorMs: Math.max(s.cursorMs, spokeAt) });
          })
          .catch((err: unknown) => {
            rec.state = 'error';
            rec.error = err instanceof Error ? err.message : String(err);
          });
        // Ack immediately — the clip streams at real-time pace. Outcome is
        // tracked: `say --wait` / GET /says reports done|error per clip;
        // listen (trace-based) hears the response.
        reply(200, { ok: true, id: rec.id, queuedAt: spokeAt });
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/says') {
      reply(200, { ok: true, says });
      return;
    }
    if (req.method === 'POST' && req.url === '/hangup') {
      // Reply FIRST (the original reply-after-close ordering wedged once and
      // left a zombie call), then flush + exit out of band.
      reply(200, { ok: true, wav: path.join(artifactDir, 'call.wav') });
      setImmediate(() => void flushAndExit(0));
      return;
    }
    reply(404, { ok: false });
  });
  server.listen(CONTROL_PORT, '127.0.0.1');

  // Safety net: never leave a zombie call burning Cartesia minutes.
  setTimeout(async () => {
    await client.close().catch(() => {});
    process.exit(0);
  }, DAEMON_MAX_MINUTES * 60_000).unref();
}

// ─────────────────────────── verbs ───────────────────────────

async function cmdStart(): Promise<void> {
  const prev = readState();
  if (prev && alive(prev.pid)) {
    console.log(`already live: thread=${prev.threadId} pid=${prev.pid} (hangup first for a fresh call)`);
    return;
  }
  fs.rmSync(STATE_FILE, { force: true });
  // Daemon stderr/stdout land in a logfile — a silent daemon is undebuggable
  // (the first wav-flush bug hid in exactly that darkness).
  const logPath = path.join(HERE, '..', '.call-daemon.log');
  const logFd = fs.openSync(logPath, 'w');
  const child = spawn(process.execPath, [process.argv[1]!, '_daemon'], {
    cwd: path.join(HERE, '..'),
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, NODE_OPTIONS: '--import tsx' },
  });
  child.unref();
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const s = readState();
    if (s && alive(s.pid)) {
      try {
        const st = await control('/status');
        if (st.json.ok) {
          console.log(`call live — thread=${st.json.threadId ?? 'unknown'} greeting=${st.json.greeting}`);
          console.log(`next: say "<text>" → listen`);
          return;
        }
      } catch {
        /* not up yet */
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.error('daemon did not come up within 60s');
  process.exit(1);
}

/** Any say that failed since the last check gets REPORTED LOUDLY on the next
 *  interaction (say or listen) — the exception finds the driving agent; no
 *  polling required. Reported ids are remembered in the state file. */
async function surfaceFailedSays(): Promise<boolean> {
  const st = await control('/says').catch(() => null);
  const fails = (st?.json?.says ?? []).filter((r: { state: string }) => r.state === 'error');
  if (!fails.length) return false;
  const cur = readState();
  const seen = new Set<number>(((cur as unknown as { reportedFails?: number[] })?.reportedFails) ?? []);
  const fresh = fails.filter((r: { id: number }) => !seen.has(r.id));
  if (!fresh.length) return false;
  for (const r of fresh) {
    console.error(`⚠️  say (id ${r.id}) FAILED/INTERRUPTED: "${r.text}" — ${r.error}`);
  }
  if (cur) {
    writeState({ ...cur, ...( { reportedFails: [...seen, ...fresh.map((r: { id: number }) => r.id)] } as object) } as SessionState);
  }
  return true;
}

async function cmdSay(text: string, wait: boolean): Promise<void> {
  if (!text) {
    console.error('usage: say "<text>" [--wait]');
    process.exit(1);
  }
  await surfaceFailedSays();
  const r = await control('/say', { text });
  if (!r.json.ok) {
    console.error(`say failed: ${JSON.stringify(r.json)}`);
    process.exit(1);
  }
  const id = r.json.id as number;
  if (!wait) {
    console.log(`speaking (id ${id}): "${text}" — async; failures surface in say --wait / status`);
    return;
  }
  // --wait: block until this clip fully streamed; nonzero exit on error or
  // interruption so a driving agent can't miss a swallowed turn.
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const st = await control('/says').catch(() => null);
    const rec = st?.json?.says?.find((x: { id: number }) => x.id === id);
    if (rec?.state === 'done') {
      console.log(`spoke (id ${id}): "${text}"`);
      return;
    }
    if (rec?.state === 'error') {
      console.error(`say INTERRUPTED/FAILED (id ${id}): ${rec.error}`);
      process.exit(3);
    }
    await new Promise((r2) => setTimeout(r2, 500));
  }
  console.error('say --wait timed out (clip still streaming after 120s?)');
  process.exit(1);
}

async function cmdListen(timeoutSec: number): Promise<void> {
  loadEnv();
  const hadFailures = await surfaceFailedSays().catch(() => false);
  const s = readState();
  if (!s) {
    console.error('no call session (run: start)');
    process.exit(1);
  }
  if (!s.threadId) {
    console.error('session has no resolved thread_id — check status / logs');
    process.exit(1);
  }
  const cfg = readLogCheckConfig();
  const deadline = Date.now() + timeoutSec * 1_000;
  const QUIET_MS = 1_800; // deltas stream; a pause this long = utterance done
  const parts: { ts: number; text: string }[] = [];
  let lastNewAt = 0;
  while (Date.now() < deadline) {
    const evs = await fetchLogs(cfg, s.cursorMs, 'tts.agent-said').catch(() => []);
    for (const e of evs) {
      if (e.thread_id !== s.threadId) continue;
      const ts = Date.parse(e.ts ?? '') || 0;
      if (ts <= s.cursorMs) continue;
      if (parts.some((p) => p.ts === ts && p.text === (e.data?.text ?? ''))) continue;
      parts.push({ ts, text: String(e.data?.text ?? '') });
      lastNewAt = Date.now();
    }
    if (parts.length && Date.now() - lastNewAt >= QUIET_MS) break;
    await new Promise((r) => setTimeout(r, 700));
  }
  if (!parts.length) {
    console.error(`NO utterance within ${timeoutSec}s (thread=${s.threadId})${hadFailures ? ' — NOTE: a prior say failed (see above); PAT may never have heard you' : ''}`);
    process.exit(2);
  }
  parts.sort((a, b) => a.ts - b.ts);
  const maxTs = parts[parts.length - 1]!.ts;
  const cur = readState();
  if (cur) writeState({ ...cur, cursorMs: maxTs });
  // Was this utterance cut off mid-stream (barge-in / cancel)? Surface it —
  // a driving agent should know it heard a fragment, not the full thought.
  const cancels = await fetchLogs(cfg, s.cursorMs, 'utterance.stream-cancelled').catch(() => []);
  const cancelled = cancels.some((e) => e.thread_id === s.threadId && (Date.parse(e.ts ?? '') || 0) >= parts[0]!.ts);
  console.log(`PAT: ${parts.map((p) => p.text).join('')}${cancelled ? '   [interrupted mid-utterance]' : ''}`);
}

async function cmdStatus(): Promise<void> {
  const s = readState();
  if (!s) {
    console.log('no session');
    return;
  }
  const up = alive(s.pid);
  let ctl: unknown = null;
  if (up) ctl = (await control('/status').catch(() => null))?.json ?? null;
  console.log(JSON.stringify({ ...s, daemonAlive: up, control: ctl }, null, 2));
}

async function cmdHangup(): Promise<void> {
  const s = readState();
  if (!s) {
    console.log('no session');
    return;
  }
  if (alive(s.pid)) {
    await control('/hangup', {}).catch(() => null); // {} forces POST — bare control() is GET and 404s
    const deadline = Date.now() + 15_000;
    while (alive(s.pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300));
    if (alive(s.pid)) {
      console.error(`daemon (pid ${s.pid}) did not exit — killing it; call.wav may be lost`);
      try { process.kill(s.pid, 'SIGKILL'); } catch { /* gone */ }
    }
  }
  const wav = path.join(s.artifactDir, 'call.wav');
  console.log(fs.existsSync(wav) ? `hung up. call.wav: ${wav}` : `hung up — WARNING: no call.wav at ${wav}`);
  fs.rmSync(STATE_FILE, { force: true });
}

// ─────────────────────────── main ───────────────────────────

const [verb, ...rest] = process.argv.slice(2);
const timeoutFlag = rest.find((a) => a.startsWith('--timeout'));
const timeoutSec = timeoutFlag ? Number(timeoutFlag.split('=')[1] ?? rest[rest.indexOf(timeoutFlag) + 1] ?? 60) : 60;

switch (verb) {
  case '_daemon':
    void runDaemon();
    break;
  case 'start':
    void cmdStart();
    break;
  case 'say':
    void cmdSay(rest.filter((a) => !a.startsWith('--')).join(' '), rest.includes('--wait'));
    break;
  case 'listen':
    void cmdListen(timeoutSec);
    break;
  case 'status':
    void cmdStatus();
    break;
  case 'hangup':
    void cmdHangup();
    break;
  default:
    console.log('usage: smoke-call start | say "<text>" [--wait] | listen [--timeout 60] | status | hangup');
    process.exit(verb ? 1 : 0);
}
