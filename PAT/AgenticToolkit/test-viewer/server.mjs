import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, extname, normalize, resolve } from 'node:path';

const PORT = Number(process.env.PORT || 9100);
const HOST = '127.0.0.1';
const PUBLIC_DIR = resolve(new URL('./public', import.meta.url).pathname);
const DATA_DIR = resolve(PUBLIC_DIR, '../../nanoclaw/data/v2-sessions/_smoketest');

// scenarios within a "run" group should start within this many ms of each other
const RUN_GROUP_GAP_MS = 60_000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function safeJoin(base, rel) {
  const target = normalize(join(base, rel));
  if (!target.startsWith(base)) return null;
  return target;
}

async function serveFile(res, path, req) {
  try {
    const st = await stat(path);
    if (!st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    const type = MIME[extname(path).toLowerCase()] || 'application/octet-stream';
    // Range support — Safari's <audio> element issues a Range request and
    // refuses to play if the server returns a plain 200. Chrome/Firefox
    // tolerate the 200; Safari does not. Always advertise Accept-Ranges
    // so clients know we'll honour subsequent Range requests.
    const range = req?.headers?.range;
    if (range) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!m) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        res.end();
        return;
      }
      const start = parseInt(m[1], 10);
      const end = m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        res.end();
        return;
      }
      const cappedEnd = Math.min(end, st.size - 1);
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Range': `bytes ${start}-${cappedEnd}/${st.size}`,
        'Content-Length': cappedEnd - start + 1,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      });
      createReadStream(path, { start, end: cappedEnd }).pipe(res);
      return;
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    });
    createReadStream(path).pipe(res);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
}

// Parse the timestamp embedded in dir names like:
// baseline-2026-05-05T20-00-01-587Z
// install-failure-recovery-2026-05-05T20-00-01-587Z
// We look for the trailing ISO-like chunk: -YYYY-MM-DDTHH-mm-ss-sssZ
const NAME_TS_RE = /-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)$/;
function tsFromName(name) {
  const m = name.match(NAME_TS_RE);
  if (!m) return null;
  // 2026-05-05T20-00-01-587Z -> 2026-05-05T20:00:01.587Z
  const iso = m[1].replace(
    /T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    'T$1:$2:$3.$4Z'
  );
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function scenarioFromName(name) {
  const m = name.match(NAME_TS_RE);
  if (m) return name.slice(0, name.length - m[0].length);
  return name;
}

async function listRuns() {
  const names = await readdir(DATA_DIR);
  const runs = [];
  for (const name of names) {
    if (name.startsWith('.') || name.startsWith('_')) continue;
    const dir = join(DATA_DIR, name);
    const s = await stat(dir).catch(() => null);
    if (!s?.isDirectory()) continue;
    const files = await readdir(dir).catch(() => []);
    let summary = null;
    try {
      const [resultJson, transcriptJson] = await Promise.all([
        readFile(join(dir, 'result.json'), 'utf8').catch(() => null),
        readFile(join(dir, 'transcript.json'), 'utf8').catch(() => null),
      ]);
      const result = resultJson ? JSON.parse(resultJson) : null;
      const transcript = transcriptJson ? JSON.parse(transcriptJson) : null;
      const startTs =
        transcript?.startTs ??
        tsFromName(name) ??
        (s?.mtimeMs ? Math.floor(s.mtimeMs) : null);
      summary = {
        name,
        scenario: result?.scenario ?? scenarioFromName(name),
        passed: result?.passed ?? null,
        durationMs: result?.durationMs ?? null,
        startTs,
        ackLatenciesMs: transcript?.metrics?.ackLatenciesMs ?? [],
        chatLatenciesMs: transcript?.metrics?.chatLatenciesMs ?? [],
        judge: result?.outcomes?.find(o => o.stepKind === 'judge')?.judge ?? null,
        wavs: ['call.wav', 'user.wav', 'agent.wav'].filter(w => files.includes(w)),
      };
    } catch {
      summary = {
        name,
        scenario: scenarioFromName(name),
        passed: null,
        durationMs: null,
        startTs: tsFromName(name) ?? (s?.mtimeMs ? Math.floor(s.mtimeMs) : null),
        error: true,
        wavs: [],
      };
    }
    runs.push(summary);
  }
  runs.sort((a, b) => (b.startTs ?? 0) - (a.startTs ?? 0));
  return runs;
}

// Group scenarios into "runs": consecutive scenarios (sorted by startTs ascending)
// belong to the same group when their gap is <= RUN_GROUP_GAP_MS.
function groupRuns(scenarios) {
  // Work on a copy ordered by startTs ascending
  const ordered = [...scenarios]
    .filter(s => s.startTs != null)
    .sort((a, b) => a.startTs - b.startTs);
  // Anything without a startTs we keep aside in its own pseudo-group
  const orphans = scenarios.filter(s => s.startTs == null);

  const groups = [];
  let cur = null;
  for (const s of ordered) {
    if (!cur || s.startTs - cur.endTs > RUN_GROUP_GAP_MS) {
      cur = {
        startTs: s.startTs,
        endTs: s.startTs,
        scenarios: [s],
      };
      groups.push(cur);
    } else {
      cur.scenarios.push(s);
      cur.endTs = s.startTs;
    }
  }

  if (orphans.length) {
    groups.push({
      startTs: null,
      endTs: null,
      scenarios: orphans,
    });
  }

  // Annotate + sort newest run first
  return groups
    .map(g => {
      const passCount = g.scenarios.filter(s => s.passed === true).length;
      const failCount = g.scenarios.filter(s => s.passed === false).length;
      const id = g.startTs != null
        ? `run-${g.startTs}`
        : `run-orphans`;
      return {
        id,
        startTs: g.startTs,
        endTs: g.endTs,
        count: g.scenarios.length,
        passCount,
        failCount,
        scenarioNames: g.scenarios.map(s => s.name),
      };
    })
    .sort((a, b) => (b.startTs ?? -Infinity) - (a.startTs ?? -Infinity));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (p === '/api/runs') {
    try {
      const runs = await listRuns();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(runs));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }

  if (p === '/api/run-groups') {
    try {
      const scenarios = await listRuns();
      const groups = groupRuns(scenarios);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ groups, scenarios }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }

  if (p.startsWith('/api/run/')) {
    const rest = decodeURIComponent(p.slice('/api/run/'.length));
    const slash = rest.indexOf('/');
    const runName = slash === -1 ? rest : rest.slice(0, slash);
    const file = slash === -1 ? '' : rest.slice(slash + 1);
    if (!runName || runName.includes('..') || runName.startsWith('.') || runName.startsWith('_')) {
      res.writeHead(400); res.end('bad run'); return;
    }
    const runDir = safeJoin(DATA_DIR, runName);
    if (!runDir) { res.writeHead(400); res.end('bad path'); return; }
    if (!file) {
      const files = await readdir(runDir).catch(() => []);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: runName, files }));
      return;
    }
    const target = safeJoin(runDir, file);
    if (!target) { res.writeHead(400); res.end('bad file'); return; }
    return serveFile(res, target, req);
  }

  const rel = p === '/' ? '/index.html' : p;
  const staticPath = safeJoin(PUBLIC_DIR, rel);
  if (!staticPath) { res.writeHead(400); res.end('bad path'); return; }
  return serveFile(res, staticPath, req);
});

server.listen(PORT, HOST, () => {
  console.log(`test-viewer listening at http://${HOST}:${PORT}`);
  console.log(`data dir: ${DATA_DIR}`);
});
