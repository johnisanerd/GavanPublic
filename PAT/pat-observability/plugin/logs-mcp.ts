/**
 * PAT Observability MCP server — the "agentically pull what you need" endpoint.
 *
 * Wraps OpenObserve's `_search` SQL API so an agent can answer "what happened on
 * call X / why did Pat say Y" with one tool call. Stdio server; run via
 * `bun run logs-mcp.ts`.
 *
 * Designed to JUST WORK with no per-session setup:
 *   - Credentials are read from a gitignored `.observability-secrets` (env-style
 *     KEY=value) at the pat-observability repo root, found by walking up from
 *     this script (the `skills/` symlink is resolved). No shell env needed.
 *     (env vars OPENOBSERVE_URL/ORG/USER/PASSWORD still override if present;
 *      $PAT_OBS_SECRETS can point at the file explicitly.)
 *   - The store is 6PN-only (no public IP, by design). If it's not already
 *     reachable, the server auto-starts `flyctl proxy` itself and reuses an
 *     existing one (e.g. the TUI's) when present. No manual proxy terminal.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

interface Conf {
  url: string;
  org: string;
  user: string;
  password: string;
  proxyApp: string;
  proxyPort: number;
  autoProxy: boolean;
}

/** Find + parse the gitignored `.observability-secrets` (env-style). */
function readSecretsFile(): Record<string, string> {
  const candidates: string[] = [];
  if (process.env.PAT_OBS_SECRETS) candidates.push(process.env.PAT_OBS_SECRETS);
  const starts: string[] = [import.meta.dir, process.cwd()];
  try {
    starts.unshift(realpathSync(import.meta.dir)); // resolve the ~/.claude/skills symlink
  } catch {
    /* ignore */
  }
  for (const s of starts) {
    let d = s;
    for (let i = 0; i < 8; i++) {
      candidates.push(join(d, '.observability-secrets'));
      const up = dirname(d);
      if (up === d) break;
      d = up;
    }
  }
  for (const p of candidates) {
    try {
      const out: Record<string, string> = {};
      for (const line of readFileSync(p, 'utf8').split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq > 0) out[t.slice(0, eq).trim()] = t.slice(eq + 1); // value verbatim (keeps '#')
      }
      return out;
    } catch {
      /* try next candidate */
    }
  }
  return {};
}

function loadConfig(): Conf {
  const f = readSecretsFile();
  // `||` (not `??`) so an empty-string env placeholder falls through to file/default.
  const pick = (k: string, def = '') => process.env[k] || f[k] || def;
  return {
    url: pick('OPENOBSERVE_URL', 'http://127.0.0.1:5080'),
    org: pick('OPENOBSERVE_ORG', 'default'),
    user: pick('OPENOBSERVE_USER'),
    password: pick('OPENOBSERVE_PASSWORD'),
    proxyApp: f.PROXY_APP || 'pat-observability',
    proxyPort: Number(f.PROXY_PORT || '5080'),
    autoProxy: (f.AUTO_PROXY || 'true') !== 'false',
  };
}

const CFG = loadConfig();
const AUTH = 'Basic ' + Buffer.from(`${CFG.user}:${CFG.password}`).toString('base64');

// ---- reachability + auto-proxy ---------------------------------------------

let proxyProc: ChildProcess | null = null;

async function healthy(): Promise<boolean> {
  try {
    const r = await fetch(`${CFG.url}/healthz`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

let readyPromise: Promise<void> | null = null;

/** Idempotent: ensure the store is reachable, auto-spawning flyctl proxy once. */
function ensureReady(): Promise<void> {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    if (await healthy()) return; // already up (our own proxy, or the TUI's)
    if (!CFG.autoProxy || !/(127\.0\.0\.1|localhost)/.test(CFG.url)) {
      throw new Error(`store not reachable at ${CFG.url} and autoProxy is off`);
    }
    // spawn `flyctl proxy <port>:5080 -a <app>`, with the app-scoping tokens unset
    const env = { ...process.env };
    delete env.FLY_API_TOKEN;
    delete env.FLY_ACCESS_TOKEN;
    proxyProc = spawn('flyctl', ['proxy', `${CFG.proxyPort}:5080`, '-a', CFG.proxyApp], {
      env,
      stdio: 'ignore',
    });
    proxyProc.on('error', () => {
      /* flyctl missing / not authed — surfaced via the health wait below */
    });
    for (let i = 0; i < 40; i++) {
      if (await healthy()) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('auto-proxy did not become healthy — is flyctl installed and authed (`flyctl auth whoami`)?');
  })();
  return readyPromise;
}

function cleanup() {
  if (proxyProc && !proxyProc.killed) proxyProc.kill();
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

// ---- OpenObserve ------------------------------------------------------------

function windowMs(since: string): number {
  const m = /^(\d+)\s*([smhd])$/.exec(since.trim());
  if (!m) return 3600_000;
  const n = Number(m[1]);
  const u = m[2];
  return n * (u === 's' ? 1000 : u === 'm' ? 60_000 : u === 'h' ? 3600_000 : 86_400_000);
}

async function ooSearch(sql: string, since: string, size: number): Promise<{ hits: unknown[]; total: number }> {
  await ensureReady();
  const nowUs = Date.now() * 1000;
  const res = await fetch(`${CFG.url}/api/${CFG.org}/_search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: AUTH },
    body: JSON.stringify({
      query: { sql, start_time: nowUs - windowMs(since) * 1000, end_time: nowUs + 60_000_000, from: 0, size },
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenObserve _search ${res.status}: ${text.slice(0, 500)}`);
  const j = JSON.parse(text);
  return { hits: j.hits ?? [], total: j.total ?? (j.hits?.length ?? 0) };
}

async function ooSchema(stream: string): Promise<unknown> {
  await ensureReady();
  const res = await fetch(`${CFG.url}/api/${CFG.org}/streams/${stream}/schema`, { headers: { authorization: AUTH } });
  const text = await res.text();
  if (!res.ok) throw new Error(`schema ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// ---- tools ------------------------------------------------------------------

const server = new McpServer({ name: 'pat-observability', version: '1.0.0' });

const QUERY_DESC = `Run an OpenObserve SQL query over PAT's centralized logs and return matching rows.

STREAMS (use as the SQL table name):
  pat_events — structured JSONL from nanoclaw (BOTH prod + staging). Front-mind,
               routing, errors, back-mind container telemetry, and FULL debug incl.
               llm.call prompt/response traces. The main forensics store.
  pat_raw    — raw stdout/stderr of every pat-* Fly app: signal-cli daemon,
               dockerd, OneCLI gateway, build/crash output.

KEY COLUMNS (pat_events): ts, _timestamp (micros), source, kind, level,
  thread_id, session_id, platform_id, env ('prod'|'staging').
  pat_raw: timestamp, _timestamp, app, message — NO ts column. match_all('term')
  full-text search works on pat_raw only (pat_events has no FTS keys, by design).
  Nested data.* is FLATTENED to underscore columns: data.latency_ms -> data_latency_ms (depth 3).

EXAMPLES:
  SELECT * FROM pat_events WHERE thread_id = 'call-7af3b2' ORDER BY _timestamp
  SELECT ts, kind, source FROM pat_events WHERE env='staging' AND level IN ('error','fatal')
  SELECT * FROM pat_events WHERE kind='llm.call' AND session_id='sess-abc'
  SELECT timestamp, app, message FROM pat_raw WHERE app='pat-transports' AND message LIKE '%getServerGuid%'
  SELECT timestamp, app, message FROM pat_raw WHERE match_all('getServerGuid')

'since' sets the lookback window (default 1h). Use 'schema' tool if unsure of column names.`;

server.tool(
  'query',
  QUERY_DESC,
  {
    sql: z.string().describe('OpenObserve SQL. Table = stream name (pat_events | pat_raw).'),
    since: z.string().optional().describe('Lookback window: "30m", "1h", "2d", "90s". Default "1h".'),
    size: z.number().int().positive().max(2000).optional().describe('Max rows (default 200).'),
  },
  async ({ sql, since, size }) => {
    const { hits, total } = await ooSearch(sql, since ?? '1h', size ?? 200);
    return { content: [{ type: 'text', text: `total=${total} returned=${hits.length}\n${JSON.stringify(hits, null, 2)}` }] };
  },
);

server.tool(
  'schema',
  'List the columns of a stream so you can write correct SQL. Nested data.* fields appear as flattened data_* columns. Streams: pat_events, pat_raw.',
  { stream: z.string().optional().describe('Stream name; default "pat_events".') },
  async ({ stream }) => {
    const s = await ooSchema(stream ?? 'pat_events');
    return { content: [{ type: 'text', text: JSON.stringify(s, null, 2) }] };
  },
);

// ---- resolve_person ---------------------------------------------------------

/** SQL-escape a single-quoted literal. */
function sqlLit(s: string): string {
  return s.replace(/'/g, "''");
}

/** Truthy across however OpenObserve serializes the boolean `removed` flag. */
function isRemoved(v: unknown): boolean {
  return v === true || v === 'true' || v === 1 || v === '1';
}

const RESOLVE_DESC = `Resolve a Person (by display name or person_id) to their directory record so you can then query their messages BY HANDLE.

This is the FIRST hop of person-scoped forensics. Names live ONLY in the
'pat_enrichment' directory stream — NEVER beside message bodies in pat_events.
This tool reads pat_enrichment and returns the latest record(s) per person:
  { person_id, display_name, handles: [...sender_ids], identifiers: [...] }

Then run 'query' over pat_events filtered by those handles, e.g.:
  SELECT ts, data_channel_type, data_text FROM pat_events
  WHERE kind='inbound.received' AND data_sender_id IN ('signal:...','pstn:+1...')
  ORDER BY _timestamp
(person_id is also stamped on inbound.received / routing.message-routed for a
one-hop convenience join; the handle list is the general/retroactive path.)

'query' matches person_id exactly OR display_name (case-insensitive substring).
Pass 'env' to scope to prod|staging.`;

server.tool(
  'resolve_person',
  RESOLVE_DESC,
  {
    query: z.string().describe('Person display name (substring, case-insensitive) or exact person_id.'),
    env: z.string().optional().describe("Scope to an env: 'prod' | 'staging'. Omit for both."),
  },
  async ({ query, env }) => {
    const q = sqlLit(query);
    const envClause = env ? ` AND env = '${sqlLit(env)}'` : '';
    const sql =
      `SELECT person_id, display_name, handles, identifiers, removed, _timestamp, env ` +
      `FROM pat_enrichment WHERE entity = 'person' ` +
      `AND (person_id = '${q}' OR LOWER(display_name) LIKE LOWER('%${q}%'))${envClause} ` +
      `ORDER BY _timestamp DESC`;
    // Directory is small + re-dumped ~every 10m, so a wide window always
    // captures the latest row for every person.
    const { hits } = await ooSearch(sql, '30d', 2000);
    // Dedupe to the LATEST row per (env, person_id); drop tombstones.
    const latest = new Map<string, Record<string, unknown>>();
    for (const h of hits as Record<string, unknown>[]) {
      const key = `${h.env ?? ''}:${h.person_id ?? ''}`;
      if (!latest.has(key)) latest.set(key, h); // hits are _timestamp DESC → first seen is latest
    }
    const records = Array.from(latest.values())
      .filter((h) => !isRemoved(h.removed))
      .map((h) => ({
        person_id: h.person_id,
        display_name: h.display_name,
        handles: h.handles ?? [],
        identifiers: h.identifiers ?? [],
        ...(env ? {} : { env: h.env }),
      }));
    return {
      content: [
        {
          type: 'text',
          text:
            records.length === 0
              ? `no person matched "${query}"${env ? ` in env=${env}` : ''} (try a different spelling, or they may not be linked to a Person yet)`
              : JSON.stringify(records, null, 2),
        },
      ],
    };
  },
);

await server.connect(new StdioServerTransport());
