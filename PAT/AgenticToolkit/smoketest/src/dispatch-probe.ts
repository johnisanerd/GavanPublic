/**
 * Channel-agnostic dispatch probe.
 *
 * Fills audit gap: the existing smoketest harness (RealtimeClient at
 * src/client.ts:124-164) only exercises the `/inbound` HTTP surface of
 * the realtime channel. Every other wired channel — Signal, Slack,
 * Discord — has no automated end-to-end coverage of the dispatch path.
 * Wave 2.A (Signal), 2.B (outbound-initiate), 2.C (image gen via
 * dispatch), 2.D (apify/http-MCP), and Task #17 (cold-DM rendezvous)
 * all converge on `getDeliveryAdapter().deliver(channelType, ...)`
 * with no test covering that seam end-to-end.
 *
 * Three injection entry points:
 *
 *   1. SQLite direct (`SqliteInjectionProbe`) — writes a synthetic
 *      `messages_in` row straight into a session's `inbound.db`,
 *      bypassing the `/inbound` HTTP route entirely. Lets scenarios
 *      address arbitrary {platform_id, channel_type, thread_id} +
 *      carry attachments[].data base64. This is the audit's
 *      "channel-agnostic dispatch probe" — closest to what a real
 *      Signal/Slack inbound dispatcher does.
 *
 *   2. CLI-socket (`HttpDispatchProbe`) — connects to NanoClaw's
 *      Unix-domain admin socket (`data/cli.sock`). The CLI channel
 *      already accepts `{text, to: {channelType, platformId, threadId}}`
 *      and routes via `onInboundEvent` (src/channels/cli.ts ~L201).
 *      Cheaper than SQLite injection because it doesn't require knowing
 *      the active session dir, but does NOT carry attachments — the
 *      socket payload shape is text-only.
 *
 *   3. In-process probe (`createDummyAdapter`, `buildInboundContent`)
 *      — for vitest/bun:test fixtures that exercise host or container
 *      modules directly without booting NanoClaw. The dummy adapter
 *      satisfies the channel-adapter shape and records every deliver()
 *      call so the test can assert on it.
 *
 * Outbound observation:
 *
 *   - `SqliteOutboundProbe` — polls a session's `outbound.db` for new
 *     `messages_out` rows. Used by scenarios that want to assert on
 *     specific outbound rows (e.g. system action emitted by back-mind)
 *     in addition to or instead of the realtime SSE stream.
 *
 *   - Existing `RealtimeClient` SSE stream — for log-event assertions
 *     and realtime-channel outbound. Scenarios can use both.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { SseEvent } from './client.js';
import { RealtimeClient } from './client.js';

/** A recorded deliver() invocation from the dummy adapter. */
export interface DeliveredCall {
  channelType: string;
  platformId: string;
  threadId: string | null;
  /** Raw OutboundMessage object handed to the adapter. */
  message: {
    kind: string;
    content: unknown;
    files?: Array<{ filename: string; data: Buffer }>;
  };
  /** Wall-clock when deliver() was invoked. */
  at: number;
}

/** Attachment description for synthetic inbound payloads. */
export interface ProbeAttachment {
  name: string;
  /** MIME type — `image/png`, `application/pdf`, `audio/mpeg`, etc. */
  mimeType: string;
  /** Raw bytes. Will be base64-encoded into the synthetic content blob. */
  data: Buffer;
}

/** Address fields for a synthetic inbound event. */
export interface ProbeAddress {
  channelType: string;
  platformId: string;
  threadId?: string | null;
}

/** Synthetic inbound message body. */
export interface ProbeInbound extends ProbeAddress {
  text: string;
  sender?: string;
  senderId?: string;
  attachments?: ProbeAttachment[];
}

// ─── SQLite direct injection (audit's "channel-agnostic dispatch probe") ───

export interface SqliteProbeOptions {
  /**
   * Absolute path to a session's `inbound.db`. The smoketest's host-side
   * fixture must already have spawned the session and ensured the file
   * exists (the host creates it on first message).
   *
   * Use `discoverActiveSessionDir()` to find the most-recently-active
   * session under `<dataRoot>/v2-sessions/` if the caller doesn't know
   * the id up front.
   */
  inboundDbPath: string;
}

/**
 * Channel-agnostic SQLite injection probe.
 *
 * Writes synthetic `messages_in` rows directly into a session's
 * inbound.db, bypassing the `/inbound` HTTP route. The session must
 * already exist (the host owns inbound.db creation and `seq` numbering
 * — we follow the host's even-seq convention).
 *
 * `attachments[].data` is base64-encoded into the row's content JSON
 * exactly the same way the slack and signal adapters do. The
 * container-side formatter (formatter.ts:materializeAttachmentBytes)
 * decodes them at prompt-build time.
 */
export class SqliteInjectionProbe {
  private db: DatabaseSync;

  constructor(opts: SqliteProbeOptions) {
    if (!fs.existsSync(opts.inboundDbPath)) {
      throw new Error(`inbound.db not found at ${opts.inboundDbPath} — has the session been spawned?`);
    }
    this.db = new DatabaseSync(opts.inboundDbPath, { timeout: 5000 });
  }

  /**
   * Insert a synthetic `messages_in` row. Returns the row's id.
   *
   * Mirrors the host's `insertMessage()` shape (src/db/session-db.ts):
   *   - Status = 'pending' (the container picks it up on the next poll).
   *   - `series_id = id` (single-message series).
   *   - `trigger = 1` (wakes the container; set to 0 for context-only).
   *   - Even seq numbers (host convention so the container's odd-seq
   *     ack rows don't collide).
   */
  inject(inbound: ProbeInbound, opts: { trigger?: 0 | 1; kind?: string } = {}): string {
    const id = `probe-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const seq = this.nextEvenSeq();
    const content = buildInboundContent(inbound);
    this.db
      .prepare(
        `INSERT INTO messages_in
           (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content, series_id, trigger)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        seq,
        opts.kind ?? 'chat',
        new Date().toISOString(),
        inbound.platformId,
        inbound.channelType,
        inbound.threadId ?? null,
        content,
        id,
        opts.trigger ?? 1,
      );
    return id;
  }

  private nextEvenSeq(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get() as { m: number };
    const maxSeq = row.m;
    return maxSeq < 2 ? 2 : maxSeq + 2 - (maxSeq % 2);
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Polling reader for a session's outbound.db. Lets scenarios assert on
 * specific `messages_out` rows (e.g. a system action emitted by the
 * back-mind in response to a probe-injected user turn).
 *
 * Polls at 100ms — fast enough to feel synchronous on a test, slow
 * enough to avoid hogging CPU. NanoClaw's own outbound polling is 1s,
 * so this gates the test on its own loop rather than waiting for
 * NanoClaw to notice rows it already wrote.
 */
export interface OutboundRow {
  id: string;
  seq: number;
  kind: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
  timestamp: string;
}

export class SqliteOutboundProbe {
  private db: DatabaseSync;
  private startedAtSeq: number;

  constructor(outboundDbPath: string) {
    if (!fs.existsSync(outboundDbPath)) {
      throw new Error(`outbound.db not found at ${outboundDbPath}`);
    }
    this.db = new DatabaseSync(outboundDbPath, { readOnly: true, timeout: 5000 });
    this.db.exec('PRAGMA mmap_size = 0');
    this.startedAtSeq = this.maxSeq();
  }

  /** Resets the seq-floor so subsequent waitFor() starts from now. */
  bookmark(): void {
    this.startedAtSeq = this.maxSeq();
  }

  /**
   * Wait for an outbound row matching the predicate. Only considers rows
   * with `seq > startedAtSeq` (bookmark at construction time, or after
   * `bookmark()`). Throws on timeout.
   */
  async waitFor(
    predicate: (row: OutboundRow) => boolean,
    timeoutMs: number,
    label = 'outbound row',
  ): Promise<OutboundRow> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rows = this.db
        .prepare('SELECT * FROM messages_out WHERE seq > ? ORDER BY seq ASC')
        .all(this.startedAtSeq) as unknown as OutboundRow[];
      for (const row of rows) {
        if (predicate(row)) return row;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timeout (${timeoutMs}ms) waiting for ${label}`);
  }

  /** Return all rows since bookmark — useful for retroactive assertions. */
  drain(): OutboundRow[] {
    return this.db
      .prepare('SELECT * FROM messages_out WHERE seq > ? ORDER BY seq ASC')
      .all(this.startedAtSeq) as unknown as OutboundRow[];
  }

  private maxSeq(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_out').get() as { m: number };
    return row.m;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Locate the most-recently-active session dir under `<dataRoot>/v2-sessions/`.
 * Useful when the scenario doesn't pin a sessionId itself and the harness
 * needs to drive whichever container is currently running.
 *
 * Order: most-recent `.heartbeat` mtime wins. Returns null if no session
 * has a heartbeat file (i.e. no active container).
 */
export function discoverActiveSessionDir(dataRoot?: string): string | null {
  const root = dataRoot ?? process.env.NANOCLAW_DATA_ROOT ?? path.resolve(process.cwd(), '../nanoclaw/data');
  const sessionsRoot = path.join(root, 'v2-sessions');
  if (!fs.existsSync(sessionsRoot)) return null;
  let bestPath: string | null = null;
  let bestMtime = 0;
  for (const group of fs.readdirSync(sessionsRoot)) {
    // Skip the smoketest sentinel folder.
    if (group.startsWith('_')) continue;
    const groupDir = path.join(sessionsRoot, group);
    if (!fs.statSync(groupDir).isDirectory()) continue;
    for (const sess of fs.readdirSync(groupDir)) {
      const sessDir = path.join(groupDir, sess);
      const heartbeat = path.join(sessDir, '.heartbeat');
      if (!fs.existsSync(heartbeat)) continue;
      const mtime = fs.statSync(heartbeat).mtimeMs;
      if (mtime > bestMtime) {
        bestMtime = mtime;
        bestPath = sessDir;
      }
    }
  }
  return bestPath;
}

// ─── HTTP probe (live NanoClaw, CLI-socket admin transport) ──────────────

export interface HttpProbeOptions {
  /** REALTIME_BASE_URL — defaults to the same env var RealtimeClient reads. */
  baseUrl?: string;
  /**
   * NanoClaw `data/` dir, which holds `cli.sock`. The smoketest's existing
   * `runner.ts` already resolves this; we default to the same parent path.
   */
  dataDir?: string;
}

/** Default location the CLI channel listens on (matches src/channels/cli.ts). */
function defaultCliSocketPath(opts: HttpProbeOptions): string {
  const dataDir =
    opts.dataDir ?? process.env.NANOCLAW_DATA_ROOT ?? path.resolve(process.cwd(), '../nanoclaw/data');
  return path.join(dataDir, 'cli.sock');
}

/**
 * Connect-and-send-once probe to NanoClaw's CLI Unix socket. The CLI channel
 * accepts `{text, to:{channelType,platformId,threadId}}` and routes the message
 * through `onInboundEvent` exactly like a real adapter would — the same path
 * the bootstrap script uses to inject admin messages. We piggy-back on this
 * instead of adding a new HTTP route on the host because (a) it already
 * exists, (b) it's gated by socket file perms (0600) so it's not a new attack
 * surface, and (c) host code is owned by pathc-lead for this sprint — we
 * don't touch it.
 *
 * Returns when the socket has flushed; outbound observation is the caller's
 * problem (use RealtimeClient's SSE stream — outbound rows for non-realtime
 * channels also broadcast via the /outbound SSE for monitoring).
 *
 * Does NOT carry attachments — the CLI socket payload is text-only. Use
 * `SqliteInjectionProbe` for attachment scenarios.
 */
export class HttpDispatchProbe {
  private readonly sockPath: string;
  private readonly sseClient: RealtimeClient;
  /** Recorded SSE events the caller can inspect for routing assertions. */
  readonly observedEvents: SseEvent[] = [];

  constructor(opts: HttpProbeOptions = {}) {
    this.sockPath = defaultCliSocketPath(opts);
    this.sseClient = new RealtimeClient({
      baseUrl: opts.baseUrl,
      onEvent: (ev) => this.observedEvents.push(ev),
    });
  }

  /** Open the /outbound SSE stream. Call once before sending. */
  async connect(): Promise<void> {
    await this.sseClient.connect();
  }

  /**
   * Send a synthetic inbound event via the CLI socket's admin-routing path.
   * Resolves once the line has been written to the socket. Does NOT wait
   * for a response — use `waitForOutbound()` to observe routing.
   */
  async send(inbound: ProbeInbound): Promise<void> {
    if (!fs.existsSync(this.sockPath)) {
      throw new Error(`CLI socket not found at ${this.sockPath} — is NanoClaw running?`);
    }
    const payload = {
      text: inbound.text,
      sender: inbound.sender ?? 'smoketest-probe',
      senderId: inbound.senderId ?? `smoketest:${inbound.platformId}`,
      to: {
        channelType: inbound.channelType,
        platformId: inbound.platformId,
        threadId: inbound.threadId ?? null,
      },
    };
    await new Promise<void>((resolve, reject) => {
      const sock = net.createConnection(this.sockPath, () => {
        sock.write(JSON.stringify(payload) + '\n', (err) => {
          if (err) reject(err);
          else {
            // CLI socket doesn't ack; close after a brief flush window.
            sock.end();
            resolve();
          }
        });
      });
      sock.once('error', reject);
    });
  }

  /**
   * Wait for an SSE event matching a predicate. Mirrors RealtimeClient's
   * waitFor; routes through the same buffered/waiter machinery so the same
   * timeout semantics apply.
   */
  waitForOutbound(predicate: (ev: SseEvent) => boolean, timeoutMs: number, label = 'outbound event'): Promise<SseEvent> {
    return this.sseClient.waitFor(predicate, timeoutMs, label);
  }

  close(): void {
    this.sseClient.close();
  }
}

// ─── In-process probe (vitest fixtures, no live NanoClaw needed) ─────────

export interface DummyAdapterOptions {
  channelType: string;
  /** If true, deliver() returns a fake message id. Otherwise undefined. */
  returnMessageId?: boolean;
  /**
   * If set, openDM() returns this platform id for ANY user handle (lets
   * tests exercise the cold-DM resolution path without a real registry).
   */
  openDmReturns?: string;
}

/** Minimal recorder adapter that satisfies the `ChannelAdapter` shape. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createDummyAdapter(opts: DummyAdapterOptions): any {
  const calls: DeliveredCall[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let setupConfig: any = null;
  const adapter = {
    name: `dummy-${opts.channelType}`,
    channelType: opts.channelType,
    supportsThreads: false,
    recordedDeliveries: calls,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async setup(config: any) {
      setupConfig = config;
    },
    async teardown() {
      setupConfig = null;
    },
    isConnected() {
      return setupConfig !== null;
    },
    async deliver(
      // The real ChannelDeliveryAdapter.deliver signature is
      // (channelType, platformId, threadId, kind, content, files?) but
      // channels register their own per-channel adapter that drops the
      // leading channelType. We support both shapes by sniffing the arity.
      ...args: unknown[]
    ): Promise<string | undefined> {
      let channelType: string;
      let platformId: string;
      let threadId: string | null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let message: any;
      if (args.length >= 5 && typeof args[3] === 'string') {
        // Delivery-adapter shape: (channelType, platformId, threadId, kind, content, files?)
        channelType = args[0] as string;
        platformId = args[1] as string;
        threadId = args[2] as string | null;
        const kind = args[3] as string;
        const content = args[4];
        const files = args[5] as Array<{ filename: string; data: Buffer }> | undefined;
        message = { kind, content, files };
      } else {
        // Per-channel shape: (platformId, threadId, message)
        channelType = opts.channelType;
        platformId = args[0] as string;
        threadId = (args[1] as string | null) ?? null;
        message = args[2];
      }
      calls.push({
        channelType,
        platformId,
        threadId,
        message,
        at: Date.now(),
      });
      return opts.returnMessageId ? `dummy-msg-${calls.length}` : undefined;
    },
    async openDM(handle: string): Promise<string> {
      return opts.openDmReturns ?? handle;
    },
  };
  return adapter;
}

/**
 * Build a synthetic `messages_in`-style content blob with the same shape
 * the slack/signal/discord adapters produce. Used by deliverable #2's
 * attachment-materialization test and by callers that want to drive the
 * formatter directly. The base64 encoding for attachments matches what
 * the real adapters emit.
 */
export function buildInboundContent(inbound: ProbeInbound): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const content: Record<string, any> = {
    text: inbound.text,
    sender: inbound.sender ?? 'probe-user',
    senderId: inbound.senderId ?? `${inbound.channelType}:${inbound.platformId}`,
  };
  if (inbound.attachments && inbound.attachments.length > 0) {
    content.attachments = inbound.attachments.map((a) => ({
      name: a.name,
      mimeType: a.mimeType,
      data: a.data.toString('base64'),
    }));
  }
  return JSON.stringify(content);
}
