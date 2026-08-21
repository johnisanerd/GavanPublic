// PAT: shared inbound voice transcription via ElevenLabs Scribe.
//
// Scribe (`scribe_v1`) ingests OGG/Opus, M4A/AAC, MP3, WAV, webm directly
// via multipart form-data — so unlike the prior OpenRouter-Whisper path
// there's NO ffmpeg→WAV pre-transcode step for any channel. Telegram
// voice memos are OGG/Opus; Signal voice notes are AAC — both go straight
// in.
//
// Wire shape (verified empirically 2026-06-19):
//   POST https://api.elevenlabs.io/v1/speech-to-text
//   header: xi-api-key: <key>
//   multipart: model_id=scribe_v1, tag_audio_events=false, file=<audio>
//   → { text, language_code, language_probability, words[] }
//
// `tag_audio_events=false` suppresses non-speech tags like "(click)" /
// "(laughs)" that would otherwise pollute the transcript text.
//
// Host-side only: the nanoclaw host process is NOT proxied through the
// OneCLI gateway, so auth is the explicit ELEVENLABS_API_KEY env var
// (a Fly secret), not a vault entry.
//
// Returns the transcript string, or null on any failure (no key, 4xx,
// network, empty result) so callers can fall back to a placeholder.
import { log } from '../../log.js';

const SCRIBE_URL = 'https://api.elevenlabs.io/v1/speech-to-text';
const SCRIBE_MODEL = 'scribe_v1';

/** Pick a filename extension Scribe can sniff the codec from. */
function extForMime(mimeType: string | undefined): string {
  const m = (mimeType ?? '').toLowerCase();
  if (m.includes('ogg') || m.includes('opus')) return 'ogg';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('wav')) return 'wav';
  if (m.includes('webm')) return 'webm';
  return 'ogg';
}

/**
 * Transcribe audio bytes to text via ElevenLabs Scribe.
 * @returns transcript (trimmed) or null on any failure.
 */
export async function transcribeVoice(bytes: Buffer, opts: { mimeType?: string } = {}): Promise<string | null> {
  if (!bytes || bytes.byteLength === 0) {
    log.warn('voice/transcribe: empty audio buffer');
    return null;
  }

  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    log.warn('voice/transcribe: ELEVENLABS_API_KEY not set');
    return null;
  }

  try {
    const form = new FormData();
    form.append('model_id', SCRIBE_MODEL);
    form.append('tag_audio_events', 'false');
    form.append(
      'file',
      new Blob([bytes], { type: opts.mimeType || 'application/octet-stream' }),
      `voice.${extForMime(opts.mimeType)}`,
    );

    const res = await fetch(SCRIBE_URL, {
      method: 'POST',
      // Do NOT set Content-Type — fetch derives the multipart boundary.
      headers: { 'xi-api-key': key },
      body: form,
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '<unreadable>');
      log.warn('voice/transcribe: Scribe returned non-2xx', {
        status: res.status,
        body: errBody.slice(0, 500),
      });
      return null;
    }

    const json = (await res.json()) as { text?: string };
    const text = (json.text ?? '').trim();
    if (!text) {
      log.warn('voice/transcribe: Scribe returned empty text');
      return null;
    }
    return text;
  } catch (err) {
    log.warn('voice/transcribe: transcription failed', { err });
    return null;
  }
}
