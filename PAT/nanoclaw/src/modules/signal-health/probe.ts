/**
 * PAT 2026-06-25: Signal health probe — daemon I/O.
 *
 * One-shot, fresh-socket probe of the signal-cli JSON-RPC daemon. Deliberately
 * does NOT reuse the channel adapter's long-lived SignalTcpClient: that socket
 * carries the subscribeReceive stream, and we must not perturb it. Each probe
 * opens its own TCP connection, runs `version` + `listAccounts`, and closes —
 * exactly the behaviour of an external monitoring client.
 *
 * Probe ladder (cheapest / most-fundamental failure first):
 *   1. TCP connect to <host>:<port>. Refused / timed out ⇒ 'daemon-unreachable'
 *      (the daemon or the whole pat-transports machine is DOWN — the exact
 *      failure that silently lapsed the account once before).
 *   2. `version` RPC. The daemon answers JSON-RPC even when its receive loop is
 *      wedged, so a successful `version` confirms the JVM is alive and serving.
 *   3. `listAccounts` RPC. The definitive registration check — the linked
 *      account must appear. Absent / empty ⇒ 'account-unregistered' (LAPSED).
 *
 * Receive-loop wedge is intentionally NOT probed here: that liveness signal
 * (receive thread + relay-:443 socket) is only visible ON the daemon machine,
 * where the watchdog (transports/signal-cli/watchdog.sh) already detects it and
 * forces a restart. A round-trip smoke test (bot→burner→bot) is the right
 * external way to catch a wedge and is tracked as P3 in
 * plans/signal-debugging-infra.md; this probe owns the two failure modes an
 * external observer CAN see definitively: daemon down + account unregistered.
 */
import { createConnection, type Socket } from 'node:net';

import { log } from '../../log.js';

import type { ProbeOutcome } from './state.js';

const CONNECT_TIMEOUT_MS = 8_000;
const RPC_TIMEOUT_MS = 10_000;

export interface ProbeConfig {
  host: string;
  port: number;
  account: string;
}

/** Minimal newline-delimited JSON-RPC round-trip over a throwaway socket. */
async function rpcOnce(host: string, port: number, method: string, params?: Record<string, unknown>): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    let settled = false;
    let buffer = '';
    const id = `health-${method}-${Math.random().toString(36).slice(2)}`;

    const finish = (err: Error | null, value?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else resolve(value);
    };

    const sock: Socket = createConnection(port, host, () => {
      sock.write(JSON.stringify({ jsonrpc: '2.0', method, params, id }) + '\n');
    });

    const timer = setTimeout(() => finish(new Error(`timeout (${method})`)), RPC_TIMEOUT_MS);
    sock.setTimeout(CONNECT_TIMEOUT_MS, () => finish(new Error(`connect timeout (${method})`)));

    sock.on('error', (err) => finish(err));
    sock.on('close', () => finish(new Error(`socket closed before ${method} reply`)));
    sock.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) {
          let parsed: { id?: string; error?: { message?: string }; result?: unknown } | null = null;
          try {
            parsed = JSON.parse(line);
          } catch {
            // Async push notification or partial — skip, keep waiting for ours.
          }
          // The daemon may interleave `receive` push notifications; ignore
          // anything that isn't our response id.
          if (parsed && parsed.id === id) {
            if (parsed.error) finish(new Error(parsed.error.message ?? `RPC error (${method})`));
            else finish(null, parsed.result);
            return;
          }
        }
        nl = buffer.indexOf('\n');
      }
    });
  });
}

/**
 * Does `listAccounts` include our account? signal-cli returns an array of
 * `{ number, ... }` objects (single-account daemons still return their one
 * account). Tolerant of shape drift: we just look for the E164 anywhere in
 * the result's `number` fields.
 */
function accountIsRegistered(result: unknown, account: string): boolean {
  if (!Array.isArray(result)) return false;
  for (const entry of result) {
    if (entry && typeof entry === 'object') {
      const num = (entry as { number?: unknown }).number;
      if (typeof num === 'string' && num === account) return true;
    }
  }
  return false;
}

/**
 * Run one probe tick. Never throws — every failure is mapped to a degraded
 * {@link ProbeOutcome} so the caller's state machine can decide on alerting.
 */
export async function probeSignalHealth(cfg: ProbeConfig): Promise<ProbeOutcome> {
  const start = Date.now();

  // Step 1+2: reachability via `version`. A connect failure and an RPC
  // failure are indistinguishable to an external observer in the way that
  // matters — the daemon isn't serving — so both map to 'daemon-unreachable'.
  try {
    await rpcOnce(cfg.host, cfg.port, 'version');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.debug('Signal health: daemon version probe failed', { host: cfg.host, port: cfg.port, detail });
    return { healthy: false, reason: 'daemon-unreachable', detail };
  }

  // Step 3: registration via `listAccounts`.
  try {
    const accounts = await rpcOnce(cfg.host, cfg.port, 'listAccounts');
    if (!accountIsRegistered(accounts, cfg.account)) {
      return {
        healthy: false,
        reason: 'account-unregistered',
        detail: `account ${cfg.account} not present in listAccounts result`,
      };
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // The daemon answered `version` but choked on `listAccounts` — treat as a
    // probe error rather than a confirmed lapse (don't false-alarm a lapse).
    return { healthy: false, reason: 'probe-error', detail: `listAccounts failed: ${detail}` };
  }

  return { healthy: true, probeMs: Date.now() - start };
}
