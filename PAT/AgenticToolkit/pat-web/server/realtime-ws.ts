/**
 * PAT realtime WebSocket bridge — Mode C′ refactor (2026-05-23).
 *
 * Browser ↔ pat-web ↔ nanoclaw, three-leg socket.
 *
 *   browser  ──── WS /api/realtime ──── pat-web ──── WS /anam-web/ws ──── nanoclaw
 *
 * Pat-web is no longer doing protocol translation (the prior iteration
 * subscribed to nanoclaw's SSE banter stream + POSTed per-turn). It's now
 * a thin frame-pass-through pipe:
 *
 *   - TLS termination on the browser leg (Fly edge).
 *   - Browser-grade auth: a per-session bearer carried via
 *     `Sec-WebSocket-Protocol: pat-bearer.<bearer>`. We don't put it in
 *     the URL — query-string tokens leak via Referer / proxy logs.
 *   - Frames flow both directions verbatim.
 *
 * Lifecycle (per browser WS):
 *   1. On open: validate `(sessionId, platformId, bearer)`, then open
 *      one upstream WS to nanoclaw's `/anam-web/ws?session=…&platform_id=…`.
 *   2. Browser → server frames are forwarded verbatim. The nanoclaw WS
 *      handler dispatches on `frame.kind` (`user-message`, `turn-ended`,
 *      `barge-in`, `session-ended`).
 *   3. Server → browser frames are nanoclaw's `BanterEvent` rows
 *      (`utterance.stream-{started,delta,ended,cancelled}`).
 *   4. On either-side close: tear down the peer socket.
 *
 * Auth surface vs the displaced POST: same trust model as
 * `/anam-web/message` (network position on the Fly internal-net). The
 * browser-grade bearer is enforced by pat-web on the upgrade; nanoclaw
 * still trusts pat-web outright. Future hardening can add an upstream
 * shared secret on the pat-web → nanoclaw leg without touching this
 * file's wire shape.
 */

import type { WSContext } from 'hono/ws';

// Bun ships the WHATWG `WebSocket` global (browser-standard API), which
// also works for outbound client connections — no `ws` npm dep needed
// on this side. Aliased for readability.
type WsClient = WebSocket;

interface BridgeOptions {
  /** Nanoclaw anam-web channel adapter base URL (e.g. `http://127.0.0.1:8766`). */
  upstreamBase: string;
  sessionId: string;
  platformId: string;
}

export interface OpenBridge {
  /** Forward a parsed browser frame to nanoclaw. */
  handleClientFrame(raw: string): void;
  /** Tear down the upstream WS. */
  close(): void;
}

export function openRealtimeBridge(ws: WSContext, opts: BridgeOptions): OpenBridge {
  const upstreamBase = opts.upstreamBase.replace(/\/$/, '');
  // ws/wss based on the upstream scheme — nanoclaw's anam-web port is
  // unencrypted (Fly internal-net), but the helper handles both for
  // tests / future TLS-terminated topologies.
  const wsBase = upstreamBase.replace(/^http/, 'ws');
  const upstreamUrl = `${wsBase}/anam-web/ws?session=${encodeURIComponent(
    opts.sessionId,
  )}&platform_id=${encodeURIComponent(opts.platformId)}`;

  let upstream: WsClient | null = null;
  // Frames arriving from the browser before the upstream socket finishes
  // its handshake. Per-call worst-case is one (the first user-message),
  // but we buffer to be safe — the user-perceived latency reduction from
  // the WS migration is precisely about NOT dropping that first turn.
  const pendingFrames: string[] = [];
  let closed = false;

  try {
    upstream = new WebSocket(upstreamUrl);
  } catch (err) {
    console.warn('[pat-web/realtime-ws] upstream WebSocket() threw', err);
    try {
      ws.close(1011, 'upstream ws construct failed');
    } catch {
      /* noop */
    }
    return {
      handleClientFrame() {
        /* never opens */
      },
      close() {
        closed = true;
      },
    };
  }

  upstream.addEventListener('open', () => {
    if (closed) {
      try {
        upstream!.close();
      } catch {
        /* noop */
      }
      return;
    }
    // Drain any pre-handshake frames the browser already sent.
    for (const raw of pendingFrames) {
      try {
        upstream!.send(raw);
      } catch (err) {
        console.warn('[pat-web/realtime-ws] upstream send (drain) threw', err);
      }
    }
    pendingFrames.length = 0;
  });

  upstream.addEventListener('message', (ev) => {
    if (closed) return;
    if (typeof ev.data !== 'string') return; // ignore binary — wire format is JSON text
    try {
      ws.send(ev.data);
    } catch (err) {
      // Browser closed mid-pipe — let the close handler run.
      console.warn('[pat-web/realtime-ws] browser-side send failed', err);
    }
  });

  upstream.addEventListener('close', (ev) => {
    if (closed) return;
    closed = true;
    try {
      ws.close(1011, 'upstream closed: ' + (ev.reason || ev.code));
    } catch {
      /* noop */
    }
  });

  upstream.addEventListener('error', (ev) => {
    if (closed) return;
    console.warn('[pat-web/realtime-ws] upstream error', ev);
    // Don't close the browser side here — `close` fires next and owns
    // the teardown path.
  });

  function handleClientFrame(raw: string): void {
    if (closed) return;
    if (!upstream || upstream.readyState === WebSocket.CONNECTING) {
      pendingFrames.push(raw);
      return;
    }
    if (upstream.readyState !== WebSocket.OPEN) return; // closing/closed
    try {
      upstream.send(raw);
    } catch (err) {
      console.warn('[pat-web/realtime-ws] upstream send threw', err);
    }
  }

  function close(): void {
    if (closed) return;
    closed = true;
    if (upstream) {
      try {
        upstream.close(1000, 'browser closed');
      } catch {
        /* noop */
      }
    }
  }

  return { handleClientFrame, close };
}
