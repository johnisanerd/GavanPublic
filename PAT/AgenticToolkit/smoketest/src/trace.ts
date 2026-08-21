/**
 * smoke-trace — the INSPECTION primitive for the interactive smoke.
 *
 * Prints a compact, chronological view of PAT's recent structured events so
 * the deploying agent can see what ACTUALLY happened server-side — which MCP
 * tools fired, whether an error surfaced, whether a voice memo really
 * synthesized, whether a delivery landed — rather than trusting the chat
 * reply alone. Backed by pat-frontend `/api/logs.jsonl` (viewer-token gated),
 * the same proxy the log-check helper uses.
 *
 *   pnpm run trace                       # last 5 min, salient kinds (internal)
 *   pnpm run trace --captured            # what a signal USER would've received
 *   pnpm run trace --since=10m --all     # everything (verbose)
 *   pnpm run trace --grep=publish_file   # substring filter on the row JSON
 *   pnpm run trace --tools               # only agent.tool_use / tool_result
 *
 * Two lenses: default = INTERNAL (tool calls, routing, errors);
 * `--captured` = USER-FACING (PAT's signal outbound rendered as messages —
 * voice memos with their spoken text, files, replies).
 *
 *   pnpm run trace --thread=smoke1 --tools   # only YOUR thread's tool calls
 *
 * Flags: --thread=<id> (isolate one conversation) --captured --since=<Nm|Ns>
 *        --grep=<str> --tools --all --limit=<n> --json
 */
import { readLogCheckConfig, fetchLogs, type LogEvent } from './log-check.js';
import { ensureEnvFromAgentSecrets } from './env-bootstrap.js';

ensureEnvFromAgentSecrets(['PAT_VIEWER_TOKEN', 'PAT_FRONTEND_URL']);

function flag(args: string[], name: string): string | undefined {
  const m = args.find((a) => a.startsWith(`--${name}=`));
  return m ? m.slice(name.length + 3) : undefined;
}

function parseSince(s: string | undefined): number {
  if (!s) return 5 * 60_000;
  const m = /^(\d+)\s*([sm])$/.exec(s.trim());
  if (!m) return 5 * 60_000;
  return Number(m[1]) * (m[2] === 's' ? 1000 : 60_000);
}

// Kinds worth showing by default — the "what did PAT do" signal.
const SALIENT = [
  'inbound.received',
  'routing.message-routed',
  'routing.message-delivered',
  'agent.tool_use',
  'agent.tool_result',
  'error.surfaced',
  'agent.query-error',
  'signal.send-acked',
  'signal.send-failed',
  'dropped_message',
  'permissions.caller-refused',
  'file.published',
];

function salientField(e: LogEvent): string {
  const d = (e.data ?? {}) as Record<string, unknown>;
  switch (e.kind) {
    case 'agent.tool_use':
    case 'agent.tool_result':
      return `${d.tool ?? '?'}${d.input_to ? ` to=${d.input_to}` : ''}${d.input_path ? ` path=${d.input_path}` : ''}${d.input_query ? ` q=${String(d.input_query).slice(0, 40)}` : ''}${d.output_summary ? ` → ${String(d.output_summary).slice(0, 80)}` : ''}`;
    case 'error.surfaced':
    case 'agent.query-error':
      return String(d.error_preview ?? d.error_raw ?? d.error ?? d.err_message ?? '').slice(0, 120);
    case 'signal.send-acked': {
      const body = (d.spoken_text ?? d.text ?? '') as string;
      return `${d.kind_detail ?? ''}${d.captured ? ' captured' : ''}${d.audio_bytes ? ` audio=${d.audio_bytes}` : ''}${d.file_count ? ` files=${d.file_count}` : ''}${body ? ` "${body.slice(0, 90)}"` : ''} → ${d.recipient ?? ''}`;
    }
    case 'signal.send-failed':
      return `${d.kind_detail ?? ''} FAILED ${String(d.error ?? '').slice(0, 80)}`;
    case 'routing.message-delivered':
      return `${d.channel_type ?? ''}${d.file_count ? ` files=${d.file_count}` : ''} kind=${d.msg_kind ?? ''}`;
    case 'routing.message-routed':
    case 'inbound.received':
      return `${d.channel_type ?? d.user_id ?? ''} ${d.person_name ?? d.person_id ?? ''}`.trim();
    case 'dropped_message':
      return String(d.reason ?? '').slice(0, 80);
    case 'file.published':
      return String(d.identifier ?? d.path ?? '').slice(0, 80);
    default:
      return JSON.stringify(d).slice(0, 100);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const cfg = readLogCheckConfig();
  if (!cfg.token) {
    console.error('smoke-trace: PAT_VIEWER_TOKEN not set (needed to read the log proxy).');
    process.exit(2);
  }
  const sinceMs = Date.now() - parseSince(flag(args, 'since'));
  const grep = flag(args, 'grep');
  const threadFilter = flag(args, 'thread');
  const toolsOnly = args.includes('--tools');
  const capturedView = args.includes('--captured');
  const all = args.includes('--all');
  const json = args.includes('--json');
  const limit = Number(flag(args, 'limit') ?? '100');

  let events: LogEvent[];
  try {
    events = await fetchLogs(cfg, sinceMs);
  } catch (err) {
    console.error(`smoke-trace: ${(err as Error).message}`);
    process.exit(1);
  }

  // --captured: the USER-FACING view — what a (simulated) signal user would
  // actually have received from PAT, rendered as messages.
  if (capturedView) {
    const outbound = events
      .filter(
        (e) =>
          (e.kind === 'signal.send-acked' && (e.data ?? {}).captured) ||
          (e.kind === 'routing.message-delivered' && (e.data ?? {}).channel_type === 'signal'),
      )
      .sort((a, b) => String(a.ts ?? '').localeCompare(String(b.ts ?? '')));
    if (outbound.length === 0) {
      console.log('(nothing captured — PAT sent no signal outbound in this window)');
      return;
    }
    for (const e of outbound) {
      const d = (e.data ?? {}) as Record<string, unknown>;
      const t = String(e.ts ?? '').slice(11, 19);
      if (e.kind === 'signal.send-acked' && d.kind_detail === 'voice-memo') {
        console.log(`${t} 🎤 voice memo (${d.audio_bytes}B): "${String(d.spoken_text ?? '').slice(0, 200)}"`);
      } else if (e.kind === 'signal.send-acked' && d.kind_detail === 'attachment') {
        const files = Array.isArray(d.files) ? d.files.map((f: { filename?: string }) => f.filename).join(', ') : '';
        console.log(`${t} 📎 file: ${files}${d.text ? ` — "${String(d.text).slice(0, 160)}"` : ''}`);
      } else if (e.kind === 'signal.send-acked') {
        console.log(`${t} 💬 "${String(d.text ?? '').slice(0, 240)}"`);
      } else {
        console.log(`${t} ✉️  delivered (${d.channel_type}${d.file_count ? `, ${d.file_count} file(s)` : ''})`);
      }
    }
    return;
  }

  let rows = events.filter((e) => {
    // --thread: keep this thread + thread-less host events; drop other threads'
    // noise (concurrent smoke runs / stray sessions).
    if (threadFilter && e.thread_id && e.thread_id !== threadFilter) return false;
    if (toolsOnly) return e.kind.startsWith('agent.tool');
    if (!all && !SALIENT.includes(e.kind)) return false;
    if (grep && !JSON.stringify(e).toLowerCase().includes(grep.toLowerCase())) return false;
    return true;
  });
  // Chronological (oldest→newest) so the agent reads the sequence of events.
  rows.sort((a, b) => String(a.ts ?? '').localeCompare(String(b.ts ?? '')));
  if (rows.length > limit) rows = rows.slice(rows.length - limit);

  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log('(no matching events — widen --since, drop filters, or the turn may not have reached PAT)');
    return;
  }
  for (const e of rows) {
    const t = String(e.ts ?? '').slice(11, 19);
    const err = e.level === 'error' || e.level === 'fatal';
    const tag = err ? '\x1b[31m' : e.kind.startsWith('agent.tool') ? '\x1b[36m' : '\x1b[90m';
    console.log(`${t} ${tag}${e.kind.padEnd(26)}\x1b[0m ${salientField(e)}`);
    if (all) {
      // --all doubles as "full": dump the untruncated payload for the fields
      // salientField clips (response_text, full_text, error, etc.).
      const d = (e.data ?? {}) as Record<string, unknown>;
      const full = d.full_text ?? d.response_text ?? d.text ?? d.spoken_text ?? d.error_raw ?? d.error_preview;
      if (typeof full === 'string' && full.length > 90) console.log(`    \x1b[90m${full}\x1b[0m`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
