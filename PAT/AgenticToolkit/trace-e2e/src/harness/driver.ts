/**
 * Session driver. Lifted from `nanoclaw/scripts/e2e-anam-scenario.mjs`.
 *
 * Three primitives:
 *   - `preflight`: confirm nanoclaw is healthy.
 *   - `sendUser`: POST a user message; drain the chat-completions SSE
 *     to recover the banter-ack text.
 *   - `bargeIn`: POST a barge-in.
 *   - `sessionEnded`: POST end-of-session (best-effort cleanup).
 *
 * All four hit the nanoclaw anam-web HTTP surface directly. No browser,
 * no Anam SDK, no WebRTC — we don't care about the avatar surface; we
 * care that the cognitive pipeline produced the right structured-log
 * side effects.
 */
import type { Identity } from './ids.js';

export interface DriverConfig {
  /** Nanoclaw anam-web base URL. Defaults to local dev port. */
  nanoclawBase?: string;
}

export interface Driver {
  identity: Identity;
  base: string;
  preflight: () => Promise<void>;
  sendUser: (text: string, label?: string) => Promise<string>;
  bargeIn: (reason?: string) => Promise<unknown>;
  sessionEnded: () => Promise<void>;
}

export function createDriver(identity: Identity, config?: DriverConfig): Driver {
  const base = config?.nanoclawBase ?? process.env.NANOCLAW_BASE ?? 'http://127.0.0.1:8766';

  return {
    identity,
    base,

    async preflight() {
      const res = await fetch(`${base}/health`).catch((e) => {
        throw new Error(`nanoclaw unreachable at ${base}: ${(e as Error).message}`);
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; channel?: string };
      if (!j.ok) throw new Error(`nanoclaw health check failed: ${JSON.stringify(j)}`);
    },

    async sendUser(text: string, label = 'user'): Promise<string> {
      const res = await fetch(`${base}/anam-web/message`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-pat-platform-id': identity.platformId,
          'x-pat-session-id': identity.sessionId,
        },
        body: JSON.stringify({
          stream: true,
          messages: [{ role: 'user', content: text }],
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`POST /anam-web/message ${res.status}: ${detail.slice(0, 200)}`);
      }
      if (!res.body) return '';
      // Drain chat-completions SSE. Each `data:` line is a chunk; the
      // sequence terminates with `data: [DONE]`. We accumulate the
      // delta.content fields into `acc` and return when done.
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
          if (data === '[DONE]') return acc;
          try {
            const j = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
            const delta = j.choices?.[0]?.delta?.content ?? '';
            if (delta) acc += delta;
          } catch {
            // ignore parse error
          }
        }
      }
      return acc;
    },

    async bargeIn(reason = 'trace-e2e-test'): Promise<unknown> {
      const res = await fetch(`${base}/anam-web/barge-in`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: identity.sessionId, reason }),
      });
      return res.json().catch(() => ({}));
    },

    async sessionEnded(): Promise<void> {
      try {
        await fetch(`${base}/anam-web/session-ended`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: identity.sessionId }),
        });
      } catch {
        // best-effort cleanup
      }
    },
  };
}
