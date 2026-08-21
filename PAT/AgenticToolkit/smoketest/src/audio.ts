/**
 * Audio mode — opt-in Cartesia TTS → STT round-trip for the simulated user's
 * turns.
 *
 * The text-only smoke posts the user's literal sentence to /inbound. In
 * audio mode we synthesize that sentence with Cartesia TTS, then transcribe
 * the audio with Cartesia STT, and post the resulting transcript instead.
 * That mirrors what the real pipeline gets after Cartesia's PSTN STT runs
 * on a phone caller — minus telephony noise.
 *
 * Why this is useful: STT introduces real-world disfluencies (homophones,
 * dropped words, capitalization shifts). Architecturally-correct text turns
 * may behave differently when they hit the agent as STT artifacts. Running
 * `--audio` on `baseline` should still pass; failures are bugs that text
 * mode would never have caught.
 *
 * Gated on CARTESIA_API_KEY. If the key isn't set, audio mode silently
 * disables and the harness uses raw text. (Inverse policy from the rest of
 * the harness — keys-required things are usually fatal — but here we want
 * scenarios to remain runnable without Cartesia in dev environments.)
 *
 * Each round-trip writes two artifacts under the scenario's output dir:
 *   - audio/<turn-N>.wav      — what the user "spoke"
 *   - audio/<turn-N>.json     — { text, transcript, latencyMs }
 */
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_VOICE_ID = process.env.CARTESIA_TTS_VOICE_ID ?? '694f9389-aac1-45b6-b726-9d9369183238'; // Cartesia's "barbershop man" — neutral male, well-tested
const DEFAULT_TTS_MODEL = process.env.CARTESIA_TTS_MODEL ?? 'sonic-2';
const DEFAULT_STT_MODEL = process.env.CARTESIA_STT_MODEL ?? 'ink-whisper';

export interface AudioRoundTripResult {
  /** What we asked TTS to say. */
  inputText: string;
  /** What STT returned after the round-trip. May differ slightly from inputText. */
  transcribedText: string;
  /** End-to-end latency in ms (TTS request + STT request, sequential). */
  latencyMs: number;
  /** WAV file location, if persistArtifactDir was supplied. */
  audioPath?: string;
}

export interface AudioOptions {
  /** Cartesia API key. Defaults to process.env.CARTESIA_API_KEY. */
  apiKey?: string;
  /** Voice id to TTS into (defaults to Cartesia's neutral voice). */
  voiceId?: string;
  /** Where to drop audio + json artifacts. Pass null/undefined to skip persisting. */
  persistDir?: string;
  /** Turn index for filenames; the runner keeps a counter. */
  turnIndex?: number;
}

/**
 * Returns null if Cartesia isn't available — caller should fall back to text.
 */
export function audioModeAvailable(opts: AudioOptions = {}): boolean {
  return Boolean(opts.apiKey ?? process.env.CARTESIA_API_KEY);
}

/**
 * Round-trip text through Cartesia TTS+STT. WAV is written to disk if
 * persistDir is supplied. Throws on Cartesia API errors so callers can
 * decide whether to abort the scenario or fall back to text.
 */
export async function roundTrip(text: string, opts: AudioOptions = {}): Promise<AudioRoundTripResult> {
  const apiKey = opts.apiKey ?? process.env.CARTESIA_API_KEY;
  if (!apiKey) {
    throw new Error('CARTESIA_API_KEY not set; audio mode unavailable');
  }
  // Lazy import so the SDK only loads when audio mode is actually used.
  const { Cartesia } = await import('@cartesia/cartesia-js');
  const client = new Cartesia({ apiKey });

  const sampleRate = 16000;
  const start = Date.now();

  // 1. TTS — generate WAV bytes.
  const ttsResp = await client.tts.generate({
    model_id: DEFAULT_TTS_MODEL,
    transcript: text,
    voice: { mode: 'id', id: opts.voiceId ?? DEFAULT_VOICE_ID },
    language: 'en',
    output_format: {
      container: 'wav',
      encoding: 'pcm_s16le',
      sample_rate: sampleRate,
    },
  } as Parameters<typeof client.tts.generate>[0]);

  const audioBuf = Buffer.from(await ttsResp.arrayBuffer());

  // 2. Persist WAV + metadata, if requested.
  let audioPath: string | undefined;
  if (opts.persistDir) {
    const audioDir = path.join(opts.persistDir, 'audio');
    fs.mkdirSync(audioDir, { recursive: true });
    const idx = String(opts.turnIndex ?? 0).padStart(3, '0');
    audioPath = path.join(audioDir, `turn-${idx}.wav`);
    fs.writeFileSync(audioPath, audioBuf);
  }

  // 3. STT — transcribe the audio back to text.
  // The SDK's stt.transcribe accepts a `file` param of `Uploadable`, which
  // includes Blob. We construct a Blob from the buffer.
  const blob = new Blob([new Uint8Array(audioBuf)], { type: 'audio/wav' });
  // The SDK's `Uploadable` type accepts Blob; cast to skip a noisy named-export check.
  const sttResp = await client.stt.transcribe({
    model: DEFAULT_STT_MODEL,
    language: 'en',
    encoding: 'pcm_s16le',
    sample_rate: sampleRate,
    file: blob as unknown as Parameters<typeof client.stt.transcribe>[0]['file'],
  });

  const latencyMs = Date.now() - start;
  const transcribedText = sttResp.text ?? '';

  // 4. Persist the JSON sidecar.
  if (opts.persistDir && audioPath) {
    fs.writeFileSync(
      audioPath.replace(/\.wav$/, '.json'),
      JSON.stringify({ inputText: text, transcribedText, latencyMs }, null, 2),
    );
  }

  return { inputText: text, transcribedText, latencyMs, audioPath };
}
