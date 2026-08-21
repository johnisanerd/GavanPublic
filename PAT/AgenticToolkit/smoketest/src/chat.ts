/**
 * smoke-chat — the INTERACTIVE smoke primitive.
 *
 * One send → wait → print PAT's reply. This is the turn-by-turn harness the
 * *deploying agent itself* drives when running the interactive smoke skill
 * (`/pat-smoke-interactive`): the agent sends a message, reads PAT's actual
 * reply on stdout, applies its own judgment, then decides the next message.
 * NOT a scripted scenario — the agent is the tester.
 *
 * Two layers (`--layer`):
 *   - `realtime` (default) — POST `/inbound` (rest tunnel :8765). Exercises the
 *     full FRONT-MIND → back-mind orchestration, as a phone/anam turn would.
 *   - `signal` — inject a chat inbound via the sim capture channel's HTTP
 *     inbound (:8769); routes STRAIGHT to the back-mind (no front-mind), exactly
 *     like a real Signal message. Bidirectional with the capture outbound.
 * Stable `--thread` keeps one realtime conversation; `/clear` resets it.
 *
 * HOW IT READS THE REPLY: from the structured-log proxy, NOT the /outbound SSE.
 * PAT answers in two shapes and the SSE tap surfaces neither reliably:
 *   - front-mind INLINE  → `request-layer.decided decision=noop`, answer in
 *     `banter.called.response_text`.
 *   - forwarded to BACK-MIND → `decision=forward`, answer in
 *     `chat.row-received.full_text` (after some front-mind filler utterances).
 * The proxy carries the FULL text of both; polling it handles both modes and
 * never false-reports "NO REPLY" for a front-mind-answered turn (the bug the
 * SSE-only version had — it broke the smoke's very first steps).
 *
 * stdout = PAT's reply text ONLY (so the agent can capture it cleanly).
 * source + diagnostics go to stderr.
 *
 *   npx tsx src/chat.ts "hey Pat, what can you do?"
 *   npx tsx src/chat.ts --thread=pubtest "publish a file containing HELLO-42"
 *   npx tsx src/chat.ts "/clear"                 # reset the session
 *
 * Flags: --thread=<id> (default smoke-interactive) --timeout=<s> (default 90) --json
 */
import { RealtimeClient } from './client.js';
import { readLogCheckConfig, fetchLogs, type LogEvent } from './log-check.js';
import { ensureEnvFromAgentSecrets } from './env-bootstrap.js';

ensureEnvFromAgentSecrets(['PAT_VIEWER_TOKEN', 'PAT_FRONTEND_URL']);

function flag(args: string[], name: string): string | undefined {
  const m = args.find((a) => a.startsWith(`--${name}=`));
  return m ? m.slice(name.length + 3) : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Back-mind replies arrive as JSON `{"text":"…"}` in full_text; unwrap it. */
function unwrapText(s: unknown): string {
  const raw = typeof s === 'string' ? s : '';
  const t = raw.trim();
  if (t.startsWith('{')) {
    try {
      const o = JSON.parse(t) as { text?: string };
      if (typeof o.text === 'string') return o.text;
    } catch {
      /* not JSON — use raw */
    }
  }
  return raw;
}

interface Reply {
  text: string;
  source: string;
}

async function getReply(
  cfg: ReturnType<typeof readLogCheckConfig>,
  sinceMs: number,
  thread: string | undefined,
  timeoutMs: number,
  isAdmin: boolean,
): Promise<Reply | null> {
  const deadline = Date.now() + timeoutMs;
  const byTs = (a: LogEvent, b: LogEvent) => String(a.ts ?? '').localeCompare(String(b.ts ?? ''));
  // Only events on this thread (some kinds omit thread_id — keep those too).
  // `thread` undefined (e.g. the signal layer, which strips thread ids) → keep
  // all and rely on the inbound-received timestamp anchor below.
  const onThread = (e: LogEvent) => !thread || !e.thread_id || e.thread_id === thread;
  for (;;) {
    let ev: LogEvent[] = [];
    try {
      ev = (await fetchLogs(cfg, sinceMs)).filter(onThread);
    } catch {
      /* transient — retry until deadline */
    }
    // Anchor on THIS turn's inbound so we never return a previous turn's reply
    // (both turns share the thread; the timestamp anchor disambiguates).
    const inbounds = ev.filter((e) => e.kind === 'inbound.received').sort(byTs);
    if (inbounds.length) {
      const turnTs = String(inbounds[inbounds.length - 1]!.ts ?? '');
      const after = (e: LogEvent) => String(e.ts ?? '') >= turnTs;
      const chatRows = ev.filter((e) => e.kind === 'chat.row-received' && after(e)).sort(byTs);
      // Back-mind reply is authoritative whenever present (the forward path).
      if (chatRows.length) {
        return { text: unwrapText(chatRows[chatRows.length - 1]!.data?.full_text), source: 'back-mind' };
      }
      // Signal layer: a pure chat channel emits NO chat.row-received — the
      // back-mind reply comes out as the captured signal.send-acked (the actual
      // "signal out" a user would receive). Read that.
      const captures = ev.filter((e) => e.kind === 'signal.send-acked' && e.data?.captured && after(e)).sort(byTs);
      if (captures.length) {
        const d = (captures[captures.length - 1]!.data ?? {}) as Record<string, unknown>;
        const text = String(d.text ?? d.spoken_text ?? `[${d.kind_detail}]`);
        return { text, source: 'signal-out (captured)' };
      }
      const banters = ev.filter((e) => e.kind === 'banter.called' && after(e)).sort(byTs);
      const decided = ev.filter((e) => e.kind === 'request-layer.decided' && after(e)).sort(byTs).pop();
      const decision = decided?.data?.decision as string | undefined;
      // Front-mind answered inline: routing decided NOT to wake the back-mind.
      if (decision && decision !== 'forward' && decision !== 'wake' && banters.length) {
        return { text: String(banters[banters.length - 1]!.data?.response_text ?? ''), source: 'front-mind' };
      }
      // Admin commands (/clear …) may not route through banter/back-mind.
      if (isAdmin) {
        if (banters.length) return { text: String(banters[banters.length - 1]!.data?.response_text ?? ''), source: 'admin' };
        const utt = ev.filter((e) => e.kind === 'utterance.stream-ended' && after(e)).sort(byTs);
        if (utt.length) return { text: String(utt[utt.length - 1]!.data?.full_text ?? ''), source: 'admin' };
      }
    }
    if (Date.now() >= deadline) return null;
    await sleep(2500);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const message = args.filter((a) => !a.startsWith('--')).join(' ').trim();
  if (!message) {
    console.error('usage: smoke-chat "<message>" [--thread=<id>] [--timeout=<s>] [--json]');
    process.exit(2);
  }
  const thread = flag(args, 'thread') ?? 'smoke-interactive';
  const timeoutMs = Number(flag(args, 'timeout') ?? '90') * 1000;
  const layer = (flag(args, 'layer') ?? 'realtime') as 'realtime' | 'signal';
  const json = args.includes('--json');
  const baseUrl = process.env.REALTIME_BASE_URL ?? 'http://127.0.0.1:8765';
  const cfg = readLogCheckConfig();
  if (!cfg.token) {
    console.error('smoke-chat: PAT_VIEWER_TOKEN not set (needed to read PAT\'s reply from the log proxy).');
    process.exit(2);
  }

  const isAdmin = message.startsWith('/');
  const sinceMs = Date.now() - 1500; // small backdate for skew; the inbound anchor prevents cross-turn bleed
  process.stderr.write(`\x1b[36m→ [${layer}:${thread}] ${message}\x1b[0m\n`);
  try {
    if (layer === 'signal') {
      // Straight-to-back-mind chat path: inject a `signal` inbound via the
      // sim capture channel's HTTP inbound (no front-mind). Reply comes back
      // as a back-mind chat.row-received (thread ids are stripped on chat
      // channels, so read by timestamp anchor).
      const simBase = (process.env.SIGNAL_SIM_BASE_URL ?? 'http://127.0.0.1:8769').replace(/\/$/, '');
      const res = await fetch(`${simBase}/inbound`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: process.env.SIGNAL_SIM_FROM, text: message }),
      });
      if (!res.ok) throw new Error(`sim /inbound → ${res.status}: ${(await res.text()).slice(0, 160)}`);
    } else {
      await new RealtimeClient({ baseUrl }).postTurn(message, 'smoke-test', thread);
    }
  } catch (err) {
    console.error(`smoke-chat: inbound failed: ${(err as Error).message} (tunnel down? realtime \`curl ${baseUrl}\`, signal needs :8769)`);
    process.exit(1);
  }

  const reply = await getReply(
    cfg,
    sinceMs,
    layer === 'signal' ? undefined : thread,
    isAdmin ? Math.min(timeoutMs, 25_000) : timeoutMs,
    isAdmin,
  );
  if (!reply) {
    const err = isAdmin
      ? `no visible reply to admin command "${message}" within 25s (may have applied silently — check \`npx tsx src/trace.ts\`).`
      : `NO REPLY within ${timeoutMs / 1000}s (thread=${thread}). Cold-start, or the turn was dropped — check \`npx tsx src/trace.ts\`.`;
    if (json) console.log(JSON.stringify({ ok: false, thread, reply: null, error: err }));
    else process.stderr.write(`\x1b[31m${err}\x1b[0m\n`);
    process.exit(1);
  }

  process.stderr.write(`\x1b[90m[source: ${reply.source}]\x1b[0m\n`);
  // An empty reply is often CORRECT (e.g. PAT sent a file/voice-memo instead of
  // chatting) — flag it so an empty stdout doesn't read as a hang/failure.
  if (!reply.text.trim()) {
    process.stderr.write(`\x1b[90m[no chat text — PAT may have replied with a file/voice memo; check \`npx tsx src/trace.ts --thread=${thread} --captured\`]\x1b[0m\n`);
  }
  if (json) console.log(JSON.stringify({ ok: true, thread, reply: reply.text, source: reply.source }));
  else process.stdout.write(reply.text.trim() + '\n');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
