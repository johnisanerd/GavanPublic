/**
 * Fast-LLM TLS keepalive pinger.
 *
 * Why this exists
 * ===============
 *
 * Node 22's built-in fetch (undici v6) closes idle keep-alive sockets
 * after ~4 seconds by default. PAT's inter-turn gap is typically 8-15
 * seconds (user thinks, speaks, listens to Pat), so the kept-alive
 * socket dies between turns and every banter-ack pays a fresh TCP+TLS
 * handshake (200-1000ms p50 on Cerebras / OpenRouter / Anthropic).
 *
 * Bench evidence (2026-05-24): 24 banter-ack + request-layer calls
 * showed `connection_reused: true` on only 3/24 — i.e. 87.5% of calls
 * paid the cold-handshake cost.
 *
 * The cheapest fix that works across providers: send a 1-token throwaway
 * completion every 3 seconds while a session is active. The TCP+TLS
 * socket stays warm because there's never a >3s idle gap. We pay
 * ~$0.00005 per ping and a handful of ms of provider compute — orders
 * of magnitude cheaper than the 200-1000ms we save on every real turn.
 *
 * Why not a smaller TCP-level ping?
 *  - Node's built-in fetch hides the socket; we can't poke TCP
 *    keepalive packets directly without a separate http path that
 *    would defeat the purpose (we want to warm the SAME socket the
 *    real request will use).
 *  - A HEAD or GET to a non-API endpoint hits a different pool key in
 *    undici (different path → may pick a different agent connection),
 *    so the warm socket wouldn't actually be reused by POST /chat/completions.
 *  - A 1-token POST to the actual chat-completions endpoint is what
 *    real traffic looks like, so it provably warms the right socket.
 *
 * Constraint: do NOT use FallbackProvider. The whole point is to warm
 * the PRIMARY's socket; if the primary fails and we fall back, we warm
 * the wrong host's socket. Use `makeProvider(...)` directly with the
 * resolved primary, swallow errors as warm-up still happened iff TLS
 * landed. Mirrors the prewarm path in nanoclaw/src/channels/anam-web.ts.
 */

import type { FastLlmLayer, FastLlmProvider } from './llm-provider.js';
import { makeProvider, parseFastModelSlug } from './llm-provider.js';
import type { StructuredLogger } from './host-adapter.js';

/** How often to ping. 3s is well under Node's 4s built-in undici
 *  keep-alive timeout — and well under whatever per-host server-side
 *  idle close interval (e.g. Cerebras's load balancer). */
const DEFAULT_INTERVAL_MS = 3_000;

/** Max tokens to request per ping. The smaller the cheaper. Some
 *  providers (Cerebras gpt-oss-120b reasoning models) need a few extra
 *  to satisfy reasoning budget — 4 leaves slack without ballooning cost. */
const PING_MAX_TOKENS = 4;

/** Cap concurrent pings — defense in depth. If a previous ping is
 *  still in flight when the next tick fires (e.g. provider stall), we
 *  skip the new tick rather than fan out parallel pings to the same
 *  socket pool. */
const MAX_INFLIGHT_PER_HOST = 1;

/** Resolve the layer's model slug from env. Mirrors `resolveModelSlug`
 *  in llm-provider.ts; duplicated here to keep that one private. */
function resolveSlugForLayer(layer: FastLlmLayer): string {
  const envKey =
    layer === 'banter-ack' ? 'BANTER_ACK_MODEL'
    : layer === 'banter-render' ? 'BANTER_RENDER_MODEL'
    : layer === 'banter-narration' ? 'NARRATION_MODEL'
    : 'REQUEST_LAYER_MODEL';
  const perLayer = process.env[envKey];
  if (perLayer && perLayer.trim() !== '') return perLayer;
  if (layer === 'request-layer') {
    return process.env.FAST_MODEL ?? 'anthropic/claude-sonnet-4-6';
  }
  return process.env.FAST_MODEL ?? 'anthropic/claude-haiku-4-5-20251001';
}

interface PerProviderKey {
  /** Display label for the structured-log event. */
  key: string;
  /** Layer that resolved to this provider+model. Surfaces in logs so
   *  multi-layer fan-out is greppable. */
  layer: FastLlmLayer;
  /** Built provider — primary only, no fallback wrap. */
  provider: FastLlmProvider;
  /** Provider name on the wire (anthropic / openrouter / cerebras). */
  providerName: string;
  /** Model id on the wire. */
  model: string;
  /** In-flight counter to prevent stacking pings on a stalled socket. */
  inflight: number;
}

/** Resolve the unique provider+model targets for the given layers.
 *  Multiple layers that resolve to the same (provider, model) are
 *  deduped so we only ping each socket pool once per tick. */
function resolveTargets(layers: readonly FastLlmLayer[]): PerProviderKey[] {
  const byKey = new Map<string, PerProviderKey>();
  for (const layer of layers) {
    const slug = resolveSlugForLayer(layer);
    const routing = parseFastModelSlug(slug);
    // Build the same way nanoclaw's prewarm does: primary only, no
    // FallbackProvider wrap. The whole point is to keep THIS host's
    // socket warm — a fallback to a different host warms the wrong one.
    const provider = makeProvider(routing.provider, routing.model);
    const key = `${routing.provider}:${routing.model}`;
    if (byKey.has(key)) continue;
    byKey.set(key, {
      key,
      layer,
      provider,
      providerName: routing.provider,
      model: routing.model,
      inflight: 0,
    });
  }
  return Array.from(byKey.values());
}

export interface FastLlmKeepalivePingerOpts {
  /** Logger for `fast-llm.keepalive` events. */
  log: StructuredLogger;
  /** Layers to keep warm. Defaults to ['banter-ack'] — the critical
   *  path. Add 'request-layer' too when the request-layer model differs
   *  from banter-ack (different host = different socket pool). */
  layers?: readonly FastLlmLayer[];
  /** Override the ping interval. Defaults to 3000ms. */
  intervalMs?: number;
  /** Optional thread_id surface for the structured-log event. */
  threadId?: string | null;
  /** Optional platform_id surface for the structured-log event. */
  platformId?: string | null;
  /** Optional session_id surface for the structured-log event. */
  sessionId?: string | null;
}

/** Per-session keepalive. Construct with target layers, call `start()`
 *  when the session opens, `stop()` when it closes. Idempotent: a
 *  second `start()` is a no-op; `stop()` after `start()` clears the
 *  interval; `stop()` before `start()` is a no-op.
 *
 *  Cancels any in-flight ping on `stop()` via the AbortController
 *  passed to `provider.stream({ signal })`. Subsequent ticks are
 *  prevented by `clearInterval`. */
export class FastLlmKeepalivePinger {
  private readonly log: StructuredLogger;
  private readonly intervalMs: number;
  private readonly threadId: string | null;
  private readonly platformId: string | null;
  private readonly sessionId: string | null;
  private readonly targets: PerProviderKey[];
  private timer: NodeJS.Timeout | null = null;
  private aborter: AbortController | null = null;
  private started = false;
  private stopped = false;
  private tickSeq = 0;

  constructor(opts: FastLlmKeepalivePingerOpts) {
    this.log = opts.log;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.threadId = opts.threadId ?? null;
    this.platformId = opts.platformId ?? null;
    this.sessionId = opts.sessionId ?? null;
    const layers = opts.layers && opts.layers.length > 0 ? opts.layers : (['banter-ack'] as const);
    this.targets = resolveTargets(layers);
  }

  /** Start the interval timer. Returns immediately. */
  start(): void {
    if (this.started || this.stopped) return;
    if (this.targets.length === 0) return;
    this.started = true;
    this.aborter = new AbortController();
    // setInterval rather than setTimeout-recursion so a slow provider
    // doesn't drift the cadence. If a tick is still inflight we skip
    // the new one (per-target `inflight` guard).
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        this.log.warn('fast-llm keepalive tick threw', { err: String(err) });
      });
    }, this.intervalMs);
    // Unref so the timer doesn't keep the Node process alive past the
    // session — channel adapters call stop() on session-close, but
    // if a bug skips that path we still want the process to exit cleanly.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** Stop the interval and abort any in-flight ping. Idempotent. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.aborter) {
      try {
        this.aborter.abort();
      } catch {
        /* ignore */
      }
      this.aborter = null;
    }
  }

  /** One tick across all targets. Each target fires independently; a
   *  slow Cerebras response does NOT block the next OpenRouter ping. */
  private async tick(): Promise<void> {
    this.tickSeq += 1;
    const seq = this.tickSeq;
    const signal = this.aborter?.signal;
    for (const target of this.targets) {
      if (target.inflight >= MAX_INFLIGHT_PER_HOST) {
        // Previous ping still in flight — skip this tick for this
        // target. Logged at debug to keep the dashboard quiet during
        // normal stalls (e.g. background CI), but visible on demand.
        this.log.event({
          kind: 'fast-llm.keepalive',
          level: 'debug',
          thread_id: this.threadId,
          platform_id: this.platformId,
          session_id: this.sessionId,
          data: {
            tick_seq: seq,
            provider: target.providerName,
            model: target.model,
            layer: target.layer,
            skipped_inflight: true,
          },
        });
        continue;
      }
      target.inflight += 1;
      const t0 = Date.now();
      void target.provider
        .stream({
          system: 'ping',
          user: '.',
          maxTokens: PING_MAX_TOKENS,
          signal,
          onDelta: () => {
            /* discard — the headers landing is what warms the socket */
          },
        })
        .then((result) => {
          this.log.event({
            kind: 'fast-llm.keepalive',
            level: 'debug',
            thread_id: this.threadId,
            platform_id: this.platformId,
            session_id: this.sessionId,
            data: {
              tick_seq: seq,
              provider: target.providerName,
              model: target.model,
              layer: target.layer,
              // socket landing is the real signal: even ok:false with
              // ttfb_ms set means TLS handshake completed → socket warmed.
              ok: result.ttfbMs !== undefined,
              latency_ms: Date.now() - t0,
              ttfb_ms: result.ttfbMs,
              ...(result.connectionReused !== undefined ? { connection_reused: result.connectionReused } : {}),
              ...(result.connectMs !== undefined ? { connect_ms: result.connectMs } : {}),
              ...(result.aborted ? { aborted: true } : {}),
              ...(result.error && !result.aborted ? { error: result.error } : {}),
            },
          });
        })
        .catch((err) => {
          this.log.warn('fast-llm keepalive ping threw', {
            err: String(err),
            provider: target.providerName,
            model: target.model,
          });
          this.log.event({
            kind: 'fast-llm.keepalive',
            level: 'debug',
            thread_id: this.threadId,
            platform_id: this.platformId,
            session_id: this.sessionId,
            data: {
              tick_seq: seq,
              provider: target.providerName,
              model: target.model,
              layer: target.layer,
              ok: false,
              latency_ms: Date.now() - t0,
              error: String(err),
            },
          });
        })
        .finally(() => {
          target.inflight = Math.max(0, target.inflight - 1);
        });
    }
  }
}
