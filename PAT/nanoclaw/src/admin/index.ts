/**
 * PAT admin/observability HTTP handlers — extracted from
 * `src/channels/phone-call.ts` so the surface that pat-frontend (the
 * dashboard Fly app embedded in pat-web via iframe) consumes lives
 * in one place rather than tucked under one channel adapter.
 *
 * The dashboard endpoints aren't channel-specific:
 *   - GET  /admin/logs.jsonl                         — durable-log fetch
 *   - GET  /admin/logs.tail                          — SSE tail
 *   - GET  /admin/monitor                            — single-page HTML monitor
 *   - GET  /admin/sessions/<id>/host-log.jsonl       — per-call slice
 *   - POST /admin/log-event                          — peer-emit ingress
 *
 * Phase 1 of the admin/observatory extraction (R7 in
 * plans/refactor-bundle-2026-05-14.md) — phone-call.ts still owns the
 * HTTP server, but routes /admin/* and /sessions/* into these handlers.
 * Phase 2 (R10) breaks them out onto their own port + listener so
 * pat-frontend can target it directly.
 */

import fs from 'fs';
import http from 'http';
import path from 'path';

import { getDb } from '../db/connection.js';
import { getSession } from '../db/sessions.js';
import { log } from '../log.js';
import { outboundDbPath } from '../session-manager.js';
// PAT (scenarios): provisioning endpoint — pat-frontend POSTs
// validated scenario content here to materialize the agent group +
// messaging-group wiring + packet/ files on disk. Generic envelope
// dispatches by `kind` to per-kind writers (just `presentation` for
// now).
import { provisionPresentation } from '../presentation/provision.js';
// PAT (people spine): generic HTTP bridge to the ncl dispatcher — DISABLED by
// default, gated behind PAT_ENABLE_NCL_HTTP (see tryHandleAdminRequest). Kept
// for the future dashboard's write path. Resources barrel imported for its
// side-effect command registration (ES module = runs once).
import { dispatch } from '../cli/dispatch.js';
import '../cli/resources/index.js';
// PAT (publish_file): signed expiring public file URLs — serving half.
import { handleFilesPubRequest } from '../modules/file-publish/index.js';

/**
 * Token check for read-side admin endpoints. Returns true when
 * - PAT_ADMIN_TOKEN is unset (open mode — assumes private network)
 * - or a matching token is supplied via `?token=<value>` or
 *   `Authorization: Bearer <value>`.
 *
 * Use a long random string for the env var (e.g. `openssl rand -hex 32`).
 * Same token covers /admin/logs.jsonl, /admin/logs.tail, /admin/monitor,
 * /admin/sessions/<id>/host-log.jsonl. The HTML page at /admin/monitor
 * propagates the query-string token into its own EventSource URL so the
 * client doesn't need to do anything special.
 */
export function checkAdminToken(req: http.IncomingMessage, url: URL): boolean {
  const expected = process.env.PAT_ADMIN_TOKEN;
  if (!expected) {
    // PAT (security): fail CLOSED when the token is unset — a cleared or typo'd
    // env var must NOT silently unauthenticate the whole admin surface (logs,
    // /admin/db, monitor). Local dev opts into open mode explicitly.
    if (process.env.PAT_ADMIN_ALLOW_OPEN === '1') return true;
    return false;
  }
  const fromQuery = url.searchParams.get('token');
  if (fromQuery && fromQuery === expected) return true;
  const auth = req.headers.authorization;
  if (auth && auth === `Bearer ${expected}`) return true;
  return false;
}

/**
 * Serve a single-page web monitor at /admin/monitor. Pure vanilla
 * HTML/JS — no build step. Uses EventSource to subscribe to
 * /admin/logs.tail and renders structured events into two columns
 * (front-mind / back-mind) with a sticky state strip on top.
 *
 * Why this instead of the Textual TUI: the TUI focus / dropdown
 * latency was unsalvageable on a wide range of terminals, and
 * browsers already do streaming-log UIs well. Single HTML doc keeps
 * the surface area minimal; nothing to install, just point a browser
 * at the URL.
 */
export function handleMonitorPage(req: http.IncomingMessage, res: http.ServerResponse): void {
  void req;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(MONITOR_HTML);
}

const MONITOR_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>pat monitor</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #0e0e10; color: #d4d4d4;
               font: 13px/1.4 'SF Mono', Menlo, Consolas, monospace; }
  header { display: flex; gap: 1rem; align-items: center; padding: 0.5rem 1rem;
           background: #16161a; border-bottom: 1px solid #2a2a30;
           position: sticky; top: 0; z-index: 1; }
  header h1 { margin: 0; font-size: 14px; color: #8fc; letter-spacing: 0.05em; }
  header select, header button {
    background: #20202a; color: #d4d4d4; border: 1px solid #3a3a44;
    border-radius: 4px; padding: 4px 8px; font: inherit;
  }
  header button:hover { background: #2a2a36; cursor: pointer; }
  header .spacer { flex: 1; }
  header .conn { font-size: 11px; color: #6c6; }
  header .conn.disconnected { color: #d66; }
  #state {
    display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;
    padding: 0.5rem 1rem; border-bottom: 1px solid #2a2a30;
    background: #131317;
  }
  #state .pane { display: flex; flex-direction: column; gap: 2px; }
  #state .pane h2 { margin: 0 0 4px; font-size: 11px; letter-spacing: 0.1em;
                     text-transform: uppercase; color: #888; }
  #state .row { display: flex; gap: 0.5rem; }
  #state .label { color: #888; min-width: 7em; }
  #state .val { color: #d4d4d4; font-weight: 600; word-break: break-all; }
  #state .dot { display: inline-block; width: 0.6em; height: 0.6em;
                border-radius: 50%; background: #444; margin-right: 0.3em;
                vertical-align: middle; }
  #state .dot.on { background: #6c6; }
  #panes { display: grid; grid-template-columns: 1fr 1fr;
           height: calc(100vh - 64px - 88px); }
  .col { overflow-y: auto; padding: 0.5rem 1rem; border-right: 1px solid #2a2a30; }
  .col:last-child { border-right: none; }
  .col h2 { margin: 0 0 0.5rem; padding-bottom: 4px; font-size: 11px;
            letter-spacing: 0.1em; text-transform: uppercase;
            border-bottom: 1px solid #2a2a30; position: sticky; top: 0;
            background: #0e0e10; }
  #front-col h2 { color: #8fc; }
  #back-col h2  { color: #88f; }
  .row {
    display: grid; grid-template-columns: 6em 8em 1fr; gap: 0.5rem;
    padding: 1px 0; align-items: baseline;
    border-bottom: 1px solid #1a1a20;
  }
  .row .ts   { color: #777; font-size: 11px; }
  .row .kind { font-weight: 600; }
  .row .body { word-break: break-word; }
  .kind-inbound        { color: #ee9; }
  .kind-banter         { color: #f8a; }
  .kind-rendition      { color: #8ff; font-weight: 700; }
  .kind-narrator       { color: #6cc; }
  .kind-forward        { color: #6f6; font-weight: 700; }
  .kind-noop, .kind-silent { color: #666; }
  .kind-state          { color: #fc6; }
  .kind-call-start     { color: #6f6; font-weight: 700; }
  .kind-call-end       { color: #f66; font-weight: 700; }
  .kind-session        { color: #6f8; }
  .kind-container      { color: #fc6; }
  .kind-chat           { color: #6af; }
  .kind-tts            { color: #ddd; }
  .kind-stt            { color: #ed8; }
  .kind-misc           { color: #555; }
</style>
</head>
<body>
<header>
  <h1>pat monitor</h1>
  <span class="conn" id="conn">connecting…</span>
  <div class="spacer"></div>
  <label>thread:
    <select id="filter">
      <option value="__auto__">Auto — latest call</option>
      <option value="__all__">All threads</option>
    </select>
  </label>
  <button id="clear-btn">Clear</button>
</header>

<section id="state">
  <div class="pane">
    <h2>front mind</h2>
    <div class="row"><span class="label">thread</span>     <span class="val" id="fm-thread">—</span></div>
    <div class="row"><span class="label">caller</span>     <span class="val" id="fm-caller">—</span></div>
    <div class="row"><span class="label">processing</span> <span class="val"><span class="dot" id="fm-proc"></span><span id="fm-proc-text">idle</span></span></div>
    <div class="row"><span class="label">tts-busy</span>   <span class="val"><span class="dot" id="fm-tts"></span><span id="fm-tts-text">no</span></span></div>
    <div class="row"><span class="label">sse-clients</span><span class="val" id="fm-sse">0</span></div>
  </div>
  <div class="pane">
    <h2>back mind</h2>
    <div class="row"><span class="label">session</span>    <span class="val" id="bm-session">—</span></div>
    <div class="row"><span class="label">container</span>  <span class="val"><span class="dot" id="bm-container"></span><span id="bm-container-text">no</span></span></div>
    <div class="row"><span class="label">chat-seq</span>   <span class="val" id="bm-chatseq">—</span></div>
    <div class="row"><span class="label">last chat</span>  <span class="val" id="bm-lastchat">—</span></div>
  </div>
</section>

<main id="panes">
  <div class="col" id="front-col"><h2>front mind</h2></div>
  <div class="col" id="back-col"><h2>back mind</h2></div>
</main>

<script>
(function() {
  const FRONT_PREFIXES = ['inbound.','banter.','request-layer.','narrator.','tts.turn','tts.busy','sse.','state.'];
  const BACK_PREFIXES  = ['session.','container.','chat.','detail.','routing.'];
  const VOICE_PREFIXES = ['call.','stt.','tts.agent-said','tts.boundary'];
  const STATE_KINDS = new Set([
    'inbound.received','session.created','session.closed','container.spawned',
    'container.exited','chat.row-received','sse.client-changed',
    'state.transitioned','call.started','call.ended',
  ]);
  const MAX_ROWS_PER_COL = 1500;

  const conn = document.getElementById('conn');
  const filter = document.getElementById('filter');
  const clearBtn = document.getElementById('clear-btn');
  const frontCol = document.getElementById('front-col');
  const backCol  = document.getElementById('back-col');

  const known = new Set();           // thread_ids seen
  let latestThread = null;
  let fixedThread = '__auto__';

  function mindFor(kind) {
    if (FRONT_PREFIXES.some(p => kind.startsWith(p))) return 'front';
    if (BACK_PREFIXES.some(p => kind.startsWith(p)))  return 'back';
    if (VOICE_PREFIXES.some(p => kind.startsWith(p))) return 'front'; // route to front column
    return 'front';
  }
  function effectiveThread() {
    if (fixedThread === '__all__') return null;
    if (fixedThread === '__auto__') return latestThread;
    return fixedThread;
  }
  function passes(rec) {
    const t = effectiveThread();
    if (!t) return true;
    return rec.thread_id === t;
  }

  function fmtTime(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleTimeString('en-US', {hour12: false}); }
    catch { return iso.slice(11, 19); }
  }

  function renderRow(rec) {
    if (rec.kind === 'misc') return;          // skip noise outright
    if (!passes(rec)) return;
    const data = rec.data || {};
    const kind = rec.kind || '?';
    let body = '';
    let cls = 'kind-misc';

    if (kind === 'inbound.received')          { cls='kind-inbound';  body = '"' + (data.text||'') + '"'; }
    else if (kind === 'banter.called') {
      if (data.intentionally_silent)          { cls='kind-noop';     body = '(silent)'; }
      else                                     { cls='kind-banter';   body = '"' + (data.response_text||'') + '"'; }
    }
    else if (kind === 'banter.rendered')      { cls='kind-rendition';body = '"' + (data.rendered_text||'') + '"  ('+data.render_ms+'ms)'; }
    else if (kind === 'request-layer.decided'){
      if (data.decision === 'forward')        { cls='kind-forward';  body = '▶ FORWARD: ' + (data.invoke_text||'') + '  — ' + (data.reason||''); }
      else                                     { cls='kind-noop';     body = data.decision + ': ' + (data.reason||''); }
    }
    else if (kind === 'narrator.fired')       { cls='kind-narrator'; body = '"' + (data.utterance||'') + '"'; }
    else if (kind === 'narrator.brain-spawned'){cls='kind-narrator'; body = 'narrator brain spawned'; }
    else if (kind === 'tts.turn-ended')       { cls='kind-tts';      body = 'tts ended: "' + (data.text_preview||'') + '"'; }
    else if (kind === 'tts.busy-marked')      { cls='kind-tts';      body = 'tts busy +' + data.est_dur_ms + 'ms'; }
    else if (kind === 'tts.agent-said')       { cls='kind-tts';      body = '"' + (data.text||'') + '"'; }
    else if (kind === 'stt.user-said')        { cls='kind-stt';      body = '"' + (data.text||'') + '"'; }
    else if (kind === 'sse.client-changed')   { cls='kind-misc';     body = 'sse ' + data.action + ' (total='+data.total_clients+')'; }
    else if (kind === 'state.transitioned')   { cls='kind-state';    body = data.state + ': ' + data.from + ' → ' + data.to; }
    else if (kind === 'session.created')      { cls='kind-session';  body = 'session created (mode=' + data.session_mode + ')'; }
    else if (kind === 'session.closed')       { cls='kind-session';  body = 'session closed: ' + (data.reason||''); }
    else if (kind === 'container.spawned')    { cls='kind-container';body = 'container spawned: ' + (data.container_name||''); }
    else if (kind === 'container.exited')     { cls='kind-container';body = 'container exited code=' + data.exit_code; }
    else if (kind === 'chat.row-received')    { cls='kind-chat';     body = 'seq=' + data.seq + '  ' + (data.preview||''); }
    else if (kind === 'detail.row-received')  { cls='kind-misc';     body = 'detail ' + data.type + (data.tool ? ' tool=' + data.tool : ''); }
    else if (kind === 'call.started')         { cls='kind-call-start';body = '☎ call started'; }
    else if (kind === 'call.ended')           { cls='kind-call-end'; body = '☎ call ended'; }
    else                                       { body = JSON.stringify(data).slice(0, 200); }

    const mind = mindFor(kind);
    const target = mind === 'back' ? backCol : frontCol;
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML =
      '<span class="ts">' + fmtTime(rec.ts) + '</span>' +
      '<span class="kind ' + cls + '">' + kind + '</span>' +
      '<span class="body">' + escapeHtml(body) + '</span>';
    target.appendChild(row);

    // Trim history.
    while (target.children.length - 1 > MAX_ROWS_PER_COL) {
      target.removeChild(target.children[1]);  // child 0 is the <h2>
    }
    target.scrollTop = target.scrollHeight;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    })[c]);
  }

  function applyState(rec) {
    if (!STATE_KINDS.has(rec.kind)) return;
    const data = rec.data || {};
    const tid = rec.thread_id, sid = rec.session_id;
    if (rec.kind === 'inbound.received') {
      if (tid)             document.getElementById('fm-thread').textContent = tid;
      if (data.sender_id)  document.getElementById('fm-caller').textContent = data.sender_id;
    }
    if (rec.kind === 'session.created') {
      if (sid) document.getElementById('bm-session').textContent = sid;
      if (tid) document.getElementById('fm-thread').textContent  = tid;
    }
    if (rec.kind === 'session.closed') {
      setDot('fm-proc', false, 'idle');
      setDot('fm-tts', false, 'no');
      setDot('bm-container', false, 'no');
    }
    if (rec.kind === 'container.spawned') setDot('bm-container', true,  'yes');
    if (rec.kind === 'container.exited')  setDot('bm-container', false, 'no');
    if (rec.kind === 'state.transitioned' && data.state === 'isProcessingNarration') {
      const on = !!data.to;
      setDot('fm-proc', on, on ? 'processing' : 'idle');
    }
    if (rec.kind === 'sse.client-changed') {
      document.getElementById('fm-sse').textContent = String(data.total_clients);
    }
    if (rec.kind === 'chat.row-received') {
      document.getElementById('bm-chatseq').textContent = String(data.seq);
      document.getElementById('bm-lastchat').textContent = (data.preview || '').slice(0, 120);
    }
    if (rec.kind === 'call.started') {
      latestThread = tid || latestThread;
      maybeSwitchAuto();
    }
  }

  function setDot(prefix, on, text) {
    const dot = document.getElementById(prefix);
    const t   = document.getElementById(prefix + '-text');
    if (dot) dot.classList.toggle('on', on);
    if (t)   t.textContent = text;
  }

  function maybeSwitchAuto() {
    if (fixedThread !== '__auto__') return;
    rebuildFilterOptions();
  }

  function rebuildFilterOptions() {
    const cur = filter.value;
    const opts = [
      ['__auto__', 'Auto — latest call'],
      ['__all__',  'All threads'],
    ];
    Array.from(known).slice(-20).reverse().forEach(t => opts.push([t, t]));
    filter.innerHTML = opts.map(([v,l]) => '<option value="'+v+'"'+(v===cur?' selected':'')+'>'+escapeHtml(l)+'</option>').join('');
  }

  filter.addEventListener('change', () => {
    fixedThread = filter.value;
    // Keep history visible — user can clear if they want.
  });
  clearBtn.addEventListener('click', () => {
    Array.from(frontCol.children).slice(1).forEach(c => c.remove());
    Array.from(backCol.children).slice(1).forEach(c => c.remove());
  });

  function connect() {
    // Propagate any ?token=... from the page URL to the SSE URL so a
    // single token unlocks both. Browsers can't set Authorization
    // headers on EventSource, so query-string is the practical channel.
    const pageQs = new URLSearchParams(window.location.search);
    const tailQs = new URLSearchParams();
    if (pageQs.has('token')) tailQs.set('token', pageQs.get('token'));
    const ev = new EventSource('/admin/logs.tail?' + tailQs.toString());
    ev.onopen = () => { conn.textContent = 'connected'; conn.classList.remove('disconnected'); };
    ev.onerror = () => { conn.textContent = 'disconnected (retry)'; conn.classList.add('disconnected'); };
    ev.onmessage = (m) => {
      let rec;
      try { rec = JSON.parse(m.data); } catch { return; }
      if (rec.thread_id && !known.has(rec.thread_id)) {
        known.add(rec.thread_id);
        rebuildFilterOptions();
      }
      applyState(rec);
      renderRow(rec);
    };
  }
  connect();
})();
</script>
</body>
</html>`;

/**
 * SSE-tail the host log. Polls the file size every 250ms and pushes
 * any new tail bytes as `data: <line>` events. Survives log rotation
 * (file shrinks → reset offset to 0). Tools can `curl -N` this and
 * pipe the result through their renderer for live timelines.
 *
 * Per-line emit (one SSE event per JSONL line) so consumers don't
 * have to re-split chunk boundaries.
 */
export function handleLogsTail(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(`: tail-stream connected\n\n`);

  // Optional `?since=<wall-clock-ms>` to skip backlog older than that
  // wall-clock instant. The full file is still scanned (we have to
  // walk byte-by-byte to find line boundaries) but lines with
  // `ts < since` are not emitted. With `since=Date.now()` you get a
  // pure live tail, no historical backlog. Default: emit everything,
  // matching the pre-since behaviour.
  let sinceMs = 0;
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    const raw = url.searchParams.get('since');
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) sinceMs = n;
    }
  } catch {
    /* ignore */
  }
  if (sinceMs > 0) {
    res.write(`: since-filter active (sinceMs=${sinceMs}, ` + `${new Date(sinceMs).toISOString()})\n\n`);
  }

  let closed = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let kaTimer: ReturnType<typeof setInterval> | null = null;
  let currentPath: string | null = null;
  let offset = 0;
  let buf = '';
  // Track wall-clock of the last byte we wrote so the keepalive only
  // fires when the stream really has been idle. Without this, intermediate
  // proxies (Fly edge, Hono, vite) drop SSE connections after ~30s of
  // silence and the dashboard goes dark until the browser auto-reconnects.
  let lastWriteAt = Date.now();
  const safeWrite = (chunk: string): boolean => {
    try {
      res.write(chunk);
      lastWriteAt = Date.now();
      return true;
    } catch {
      return false;
    }
  };

  const cleanup = () => {
    closed = true;
    if (timer) clearInterval(timer);
    timer = null;
    if (kaTimer) clearInterval(kaTimer);
    kaTimer = null;
  };
  req.on('close', cleanup);
  req.on('error', cleanup);

  const tick = () => {
    if (closed) return;
    const day = new Date().toISOString().slice(0, 10);
    const logDir = process.env.PAT_HOST_LOG_DIR ?? path.resolve(process.cwd(), 'data', 'logs');
    const filePath = path.join(logDir, `host-${day}.jsonl`);
    if (filePath !== currentPath) {
      // Day rolled over. Reset and start tailing the new file.
      currentPath = filePath;
      offset = 0;
      buf = '';
    }
    if (!fs.existsSync(filePath)) return;
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return;
    }
    if (stat.size < offset) {
      // File rotated or truncated; restart from 0.
      offset = 0;
      buf = '';
    }
    if (stat.size === offset) return;
    let chunk: string;
    try {
      const fd = fs.openSync(filePath, 'r');
      const len = stat.size - offset;
      const data = Buffer.alloc(len);
      fs.readSync(fd, data, 0, len, offset);
      fs.closeSync(fd);
      chunk = data.toString('utf8');
      offset = stat.size;
    } catch {
      return;
    }
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line) continue;
      // Apply since-filter on backlog. Cheap-parse the ts via regex
      // to avoid JSON.parse overhead on lines we're going to drop.
      if (sinceMs > 0) {
        const m = /"ts"\s*:\s*"([^"]+)"/.exec(line);
        if (m) {
          const lineMs = Date.parse(m[1] ?? '');
          if (Number.isFinite(lineMs) && lineMs < sinceMs) continue;
        }
      }
      if (!safeWrite(`data: ${line}\n\n`)) {
        cleanup();
        return;
      }
    }
  };

  // Tick every 250ms — half the previous lag. The cost is one statSync()
  // per active SSE client per tick, which is cheap.
  timer = setInterval(tick, 250);
  // Keepalive every 5s; only emits if the stream has been silent for
  // at least 15s. ":\n\n" is a valid SSE comment (browsers ignore it),
  // but the bytes traverse every intermediate proxy and prevent idle
  // disconnects.
  kaTimer = setInterval(() => {
    if (closed) return;
    if (Date.now() - lastWriteAt < 15_000) return;
    if (!safeWrite(`: ka\n\n`)) cleanup();
  }, 5_000);
  tick(); // immediate first read so consumer sees backlog quickly
}

/**
 * Serve a per-session host-log slice. Looks the session up in the
 * central DB to recover its agent_group_id (which, with sessionId,
 * gives the on-disk path). Returns 404 if the session doesn't exist
 * or the slice file is missing.
 */
export function handleSessionLogServe(req: http.IncomingMessage, res: http.ServerResponse, sessionId: string): void {
  void req;
  const sess = getSession(sessionId);
  if (!sess) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'session not found', sessionId }));
    return;
  }
  const dir = path.dirname(outboundDbPath(sess.agent_group_id, sessionId));
  const slicePath = path.join(dir, 'host-log.jsonl');
  if (!fs.existsSync(slicePath)) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'no slice yet (call still in progress?)', sessionId }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  fs.createReadStream(slicePath).pipe(res);
}

/**
 * Serve a per-session container stderr capture (written by
 * container-runner's stderr tee). Tails the Claude Code subprocess's
 * init / MCP-connect / @-import-load output — lost on container exit
 * because we run with --rm. Same lookup + 404 shape as host-log.jsonl.
 */
export function handleSessionContainerStderrServe(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sessionId: string,
): void {
  void req;
  const sess = getSession(sessionId);
  if (!sess) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'session not found', sessionId }));
    return;
  }
  const dir = path.dirname(outboundDbPath(sess.agent_group_id, sessionId));
  const filePath = path.join(dir, 'container.stderr.log');
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'no stderr capture yet', sessionId }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  fs.createReadStream(filePath).pipe(res);
}

/**
 * Snapshot every host-log line that mentions this call's thread_id or
 * session_id into the session folder (next to inbound.db / outbound.db).
 * Survives forever after the day-rotated log moves on; per-call
 * post-mortems consume from it via /admin/sessions/<id>/host-log.jsonl.
 *
 * Multi-day calls (rare) only get today's slice; the previous day's
 * lines stay in the day-rotated host.jsonl. Acceptable: a post-mortem
 * on a midnight-spanning call merges both manually.
 */
export function sliceHostLogForCall(agentGroupId: string, sessionId: string, threadId: string): void {
  const logDir = process.env.PAT_HOST_LOG_DIR ?? path.resolve(process.cwd(), 'data', 'logs');
  const today = new Date().toISOString().slice(0, 10);
  const srcPath = path.join(logDir, `host-${today}.jsonl`);
  if (!fs.existsSync(srcPath)) {
    log.info('host-log slice: no source file yet, skipping', { srcPath });
    return;
  }
  const dstDir = path.dirname(outboundDbPath(agentGroupId, sessionId));
  fs.mkdirSync(dstDir, { recursive: true });
  const dstPath = path.join(dstDir, 'host-log.jsonl');
  const src = fs.readFileSync(srcPath, 'utf8');
  const matched: string[] = [];
  for (const line of src.split('\n')) {
    if (!line) continue;
    if (line.includes(threadId) || line.includes(sessionId)) {
      matched.push(line);
    }
  }
  fs.writeFileSync(dstPath, matched.join('\n') + (matched.length ? '\n' : ''));
  log.info('host-log slice written', {
    sessionId,
    threadId,
    lines: matched.length,
    path: dstPath,
  });
}

/**
 * PAT: voice-transport (and any other peer transport) POSTs structured
 * events here so they land in the same persistent host log as
 * nanoclaw's own emits. Without this, voice-transport's `User said:` /
 * `Agent said:` lines were only in Fly's rolling 7-min buffer and gone
 * forever after that — making post-mortem on past calls partially
 * blind. Body shape: `{ source, level, msg, ...fields }`.
 */
export async function handleLogEvent(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let body = '';
  req.setEncoding('utf8');
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 16 * 1024) {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'payload too large' }));
      return;
    }
  }
  let payload: {
    source?: unknown;
    id?: unknown;
    level?: unknown;
    kind?: unknown;
    data?: unknown;
    msg?: unknown;
    thread_id?: unknown;
    session_id?: unknown;
    platform_id?: unknown;
    [key: string]: unknown;
  };
  try {
    payload = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid json' }));
    return;
  }

  const validLevels = ['debug', 'info', 'warn', 'error', 'fatal'] as const;
  const level: (typeof validLevels)[number] =
    typeof payload.level === 'string' && (validLevels as readonly string[]).includes(payload.level)
      ? (payload.level as (typeof validLevels)[number])
      : 'info';
  const source = typeof payload.source === 'string' && payload.source.length > 0 ? payload.source : undefined;
  const peerId = typeof payload.id === 'string' && payload.id.length > 0 ? payload.id : undefined;
  const threadId = typeof payload.thread_id === 'string' ? payload.thread_id : null;
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : null;
  const platformId = typeof payload.platform_id === 'string' ? payload.platform_id : null;

  // Path A: structured peer event (kind + data). Preserves source so the
  // dashboard can attribute every line to its actual emitting process.
  if (
    typeof payload.kind === 'string' &&
    payload.kind.length > 0 &&
    payload.data !== null &&
    typeof payload.data === 'object' &&
    !Array.isArray(payload.data)
  ) {
    log.event({
      kind: payload.kind,
      level,
      source,
      id: peerId,
      thread_id: threadId,
      session_id: sessionId,
      platform_id: platformId,
      data: payload.data as Record<string, unknown>,
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Path B: free-form forward (no `kind`/`data`) — emit as `misc` so
  // we still get a uniform JSONL line. This is the legacy path that
  // pre-structured voice-transport logs use.
  const msg = typeof payload.msg === 'string' ? payload.msg : '';
  const {
    source: _s,
    level: _l,
    msg: _m,
    kind: _k,
    data: _d,
    thread_id: _t,
    session_id: _ss,
    platform_id: _p,
    ...extra
  } = payload;
  void _s;
  void _l;
  void _m;
  void _k;
  void _d;
  void _t;
  void _ss;
  void _p;
  log.event({
    kind: 'misc',
    level,
    source,
    id: peerId,
    thread_id: threadId,
    session_id: sessionId,
    platform_id: platformId,
    data: { msg, ...extra } as Record<string, unknown>,
  });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

/**
 * PAT: dump the persistent host log as JSONL with server-side filters.
 * Lets forensics scripts (and humans + LLMs in CLI sessions) pull a
 * narrowed slice without first downloading the whole day.
 *
 * Query params:
 *   - `since=<ms>` / `until=<ms>`: wallclock UTC ms window. Defaults
 *     `[0, ∞)`. Spans MULTIPLE day files when needed.
 *   - `date=YYYY-MM-DD`: pin to a single day's file (overrides
 *     since/until-based day scan). Optional — defaults to today
 *     UTC only when no since/until are supplied.
 *   - `thread_id=<id>`: only events whose `thread_id` matches.
 *   - `session_id=<id>`: only events whose `session_id` matches.
 *   - `kind=a,b,c`: comma-separated kind whitelist.
 *   - `source=a,b,c`: comma-separated source whitelist.
 *   - `levels=debug,info,warn,error,fatal`: opt-in level list.
 *     Default excludes `debug` (the `llm.call` forensic trace
 *     volume). Pass `?levels=debug,info,warn,error` or
 *     `?include_debug=1` to include LLM-call traces.
 *
 * Streams line-by-line; small queries → small response. No paging
 * cursor today — filters narrow enough that a thread-scoped query is
 * always < a few MB.
 */
export function handleLogsServe(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
  void req;
  const since = Number(url.searchParams.get('since') ?? '0');
  const untilRaw = url.searchParams.get('until');
  const until = untilRaw ? Number(untilRaw) : Number.MAX_SAFE_INTEGER;
  const dateRaw = url.searchParams.get('date'); // YYYY-MM-DD pins to one day
  // PAT (security): the date pins a filename (host-<date>.jsonl), so reject
  // anything that isn't a literal YYYY-MM-DD — an unvalidated value traverses
  // (e.g. date=../../../etc/foo → reads an arbitrary *.jsonl). Malformed → ignore
  // (fall through to the default day-walk) rather than serve a traversed file.
  const dateOverride = dateRaw && /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : null;
  const threadIdFilter = url.searchParams.get('thread_id') ?? undefined;
  const sessionIdFilter = url.searchParams.get('session_id') ?? undefined;
  const kindFilterRaw = url.searchParams.get('kind');
  const kindFilter = kindFilterRaw
    ? new Set(
        kindFilterRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      )
    : null;
  const sourceFilterRaw = url.searchParams.get('source');
  const sourceFilter = sourceFilterRaw
    ? new Set(
        sourceFilterRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      )
    : null;
  // Default level set: exclude 'debug' so the high-volume llm.call
  // trace stream doesn't dominate normal reads. Caller opts in via
  // ?levels=debug,info,warn,error OR ?include_debug=1.
  const levelsRaw = url.searchParams.get('levels');
  const includeDebug = url.searchParams.get('include_debug') === '1';
  const levelFilter = levelsRaw
    ? new Set(
        levelsRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      )
    : includeDebug
      ? new Set(['debug', 'info', 'warn', 'error', 'fatal'])
      : new Set(['info', 'warn', 'error', 'fatal']);

  // Decide which day files to walk. Pinned date → exactly that file.
  // Otherwise, walk every host-YYYY-MM-DD.jsonl in PAT_HOST_LOG_DIR
  // that falls within the [since, until] wall-clock window. Defaults
  // (since=0, until=MAX) → all available files.
  const logDir = process.env.PAT_HOST_LOG_DIR ?? path.resolve(process.cwd(), 'data', 'logs');
  let candidateFiles: string[];
  if (dateOverride) {
    candidateFiles = [path.join(logDir, `host-${dateOverride}.jsonl`)];
  } else {
    try {
      const all = fs.readdirSync(logDir);
      const dayPattern = /^host-(\d{4}-\d{2}-\d{2})\.jsonl$/;
      const sinceDay = since > 0 ? new Date(since).toISOString().slice(0, 10) : null;
      const untilDay = until < Number.MAX_SAFE_INTEGER ? new Date(until).toISOString().slice(0, 10) : null;
      candidateFiles = all
        .map((f) => f.match(dayPattern)?.[1])
        .filter((d): d is string => Boolean(d))
        .filter((d) => {
          if (sinceDay && d < sinceDay) return false;
          if (untilDay && d > untilDay) return false;
          return true;
        })
        .sort()
        .map((d) => path.join(logDir, `host-${d}.jsonl`));
    } catch {
      candidateFiles = [];
    }
  }
  if (candidateFiles.length === 0) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'no log files match window', since, until, date: dateOverride }));
    return;
  }

  // PAT: fail-fast guard for over-broad pulls. An *unscoped* query (no
  // thread_id / session_id, no single-day `date` pin) that spans a large
  // volume of day files streams hundreds of MB through the proxy chain
  // (nanoclaw -> pat-frontend -> client) and blows past the client/edge
  // timeout — surfacing as a truncated or "hung" response rather than an
  // error. The bottleneck is transferred bytes, not CPU, so narrowing the
  // query is the only real fix. Refuse fast with an actionable hint
  // instead of half-streaming and dying. Scoped queries (thread/session/
  // date) emit little even over big files and are exempt. In normal
  // operation day files are < a few MB, so this never fires; it's a
  // backstop against a future log-volume runaway (see the zombie-session
  // narration loop that produced ~350MB/day day files).
  const isScoped = Boolean(threadIdFilter || sessionIdFilter || dateOverride);
  if (!isScoped) {
    let candidateBytes = 0;
    for (const f of candidateFiles) {
      try {
        candidateBytes += fs.statSync(f).size;
      } catch {
        /* missing file: skip, the scan below tolerates it */
      }
    }
    const MAX_UNSCOPED_BYTES = 256 * 1024 * 1024; // 256MB of candidate files
    if (candidateBytes > MAX_UNSCOPED_BYTES) {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'query too broad',
          hint: 'add thread_id= or session_id=, pin a single day with date=YYYY-MM-DD, or narrow since/until — an unscoped multi-day pull streams more data than the proxy/client timeout allows',
          candidate_bytes: candidateBytes,
          candidate_files: candidateFiles.length,
          max_bytes: MAX_UNSCOPED_BYTES,
        }),
      );
      return;
    }
  }

  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  // PAT: flush headers immediately + emit a periodic empty-line keepalive
  // so downstream proxies (Fly edge, pat-frontend Hono stream) don't 502
  // when no events match the filter for long stretches. Empty lines are
  // ignored by every NDJSON parser, so this is safe wire-format-wise.
  // The first write() forces Node's http response to flush the 200 status
  // line; without it Hono's stream() never flushes our proxy headers and
  // the edge times out at ~10s.
  res.write('\n');
  let lastWriteAt = Date.now();
  const safeWrite = (chunk: string): void => {
    lastWriteAt = Date.now();
    res.write(chunk);
  };
  const KEEPALIVE_MS = 3_000; // well under Fly edge's body-start timeout
  const keepaliveTimer = setInterval(() => {
    if (Date.now() - lastWriteAt < KEEPALIVE_MS) return;
    res.write('\n');
    lastWriteAt = Date.now();
  }, 1_000);
  res.on('close', () => clearInterval(keepaliveTimer));

  // Walk files sequentially. For each line: best-effort JSON parse +
  // apply filters; pass-through unparseable lines so we don't lose
  // data to format drift. Stream the output (don't materialize).
  const matches = (line: string): boolean => {
    try {
      const parsed = JSON.parse(line) as {
        ts?: string;
        kind?: string;
        level?: string;
        source?: string;
        thread_id?: string | null;
        session_id?: string | null;
      };
      if (parsed.ts) {
        const ms = Date.parse(parsed.ts);
        if (Number.isFinite(ms) && (ms < since || ms > until)) return false;
      }
      const level = parsed.level ?? 'info';
      if (!levelFilter.has(level)) return false;
      if (kindFilter && parsed.kind && !kindFilter.has(parsed.kind)) return false;
      if (sourceFilter && parsed.source && !sourceFilter.has(parsed.source)) return false;
      if (threadIdFilter && parsed.thread_id !== threadIdFilter) return false;
      if (sessionIdFilter && parsed.session_id !== sessionIdFilter) return false;
      return true;
    } catch {
      // Unparseable lines: pass through so format drift doesn't drop data.
      return true;
    }
  };

  // Sequential walk — small queries are fast; busy days are still
  // bounded by what we transmit (filters narrow heavily).
  let fileIdx = 0;
  const advance = (): void => {
    if (fileIdx >= candidateFiles.length) {
      clearInterval(keepaliveTimer);
      res.end();
      return;
    }
    const filePath = candidateFiles[fileIdx]!;
    fileIdx++;
    if (!fs.existsSync(filePath)) {
      advance();
      return;
    }
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    let buf = '';
    stream.on('data', (chunk: string | Buffer) => {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line) continue;
        if (matches(line)) safeWrite(line + '\n');
      }
    });
    stream.on('end', () => {
      if (buf && matches(buf)) safeWrite(buf + '\n');
      advance();
    });
    stream.on('error', (err: NodeJS.ErrnoException) => {
      log.warn('logs serve stream error', { filePath, err: String(err) });
      advance();
    });
  };
  advance();
}

/** Body-reader helper for POST endpoints. */
async function readJsonBody<T = unknown>(req: http.IncomingMessage): Promise<T | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

type PresentationContent = {
  manifest?: Record<string, unknown>;
  /** PAT Phase 6: reveal HTML packet — one `<section>` per slide.
   *  Replaces the legacy per-slide `slides[]` JSON array. */
  slides_html?: string;
  deep_context?: string;
  audience_qa?: string;
  tone?: string;
};

async function handleScenarioProvision(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  type Input = {
    kind?: string;
    slug?: string;
    content?: PresentationContent;
  };
  const body = await readJsonBody<Input>(req);
  if (!body || typeof body !== 'object') {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON body' }));
    return;
  }
  if (!body.kind || !body.slug || !body.content) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'required: kind, slug, content' }));
    return;
  }
  try {
    let result;
    switch (body.kind) {
      case 'presentation': {
        const c = body.content;
        if (!c.manifest || typeof c.slides_html !== 'string') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: 'presentation content requires manifest + slides_html (Phase 6 reveal HTML)',
            }),
          );
          return;
        }
        result = provisionPresentation({
          slug: body.slug,
          manifest: c.manifest,
          slides_html: c.slides_html,
          deep_context: c.deep_context,
          audience_qa: c.audience_qa,
          tone: c.tone,
        });
        break;
      }
      default:
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `unknown scenario kind: ${body.kind}` }));
        return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (e) {
    log.error('scenario provision failed', { error: e instanceof Error ? e.message : String(e) });
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
  }
}

/**
 * PAT: minimal unstyled operator console for the people spine. A DEV/TEST
 * affordance only — the real dashboard (Shadcn) is deferred (see
 * plans/admin-dashboard-and-people.md). Single self-contained HTML doc, no
 * build step, drives the `/admin/ncl` bridge from the browser. Mirrors the
 * vanilla approach of /admin/monitor.
 */
function handlePeoplePage(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
  const token = url.searchParams.get('token') ?? '';
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>PAT people (dev console)</title>
<style>body{font:14px system-ui,sans-serif;margin:1.5rem;max-width:900px}h1{font-size:1.2rem}
table{border-collapse:collapse;width:100%;margin:.5rem 0}td,th{border:1px solid #ccc;padding:.3rem .5rem;text-align:left}
input,button{font:inherit;padding:.2rem .4rem}fieldset{margin:.6rem 0}pre{background:#f4f4f4;padding:.5rem;white-space:pre-wrap}
.row{display:flex;gap:.4rem;flex-wrap:wrap;align-items:center}small{color:#666}</style></head>
<body><h1>PAT people <small>— dev console (not the real dashboard)</small></h1>
<div class="row"><button onclick="load()">Refresh</button><button onclick="ncl('people-backfill',{}).then(r=>{out(r);load()})">Backfill</button></div>
<fieldset><legend>Create person</legend><div class="row">
<input id="fn" placeholder="first name"><input id="ln" placeholder="last name">
<button onclick="create()">Create</button></div></fieldset>
<div id="people"></div>
<fieldset><legend>Detail</legend><div id="detail"><small>click a person</small></div></fieldset>
<pre id="out"></pre>
<script>
const TOKEN=${JSON.stringify(token)};
function out(o){document.getElementById('out').textContent=JSON.stringify(o,null,2)}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
async function ncl(command,args){const u='/admin/ncl'+(TOKEN?'?token='+encodeURIComponent(TOKEN):'');
const r=await fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({command,args})});
return r.json()}
async function create(){const fn=document.getElementById('fn').value,ln=document.getElementById('ln').value;
out(await ncl('people-create',{'first-name':fn,'last-name':ln}));load()}
async function load(){const r=await ncl('people-list',{});const ppl=r.data||[];
let h='<table><tr><th>name</th><th>id</th><th></th></tr>';
for(const p of ppl){h+='<tr><td>'+esc(p.first_name)+' '+esc(p.last_name)+'</td><td><small>'+esc(p.id)+'</small></td>'+
'<td><button onclick="detail(\\''+esc(p.id)+'\\')">open</button> <button onclick="del(\\''+esc(p.id)+'\\')">del</button></td></tr>'}
document.getElementById('people').innerHTML=h+'</table>'}
async function del(id){if(!confirm('delete '+id+'?'))return;out(await ncl('people-delete',{id}));load()}
async function detail(id){const ids=(await ncl('people-identifiers',{'person-id':id})).data||[];
const hs=(await ncl('people-handles',{'person-id':id})).data||[];
let h='<b>identifiers</b><table><tr><th>kind</th><th>value</th></tr>';
for(const i of ids)h+='<tr><td>'+esc(i.kind)+'</td><td>'+esc(i.value)+'</td></tr>';
h+='</table><div class="row"><input id="ik" placeholder="phone|email" value="phone"><input id="iv" placeholder="value">'+
'<button onclick="addId(\\''+esc(id)+'\\')">add identifier</button></div>';
h+='<b>handles</b><table><tr><th>user_id</th><th>method</th></tr>';
for(const u of hs)h+='<tr><td>'+esc(u.user_id)+'</td><td>'+esc(u.link_method||'')+'</td></tr>';
h+='</table><div class="row"><input id="lh" placeholder="user_id e.g. signal:+1555">'+
'<button onclick="linkH(\\''+esc(id)+'\\')">link handle</button></div>';
document.getElementById('detail').innerHTML=h}
async function addId(id){out(await ncl('people-add-identifier',{'person-id':id,kind:document.getElementById('ik').value,value:document.getElementById('iv').value}));detail(id)}
async function linkH(id){out(await ncl('people-link',{'user-id':document.getElementById('lh').value,'person-id':id}));detail(id)}
load();
</script></body></html>`;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

/**
 * PAT: generic HTTP bridge to the `ncl` dispatcher. Body: `{ command, args }`
 * (e.g. `{ "command": "people-create", "args": { "first-name": "Ada",
 * "last-name": "Lovelace" } }`). Dispatches with `caller: 'host'`, so it
 * inherits the exact authorization the CLI uses — no approval gate, full
 * resource access — and exposes the WHOLE ncl surface through one route. This
 * is the control-plane write path the dashboard will forward mutations to.
 *
 * Token-gated by the caller (`checkAdminToken`): open when PAT_ADMIN_TOKEN is
 * unset (local dev / internal-only :8767), required in prod. Because it grants
 * the full host CLI surface, prod MUST set PAT_ADMIN_TOKEN.
 */
/**
 * PAT: read-only central-DB browser. Serves the dashboard's Database tab, which
 * runs in a separate app (pat-frontend) and proxies here — it has no local v2.db.
 * `GET /admin/db` → { tables: [{name, exists, count}] }; `GET /admin/db/<table>`
 * → { table, columns, foreignKeys, total, rows } (limit/offset). SELECT + PRAGMA
 * only; the table name is validated against sqlite_master before interpolation.
 */
function handleDbServe(res: http.ServerResponse, url: URL): void {
  const db = getDb();
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const sub = url.pathname.slice('/admin/db'.length); // '' | '/' | '/<table>'
  if (sub === '' || sub === '/') {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[];
    const out = tables.map((t) => ({
      name: t.name,
      exists: true,
      count: (db.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).get() as { n: number }).n,
    }));
    json(200, { available: true, tables: out });
    return;
  }
  const table = decodeURIComponent(sub.slice(1));
  const known = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(table);
  if (!known) {
    json(404, { error: 'unknown table', table });
    return;
  }
  // table is now a verified real table name → safe to interpolate as a quoted id.
  const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') ?? '200') || 200));
  const offset = Math.max(0, Number(url.searchParams.get('offset') ?? '0') || 0);
  const columns = db.prepare(`PRAGMA table_info("${table}")`).all();
  const foreignKeys = (
    db.prepare(`PRAGMA foreign_key_list("${table}")`).all() as { from: string; table: string; to: string }[]
  ).map((r) => ({ from: r.from, table: r.table, to: r.to }));
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
  const rows = db.prepare(`SELECT * FROM "${table}" ORDER BY ROWID DESC LIMIT ? OFFSET ?`).all(limit, offset);
  json(200, { table, exists: true, columns, foreignKeys, total, rows });
}

async function handleNclDispatch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  type Input = { command?: string; args?: Record<string, unknown> };
  const body = await readJsonBody<Input>(req);
  if (!body || typeof body !== 'object' || typeof body.command !== 'string') {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: { code: 'invalid-args', message: 'required: command (string)' } }));
    return;
  }
  try {
    const response = await dispatch(
      { id: `http-${Date.now()}`, command: body.command, args: body.args ?? {} },
      { caller: 'host' },
    );
    // dispatch never throws — it returns an ok/error frame. Map error frames to
    // a 4xx/5xx so curl/fetch callers can branch on status, mirroring the
    // frame's error code.
    const status = response.ok ? 200 : response.error.code === 'unknown-command' ? 404 : 400;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response));
  } catch (e) {
    log.error('ncl dispatch failed', { error: e instanceof Error ? e.message : String(e) });
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: false,
        error: { code: 'handler-error', message: e instanceof Error ? e.message : String(e) },
      }),
    );
  }
}

/**
 * Single dispatcher — phone-call.ts (and, when R10 lands, the standalone
 * admin server) calls this from the HTTP handler. Returns true when the
 * request was handled (response written), false to fall through to the
 * channel-specific handler.
 *
 * `/admin/log-event` skips the token check (POST from peers on the
 * internal network only). All other `/admin/*` paths run through
 * `checkAdminToken` first.
 */
export async function tryHandleAdminRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<boolean> {
  if (req.method === 'POST' && url.pathname === '/admin/log-event') {
    await handleLogEvent(req, res);
    return true;
  }
  // PAT (publish_file): public signed-URL file serving. NOT admin-token-gated —
  // each URL carries its own HMAC + expiry (modules/file-publish). Exposed to
  // the internet by a pass-through proxy route on pat-frontend.
  if (req.method === 'GET' && url.pathname.startsWith('/files/pub/')) {
    handleFilesPubRequest(res, url);
    return true;
  }
  // PAT (scenarios): pat-frontend POSTs a validated scenario here.
  // No auth token: this endpoint is internal-only (callable only
  // from the operator console which sits next to nanoclaw on the
  // same network).
  if (req.method === 'POST' && url.pathname === '/scenarios/provision') {
    await handleScenarioProvision(req, res);
    return true;
  }
  // PAT (people spine): generic ncl bridge — DISABLED by default. It grants the
  // full host CLI (caller:'host' → no approval gate), so it's opt-in via
  // PAT_ENABLE_NCL_HTTP=1 AND fail-closed on the token (no open-mode for a
  // mutation surface — refuse if PAT_ADMIN_TOKEN is unset). When disabled it
  // 404s like any unknown route. Kept for the future dashboard write path.
  const nclHttpEnabled = process.env.PAT_ENABLE_NCL_HTTP === '1';
  if (req.method === 'POST' && url.pathname === '/admin/ncl') {
    if (!nclHttpEnabled) return false;
    if (!process.env.PAT_ADMIN_TOKEN) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: '/admin/ncl requires PAT_ADMIN_TOKEN to be set' }));
      return true;
    }
    if (!checkAdminToken(req, url)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return true;
    }
    await handleNclDispatch(req, res);
    return true;
  }
  if (req.method === 'GET' && url.pathname.startsWith('/admin/')) {
    if (!checkAdminToken(req, url)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return true;
    }
    if (url.pathname === '/admin/logs.jsonl') {
      handleLogsServe(req, res, url);
      return true;
    }
    if (url.pathname === '/admin/logs.tail') {
      handleLogsTail(req, res);
      return true;
    }
    if (url.pathname === '/admin/monitor') {
      handleMonitorPage(req, res);
      return true;
    }
    // PAT: read-only central-DB browser for the dashboard's Database tab. The
    // dashboard (pat-frontend, a separate app) PROXIES here over the network —
    // it can't read v2.db off its own disk. Token-gated above; SELECT/PRAGMA
    // only.
    if (url.pathname === '/admin/db' || url.pathname.startsWith('/admin/db/')) {
      handleDbServe(res, url);
      return true;
    }
    // PAT (people spine): dev console — same gate as the ncl bridge it drives
    // (disabled by default; requires PAT_ADMIN_TOKEN when enabled). 404s when off.
    if (url.pathname === '/admin/people') {
      if (!nclHttpEnabled || !process.env.PAT_ADMIN_TOKEN) return false;
      handlePeoplePage(req, res, url);
      return true;
    }
    const sessionLogMatch = url.pathname.match(/^\/admin\/sessions\/([\w-]+)\/host-log\.jsonl$/);
    if (sessionLogMatch) {
      handleSessionLogServe(req, res, sessionLogMatch[1]!);
      return true;
    }
    const containerStderrMatch = url.pathname.match(/^\/admin\/sessions\/([\w-]+)\/container-stderr\.log$/);
    if (containerStderrMatch) {
      handleSessionContainerStderrServe(req, res, containerStderrMatch[1]!);
      return true;
    }
  }
  return false;
}
