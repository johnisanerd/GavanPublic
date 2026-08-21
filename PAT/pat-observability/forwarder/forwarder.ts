/**
 * PAT log forwarder (Path A — structured ingest, zero nanoclaw edits).
 *
 * Subscribes to nanoclaw's EXISTING `/admin/logs.tail` SSE endpoint (which
 * emits every structured JSONL event from the host day-file, debug included —
 * `handleLogsTail` applies no level filter) and ships each event into
 * OpenObserve. Because it consumes an endpoint nanoclaw already serves, it
 * requires no change to nanoclaw/realtime/transports/pat-frontend.
 *
 * Handles N sources (prod + staging) in one process. Per-source reconnect with
 * `?since=<ms>` replay + an on-disk checkpoint so a restart resumes near where
 * it left off (at-least-once; rare dupes on reconnect overlap are acceptable —
 * see DEDUP note below).
 *
 * Runs on Bun (`bun run forwarder.ts`) or Node >=22 (native TS strip + fetch).
 *
 * What this CANNOT capture (by design — see observability/README.md):
 *   - signal-cli daemon JVM text, dockerd, OneCLI gateway, build/crash output
 *     (those are app stdout/stderr → use Path B, the NATS log-shipper)
 *   - genuinely-silent failures the emitter never writes to the day-file
 */

interface Source {
  /** "prod" | "staging" — tags every record so one store serves both envs. */
  env: string;
  /** Full SSE URL, e.g. http://pat-nanoclaw.internal:8767/admin/logs.tail */
  tailUrl: string;
  /** PAT_ADMIN_TOKEN for that nanoclaw (Bearer). Optional if admin is open. */
  token?: string;
}

interface Config {
  sources: Source[];
  oo: {
    url: string; // e.g. http://pat-observability.internal:5080
    org: string; // OpenObserve org, default "default"
    stream: string; // structured stream, default "pat_events"
    enrichmentStream: string; // directory stream, default "pat_enrichment" (names live HERE, never in pat_events)
    user: string;
    password: string;
  };
  checkpointFile: string;
  batchMax: number; // flush when this many records buffered
  batchMs: number; // ...or after this many ms, whichever first
  startupLookbackMs: number; // on a cold start with no checkpoint, replay this far back
  reconnectOverlapMs: number; // re-request slightly before last-seen ts to avoid gaps
  dumpIntervalMs: number; // baseline/reconcile dump of nanoclaw people tables → pat_enrichment
}

function envStr(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env ${name}`);
  }
  return v;
}

function loadConfig(): Config {
  // SOURCES is a JSON array; falls back to single-source individual envs.
  let sources: Source[];
  const rawSources = process.env.SOURCES;
  if (rawSources) {
    sources = JSON.parse(rawSources);
  } else {
    sources = [
      {
        env: envStr('PAT_ENV', 'prod'),
        tailUrl: envStr('NANOCLAW_TAIL_URL'),
        token: process.env.PAT_ADMIN_TOKEN,
      },
    ];
  }
  return {
    sources,
    oo: {
      url: envStr('OPENOBSERVE_URL').replace(/\/$/, ''),
      org: envStr('OPENOBSERVE_ORG', 'default'),
      stream: envStr('OPENOBSERVE_STREAM', 'pat_events'),
      enrichmentStream: envStr('OPENOBSERVE_ENRICHMENT_STREAM', 'pat_enrichment'),
      user: envStr('OPENOBSERVE_USER'),
      password: envStr('OPENOBSERVE_PASSWORD'),
    },
    checkpointFile: envStr('CHECKPOINT_FILE', './checkpoint.json'),
    batchMax: Number(envStr('BATCH_MAX', '500')),
    batchMs: Number(envStr('BATCH_MS', '1000')),
    startupLookbackMs: Number(envStr('STARTUP_LOOKBACK_MS', String(5 * 60_000))),
    reconnectOverlapMs: Number(envStr('RECONNECT_OVERLAP_MS', '2000')),
    dumpIntervalMs: Number(envStr('PEOPLE_DUMP_INTERVAL_MS', String(10 * 60_000))),
  };
}

// ---- checkpoint (per-env last-seen ts in ms) -------------------------------

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

type Checkpoint = Record<string, number>;

function readCheckpoint(path: string): Checkpoint {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Checkpoint;
  } catch {
    return {};
  }
}

function writeCheckpoint(path: string, cp: Checkpoint): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cp));
  } catch (err) {
    console.error(`[forwarder] checkpoint write failed: ${String(err)}`);
  }
}

// ---- OpenObserve ingest ----------------------------------------------------

/** Map an ISO ts to OpenObserve's microsecond `_timestamp`. */
function microsOf(ts: unknown): number {
  const ms = typeof ts === 'string' ? Date.parse(ts) : NaN;
  return Number.isFinite(ms) ? ms * 1000 : Date.now() * 1000;
}

async function ingest(
  cfg: Config,
  env: string,
  records: Record<string, unknown>[],
  stream: string = cfg.oo.stream,
): Promise<void> {
  if (records.length === 0) return;
  const url = `${cfg.oo.url}/api/${cfg.oo.org}/${stream}/_json`;
  const auth = 'Basic ' + Buffer.from(`${cfg.oo.user}:${cfg.oo.password}`).toString('base64');
  const body = JSON.stringify(
    records.map((r) => ({
      ...r,
      env, // discriminator so one stream serves prod + staging
      _timestamp: microsOf(r.ts),
      // NOTE on dedup: OpenObserve does not upsert by default. The event `id`
      // (`<src>-<startMs>-<counter>`) is unique per emit; we keep it as `id`
      // for traceability. Reconnect overlap can produce rare dupes — acceptable
      // for forensics. If exact-once is ever needed, enable a stream-level
      // dedup key on `id` in OpenObserve.
    })),
  );
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: auth },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenObserve ingest ${res.status}: ${text.slice(0, 300)}`);
  }
}

// ---- pat_enrichment (directory stream) -------------------------------------
//
// Names live HERE, never in pat_events. Two feeds keep it fresh:
//   1. live `people.*` events off the SSE tail (routed out of pat_events).
//   2. a periodic full DUMP of nanoclaw's people tables (baseline + reconcile),
//      so a directory built mid-flight or after dropped events self-heals.
// Generic row shape keyed on `entity` so other directory types can be added
// later. The resolver (`resolve_person` / `patobs resolve`) reads latest-per
// -person from this stream.

/** True iff this raw event row is a people-directory mutation. */
function isPeopleEvent(r: Record<string, unknown>): boolean {
  return typeof r.kind === 'string' && (r.kind as string).startsWith('people.');
}

/** Map a live `people.upserted` / `people.removed` event into a directory row. */
function enrichmentRowFromEvent(r: Record<string, unknown>): Record<string, unknown> {
  const d = (r.data ?? {}) as Record<string, unknown>;
  return {
    entity: 'person',
    person_id: d.person_id ?? null,
    display_name: d.display_name ?? '',
    handles: d.handles ?? [],
    identifiers: d.identifiers ?? [],
    // tombstone flag — a full delete emits people.removed with empty snapshot.
    removed: r.kind === 'people.removed',
    src_kind: r.kind, // provenance: which mutation produced this row
    origin: 'event',
    id: r.id, // carry the event id for traceability
    ts: r.ts, // ingest() stamps env + _timestamp from this
  };
}

// ---- per-source SSE tail loop ----------------------------------------------

function maxTsMs(records: Record<string, unknown>[]): number {
  let m = 0;
  for (const r of records) {
    const ms = typeof r.ts === 'string' ? Date.parse(r.ts) : NaN;
    if (Number.isFinite(ms) && ms > m) m = ms;
  }
  return m;
}

async function runSource(cfg: Config, src: Source, cp: Checkpoint): Promise<never> {
  let backoff = 1000;
  for (;;) {
    const since = cp[src.env] ? cp[src.env] - cfg.reconnectOverlapMs : Date.now() - cfg.startupLookbackMs;
    const url = `${src.tailUrl}${src.tailUrl.includes('?') ? '&' : '?'}since=${since}`;
    console.error(`[forwarder:${src.env}] connecting since=${new Date(since).toISOString()}`);
    try {
      const headers: Record<string, string> = { accept: 'text/event-stream' };
      if (src.token) headers.authorization = `Bearer ${src.token}`;
      const res = await fetch(url, { headers });
      if (!res.ok || !res.body) throw new Error(`tail HTTP ${res.status}`);
      backoff = 1000; // connected — reset

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let batch: Record<string, unknown>[] = [];
      let lastFlush = Date.now();

      const flush = async () => {
        if (batch.length === 0) return;
        const toSend = batch;
        batch = [];
        // Route people.* OUT of pat_events and INTO pat_enrichment so names
        // never land beside message bodies. Everything else → pat_events.
        const events = toSend.filter((r) => !isPeopleEvent(r));
        const peopleRows = toSend.filter(isPeopleEvent).map(enrichmentRowFromEvent);
        await ingest(cfg, src.env, events, cfg.oo.stream);
        if (peopleRows.length > 0) await ingest(cfg, src.env, peopleRows, cfg.oo.enrichmentStream);
        // Checkpoint advances on ALL rows (incl. people.*) so a reconnect
        // doesn't re-replay the directory mutations either.
        const top = maxTsMs(toSend);
        if (top > (cp[src.env] ?? 0)) {
          cp[src.env] = top;
          writeCheckpoint(cfg.checkpointFile, cp);
        }
        lastFlush = Date.now();
      };

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue; // ignore ": " comments/keepalives
          const json = line.slice(6);
          try {
            batch.push(JSON.parse(json) as Record<string, unknown>);
          } catch {
            /* skip malformed line */
          }
        }
        if (batch.length >= cfg.batchMax || Date.now() - lastFlush >= cfg.batchMs) {
          await flush();
        }
      }
      await flush();
      console.error(`[forwarder:${src.env}] stream ended; reconnecting`);
    } catch (err) {
      console.error(`[forwarder:${src.env}] error: ${String(err)} (backoff ${backoff}ms)`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}

// ---- periodic people dump (baseline / reconcile) ---------------------------

/** Derive the read-only `/admin/db` base from a source's `/admin/logs.tail`
 *  URL — same nanoclaw admin server, same token. e.g.
 *  `http://pat-nanoclaw.internal:8767/admin/logs.tail` →
 *  `http://pat-nanoclaw.internal:8767/admin/db`. */
function adminDbBase(tailUrl: string): string {
  return tailUrl.replace(/\/admin\/.*$/, '/admin/db');
}

/** Read one central-DB table via the read-only browser (same endpoint
 *  pat-frontend/server/people.ts uses). Returns the `rows` array. */
async function readTable(base: string, token: string | undefined, table: string): Promise<Record<string, unknown>[]> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/${table}?limit=500`, { headers });
  if (!res.ok) throw new Error(`admin/db/${table} HTTP ${res.status}`);
  const j = (await res.json()) as { rows?: Record<string, unknown>[] };
  return j.rows ?? [];
}

/** Full snapshot of nanoclaw's people tables → one pat_enrichment row per
 *  person. Self-heals a directory built mid-flight or after dropped events. */
async function dumpPeople(cfg: Config, src: Source): Promise<void> {
  const base = adminDbBase(src.tailUrl);
  const [people, idents, links] = await Promise.all([
    readTable(base, src.token, 'people'),
    readTable(base, src.token, 'person_identifiers'),
    readTable(base, src.token, 'person_users'),
  ]);
  const ts = new Date().toISOString();
  const rows = people.map((p) => {
    const pid = p.id;
    const name = [p.first_name, p.last_name].filter(Boolean).join(' ').trim();
    return {
      entity: 'person',
      person_id: pid,
      display_name: name,
      handles: links.filter((l) => l.person_id === pid).map((l) => l.user_id),
      identifiers: idents.filter((i) => i.person_id === pid).map((i) => ({ kind: i.kind, value: i.value })),
      removed: false,
      origin: 'dump',
      ts,
    };
  });
  await ingest(cfg, src.env, rows, cfg.oo.enrichmentStream);
  console.error(`[forwarder:${src.env}] people dump → ${rows.length} person row(s) into ${cfg.oo.enrichmentStream}`);
}

/** Run the people dump on boot and every `dumpIntervalMs`. Never throws — a
 *  dump failure is logged and retried next interval (it's a reconcile, the
 *  live event feed keeps the directory fresh in between). Runs forever. */
async function runPeopleDump(cfg: Config, src: Source): Promise<never> {
  for (;;) {
    try {
      await dumpPeople(cfg, src);
    } catch (err) {
      console.error(`[forwarder:${src.env}] people dump failed: ${String(err)}`);
    }
    await new Promise((r) => setTimeout(r, cfg.dumpIntervalMs));
  }
}

// ---- main ------------------------------------------------------------------

async function main(): Promise<void> {
  const cfg = loadConfig();
  const cp = readCheckpoint(cfg.checkpointFile);
  console.error(
    `[forwarder] ${cfg.sources.length} source(s) → ${cfg.oo.url}/${cfg.oo.org} ` +
      `(events=${cfg.oo.stream}, directory=${cfg.oo.enrichmentStream}, dump=${Math.round(cfg.dumpIntervalMs / 60_000)}m)`,
  );
  // One SSE tail loop + one people-dump loop per source; none resolve.
  await Promise.all([
    ...cfg.sources.map((s) => runSource(cfg, s, cp)),
    ...cfg.sources.map((s) => runPeopleDump(cfg, s)),
  ]);
}

main().catch((err) => {
  console.error(`[forwarder] fatal: ${String(err)}`);
  process.exit(1);
});
