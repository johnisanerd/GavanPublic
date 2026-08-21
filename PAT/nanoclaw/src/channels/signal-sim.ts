// PAT: simulated-Signal CAPTURE adapter — test-only outbound sink that
// exercises the full real plumbing MINUS the signal-cli wire.
//
// Why: the signal-cli test rig (pat-signal-rig) can't decrypt PAT's
// outbound (a known B2B session/redelivery desync — see KNOWN_ISSUES), so
// rig-side E2E assertion of PAT's Signal features is blocked. This adapter
// stands in for the real Signal transport when
// `PAT_TEST_OUTBOUND_ADAPTER=1`: it registers under `channelType:'signal'`
// (so it exercises the IDENTICAL code paths a real Signal reply hits —
// COLD_CONTACT_RE routing, CHANNEL_SHAPES['signal'], the delivery loop,
// the `send_voice_memo` system-action → `sendVoiceMemo` extension, and the
// REAL Cartesia synth) and, at the final hop, CAPTURES the outbound instead
// of RPCing signal-cli. The real signal adapter's factory short-circuits to
// null in the same mode (see signal.ts), so this one cleanly owns the
// `signal` key.
//
// Assertions: this adapter emits the same `signal.send-acked` events the
// real adapter does (kind_detail text|attachment|voice-memo) with an added
// `captured:true` marker + payload details, so the smoke can assert on
// patobs byte-for-byte as if it were a real Signal send — proving Cartesia
// actually synthesized audio and files were marshaled — without a
// log-schema change (kinds aren't runtime-validated; extra data fields are
// safe). The delivery loop still fires its own `routing.message-delivered`
// (with file_count) because deliver() returns normally.
//
// SCOPE: host-only, no agent-runner rebuild, no DB migration. Flipping the
// flag off + restart restores the real signal-cli adapter. What this CANNOT
// exercise (out of scope): signal-cli's own attachment/voiceNote RPC, the
// staging voice sidecar, and actual Signal Service delivery/receipts.
import http from 'node:http';
import { mkdtempSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { log } from '../log.js';
import { synthesizeVoiceMemo } from '../modules/voice/synth.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

export function captureModeEnabled(): boolean {
  return process.env.PAT_TEST_OUTBOUND_ADAPTER === '1';
}

// Bidirectional test transport: a tiny HTTP server that injects `signal`
// INBOUND straight into the router (→ back-mind, no front-mind) so the sim
// channel behaves as REAL Signal in AND out. Default sender is the wired rig
// identity (Smoke McGee) so routing/person-resolution works out of the box.
const SIM_INBOUND_PORT = Number(process.env.SIGNAL_SIM_INBOUND_PORT ?? 8769);
const SIM_DEFAULT_FROM = process.env.SIGNAL_SIM_FROM ?? '00000000-0000-4000-8000-000000000000';

function recipientOf(platformId: string): { recipient: string; group_id?: string } {
  return platformId.startsWith('group:')
    ? { recipient: '', group_id: platformId.slice('group:'.length) }
    : { recipient: platformId };
}

/** The capture adapter: same shape as the signal adapter (incl. the
 *  off-interface `sendVoiceMemo` extension), transport swapped for capture. */
function createCaptureAdapter(): ChannelAdapter {
  const outDir = mkdtempSync(join(tmpdir(), 'pat-capture-'));
  log.event({ kind: 'signal.capture-enabled', data: { out_dir: outDir } });

  let inboundServer: http.Server | null = null;

  const adapter: ChannelAdapter & {
    sendVoiceMemo?: (platformId: string, text: string, voiceId?: string) => Promise<boolean>;
  } = {
    name: 'signal-sim',
    // Own the semantic `signal` key so cold `signal:<handle>` routing, the
    // container COLD_CONTACT_RE, and CHANNEL_SHAPES['signal'] all apply.
    channelType: 'signal',
    supportsThreads: false,
    async setup(config: ChannelSetup) {
      // Bidirectional: stand up a tiny HTTP inbound so a test can inject a
      // `signal` message that routes through the SAME path a real Signal
      // message would — straight to the back-mind (no front-mind). `deliver`
      // (below) is the matching outbound. Together = real Signal in AND out,
      // minus the signal-cli wire.
      inboundServer = http.createServer((req, res) => {
        const path = (req.url ?? '').split('?')[0];
        if (req.method === 'GET' && path === '/health') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, channel: 'signal-sim', default_from: SIM_DEFAULT_FROM }));
          return;
        }
        if (req.method !== 'POST' || path !== '/inbound') {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          void (async () => {
            try {
              const { from, text, threadId } = JSON.parse(body || '{}') as {
                from?: string;
                text?: string;
                threadId?: string | null;
              };
              const sender = from || SIM_DEFAULT_FROM;
              if (!text) {
                res.writeHead(400, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: 'text required' }));
                return;
              }
              const msg: InboundMessage = {
                id: String(Date.now()),
                kind: 'chat',
                content: { text, sender, senderId: `signal:${sender}`, senderName: 'Sim Sender' },
                timestamp: new Date().toISOString(),
              };
              log.event({
                kind: 'signal.capture-inbound',
                platform_id: sender,
                data: { from: sender, text_len: text.length },
              });
              await config.onInbound(sender, threadId ?? null, msg);
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ ok: true, routed: `signal:${sender}` }));
            } catch (err) {
              res.writeHead(500, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: String(err) }));
            }
          })();
        });
      });
      // Bind '::' (IPv6, dual-stack) NOT '0.0.0.0': this is a raw port (not a
      // Fly [[service]]), so `flyctl proxy` reaches it directly over the
      // machine's 6PN IPv6 — an IPv4-only bind is unreachable via the tunnel.
      inboundServer.listen(SIM_INBOUND_PORT, '::', () =>
        log.event({
          kind: 'signal.capture-inbound-listening',
          data: { port: SIM_INBOUND_PORT, default_from: SIM_DEFAULT_FROM },
        }),
      );
    },
    async teardown() {
      inboundServer?.close();
      inboundServer = null;
    },
    isConnected() {
      return true;
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      const content = (message.content ?? {}) as { text?: string; operation?: string };
      const files = message.files ?? [];
      // Persist file bytes so a test can inspect them, and record metadata.
      const captured: Array<{ filename: string; size: number; path: string }> = [];
      for (const f of files) {
        const p = join(outDir, `${Date.now()}-${f.filename}`);
        try {
          writeFileSync(p, f.data);
          captured.push({ filename: f.filename, size: f.data.length, path: p });
        } catch (err) {
          log.warn('signal-sim: failed to persist captured file', { filename: f.filename, err });
        }
      }
      const kindDetail = captured.length > 0 ? 'attachment' : 'text';
      const { recipient, group_id } = recipientOf(platformId);
      // Mirror the real adapter's signal.send-acked so smoke assertions are
      // channel-identical; `captured:true`, the actual `text`, and `files` are
      // the sim-only extras. Logging the real text is intentional — this is a
      // TEST sink, and "what would the user receive over signal" is the point.
      log.event({
        kind: 'signal.send-acked',
        platform_id: platformId,
        data: {
          captured: true,
          kind_detail: kindDetail,
          recipient,
          ...(group_id ? { group_id } : {}),
          text: (content.text ?? '').slice(0, 2000),
          text_len: (content.text ?? '').length,
          file_count: captured.length,
          files: captured.map((c) => ({ filename: c.filename, size: c.size })),
        },
      });
      return `capture-${Date.now()}`;
    },
  };

  // Off-interface extension mirroring signal.ts:1600 — the send_voice_memo
  // system-action handler duck-types this. We run the SAME real Cartesia
  // synth (synthesizeVoiceMemo → api.cartesia.ai/tts/bytes + ffmpeg m4a)
  // and capture the produced audio instead of RPCing signal-cli sendVoiceNote.
  adapter.sendVoiceMemo = async (platformId: string, text: string, voiceId?: string): Promise<boolean> => {
    const { recipient, group_id } = recipientOf(platformId);
    const oggPath = await synthesizeVoiceMemo(text, voiceId, { format: 'm4a' });
    if (!oggPath) {
      log.event({
        kind: 'signal.send-failed',
        level: 'error',
        platform_id: platformId,
        data: { captured: true, kind_detail: 'voice-memo', recipient, error: 'synthesizeVoiceMemo returned null' },
      });
      return false;
    }
    let audioBytes = 0;
    try {
      audioBytes = statSync(oggPath).size;
    } catch {
      /* best-effort size */
    }
    log.event({
      kind: 'signal.send-acked',
      platform_id: platformId,
      data: {
        captured: true,
        kind_detail: 'voice-memo',
        recipient,
        ...(group_id ? { group_id } : {}),
        // The exact text PAT synthesized — i.e. what the user would hear.
        spoken_text: text.slice(0, 2000),
        audio_bytes: audioBytes,
        content_type: 'audio/mp4',
        audio_path: oggPath,
      },
    });
    return true;
  };

  return adapter;
}

registerChannelAdapter('signal-sim', {
  // Only active in capture mode; otherwise null so the real signal adapter
  // (registered under the same `signal` key) is the one that lives.
  factory: () => (captureModeEnabled() ? createCaptureAdapter() : null),
});
