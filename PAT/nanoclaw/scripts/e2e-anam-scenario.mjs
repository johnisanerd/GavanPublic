#!/usr/bin/env node
// E2E driver for anam-web scenario delivery.
//
// What this verifies:
//   1. POST /anam-web/message with `x-pat-platform-id: anam-web:scenario-<slug>`
//      reaches the orchestrator and the request-layer forwards to the back-mind.
//   2. The presenter back-mind advances the on-disk `.cursor` past slide 1.
//   3. The agent's delivered text (rendition + narration utterances) overlaps
//      with each slide's `notes.spoken` (bag-of-words coverage).
//   4. POST /anam-web/barge-in mid-delivery aborts in-flight streams and the
//      back-mind container.
//   5. The session can recover to handle a follow-up Q&A turn after barge-in.
//
// Transport choice: we hit nanoclaw's anam-web HTTP surface DIRECTLY at
// :8766. No browser, no Anam SDK — we don't care about avatar rendering;
// we care that the cognitive pipeline produced the right side effects.
//
// Observability: we subscribe to /anam-web/events (per-session SSE that
// tails the host log filtered by thread_id/platform_id) and collect:
//   - utterance.stream-* (banter-rendition + banter-narration deltas)
//   - detail.row-received (tool calls — present_advance etc.)
//   - chat.row-received  (back-mind chat replies before banter-rendition)
//   - request-layer.decided  (forward vs. banter-only)
//   - state.transitioned (orchestrator state machine)
//   - container.spawned / container.exited (back-mind lifecycle)
//   - bargein.received / bargein.propagated
//
// Usage:
//   node scripts/e2e-anam-scenario.mjs                       # smoke-test
//   node scripts/e2e-anam-scenario.mjs --scenario=ai-self-replication-palisade-2026
//   node scripts/e2e-anam-scenario.mjs --timeout=300000      # 5min
//   node scripts/e2e-anam-scenario.mjs --no-bargein          # skip interrupt
//   node scripts/e2e-anam-scenario.mjs --no-followup         # skip post-bargein Q
//   node scripts/e2e-anam-scenario.mjs --barge-after=20000   # interrupt after 20s
//
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const GROUPS_DIR = path.join(REPO_ROOT, 'groups');

// ─────────────────────────── Args ────────────────────────────────────
function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (!m) continue;
    out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}
const ARGS = parseArgs(process.argv.slice(2));

const SCENARIO = ARGS.scenario ?? 'smoke-test';
const NANOCLAW_BASE = ARGS.base ?? 'http://127.0.0.1:8766';
const PLATFORM_ID = `anam-web:scenario-${SCENARIO}`;
const SESSION_ID = `e2e-${Date.now()}-${randomUUID().slice(0, 8)}`;
const THREAD_ID = `anam-web-call-${SESSION_ID}`;
const TIMEOUT_MS = Number(ARGS.timeout ?? 180_000);
const BARGE_AFTER_MS = Number(ARGS['barge-after'] ?? 25_000);
const RUN_BARGEIN = !ARGS['no-bargein'];
const RUN_FOLLOWUP = !ARGS['no-followup'];
const VERBOSE = !!ARGS.verbose;

// Resolve packet dir — folder may still be `presenter-<slug>` (legacy) or
// `scenario-<slug>` (new convention). Try both.
function resolvePacketDir(slug) {
  for (const prefix of ['scenario-', 'presenter-']) {
    const p = path.join(GROUPS_DIR, `${prefix}${slug}`, 'packet');
    if (existsSync(p)) return p;
  }
  return null;
}
const PACKET_DIR = resolvePacketDir(SCENARIO);

// ─────────────────────────── State ───────────────────────────────────
const state = {
  events: [], // raw parsed event objects
  cursorHistory: [], // {ms, slide}
  ackText: '', // banter-ack text from chat-completions SSE
  utterances: { rendition: [], narration: [], ack: [] }, // arrays of {seq, text, when}
  toolCalls: [], // {name, args?, result?, ms}
  toolPre: 0,
  chatRows: [], // back-mind raw chat rows (pre-rendition)
  forwardDecisions: [],
  containerEvents: [],
  bargein: null, // {response}
  errors: [],
  envBlocker: null, // populated when an OneCLI / API-key issue gates the test
  naturalEnd: false, // back-mind called end_presentation before barge window
  // PAT: tag-stream observability — per plans/presenter-tag-stream.md.
  // tagStreams: one entry per chat-row parsed in tag-stream mode.
  // actions: cumulative ScenarioAction events grouped by action_type so
  // the harness can verify nav / fragment / verbatim splice fired.
  tagStreams: [], // {scenarioSlug, slideN, rawChars, actionCount, durationMs, terminator}
  actions: { prose: 0, 'slide-nav': 0, 'slide-goto': 0, fragment: 0, 'ask-questions': 0, tool: 0, 'verbatim-expanded': 0, 'cartesia-passthrough': 0, 'unknown-tag': 0 },
  startMs: Date.now(),
  finished: false,
};

// ───────────────────── Logging ────────────────────────────────────────
const ts = () => {
  const ms = Date.now() - state.startMs;
  return `[+${(ms / 1000).toFixed(1)}s]`;
};
const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', cyan: '\x1b[36m', green: '\x1b[32m',
  yellow: '\x1b[33m', red: '\x1b[31m', mag: '\x1b[35m', blue: '\x1b[34m',
  bold: '\x1b[1m',
};
function log(line) { console.log(`${c.dim}${ts()}${c.reset} ${line}`); }
function info(line) { log(`${c.cyan}${line}${c.reset}`); }
function ok(line) { log(`${c.green}✓ ${line}${c.reset}`); }
function warn(line) { log(`${c.yellow}⚠ ${line}${c.reset}`); }
function err(line) { log(`${c.red}✗ ${line}${c.reset}`); }
function dbg(line) { if (VERBOSE) log(`${c.dim}${line}${c.reset}`); }

// ───────────────────── Pre-flight ─────────────────────────────────────
async function preflight() {
  if (!PACKET_DIR) {
    throw new Error(`packet dir not found for scenario=${SCENARIO}`);
  }
  info(`scenario=${SCENARIO}`);
  info(`packet  =${PACKET_DIR}`);
  info(`platform=${PLATFORM_ID}`);
  info(`session =${SESSION_ID}`);

  const health = await fetch(`${NANOCLAW_BASE}/health`).then((r) => r.json());
  if (!health.ok) throw new Error('nanoclaw health check failed');
  ok(`nanoclaw :8766 healthy (channel=${health.channel})`);

  // PAT: cursor is in-memory per-thread on the host now. A fresh
  // SESSION_ID (and therefore THREAD_ID) means a fresh cursor that
  // defaults to 1 — no preflight reset needed.
  state.cursorHistory.push({ ms: Date.now(), slide: 1 });
}

// ───────────────────── Slide expectations ─────────────────────────────
function loadSlides() {
  const slidesDir = path.join(PACKET_DIR, 'slides');
  const files = readdirSync(slidesDir).filter((f) => /^\d+\.yaml$/.test(f)).sort();
  return files.map((f) => {
    const raw = readFileSync(path.join(slidesDir, f), 'utf8');
    // The packet files happen to be JSON (provision.ts uses JSON.stringify);
    // safe to parse as JSON. If a packet ever ships actual YAML this breaks
    // and we add a yaml parser. For now keep it dep-free.
    return JSON.parse(raw);
  });
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'so', 'as', 'at', 'by',
  'for', 'from', 'in', 'into', 'of', 'on', 'to', 'with', 'is', 'are',
  'was', 'were', 'be', 'been', 'being', 'this', 'that', 'these', 'those',
  'it', 'its', 'i', 'you', 'we', 'they', 'he', 'she', 'me', 'my',
  'our', 'their', 'his', 'her', 'them', 'us', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'can', 'could', 'should',
  'may', 'might', 'must', 'shall', 'than', 'then', 'when', 'where',
  'who', 'what', 'why', 'how', 'not', 'no', 'yes', 'only', 'just',
  'about', 'all', 'each', 'any', 'one', 'two', 'three', 'first',
  'now', 'before', 'after', 'over', 'under', 'up', 'down', 'out',
  'm', 's', 't', 'd', 'll', 're', 've',
]);
function tokenize(text) {
  if (!text) return new Set();
  const tokens = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return new Set(tokens);
}

// ───────────────────── SSE event subscription ─────────────────────────
async function subscribeEvents(abortSignal) {
  const url = new URL(`${NANOCLAW_BASE}/anam-web/events`);
  url.searchParams.set('session', SESSION_ID);
  url.searchParams.set('platform_id', PLATFORM_ID);
  // Start fresh — don't replay history.
  url.searchParams.set('since', String(Date.now()));
  dbg(`subscribe ${url}`);
  const res = await fetch(url, { signal: abortSignal });
  if (!res.ok) throw new Error(`SSE subscribe failed: ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (e) {
      if (e.name === 'AbortError') return;
      throw e;
    }
    if (chunk.done) return;
    buf += decoder.decode(chunk.value);
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (!data || data.startsWith(':')) continue;
      try {
        const ev = JSON.parse(data);
        onEvent(ev);
      } catch (e) {
        dbg(`SSE parse error: ${e.message}: ${data.slice(0, 120)}`);
      }
    }
  }
}

function onEvent(ev) {
  state.events.push(ev);
  const kind = ev.kind;
  const d = ev.data ?? {};
  switch (kind) {
    case 'utterance.stream-started': {
      dbg(`utterance.stream-started source=${d.source}`);
      break;
    }
    case 'utterance.stream-delta': {
      // Per-delta — too noisy for default logs; we accumulate in stream-ended
      break;
    }
    case 'utterance.stream-ended': {
      const source = d.source ?? 'unknown';
      const text = d.full_text ?? '';
      const bucket = source.includes('rendition') ? 'rendition'
        : source.includes('narration') ? 'narration'
        : source.includes('ack') ? 'ack' : null;
      if (bucket) state.utterances[bucket].push({ source, text, when: Date.now() });
      log(`${c.mag}utterance.stream-ended${c.reset} ${c.dim}[${source}]${c.reset} ${text.slice(0, 120)}${text.length > 120 ? '…' : ''}`);
      break;
    }
    case 'utterance.stream-cancelled': {
      log(`${c.yellow}utterance.stream-cancelled${c.reset} source=${d.source} reason=${d.reason} partial="${(d.partial_text ?? '').slice(0, 60)}"`);
      break;
    }
    case 'detail.row-received': {
      // Wire shape (per host log): data.type = "tool-pre" | "tool-post" |
      // "query-start" | "query-end" | "reasoning"; data.tool = name;
      // data.input / data.result_preview carry payload. (My earlier
      // assumption that args were nested under data.content was wrong.)
      const dtype = d.type;
      if (dtype === 'tool-pre') {
        state.toolPre++;
        const name = d.tool ?? 'unknown';
        state.toolCalls.push({ name, args: d.input, when: Date.now() });
        log(`${c.blue}tool-pre${c.reset} ${c.bold}${name}${c.reset}(${JSON.stringify(d.input ?? {}).slice(0, 120)})`);
        // Surface the spoken-text contained in present_* calls
        if (name.includes('present_advance')) {
          const n = d.input?.n;
          if (typeof n === 'number') log(`  ${c.bold}${c.green}→ advance to slide ${n}${c.reset}`);
        }
        if (name.includes('end_presentation')) {
          state.naturalEnd = true;
          log(`  ${c.bold}${c.green}→ presentation ended naturally${c.reset}`);
        }
      } else if (dtype === 'tool-post') {
        const tc = state.toolCalls.find((t) => t.name === d.tool && !t.result);
        if (tc) tc.result = d.result_preview;
        const out = d.result_preview ?? '';
        log(`${c.blue}tool-post${c.reset} ${c.bold}${d.tool}${c.reset} → ${String(out).slice(0, 80).replace(/\n/g, ' ')}`);
      } else if (dtype === 'reasoning') {
        dbg(`reasoning: ${(d.text ?? '').slice(0, 100)}`);
      } else {
        dbg(`detail.row ${dtype}`);
      }
      break;
    }
    case 'chat.row-received': {
      const content = d.content ?? {};
      const text = typeof content.text === 'string' ? content.text : '';
      state.chatRows.push({ text, when: Date.now() });
      log(`${c.green}chat.row-received${c.reset} ${text.slice(0, 120)}${text.length > 120 ? '…' : ''}`);
      // Detect environmental blockers so the report explains why
      // instead of just "0 tool calls, 0% coverage". These are
      // independent of the presenter pipeline.
      if (/Self-signed certificate|certificate.*verify|CERT_HAS_EXPIRED|unable to verify the first certificate/i.test(text)) {
        state.envBlocker = state.envBlocker ?? `OneCLI CA cert not reaching container (NODE_EXTRA_CA_CERTS=/tmp/onecli-combined-ca.pem). Chat row from back-mind: ${text.slice(0, 200)}`;
      } else if (/API Error|Unable to connect to API|401 Unauthorized|403 Forbidden/i.test(text)) {
        state.envBlocker = state.envBlocker ?? `Back-mind couldn't reach Anthropic API: ${text.slice(0, 200)}`;
      }
      break;
    }
    case 'request-layer.decided': {
      state.forwardDecisions.push(d);
      log(`${c.cyan}request-layer.decided${c.reset} decision=${d.decision} reason="${(d.reason ?? '').slice(0, 80)}"`);
      break;
    }
    case 'state.transitioned': {
      dbg(`state.transitioned ${d.from} → ${d.to}`);
      break;
    }
    case 'container.spawned': {
      state.containerEvents.push({ kind: 'spawned', ms: Date.now() - state.startMs, data: d });
      log(`${c.green}container.spawned${c.reset} session_id=${ev.session_id}`);
      break;
    }
    case 'container.exited': {
      state.containerEvents.push({ kind: 'exited', ms: Date.now() - state.startMs, data: d });
      log(`${c.yellow}container.exited${c.reset} session_id=${ev.session_id} reason=${d.reason ?? 'normal'}`);
      break;
    }
    case 'bargein.received':
    case 'bargein.propagated': {
      log(`${c.red}${kind}${c.reset} ${JSON.stringify(d)}`);
      break;
    }
    case 'error.surfaced':
    case 'error': {
      state.errors.push({ kind, data: d, ts: ev.ts });
      err(`${kind}: ${JSON.stringify(d).slice(0, 200)}`);
      break;
    }
    case 'scenario.tag-stream-started': {
      log(`${c.mag}↓ scenario.tag-stream-started${c.reset} slug=${d.scenario_slug} slide=${d.slide_n} chars=${d.raw_chars}`);
      break;
    }
    case 'scenario.action': {
      const t = d.action_type ?? 'unknown';
      if (state.actions[t] !== undefined) state.actions[t]++;
      else state.actions[t] = 1;
      if (t === 'prose' || t === 'verbatim-expanded') {
        const preview = (d.text ?? '').slice(0, 60);
        dbg(`scenario.action ${t} a=${d.anchor ?? ''} "${preview}"`);
      } else if (t === 'slide-nav') {
        log(`${c.mag}→ scenario.action${c.reset} slide-nav ${d.direction}`);
      } else if (t === 'slide-goto') {
        log(`${c.mag}→ scenario.action${c.reset} slide-goto n=${d.target_slide}`);
      } else if (t === 'fragment') {
        log(`${c.mag}→ scenario.action${c.reset} fragment ${d.fragment_direction}`);
      } else if (t === 'tool') {
        log(`${c.mag}→ scenario.action${c.reset} tool ${d.tool_name} ${JSON.stringify(d.tool_args ?? {})}`);
      } else if (t === 'ask-questions') {
        log(`${c.mag}→ scenario.action${c.reset} ask-questions`);
      } else {
        dbg(`scenario.action ${t}`);
      }
      break;
    }
    case 'scenario.tag-stream-ended': {
      state.tagStreams.push({
        scenarioSlug: d.scenario_slug,
        slideN: d.slide_n,
        actionCount: d.action_count,
        durationMs: d.duration_ms,
        terminator: d.terminator,
      });
      // PAT: tag-stream packets keep the cursor in-memory now, so the
      // on-disk .cursor never updates. Derive cursor progression
      // from the slide_n field of completed tag-streams. Mimics the
      // disk-poll's cursorHistory shape so existing checks still work.
      const last = state.cursorHistory.at(-1);
      if (!last || last.slide !== d.slide_n) {
        state.cursorHistory.push({ ms: Date.now(), slide: d.slide_n });
      }
      log(`${c.mag}↑ scenario.tag-stream-ended${c.reset} slide=${d.slide_n} actions=${d.action_count} ${d.duration_ms}ms terminator=${d.terminator}`);
      break;
    }
    case 'llm.call': {
      // System prompt verification: if this is the request-layer call,
      // confirm it has <scenario> in it.
      const sp = d.system_prompt ?? d.system ?? '';
      const call = d.call ?? d.source ?? '';
      if (typeof sp === 'string' && sp.includes('<scenario>') && state.events.filter((e) => e.kind === 'llm.call' && (e.data?.system_prompt ?? '').includes('<scenario>')).length === 1) {
        ok(`llm.call carries <scenario> context (call=${call})`);
      }
      break;
    }
    default:
      dbg(`event ${kind}`);
  }
}

// PAT: the on-disk `.cursor` was scrapped — the host owns the
// cursor in-memory per-thread. We derive cursor progression from
// scenario.tag-stream-ended events instead (see onEvent above).
// pollCursor() is a no-op now; kept as a named promise so main()'s
// awaits don't need surgery.
async function pollCursor() {
  // Intentional no-op. Cursor history is populated from
  // scenario.tag-stream-ended events.
}

// ───────────────────── HTTP helpers ───────────────────────────────────
async function sendUserMessage(text, label) {
  info(`POST /anam-web/message [${label}]: "${text}"`);
  const res = await fetch(`${NANOCLAW_BASE}/anam-web/message`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-pat-platform-id': PLATFORM_ID,
      'x-pat-session-id': SESSION_ID,
    },
    body: JSON.stringify({
      stream: true,
      messages: [{ role: 'user', content: text }],
    }),
  });
  if (!res.ok) {
    err(`POST /anam-web/message ${res.status}: ${await res.text().catch(() => '')}`);
    return '';
  }
  // Drain SSE chat-completions
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let acc = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buf += decoder.decode(chunk.value);
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') {
        ok(`/anam-web/message stream complete [${label}] (${acc.length}c)`);
        return acc;
      }
      try {
        const j = JSON.parse(data);
        const delta = j.choices?.[0]?.delta?.content ?? '';
        if (delta) { acc += delta; state.ackText += delta; }
      } catch { /* ignore */ }
    }
  }
  return acc;
}

async function bargeIn(reason = 'e2e-test-interrupt') {
  info(`POST /anam-web/barge-in reason=${reason}`);
  const res = await fetch(`${NANOCLAW_BASE}/anam-web/barge-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: SESSION_ID, reason }),
  });
  const body = await res.json().catch(() => ({}));
  state.bargein = body;
  log(`barge-in response: ${JSON.stringify(body)}`);
  return body;
}

async function sessionEnded() {
  try {
    await fetch(`${NANOCLAW_BASE}/anam-web/session-ended`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });
  } catch { /* best-effort */ }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ───────────────────── Scoring ────────────────────────────────────────
function score(slides) {
  // Concatenate all spoken text the agent produced (rendition + narration + chat-rows).
  const agentTexts = [
    ...state.utterances.rendition.map((u) => u.text),
    ...state.utterances.narration.map((u) => u.text),
    ...state.chatRows.map((c) => c.text),
    state.ackText,
  ].join(' ');
  const agentTokens = tokenize(agentTexts);

  const lastSlide = state.cursorHistory.at(-1)?.slide ?? 1;
  const reached = state.cursorHistory.map((h) => h.slide);
  const uniqueReached = [...new Set(reached)];

  console.log('');
  console.log(`${c.bold}─── Slide coverage ───${c.reset}`);
  let totalScore = 0, nScored = 0;
  for (const slide of slides) {
    const n = slide.slide;
    const spoken = slide?.notes?.spoken ?? '';
    if (!spoken) continue;
    const expected = tokenize(spoken);
    let overlap = 0;
    for (const tok of expected) if (agentTokens.has(tok)) overlap++;
    const pct = expected.size === 0 ? 0 : (overlap / expected.size) * 100;
    totalScore += pct;
    nScored++;
    const reachedTag = uniqueReached.includes(n) ? `${c.green}reached${c.reset}` : `${c.dim}not-reached${c.reset}`;
    const pctStr = `${pct.toFixed(0).padStart(3)}%`;
    const colorPct = pct >= 25 ? c.green : pct >= 10 ? c.yellow : c.red;
    console.log(`  slide ${String(n).padStart(2)} [${reachedTag}] words ${overlap}/${expected.size} ${colorPct}${pctStr}${c.reset}  ${spoken.slice(0, 70).replace(/\n/g, ' ')}…`);
  }
  const avg = nScored === 0 ? 0 : totalScore / nScored;
  console.log(`${c.bold}avg coverage: ${avg.toFixed(1)}% across ${nScored} slides${c.reset}`);

  return { avg, lastSlide, uniqueReached };
}

function report(slides) {
  console.log('');
  console.log(`${c.bold}╔═══ E2E REPORT ═══╗${c.reset}`);
  console.log(`scenario:       ${SCENARIO}`);
  console.log(`elapsed:        ${((Date.now() - state.startMs) / 1000).toFixed(1)}s`);
  console.log(`events seen:    ${state.events.length}`);
  console.log(`forward decns:  ${state.forwardDecisions.length}  (forwards=${state.forwardDecisions.filter((d) => d.decision === 'forward').length})`);
  console.log(`tool calls:     ${state.toolPre}  ${state.toolCalls.slice(0, 12).map((t) => t.name).join(', ')}`);
  console.log(`chat rows:      ${state.chatRows.length}`);
  console.log(`utterances:     ack=${state.utterances.ack.length}  rendition=${state.utterances.rendition.length}  narration=${state.utterances.narration.length}`);
  console.log(`tag-streams:    ${state.tagStreams.length}  ${state.tagStreams.map((s) => `slide${s.slideN}/${s.actionCount}a/${s.terminator}`).join(', ').slice(0, 200)}`);
  console.log(`actions:        ${Object.entries(state.actions).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  console.log(`container:      ${state.containerEvents.map((e) => e.kind).join(' → ') || '(none)'}`);
  console.log(`bargein:        ${state.bargein ? JSON.stringify(state.bargein) : '(skipped)'}`);
  console.log(`errors:         ${state.errors.length}`);

  const { avg, lastSlide, uniqueReached } = score(slides);

  console.log('');
  console.log(`${c.bold}cursor trace:${c.reset} ${state.cursorHistory.map((h) => h.slide).join(' → ')}`);

  // Pass/fail summary
  console.log('');
  // Infer "container spawned" from any tool-pre event (container is the
  // only thing that emits those) — the explicit container.spawned event
  // races our SSE attach and gets missed sometimes.
  const containerWasAlive =
    state.containerEvents.some((e) => e.kind === 'spawned') ||
    state.toolPre > 0 ||
    (state.bargein && state.bargein.killed_container) ||
    state.chatRows.length > 0;
  const sawTagStream = state.tagStreams.length > 0;
  const navFired = (state.actions['slide-nav'] ?? 0) + (state.actions['slide-goto'] ?? 0);
  const checks = [
    ['forwarded to back-mind', state.forwardDecisions.some((d) => d.decision === 'forward')],
    ['back-mind container alive (tool-pre / chat-row / kill confirmed)', containerWasAlive],
    [`cursor advanced past 1 (saw ${uniqueReached.length} unique slides)`, lastSlide > 1 || uniqueReached.length > 1],
    [`agent spoke (rendition or narration ≥1)`, state.utterances.rendition.length + state.utterances.narration.length > 0],
    [`word coverage ≥10% on average`, avg >= 10],
    // PAT: tag-stream-specific checks. The provisioner defaults to
    // delivery_mode: 'tag-stream' so any post-Phase-A scenario should
    // emit ≥1 tag-stream-started/ended pair AND ≥1 nav dispatch.
    [`scenario.tag-stream events fired (${state.tagStreams.length})`, sawTagStream],
    [`tag-stream nav dispatched (${navFired} actions)`, navFired > 0],
  ];
  if (RUN_BARGEIN) {
    if (state.naturalEnd && !state.bargein) {
      checks.push([`barge-in [skipped — presentation ended naturally]`, true]);
    } else {
      checks.push(['barge-in killed container or aborted streams', state.bargein && (state.bargein.killed_container || state.bargein.aborted_streams)]);
    }
  }
  let pass = 0;
  for (const [label, ok_] of checks) {
    console.log(`  ${ok_ ? c.green + '✓' : c.red + '✗'} ${label}${c.reset}`);
    if (ok_) pass++;
  }
  const overall = pass === checks.length;
  console.log('');
  if (state.envBlocker) {
    console.log(`${c.yellow}${c.bold}ENV BLOCKER:${c.reset} ${state.envBlocker}`);
    console.log(`${c.dim}  → the pipeline (banter-ack / request-layer / container-spawn / narrator) is working;${c.reset}`);
    console.log(`${c.dim}    the back-mind can't make API calls so it can't read the packet or call present_advance.${c.reset}`);
    console.log('');
  }
  console.log(`${overall ? c.green + c.bold + 'PASS' : c.red + c.bold + 'FAIL'}${c.reset}  ${pass}/${checks.length} checks`);
  return overall;
}

// ───────────────────── Main ───────────────────────────────────────────
async function main() {
  console.log(`${c.bold}═══ anam-web scenario E2E ═══${c.reset}`);
  await preflight();
  const slides = loadSlides();
  info(`packet has ${slides.length} slides`);

  const ctrl = new AbortController();
  const eventsPromise = subscribeEvents(ctrl.signal).catch((e) => {
    if (e.name !== 'AbortError') err(`SSE subscriber: ${e.message}`);
  });
  const cursorPromise = pollCursor();

  // Give SSE a beat to attach (otherwise we'd miss early request-layer events)
  await sleep(500);

  // 1) Trigger delivery. The first message is deliberately explicit about
  // packet location and intended behavior because Claude Code's auto-load
  // of /workspace/agent/CLAUDE.local.md doesn't fire from cwd
  // /workspace/group — until the compose fix takes effect on next host
  // restart, the agent has no other way to learn the packet path. This
  // verifies the pipeline (cognition + present_advance tool + rendition
  // streaming) rather than the cold-start identity bootstrap.
  const beginMsg = [
    'The audience is in position — please begin the presentation now.',
    'Your packet lives at /workspace/agent/packet/.',
    'Read manifest.yaml first. If delivery_mode is "tag-stream", emit',
    'each slide as ONE send_message containing the prose (with <verbatim a="..."/>',
    'splices from notes.spoken) and end with <slide_next/>.',
    'For non-tag-stream manifests, use the legacy present_advance(N) +',
    'send_message(notes.spoken) per slide.',
    'When you reach the last slide, finish that slide then call end_presentation.',
  ].join(' ');
  const ackText = await sendUserMessage(beginMsg, 'begin');
  if (ackText) info(`banter-ack: "${ackText.slice(0, 120)}${ackText.length > 120 ? '…' : ''}"`);
  // Give the request-layer a moment to decide. If it's a noop, send a
  // disambiguator. We only re-poke ONCE so we don't paper over a real
  // pipeline bug forever.
  await sleep(4000);
  let lastDecision = state.forwardDecisions.at(-1);
  if (!lastDecision || lastDecision.decision !== 'forward') {
    warn(`first turn didn't forward (decision=${lastDecision?.decision ?? 'none'}); re-poking with clearer cue`);
    await sendUserMessage('Yes please start now — read /workspace/agent/packet/manifest.yaml and deliver slide one verbatim.', 'begin-retry');
    await sleep(3000);
  }

  // 2) Wait for either: cursor reaches last slide, timeout, barge-in window,
  // or environment blocker (back-mind can't reach API → no point waiting).
  const deadline = state.startMs + TIMEOUT_MS;
  let bargeFired = false;
  while (Date.now() < deadline && !state.finished) {
    const elapsed = Date.now() - state.startMs;
    const lastSlide = state.cursorHistory.at(-1)?.slide ?? 1;

    // Short-circuit if back-mind hit an env blocker.
    if (state.envBlocker && elapsed > 30_000) {
      warn(`environment blocker detected; not waiting for cursor advance`);
      break;
    }

    // If the back-mind finished naturally before the barge window,
    // skip barge entirely — there's nothing to interrupt.
    if (RUN_BARGEIN && !bargeFired && state.naturalEnd) {
      info(`presentation ended naturally; skipping barge-in interrupt`);
      bargeFired = true; // mark as "handled" so the wait-loop can exit
    }

    // Barge-in window
    if (RUN_BARGEIN && !bargeFired && elapsed >= BARGE_AFTER_MS) {
      info(`barge-in window — interrupting after ${(elapsed / 1000).toFixed(1)}s`);
      bargeFired = true;
      await bargeIn();
      await sleep(2000);

      if (RUN_FOLLOWUP) {
        // Send a follow-up Q&A — verify the back-mind can resume.
        const followup = SCENARIO === 'smoke-test'
          ? 'Quick question — can you confirm you can still respond?'
          : 'Quick question — what is the headline finding from this paper?';
        await sendUserMessage(followup, 'followup');
      }
    }

    // Done when cursor reaches packet end and we've already barge-tested.
    if (lastSlide >= slides.length && (bargeFired || !RUN_BARGEIN)) {
      info(`cursor reached last slide (${lastSlide}); winding down…`);
      await sleep(5000); // let any final utterance flush
      break;
    }

    await sleep(1000);
  }

  // 3) Wrap up
  state.finished = true;
  ctrl.abort();
  await Promise.race([eventsPromise, sleep(500)]);
  await sessionEnded();
  const pass = report(slides);
  process.exit(pass ? 0 : 1);
}

main().catch(async (e) => {
  err(`fatal: ${e.message}`);
  console.error(e.stack);
  state.finished = true;
  await sessionEnded();
  process.exit(2);
});
