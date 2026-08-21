/**
 * PAT: file publishing — agent-initiated public, signed, expiring file URLs.
 *
 * The agent (via the `publish_file` MCP tool → `ncl files publish` over the
 * session-DB CLI transport) asks the host to publish a file from its
 * workspace. The host copies it into DATA_DIR/published/ under a
 * slug-suffixed name and mints a URL like
 *
 *   https://pat-staging.plsd.app/files/pub/report.x7k2m9q4.pdf?exp=1751600000&sig=<hmac>
 *
 * Serving happens on the nanoclaw admin server (GET /files/pub/<name> —
 * signature-gated, NOT admin-token-gated) and is exposed publicly by a thin
 * pass-through proxy route on pat-frontend (which owns the plsd.app certs).
 *
 * Security properties:
 *  - The URL is self-authenticating: sig = HMAC-SHA256(key, `${name}:${exp}`).
 *    No enumeration (random slug), no forgery (HMAC), no post-expiry access
 *    (exp checked server-side; expired files are lazily deleted).
 *  - The signing key never leaves the host: auto-generated on first use and
 *    persisted at DATA_DIR/file-pub.key (0600). Rotation = delete the file
 *    (existing links die — acceptable for short-lived shares).
 *  - The container path is resolved against the calling session's OWN mounts
 *    (session dir + agent-group dir) with a realpath containment check, so a
 *    workspace symlink can't publish arbitrary host files.
 *  - Served with nosniff + CSP sandbox; active-content types (html/svg/js)
 *    are forced to attachment so nothing attacker-authored executes on the
 *    dashboard origin.
 *
 * Operator note (sprint/backlog.md): publishing may later be gated behind an
 * admin approval card (all publishes, or long expiries). v1 is unggated.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type http from 'http';

import { DATA_DIR, GROUPS_DIR } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { log } from '../../log.js';

const PUBLISHED_DIR = path.join(DATA_DIR, 'published');
const KEY_PATH = path.join(DATA_DIR, 'file-pub.key');

export const DEFAULT_TTL_HOURS = 24;
export const MIN_TTL_HOURS = 1;
export const MAX_TTL_HOURS = 24 * 7;
const MAX_FILE_BYTES = 200 * 1024 * 1024; // 200MB

// Unambiguous lowercase alphabet (no i/l/o/u lookalikes), 8 chars ≈ 1e12.
const SLUG_ALPHABET = 'abcdefghjkmnpqrstvwxyz23456789';
export function mintSlug(len = 8): string {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += SLUG_ALPHABET[bytes[i] % SLUG_ALPHABET.length];
  return out;
}

function getSigningKey(): Buffer {
  try {
    const hex = fs.readFileSync(KEY_PATH, 'utf-8').trim();
    if (hex.length >= 64) return Buffer.from(hex, 'hex');
  } catch {
    /* fall through to create */
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(KEY_PATH), { recursive: true });
  fs.writeFileSync(KEY_PATH, key.toString('hex') + '\n', { mode: 0o600 });
  return key;
}

export function signName(name: string, exp: number): string {
  return crypto.createHmac('sha256', getSigningKey()).update(`${name}:${exp}`).digest('hex');
}

function verifySig(name: string, exp: number, sig: string): boolean {
  const expected = signName(name, exp);
  const a = Buffer.from(expected, 'utf-8');
  const b = Buffer.from(sig, 'utf-8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** "24h" | "3d" | "90" (hours) → clamped hours. Throws on unparseable. */
export function parseTtlHours(raw: string | number | undefined): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_TTL_HOURS;
  let hours: number;
  if (typeof raw === 'number') {
    hours = raw;
  } else {
    const m = /^(\d+(?:\.\d+)?)\s*([hd]?)$/i.exec(String(raw).trim());
    if (!m) throw new Error(`unparseable ttl "${raw}" — use e.g. "24h", "3d", or a number of hours`);
    hours = Number(m[1]) * (m[2].toLowerCase() === 'd' ? 24 : 1);
  }
  if (!Number.isFinite(hours)) throw new Error(`unparseable ttl "${raw}"`);
  return Math.min(MAX_TTL_HOURS, Math.max(MIN_TTL_HOURS, hours));
}

/** Keep the original basename readable but strictly safe for a URL path + fs. */
function sanitizeBase(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '');
  return cleaned.slice(0, 80) || 'file';
}

export interface PublishResult {
  name: string;
  url: string;
  expires_at: string;
  size_bytes: number;
}

export function publicBaseUrl(): string {
  return process.env.PAT_PUBLIC_BASE_URL?.replace(/\/+$/, '') || 'http://127.0.0.1:8767';
}

interface PublishCaller {
  agentGroupId: string;
  sessionId: string;
}

/**
 * Resolve a container-visible path to a host path, constrained to the
 * calling session's real mounts. Accepts:
 *   /workspace/agent/...  → GROUPS_DIR/<folder>/...
 *   /workspace/...        → DATA_DIR/v2-sessions/<group>/<session>/...
 *   relative              → agent dir (the agent's cwd is /workspace/agent)
 */
function resolveContainerPath(containerPath: string, caller: PublishCaller): string {
  const group = getAgentGroup(caller.agentGroupId);
  if (!group) throw new Error(`agent group not found: ${caller.agentGroupId}`);
  const agentDir = path.resolve(GROUPS_DIR, group.folder);
  const sessDir = path.join(DATA_DIR, 'v2-sessions', caller.agentGroupId, caller.sessionId);

  let hostPath: string;
  let base: string;
  if (containerPath.startsWith('/workspace/agent/')) {
    base = agentDir;
    hostPath = path.join(agentDir, containerPath.slice('/workspace/agent/'.length));
  } else if (containerPath.startsWith('/workspace/')) {
    base = sessDir;
    hostPath = path.join(sessDir, containerPath.slice('/workspace/'.length));
  } else if (!path.isAbsolute(containerPath)) {
    base = agentDir;
    hostPath = path.join(agentDir, containerPath);
  } else {
    throw new Error(`path must be under /workspace (got ${containerPath})`);
  }

  // realpath BOTH sides: the agent controls its workspace and could plant a
  // symlink pointing anywhere on the host — containment must hold on the
  // fully-resolved path.
  const realBase = fs.realpathSync(base);
  let real: string;
  try {
    real = fs.realpathSync(hostPath);
  } catch {
    throw new Error(`file not found: ${containerPath}`);
  }
  if (real !== realBase && !real.startsWith(realBase + path.sep)) {
    throw new Error(`path escapes the workspace: ${containerPath}`);
  }
  return real;
}

export function publishFile(
  containerPath: string,
  ttl: string | number | undefined,
  caller: PublishCaller,
): PublishResult {
  const ttlHours = parseTtlHours(ttl);
  const hostPath = resolveContainerPath(containerPath, caller);
  const st = fs.statSync(hostPath);
  if (!st.isFile()) throw new Error(`not a regular file: ${containerPath}`);
  if (st.size > MAX_FILE_BYTES) {
    throw new Error(`file too large (${Math.round(st.size / 1024 / 1024)}MB > ${MAX_FILE_BYTES / 1024 / 1024}MB cap)`);
  }

  const ext = path.extname(hostPath);
  const base = sanitizeBase(path.basename(hostPath, ext));
  const name = `${base}.${mintSlug()}${ext.toLowerCase()}`;
  const exp = Math.floor(Date.now() / 1000) + Math.round(ttlHours * 3600);

  fs.mkdirSync(PUBLISHED_DIR, { recursive: true });
  fs.copyFileSync(hostPath, path.join(PUBLISHED_DIR, name));
  const meta = {
    expires_at: new Date(exp * 1000).toISOString(),
    exp,
    agent_group_id: caller.agentGroupId,
    session_id: caller.sessionId,
    source_path: containerPath,
    size_bytes: st.size,
    created_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(PUBLISHED_DIR, `${name}.meta.json`), JSON.stringify(meta, null, 2));

  cleanupExpired(); // opportunistic — dir stays small

  const sig = signName(name, exp);
  const url = `${publicBaseUrl()}/files/pub/${encodeURIComponent(name)}?exp=${exp}&sig=${sig}`;
  log.event({
    kind: 'file.published',
    level: 'info',
    data: {
      name,
      agent_group_id: caller.agentGroupId,
      session_id: caller.sessionId,
      size_bytes: st.size,
      ttl_hours: ttlHours,
      expires_at: meta.expires_at,
    },
  });
  return { name, url, expires_at: meta.expires_at, size_bytes: st.size };
}

export function cleanupExpired(): number {
  let removed = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(PUBLISHED_DIR);
  } catch {
    return 0;
  }
  const now = Math.floor(Date.now() / 1000);
  for (const entry of entries) {
    if (!entry.endsWith('.meta.json')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(PUBLISHED_DIR, entry), 'utf-8')) as { exp?: number };
      if (typeof meta.exp === 'number' && meta.exp < now) {
        fs.rmSync(path.join(PUBLISHED_DIR, entry.slice(0, -'.meta.json'.length)), { force: true });
        fs.rmSync(path.join(PUBLISHED_DIR, entry), { force: true });
        removed++;
      }
    } catch {
      /* unreadable meta — leave for manual inspection */
    }
  }
  return removed;
}

// ── Serving ────────────────────────────────────────────────────────────────

const CONTENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.zip': 'application/zip',
};

// Types that may render inline. Anything else — html, svg, js, xml, unknown —
// is active-content risk on the dashboard origin and is forced to download.
const INLINE_EXTS = new Set([
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.txt',
  '.md',
  '.csv',
  '.json',
  '.mp3',
  '.m4a',
  '.wav',
  '.ogg',
  '.mp4',
  '.webm',
]);

function deny(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

/** GET /files/pub/<name>?exp=..&sig=..  — signature-gated, no admin token. */
export function handleFilesPubRequest(res: http.ServerResponse, url: URL): void {
  const rawName = url.pathname.slice('/files/pub/'.length);
  const name = decodeURIComponent(rawName);
  // One flat segment only — no separators, no dotfiles, no traversal.
  if (!name || name.includes('/') || name.includes('\\') || name.startsWith('.') || name.includes('..')) {
    deny(res, 404, 'not found');
    return;
  }
  const exp = Number(url.searchParams.get('exp'));
  const sig = url.searchParams.get('sig') ?? '';
  if (!Number.isFinite(exp) || !sig || !verifySig(name, exp, sig)) {
    deny(res, 404, 'not found');
    return;
  }
  if (Math.floor(Date.now() / 1000) > exp) {
    // Expired: the signature was valid, so it's safe to say so — and lazily reap.
    fs.rmSync(path.join(PUBLISHED_DIR, name), { force: true });
    fs.rmSync(path.join(PUBLISHED_DIR, `${name}.meta.json`), { force: true });
    deny(res, 410, 'link expired');
    return;
  }
  const filePath = path.join(PUBLISHED_DIR, name);
  let st: fs.Stats;
  try {
    st = fs.statSync(filePath);
  } catch {
    deny(res, 404, 'not found');
    return;
  }

  const ext = path.extname(name).toLowerCase();
  const disposition = INLINE_EXTS.has(ext) ? 'inline' : 'attachment';
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
    'content-length': st.size,
    'content-disposition': `${disposition}; filename="${name}"`,
    'x-content-type-options': 'nosniff',
    'content-security-policy': 'sandbox',
    'cache-control': 'private, max-age=3600',
  });
  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  stream.on('error', () => res.destroy());
  log.event({ kind: 'file.served', level: 'info', data: { name, size_bytes: st.size } });
}
