/**
 * Per-call HTTP-level instrumentation for the fast-LLM providers
 * (OpenRouter, Cerebras). Subscribes to Node's built-in undici
 * `diagnostics_channel` once at module load and exposes:
 *
 *   - `markCallStart()`            — call before `fetch()`
 *   - `markCallEnd(ctx, host)`     — call after `fetch()` resolves;
 *                                    returns `{ connectionReused, connectMs }`
 *
 * Why this exists
 * ===============
 *
 * Node's built-in `fetch()` (which is undici under the hood) does not
 * surface per-request connection-reuse, TLS handshake, or socket
 * connect timing — the Response object only carries headers + body.
 * For "warm p50 180ms vs warm p99 3500ms" forensics on the banter-ack
 * critical path, we need to know whether a slow turn paid a cold-
 * handshake cost or whether the upstream gateway itself was slow.
 *
 * undici emits the following channels (host-keyed, not per-request,
 * so we have to correlate by timestamp + host):
 *
 *   - `undici:client:beforeConnect`  — about to open a TCP/TLS socket
 *   - `undici:client:connected`      — socket established
 *
 * Approach
 * ========
 *
 * We track, per host (`api.cerebras.ai`, `openrouter.ai`, …), the most
 * recent `beforeConnect` and `connected` timestamps. A "call" registers
 * a start timestamp via `markCallStart()`; on `markCallEnd(ctx, host)`
 * we check whether a `beforeConnect` for that host occurred between
 * `start` and `now`. If yes ⇒ cold handshake (new socket), and
 * `connectMs = connected - beforeConnect`. If no ⇒ kept-alive socket
 * reuse. The classification is approximate (a parallel call to the
 * same host while ours is in-flight could spuriously mark ours
 * "cold"), but for the realtime banter-ack call site we issue calls
 * sequentially so the heuristic is reliable in practice.
 *
 * Concurrency note: a per-call-id token would be exact but requires
 * subscribing to `undici:request:create` / `undici:request:headers`
 * and accepting the WeakMap correlation between event payloads. The
 * timestamp-window approach is simpler and good enough for the volume
 * of front-mind calls (1-3 concurrent per realtime session).
 */
import diagnosticsChannel from 'node:diagnostics_channel';

interface PerHostConnectStats {
  /** Time of the most recent `beforeConnect` for this host (ms). */
  lastBeforeConnectAt: number | null;
  /** Time the most recent socket finished connecting for this host. */
  lastConnectedAt: number | null;
  /** Duration of the most recent connect (connected - beforeConnect). */
  lastConnectMs: number | null;
}

const _stats: Map<string, PerHostConnectStats> = new Map();
let _subscribed = false;

function getStats(host: string): PerHostConnectStats {
  let s = _stats.get(host);
  if (!s) {
    s = { lastBeforeConnectAt: null, lastConnectedAt: null, lastConnectMs: null };
    _stats.set(host, s);
  }
  return s;
}

/** Subscribe to undici's connection lifecycle channels.
 *
 *  Idempotent — calling twice is a no-op. Subscribers are bound for
 *  the process lifetime; there's no unsubscribe path (nothing in PAT
 *  needs one and removing subscribers would race with in-flight calls).
 *
 *  The payload shape is documented at
 *  https://undici.nodejs.org/#/docs/api/DiagnosticsChannel — we only
 *  read `connectParams.hostname` (a string the user-supplied URL
 *  parser resolved). The `socket` and `connector` fields are unused.
 */
function ensureSubscribed(): void {
  if (_subscribed) return;
  _subscribed = true;
  try {
    diagnosticsChannel.channel('undici:client:beforeConnect').subscribe((msg: unknown) => {
      const params = (msg as { connectParams?: { hostname?: string } }).connectParams;
      if (!params?.hostname) return;
      getStats(params.hostname).lastBeforeConnectAt = Date.now();
    });
    diagnosticsChannel.channel('undici:client:connected').subscribe((msg: unknown) => {
      const params = (msg as { connectParams?: { hostname?: string } }).connectParams;
      if (!params?.hostname) return;
      const s = getStats(params.hostname);
      const now = Date.now();
      s.lastConnectedAt = now;
      if (s.lastBeforeConnectAt !== null) {
        s.lastConnectMs = now - s.lastBeforeConnectAt;
      }
    });
  } catch {
    // diagnostics_channel.subscribe should not throw on Node 18+ but
    // defensively swallow. Without subscribers, `markCallEnd` returns
    // undefined for the per-call fields — same as current behavior.
  }
}

/** A snapshot taken when a call starts; threaded into `markCallEnd`. */
export interface LlmCallTimingHandle {
  /** Wall-clock time at `markCallStart()`. */
  startedAt: number;
}

/** Start a timing window. Pair with `markCallEnd`. */
export function markCallStart(): LlmCallTimingHandle {
  ensureSubscribed();
  return { startedAt: Date.now() };
}

/** Per-call HTTP timing result. All fields are best-effort — if the
 *  diagnostics channels don't fire (rare; rate-limited, mocked Node,
 *  etc.) the fields are undefined. */
export interface LlmCallTimingResult {
  /** True iff the socket was kept-alive across this call. False ⇒ a
   *  new TCP/TLS handshake happened during this call. Absent ⇒ no
   *  `beforeConnect` for this host has been observed YET (so we can't
   *  classify — likely the very first call to this host). */
  connectionReused?: boolean;
  /** When `connectionReused === false`, how long the new connection
   *  took (TCP + TLS, ms). Useful for separating "cold socket cost"
   *  from "upstream inference cost". */
  connectMs?: number;
  /** When the most recent connect to this host happened, regardless
   *  of whether it was during this call. Pair with `startedAt` for
   *  socket-age analysis. */
  lastConnectedAt?: number;
}

/** End a timing window. `host` is the URL hostname (e.g.
 *  `api.cerebras.ai`); must match the `connectParams.hostname` undici
 *  reports. Take it from `new URL(url).hostname`.
 *
 *  When this returns `connectionReused === undefined`, we couldn't
 *  classify — typically because the diagnostics subscriber hasn't
 *  observed any `beforeConnect` for that host yet OR the channels are
 *  unavailable in this runtime. Callers should treat undefined as
 *  "no signal" rather than a sentinel. */
export function markCallEnd(ctx: LlmCallTimingHandle, host: string): LlmCallTimingResult {
  const s = _stats.get(host);
  if (!s) {
    // Never observed any connection to this host — likely diagnostics
    // never fired. Don't fabricate a signal.
    return {};
  }
  const newConnectInWindow =
    s.lastBeforeConnectAt !== null && s.lastBeforeConnectAt >= ctx.startedAt;
  return {
    connectionReused: !newConnectInWindow,
    connectMs: newConnectInWindow && s.lastConnectMs !== null ? s.lastConnectMs : undefined,
    lastConnectedAt: s.lastConnectedAt ?? undefined,
  };
}

/** Test-only — reset the per-host stats map. The subscriber flag stays
 *  set (no clean unsubscribe), so a second `markCallStart` after this
 *  reset is still wired correctly. */
export function _resetLlmHttpInstrumentationForTesting(): void {
  _stats.clear();
}
