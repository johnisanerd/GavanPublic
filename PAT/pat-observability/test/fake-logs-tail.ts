/**
 * Synthetic stand-in for nanoclaw's `/admin/logs.tail`, for local end-to-end
 * testing of the forwarder without a live nanoclaw. Mirrors the real endpoint's
 * contract (verified against nanoclaw/src/admin/index.ts:397-528):
 *   - SSE framing: each event as `data: <single-line-json>\n\n`
 *   - `: ` comment lines for connect notice + keepalive
 *   - `?since=<wall-clock-ms>` filters out backlog with ts < since
 *   - NO level filter — debug + llm.call emitted like everything else
 *
 * Emits a small backlog immediately, then one synthetic event/sec live.
 * Run: bun run fake-logs-tail.ts  (PORT default 8767)
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8767);

const KINDS = [
  { kind: 'chat.row-received', level: 'info' },
  { kind: 'request-layer.decided', level: 'info' },
  { kind: 'llm.call', level: 'debug' }, // the detailed-debug case
  { kind: 'narrator.fired', level: 'info' },
  { kind: 'tts.turn-ended', level: 'info' },
];

let counter = 0;
function makeEvent(threadId: string, tsMs: number): Record<string, unknown> {
  const spec = KINDS[counter % KINDS.length]!;
  counter += 1;
  return {
    ts: new Date(tsMs).toISOString(),
    source: 'nanoclaw-host',
    id: `nch-${tsMs}-${counter}`,
    kind: spec.kind,
    level: spec.level,
    thread_id: threadId,
    session_id: `sess-${threadId}`,
    platform_id: 'anam-web:test',
    data: {
      seq: counter,
      note: `synthetic ${spec.kind}`,
      // a nested data.* field to confirm OpenObserve flattening + query
      latency_ms: 100 + (counter % 50),
    },
  };
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname !== '/admin/logs.tail') {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(`: tail-stream connected\n\n`);

  const sinceMs = Number(url.searchParams.get('since') ?? '0') || 0;
  const now = Date.now();

  // Backlog: 10 events over the last 100s, filtered by since (like the real one).
  const thread = `call-${now.toString(36)}`;
  for (let i = 10; i >= 1; i--) {
    const tsMs = now - i * 10_000;
    if (sinceMs > 0 && tsMs < sinceMs) continue;
    res.write(`data: ${JSON.stringify(makeEvent(thread, tsMs))}\n\n`);
  }

  // Live: one event/sec.
  const timer = setInterval(() => {
    res.write(`data: ${JSON.stringify(makeEvent(thread, Date.now()))}\n\n`);
  }, 1000);
  const ka = setInterval(() => res.write(`: ka\n\n`), 5000);
  req.on('close', () => {
    clearInterval(timer);
    clearInterval(ka);
  });
});

server.listen(PORT, () => console.error(`[fake-logs-tail] listening on :${PORT}/admin/logs.tail`));
