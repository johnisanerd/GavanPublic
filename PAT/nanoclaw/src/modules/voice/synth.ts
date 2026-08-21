// PAT: shared voice-memo synthesis. Cartesia Sonic TTS → temp audio file
// in the codec the target channel's native voice bubble requires.
//
// Extracted from signal.ts so multiple channels (Signal, Telegram, ...)
// share one TTS path instead of each re-implementing it. The ONLY
// per-channel difference is the output codec:
//   - 'm4a' (AAC)   → iOS Signal native voice-note bubble. signal-cli.
//   - 'ogg' (Opus)  → Telegram sendVoice native voice message.
//
// Cartesia returns mp3/wav/raw but not opus/aac directly, so we transcode
// with ffmpeg (already in the image). ~100ms per typical voice note.
//
// Returns the local path of a temp file, or null on any failure (auth
// missing, Cartesia 4xx, network, ffmpeg, write). Caller owns the
// tempfile lifecycle — unlink after the send completes.
import { execSync } from 'node:child_process';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { log } from '../../log.js';

// PAT canonical voice — same ID prod sets as CARTESIA_VOICE_ID and what
// Signal voice memos use, so Telegram/Signal/phone all speak in one voice.
// The env override is the source of truth; this default just guarantees we
// never silently fall back to a stranger's voice if the secret is unset.
const CARTESIA_DEFAULT_VOICE_ID = process.env.CARTESIA_VOICE_ID || 'dbfa416f-d5c3-4006-854b-235ef6bdf4fd';
const CARTESIA_VERSION = '2025-04-16';
const CARTESIA_TTS_MODEL = 'sonic-2';

export type VoiceFormat = 'm4a' | 'ogg';

// ffmpeg transcode args + file extension per target codec. Signal's iOS
// native bubble needs AAC/m4a; Telegram's sendVoice needs Opus-in-ogg
// (other containers get sent as a generic Audio/Document tile).
const FORMAT_SPEC: Record<VoiceFormat, { ext: string; codecArgs: string }> = {
  m4a: { ext: 'm4a', codecArgs: '-c:a aac -b:a 64k -ar 44100 -ac 1' },
  ogg: { ext: 'ogg', codecArgs: '-c:a libopus -b:a 32k -ar 48000 -ac 1' },
};

/**
 * Synthesize `text` to a temp audio file in the given codec.
 * @returns local temp path (caller unlinks), or null on any failure.
 */
export async function synthesizeVoiceMemo(
  text: string,
  voiceId: string | undefined,
  opts: { format: VoiceFormat },
): Promise<string | null> {
  const trimmed = text.trim();
  if (!trimmed) {
    log.warn('voice/synth: called with empty text');
    return null;
  }

  const cartesiaKey = process.env.CARTESIA_API_KEY;
  if (!cartesiaKey) {
    log.warn('voice/synth: CARTESIA_API_KEY not set, falling back to text');
    return null;
  }

  const spec = FORMAT_SPEC[opts.format];
  let mp3Path: string | null = null;
  let outPath: string | null = null;
  try {
    const body = {
      transcript: trimmed,
      model_id: CARTESIA_TTS_MODEL,
      voice: { mode: 'id', id: voiceId || CARTESIA_DEFAULT_VOICE_ID },
      // Smallest reasonable mp3 — speech-quality, ~64kbps. The codec
      // transcode that follows compresses further.
      output_format: { container: 'mp3', sample_rate: 24000, bit_rate: 64000 },
    };
    const res = await fetch('https://api.cartesia.ai/tts/bytes', {
      method: 'POST',
      headers: {
        'Cartesia-Version': CARTESIA_VERSION,
        'Content-Type': 'application/json',
        'X-API-Key': cartesiaKey,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '<unreadable>');
      log.warn('voice/synth: Cartesia TTS returned non-2xx', {
        status: res.status,
        body: errBody.slice(0, 500),
      });
      return null;
    }
    const arrayBuf = await res.arrayBuffer();
    if (arrayBuf.byteLength === 0) {
      log.warn('voice/synth: Cartesia TTS returned empty body');
      return null;
    }
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    mp3Path = join(tmpdir(), `pat-tts-${stamp}.mp3`);
    outPath = join(tmpdir(), `pat-tts-${stamp}.${spec.ext}`);
    writeFileSync(mp3Path, Buffer.from(arrayBuf));

    execSync(`ffmpeg -y -loglevel error -i "${mp3Path}" ${spec.codecArgs} "${outPath}"`, {
      stdio: 'ignore',
    });

    try {
      unlinkSync(mp3Path);
    } catch {
      /* best-effort */
    }
    return outPath;
  } catch (err) {
    log.warn('voice/synth: synthesis failed', { format: opts.format, err });
    for (const p of [mp3Path, outPath]) {
      if (p) {
        try {
          unlinkSync(p);
        } catch {
          /* best-effort */
        }
      }
    }
    return null;
  }
}
