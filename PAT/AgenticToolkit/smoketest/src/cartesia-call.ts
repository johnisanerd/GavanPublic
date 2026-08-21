/**
 * Tier 3A — WebSocket client for Cartesia's programmatic Calls API.
 *
 *   wss://api.cartesia.ai/agents/stream/<agent_id>
 *
 * Same scenarios as Tier 3T (text), different transport. Cartesia's full
 * voice pipeline (real STT → voice-transport on Railway → NanoClaw → real
 * TTS) sits in the loop. Caller sends `event:"start"`, then `media_input`
 * frames containing base64 PCM. Server replies with `media_output` frames
 * carrying agent audio.
 *
 * Capture model: every PCM byte we send (user side) and every PCM byte we
 * receive (agent side) is appended to its own ring with a wall-clock
 * timestamp. After the scenario ends, we render `call.wav` by mixing the
 * two streams at their actual offsets — overlap (barge-in) becomes audible
 * overlap, gaps become silence.
 *
 * Required env:
 *   CARTESIA_API_KEY                — auth
 *   CARTESIA_AGENT_ID               — staging or prod agent id
 *   CARTESIA_TTS_USER_VOICE_ID      — voice for the simulated user (default: barbershop man)
 */
import dns from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';

import WebSocket from 'ws';

/**
 * Override `ws`'s default lookup with one that uses Node's native DNS
 * resolver (UDP query) instead of libc's getaddrinfo. macOS's
 * mDNSResponder occasionally returns ENOTFOUND for hosts that DO resolve
 * via the wire protocol — flushing the cache fixes it but isn't an option
 * we can rely on. resolve4 always works as long as the network is up.
 *
 * The standard `dns.lookup` signature has two callback shapes depending
 * on `options.all`:
 *   - all=false (default): cb(err, address, family)
 *   - all=true:            cb(err, [{ address, family }, ...])
 * We honor both so any caller — including the connect helper inside
 * `ws` — gets the response shape it expects.
 */
type LookupCb = (err: NodeJS.ErrnoException | null, ...rest: unknown[]) => void;
function resolverLookup(host: string, optsOrCb: dns.LookupOptions | LookupCb, maybeCb?: LookupCb): void {
  const opts: dns.LookupOptions | dns.LookupAllOptions = typeof optsOrCb === 'function' ? {} : optsOrCb;
  const cb: LookupCb = typeof optsOrCb === 'function' ? optsOrCb : (maybeCb as LookupCb);
  dns.resolve4(host, (err, addrs) => {
    if (err) {
      cb(err);
      return;
    }
    if (!addrs || addrs.length === 0) {
      const e: NodeJS.ErrnoException = new Error(`no A records for ${host}`);
      e.code = 'ENOTFOUND';
      cb(e);
      return;
    }
    if ((opts as dns.LookupAllOptions).all) {
      cb(null, addrs.map((a) => ({ address: a, family: 4 })));
    } else {
      cb(null, addrs[0]!, 4);
    }
  });
}

const CARTESIA_VERSION = '2025-04-16';
const STREAM_ENDPOINT_BASE = 'wss://api.cartesia.ai/agents/stream';
const SAMPLE_RATE = 44100; // pcm_44100 per Cartesia start-event default
const TTS_USER_VOICE_DEFAULT = '694f9389-aac1-45b6-b726-9d9369183238'; // barbershop man
const BYTES_PER_SAMPLE = 2; // pcm_s16le
const BYTE_RATE = SAMPLE_RATE * BYTES_PER_SAMPLE;
const GAP_THRESHOLD_MS = 50;

export interface CartesiaCallOptions {
  apiKey?: string;
  agentId?: string;
  /** Voice id used to synthesize the simulated user's turns. */
  userVoiceId?: string;
  /** Where to drop call.wav and per-turn artifacts. */
  persistDir?: string;
  /** If set, also stream every server event into this callback. */
  onServerEvent?: (ev: ServerEvent) => void;
}

export interface ServerEvent {
  event: string;
  payload: unknown;
}

/**
 * One contiguous audio stream (e.g. all agent media_output) recorded as
 * sequential PCM with silence inserted at real wall-clock gaps.
 *
 * For each new chunk we compare its arrival time to "when the audio we've
 * already buffered would finish playing." If the new chunk arrives before
 * that boundary, we treat it as continuous — concat back-to-back, no gap
 * (preserves the bursts that cause crackle when over-aligned). If it
 * arrives after the boundary, we insert silence to bridge the gap so the
 * playback matches wall-clock pacing.
 *
 * `bytesTotal` is the running length of `pcm` (including any inserted
 * silence) — used to compute "expected playback end" without re-summing.
 */
export interface AudioStream {
  startMs: number | null;
  bytesTotal: number;
  pcm: Buffer[];
  /** Trailing odd byte from the previous chunk (if any), to keep s16 alignment. */
  carry: Buffer;
}

export function newAudioStream(): AudioStream {
  return { startMs: null, bytesTotal: 0, pcm: [], carry: Buffer.alloc(0) };
}

/** Total seconds of audio buffered so far in this stream. */
export function streamDurationSec(s: AudioStream): number {
  return s.bytesTotal / BYTE_RATE;
}

export class CartesiaCallClient {
  private ws: WebSocket | null = null;
  private streamId: string;
  private startTs = 0;
  private connectPromise: Promise<void> | null = null;
  /** Continuous-mic keepalive (see startContinuousMic). */
  private micTimer: NodeJS.Timeout | null = null;
  /** True while sendUserTurn is streaming speech frames — the keepalive
   *  yields so we never interleave silence into the middle of speech. */
  private sendingSpeech = false;
  private userStream: AudioStream = { startMs: null, bytesTotal: 0, pcm: [], carry: Buffer.alloc(0) };
  private agentStream: AudioStream = { startMs: null, bytesTotal: 0, pcm: [], carry: Buffer.alloc(0) };
  private serverEvents: { ts: number; ev: ServerEvent }[] = [];
  private readonly opts: Required<Omit<CartesiaCallOptions, 'persistDir' | 'onServerEvent'>> & {
    persistDir?: string;
    onServerEvent?: (ev: ServerEvent) => void;
  };

  constructor(opts: CartesiaCallOptions = {}) {
    this.streamId = `smoketest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.opts = {
      apiKey: opts.apiKey ?? process.env.CARTESIA_API_KEY ?? '',
      agentId: opts.agentId ?? process.env.CARTESIA_AGENT_ID ?? process.env.CARTESIA_AGENT_ID_STAGING ?? '',
      userVoiceId: opts.userVoiceId ?? process.env.CARTESIA_TTS_USER_VOICE_ID ?? TTS_USER_VOICE_DEFAULT,
      persistDir: opts.persistDir,
      onServerEvent: opts.onServerEvent,
    };
    if (!this.opts.apiKey) throw new Error('CARTESIA_API_KEY not set');
    if (!this.opts.agentId) throw new Error('CARTESIA_AGENT_ID (or _STAGING) not set');
  }

  /** Open the WS, send the start event, wait until the server has the stream open. */
  connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    const url = `${STREAM_ENDPOINT_BASE}/${this.opts.agentId}`;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          'Cartesia-Version': CARTESIA_VERSION,
        },
        lookup: resolverLookup as never,
      });
      this.ws = ws;
      let started = false;
      ws.on('open', () => {
        this.startTs = Date.now();
        ws.send(
          JSON.stringify({
            event: 'start',
            stream_id: this.streamId,
            config: { input_format: `pcm_${SAMPLE_RATE}` },
            // PAT 2026-07-06: smoke-caller pre-auth. A top-level `from` is not
            // a documented start-event field and Cartesia drops it (verified
            // 2026-07-04 — the old SMOKETEST_CALLER_E164 spoof was inert). The
            // documented client→agent passthrough is `metadata` (docs.cartesia
            // .ai/line/integrations/websocket-api). When SMOKE_PREAUTH_TOKEN is
            // set (and SMOKE_PREAUTH != '0'), send it as metadata.smoke_preauth;
            // the staging voice-transport maps a matching token to its own
            // SMOKE_CALLER_E164 (server-side, +15005550006 = Smoke McGee), so
            // the call is admitted via the REAL people-spine path instead of
            // arriving as realtime:websocket.
            ...(process.env.SMOKE_PREAUTH !== '0' && process.env.SMOKE_PREAUTH_TOKEN
              ? { metadata: { smoke_preauth: process.env.SMOKE_PREAUTH_TOKEN } }
              : {}),
          }),
        );
      });
      ws.on('message', (data) => {
        let msg: { event: string; media?: { payload?: string }; [k: string]: unknown };
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        const ts = Date.now() - this.startTs;
        const serverEv: ServerEvent = { event: msg.event, payload: msg };
        this.serverEvents.push({ ts, ev: serverEv });
        this.opts.onServerEvent?.(serverEv);
        // Cartesia's first server event after start varies; resolve on the
        // first one that's NOT an error. If `start` itself fails, we'll see
        // an `error` event and reject.
        if (!started) {
          if (msg.event === 'error') {
            reject(new Error(`Cartesia start error: ${JSON.stringify(msg)}`));
            return;
          }
          started = true;
          // PAT: real mics never stop streaming — start the continuous-mic
          // keepalive as soon as the stream is live (see startContinuousMic
          // for why this is load-bearing, not cosmetic).
          this.startContinuousMic();
          resolve();
        }
        if (msg.event === 'media_output' && msg.media?.payload) {
          const pcm = Buffer.from(msg.media.payload, 'base64');
          appendChunk(this.agentStream, pcm, ts);
        }
      });
      ws.on('error', (err) => {
        if (!started) reject(err);
      });
      ws.on('close', () => {
        if (!started) reject(new Error('WS closed before start ack'));
      });
    });
    return this.connectPromise;
  }

  /**
   * PAT: continuous-mic emulation — the fix for the 2026-07-04 "endpointer
   * starvation" drop (KNOWN_ISSUES). A real phone leg streams audio (speech,
   * silence, noise) for the WHOLE call; this client used to stop sending
   * media_input frames ~200ms after each utterance, and Cartesia's
   * end-of-turn detection starves without incoming frames — the final
   * user-turn segment never finalizes and is flushed EMPTY at teardown
   * ("greets but never answers", segmentation-lottery C1). So: from stream
   * start until close, send one 200ms silence frame per 200ms whenever we
   * are not actively streaming speech. Disable (to reproduce the starvation
   * signature deliberately) with SMOKETEST_CONTINUOUS_MIC=0.
   */
  private startContinuousMic(): void {
    if (process.env.SMOKETEST_CONTINUOUS_MIC === '0') return;
    if (this.micTimer) return;
    const CHUNK_MS = 200;
    const chunkBytes = Math.floor((CHUNK_MS / 1000) * SAMPLE_RATE * BYTES_PER_SAMPLE);
    const silenceB64 = Buffer.alloc(chunkBytes).toString('base64');
    this.micTimer = setInterval(() => {
      if (this.sendingSpeech) return;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      try {
        this.ws.send(
          JSON.stringify({ event: 'media_input', stream_id: this.streamId, media: { payload: silenceB64 } }),
        );
      } catch {
        // ignore — close() clears the timer
      }
    }, CHUNK_MS);
  }

  /**
   * Synthesize the user's text via Cartesia TTS and stream it to the agent
   * as a sequence of ~200ms `media_input` frames at real-time pacing. After
   * the last speech frame, trailing silence keeps flowing via the
   * continuous-mic keepalive (startContinuousMic), so Cartesia's STT
   * voice-activity-detection always has frames to finalize the turn against.
   *
   * Returns once all audio has been sent (server may still be processing).
   */
  async sendUserTurn(text: string): Promise<void> {
    if (!this.ws) throw new Error('CartesiaCallClient not connected');
    const { Cartesia } = await import('@cartesia/cartesia-js');
    const client = new Cartesia({ apiKey: this.opts.apiKey });

    const ttsResp = await client.tts.generate({
      model_id: process.env.CARTESIA_TTS_MODEL ?? 'sonic-2',
      transcript: text,
      voice: { mode: 'id', id: this.opts.userVoiceId },
      language: 'en',
      output_format: {
        container: 'raw',
        encoding: 'pcm_s16le',
        sample_rate: SAMPLE_RATE,
      },
    } as Parameters<typeof client.tts.generate>[0]);
    const speechPcm = Buffer.from(await ttsResp.arrayBuffer());

    // Append trailing silence after the speech. NOTE (2026-07-04): the old
    // "200ms is enough" claim was REFUTED — with the mic stream halted after
    // it, Cartesia's endpointer starves and never finalizes the turn. The
    // real fix is the continuous-mic keepalive (startContinuousMic); this
    // inline pad only matters on the SMOKETEST_CONTINUOUS_MIC=0 repro arm.
    const silenceMs = Number(process.env.SMOKETEST_END_OF_TURN_SILENCE_MS ?? 200);
    const silenceBytes = Math.floor((silenceMs / 1000) * SAMPLE_RATE * BYTES_PER_SAMPLE);
    const fullPcm = Buffer.concat([speechPcm, Buffer.alloc(silenceBytes)]);

    // Real-time pacing: one frame every CHUNK_MS, sleep between sends. If we
    // dump everything instantly, Cartesia may treat it as backpressure or
    // the VAD may never see "speech then silence".
    const CHUNK_MS = 200;
    const chunkBytes = Math.floor((CHUNK_MS / 1000) * SAMPLE_RATE * BYTES_PER_SAMPLE);
    const turnStartTs = Date.now() - this.startTs;
    // Record the entire speech (without trailing silence) at the turn-start
    // offset for the local mix. Sequential concat — no per-chunk receive
    // jitter on our side because we synthesized this in one go.
    appendChunk(this.userStream, speechPcm, turnStartTs);

    this.sendingSpeech = true;
    try {
      for (let off = 0; off < fullPcm.length; off += chunkBytes) {
        const slice = fullPcm.subarray(off, Math.min(off + chunkBytes, fullPcm.length));
        this.ws.send(
          JSON.stringify({
            event: 'media_input',
            stream_id: this.streamId,
            media: { payload: slice.toString('base64') },
          }),
        );
        await new Promise((r) => setTimeout(r, CHUNK_MS));
      }
    } finally {
      this.sendingSpeech = false;
    }
  }

  /**
   * PAT: robust ask — behave like a human caller, not a timing model. Send
   * the turn, then wait for FRESH agent audio arriving AFTER our clip ended
   * (banter that fired mid-clip — e.g. a semantic-split fragment getting
   * bantered over — doesn't count as an answer). If nothing lands within the
   * window, assume our turn was swallowed or talked over and simply ask
   * again, like a person repeating themselves. This is deliberately NOT a
   * silence-ms tuning knob: it's detection + repeat, robust regardless of
   * which upstream micro-mechanism ate the turn.
   */
  async askWithRetry(
    text: string,
    {
      replyTimeoutMs = 45_000,
      retries = 1,
      // ≥0.5s of fresh 44.1kHz 16-bit mono — enough to rule out a stray
      // keepalive burst while tolerating a terse "four."
      minReplyBytes = 44_100,
    }: { replyTimeoutMs?: number; retries?: number; minReplyBytes?: number } = {},
  ): Promise<{ replied: boolean; attempts: number; freshBytes: number }> {
    let attempts = 0;
    let bytesAtClipEnd = this.agentStream.bytesTotal;
    while (attempts <= retries) {
      attempts++;
      await this.sendUserTurn(text);
      bytesAtClipEnd = this.agentStream.bytesTotal;
      const deadline = Date.now() + replyTimeoutMs;
      while (Date.now() < deadline) {
        const fresh = this.agentStream.bytesTotal - bytesAtClipEnd;
        if (fresh >= minReplyBytes) return { replied: true, attempts, freshBytes: fresh };
        await new Promise((r) => setTimeout(r, 250));
      }
      // No post-clip agent audio — swallowed turn. Loop → repeat the question.
    }
    return { replied: false, attempts, freshBytes: this.agentStream.bytesTotal - bytesAtClipEnd };
  }

  /**
   * Wait for the agent's opening greeting to finish playing before sending
   * the first user turn. Without this we clobber "Hey, you've got Pat" —
   * Cartesia STT then has to deal with overlapping speech, banter rendering
   * gets muddled, and recordings sound bad.
   *
   * Strategy: poll the agent stream for a quiet window — N consecutive
   * checks with no new bytes arrived. Capped at `maxMs` so a stuck greeting
   * doesn't wedge the test.
   *
   *   minSilenceMs   how long the stream must be silent before we call it done
   *   maxMs          hard cap on total wait (greeting will time out at this)
   *   warmupMs       grace before starting silence detection (gives Cartesia
   *                  time to start streaming the greeting at all)
   */
  async waitForGreetingToFinish(
    {
      // PAT: 500ms tripped mid-greeting — Cartesia TTS delivery is bursty and
      // routinely gaps >500ms between sentences, so the harness started
      // talking over the greeting and its turn landed as a BARGE-IN (seen
      // live 2026-07-03: bargein.received + no banter for the turn).
      minSilenceMs = 2_000,
      maxMs = 15_000,
      warmupMs = 1_000,
    }: { minSilenceMs?: number; maxMs?: number; warmupMs?: number } = {},
  ): Promise<{ reason: 'greeting-ended' | 'timeout' | 'never-started'; durationMs: number }> {
    const startWait = Date.now();
    const pollMs = 100;
    // Warmup: just sleep so the stream has a chance to start.
    await new Promise((r) => setTimeout(r, warmupMs));
    let lastBytes = this.agentStream.bytesTotal;
    let lastChangeAt = Date.now();
    let everSpoke = lastBytes > 0;
    while (Date.now() - startWait < maxMs) {
      const cur = this.agentStream.bytesTotal;
      if (cur !== lastBytes) {
        lastBytes = cur;
        lastChangeAt = Date.now();
        everSpoke = true;
      } else if (everSpoke && Date.now() - lastChangeAt >= minSilenceMs) {
        return { reason: 'greeting-ended', durationMs: Date.now() - startWait };
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return { reason: everSpoke ? 'timeout' : 'never-started', durationMs: Date.now() - startWait };
  }

  /**
   * Wait for the agent to STOP speaking before we close the call. Without
   * this we frequently close mid-utterance and the recorded WAV cuts off
   * a sentence (e.g. "I've tried — the install request keeps faili—" then
   * dead air). Same quiet-window detection as waitForGreetingToFinish but
   * tuned for end-of-call: longer trailing silence before we trust it.
   *
   *   minSilenceMs   stream must be silent this long before we call it done
   *   maxMs          hard cap; protects against a stuck stream
   */
  async waitForAgentToFinishSpeaking(
    {
      minSilenceMs = 1500,
      maxMs = 12_000,
    }: { minSilenceMs?: number; maxMs?: number } = {},
  ): Promise<{ reason: 'finished' | 'timeout' | 'never-spoke'; durationMs: number }> {
    const startWait = Date.now();
    const pollMs = 100;
    let lastBytes = this.agentStream.bytesTotal;
    let lastChangeAt = Date.now();
    let everSpoke = lastBytes > 0;
    while (Date.now() - startWait < maxMs) {
      const cur = this.agentStream.bytesTotal;
      if (cur !== lastBytes) {
        lastBytes = cur;
        lastChangeAt = Date.now();
        everSpoke = true;
      } else if (everSpoke && Date.now() - lastChangeAt >= minSilenceMs) {
        return { reason: 'finished', durationMs: Date.now() - startWait };
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return { reason: everSpoke ? 'timeout' : 'never-spoke', durationMs: Date.now() - startWait };
  }

  /**
   * PAT: total agent PCM bytes received so far. Call-only scenarios use a
   * before/after delta around a user turn as the "did the agent audibly
   * respond" assertion — the SSE tap doesn't carry call-thread events, so
   * audio-level evidence is the reliable signal on Tier 3A.
   */
  agentAudioBytes(): number {
    return this.agentStream.bytesTotal;
  }

  /**
   * Wait until at least one media_output frame has arrived after `since` ms
   * (relative to call start). Useful for "did the agent reply at all" gates;
   * we still rely on the parallel SSE tap to nanoclaw for *what* the agent
   * said in text.
   */
  waitForAgentAudio(timeoutMs: number, sinceMs = 0): Promise<void> {
    return new Promise((resolve, reject) => {
      const startedSamples = streamOffsetSamples(this.agentStream);
      const sinceSamples = Math.floor((sinceMs / 1000) * SAMPLE_RATE);
      const check = () => {
        const lenSamples = Math.floor(streamToPcm(this.agentStream).length / BYTES_PER_SAMPLE);
        if (this.agentStream.startMs !== null && startedSamples + lenSamples > sinceSamples) {
          resolve();
          return true;
        }
        return false;
      };
      if (check()) return;
      const interval = setInterval(() => {
        if (check()) clearInterval(interval);
      }, 200);
      setTimeout(() => {
        clearInterval(interval);
        reject(new Error(`timeout waiting for media_output after ${sinceMs}ms (within ${timeoutMs}ms)`));
      }, timeoutMs);
    });
  }

  /** End the call and flush artifacts. Returns the final mixed WAV path (if persistDir was set). */
  async close(): Promise<string | null> {
    if (this.micTimer) {
      clearInterval(this.micTimer);
      this.micTimer = null;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        // Some servers honor a stop event; if Cartesia doesn't, the close
        // below ends the stream cleanly anyway.
        this.ws.send(JSON.stringify({ event: 'stop', stream_id: this.streamId }));
      } catch {
        // ignore
      }
      this.ws.close();
    }
    if (!this.opts.persistDir) return null;
    return this.flushArtifacts(this.opts.persistDir);
  }

  /**
   * Render call.wav by placing user + agent streams at their start
   * timestamps in a shared buffer. Overlap (barge-in) sums; gaps are
   * silence. Per-stream concat is sequential — no per-chunk receive
   * jitter — so the only crackle source would be true overlap of the
   * two speakers.
   */
  private flushArtifacts(dir: string): string {
    fs.mkdirSync(dir, { recursive: true });

    const userPath = path.join(dir, 'user.wav');
    const agentPath = path.join(dir, 'agent.wav');
    const mixPath = path.join(dir, 'call.wav');
    const eventsPath = path.join(dir, 'cartesia-events.jsonl');

    const userPcm = streamToPcm(this.userStream);
    const agentPcm = streamToPcm(this.agentStream);
    const userOffset = streamOffsetSamples(this.userStream);
    const agentOffset = streamOffsetSamples(this.agentStream);
    const totalSamples = Math.max(
      userOffset + userPcm.length / BYTES_PER_SAMPLE,
      agentOffset + agentPcm.length / BYTES_PER_SAMPLE,
    );

    fs.writeFileSync(userPath, encodeWav(placeStream(userPcm, userOffset, totalSamples)));
    fs.writeFileSync(agentPath, encodeWav(placeStream(agentPcm, agentOffset, totalSamples)));
    fs.writeFileSync(
      mixPath,
      encodeWav(
        mixStreams(
          [
            { pcm: userPcm, offset: userOffset },
            { pcm: agentPcm, offset: agentOffset },
          ],
          totalSamples,
        ),
      ),
    );
    fs.writeFileSync(
      eventsPath,
      this.serverEvents.map((e) => JSON.stringify({ ts: e.ts, ...e.ev })).join('\n'),
    );
    return mixPath;
  }
}

/**
 * Append a raw PCM chunk to a stream:
 *   1. The first chunk anchors `startMs`.
 *   2. Subsequent chunks: compute the playback boundary of audio buffered
 *      so far (`startMs + bytesTotal/byteRate`). If the chunk arrives
 *      LATER than that boundary, insert silence to bridge the wall-clock
 *      gap. Otherwise (chunk arrived early or right on time), it's part
 *      of an ongoing burst — concat with no gap.
 *   3. Preserve s16le byte alignment via a carry buffer.
 *
 * The 50ms gap threshold avoids spurious silence on small jitter; gaps
 * smaller than that just snap together.
 *
 * Exported so unit tests can verify timing math without burning Cartesia.
 */
export function appendChunk(s: AudioStream, chunk: Buffer, arrivalTs: number): void {
  if (s.startMs === null) {
    s.startMs = arrivalTs;
  } else {
    const expectedEndMs = s.startMs + (s.bytesTotal / BYTE_RATE) * 1000;
    const gapMs = arrivalTs - expectedEndMs;
    if (gapMs > GAP_THRESHOLD_MS) {
      const silenceBytes = Math.floor((gapMs / 1000) * BYTE_RATE);
      // Round down to s16le sample boundary.
      const aligned = silenceBytes - (silenceBytes % BYTES_PER_SAMPLE);
      if (aligned > 0) {
        s.pcm.push(Buffer.alloc(aligned));
        s.bytesTotal += aligned;
      }
    }
  }
  const combined = Buffer.concat([s.carry, chunk]);
  const evenLen = combined.length - (combined.length % BYTES_PER_SAMPLE);
  if (evenLen > 0) {
    s.pcm.push(combined.subarray(0, evenLen));
    s.bytesTotal += evenLen;
  }
  s.carry = combined.subarray(evenLen);
}

function streamToPcm(s: AudioStream): Buffer {
  return Buffer.concat(s.pcm);
}

function streamOffsetSamples(s: AudioStream): number {
  return s.startMs == null ? 0 : Math.floor((s.startMs / 1000) * SAMPLE_RATE);
}

/** Place one PCM stream at a sample offset inside a totalSamples-long Int16 buffer. */
function placeStream(pcm: Buffer, offsetSamples: number, totalSamples: number): Int16Array {
  const out = new Int16Array(totalSamples);
  const len = Math.floor(pcm.length / BYTES_PER_SAMPLE);
  for (let i = 0; i < len; i++) {
    const dest = offsetSamples + i;
    if (dest >= totalSamples) break;
    out[dest] = pcm.readInt16LE(i * BYTES_PER_SAMPLE);
  }
  return out;
}

/** Sum multiple PCM streams at their respective offsets. */
function mixStreams(
  streams: Array<{ pcm: Buffer; offset: number }>,
  totalSamples: number,
): Int16Array {
  const out = new Int16Array(totalSamples);
  for (const s of streams) {
    const len = Math.floor(s.pcm.length / BYTES_PER_SAMPLE);
    for (let i = 0; i < len; i++) {
      const dest = s.offset + i;
      if (dest >= totalSamples) break;
      const sum = out[dest]! + s.pcm.readInt16LE(i * BYTES_PER_SAMPLE);
      out[dest] = Math.max(-32768, Math.min(32767, sum));
    }
  }
  return out;
}

// ────────────────────────────── WAV utilities ──────────────────────────────

/** Build a 44-byte WAV header + PCM body. Mono, 16-bit, SAMPLE_RATE Hz. */
function encodeWav(samples: Int16Array): Buffer {
  const byteLen = samples.length * BYTES_PER_SAMPLE;
  const buf = Buffer.alloc(44 + byteLen);
  // RIFF header
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + byteLen, 4);
  buf.write('WAVE', 8);
  // fmt chunk
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);              // chunk size
  buf.writeUInt16LE(1, 20);               // PCM
  buf.writeUInt16LE(1, 22);               // mono
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28); // byte rate
  buf.writeUInt16LE(BYTES_PER_SAMPLE, 32);                // block align
  buf.writeUInt16LE(16, 34);                              // bits per sample
  // data chunk
  buf.write('data', 36);
  buf.writeUInt32LE(byteLen, 40);
  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(samples[i]!, 44 + i * BYTES_PER_SAMPLE);
  }
  return buf;
}
