/**
 * Shared signal-test-rig client for smoke scenarios.
 *
 * The rig (signal-test-rig, deployed as pat-signal-rig = "Smoke McGee")
 * wraps a signal-cli daemon and exposes an HTTP + WS API:
 *   GET  /address          → { accounts:[{number,uuid,profile_name}], default }
 *   POST /send {recipient,text}
 *   WS   /ws?token=&kind=&from=&text_contains=…  → broadcast of inbound.* events
 *
 * Inbound taxonomy the rig classifies (what PAT SENDS shows up here as the
 * rig's inbound): inbound.text, inbound.voice-memo, inbound.attachment,
 * inbound.reaction, inbound.edit, inbound.typing.*, receipt.*.
 *
 * This client is the shared plumbing for every signal feature scenario, so
 * they don't each re-inline ~300 LOC of HTTP/WS. Assertions live on the RIG
 * side (PAT produced media → rig observed it), which keeps these scenarios
 * self-contained: rig bearer token only, no log tunnel / viewer token.
 *
 * Node 22's global WebSocket is used (smoketest tsconfig has the DOM lib).
 */
import http from 'node:http';
import https from 'node:https';

declare const WebSocket: typeof globalThis.WebSocket;

export interface RigAccount {
  number?: string;
  uuid?: string;
  profile_name?: string | null;
}

export interface RigEvent {
  kind: string;
  ts?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
}

export interface SignalRigOptions {
  /** Base URL, e.g. https://pat-signal-rig.fly.dev (no trailing slash needed). */
  url: string;
  /** Shared bearer (PAT_SIGNAL_RIG_TOKEN). */
  token: string;
}

export class SignalRig {
  private readonly url: string;
  private readonly token: string;

  constructor(opts: SignalRigOptions) {
    this.url = opts.url.replace(/\/+$/, '');
    this.token = opts.token;
  }

  /** The rig's own Signal identities (E164 + ACI UUID). accounts[0] is the /send default. */
  async address(): Promise<RigAccount[]> {
    const body = await this.getJson('/address');
    const accts = Array.isArray(body?.accounts) ? (body.accounts as RigAccount[]) : [];
    return accts;
  }

  /** Send a text message from the rig to `recipient` (E164 or ACI UUID). */
  async sendText(recipient: string, text: string): Promise<void> {
    await this.postJson('/send', { recipient, text });
  }

  /**
   * Open a WS tap and resolve with the FIRST event matching `match` within
   * `timeoutMs`, or null on timeout. `kindPrefix` narrows the server-side
   * filter (e.g. 'inbound.voice-memo'); `match` is the precise predicate
   * (kind + sender + content) applied client-side.
   */
  async waitForEvent(
    opts: { kindPrefix?: string; timeoutMs: number; match: (e: RigEvent) => boolean },
  ): Promise<RigEvent | null> {
    const wsBase = this.url.replace(/^http/, 'ws');
    const params = new URLSearchParams({ token: this.token });
    if (opts.kindPrefix) params.set('kind', opts.kindPrefix);
    const wsUrl = `${wsBase}/ws?${params.toString()}`;

    return new Promise((resolve) => {
      let settled = false;
      let ws: WebSocket | null = null;
      const done = (r: RigEvent | null) => {
        if (settled) return;
        settled = true;
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
        resolve(r);
      };
      const timer = setTimeout(() => done(null), opts.timeoutMs);
      try {
        ws = new WebSocket(wsUrl);
        ws.addEventListener('message', (ev: MessageEvent) => {
          let parsed: RigEvent;
          try {
            parsed = JSON.parse(String(ev.data)) as RigEvent;
          } catch {
            return;
          }
          if (opts.match(parsed)) {
            clearTimeout(timer);
            done(parsed);
          }
        });
        ws.addEventListener('error', () => {
          /* swallow — timeout will fire */
        });
      } catch {
        clearTimeout(timer);
        done(null);
      }
    });
  }

  private getJson(path: string): Promise<Record<string, unknown>> {
    return this.request('GET', path);
  }

  private postJson(path: string, payload: unknown): Promise<Record<string, unknown>> {
    return this.request('POST', path, payload);
  }

  private request(method: 'GET' | 'POST', path: string, payload?: unknown): Promise<Record<string, unknown>> {
    const u = new URL(this.url + path);
    const data = payload === undefined ? undefined : JSON.stringify(payload);
    return new Promise((resolve, reject) => {
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request(
        {
          hostname: u.hostname,
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: u.pathname + u.search,
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data).toString() } : {}),
          },
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => (body += c));
          res.on('end', () => {
            if ((res.statusCode ?? 0) >= 400) {
              reject(new Error(`${method} ${path} → HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
              return;
            }
            try {
              resolve(body ? (JSON.parse(body) as Record<string, unknown>) : {});
            } catch (err) {
              reject(new Error(`${method} ${path} bad JSON: ${(err as Error).message}`));
            }
          });
        },
      );
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }
}

/** Does this rig event's sender match one of PAT's identities (E164 or ACI UUID)? */
export function eventFromSender(e: RigEvent, senderIds: string[]): boolean {
  const hay = JSON.stringify(e.data ?? e).toLowerCase();
  return senderIds.some((id) => id && hay.includes(id.toLowerCase()));
}
