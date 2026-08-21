/**
 * PAT: dev-only TTS injector. Replaces the page's mic input with synthesized
 * speech via Cartesia REST, so console-driven and headless tests don't need
 * the speakers→mic acoustic loop.
 *
 * Enabled by `?simUserSay=1` (or `?simUserSay=<anything-truthy>`) on the URL.
 * Once installed:
 *
 *   simUserSay("hey PAT, what's the weather")
 *
 * The first call prompts for a Cartesia API key + voice id and stashes them
 * in localStorage. Subsequent calls reuse the stash. Override per-call via:
 *
 *   simUserSay("...", { key, voiceId, model, sampleRate })
 *
 * Patches `navigator.mediaDevices.getUserMedia` at install time. The avatar
 * mic mute toggle still gates `track.enabled`, so unmute in the UI before the
 * synthesized audio will actually reach Anam.
 *
 * Side-effect-only when invoked — no react integration. MUST run BEFORE the
 * Anam SDK (or anything else) calls getUserMedia.
 */

const KEY_STORAGE = 'simUserSayCartesiaKey';
const VOICE_STORAGE = 'simUserSayVoiceId';
const TAG = '[simUserSay]';

type SayOpts = {
  key?: string;
  voiceId?: string;
  model?: string;
  sampleRate?: number;
};

declare global {
  interface Window {
    __SIM_USER_SAY_INSTALLED__?: boolean;
    simUserSay?: (text: string, opts?: SayOpts) => Promise<void>;
  }
}

export function installSimUserSay(): void {
  if (typeof window === 'undefined') return;
  if (window.__SIM_USER_SAY_INSTALLED__) return;
  window.__SIM_USER_SAY_INSTALLED__ = true;

  const ac = new AudioContext();
  const dest = ac.createMediaStreamDestination();
  const fakeMic = dest.stream;

  const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
    navigator.mediaDevices,
  );
  navigator.mediaDevices.getUserMedia = async (
    constraints: MediaStreamConstraints,
  ): Promise<MediaStream> => {
    if (!constraints?.audio) return origGetUserMedia(constraints);
    if (constraints.video) {
      console.warn(
        `${TAG} ignoring video request — sim mode never opens the camera`,
      );
    }
    if (ac.state === 'suspended') ac.resume().catch(() => {});
    return fakeMic;
  };

  window.simUserSay = async (text, opts = {}) => {
    const key = resolveKey(opts.key);
    if (!key) throw new Error(`${TAG} no Cartesia key`);
    const voiceId = resolveVoice(opts.voiceId);
    if (!voiceId) throw new Error(`${TAG} no voice id`);

    const res = await fetch('https://api.cartesia.ai/tts/bytes', {
      method: 'POST',
      headers: {
        'X-API-Key': key,
        'Cartesia-Version': '2024-06-10',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model_id: opts.model ?? 'sonic-2',
        transcript: text,
        voice: { mode: 'id', id: voiceId },
        output_format: {
          container: 'wav',
          encoding: 'pcm_s16le',
          sample_rate: opts.sampleRate ?? 16000,
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`${TAG} cartesia ${res.status}: ${body}`);
    }
    if (ac.state === 'suspended') await ac.resume();
    const buf = await ac.decodeAudioData(await res.arrayBuffer());
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.connect(dest);
    src.start();
    await new Promise<void>((r) => src.addEventListener('ended', () => r()));
  };

  console.log(
    `${TAG} installed. Call simUserSay("text") in the console. Unmute the avatar mic before the audio will reach Anam.`,
  );
}

function resolveKey(override?: string): string | null {
  if (override) return override;
  const cached = localStorage.getItem(KEY_STORAGE);
  if (cached) return cached;
  const entered = window.prompt('Cartesia API key (stored in localStorage):');
  if (entered) {
    localStorage.setItem(KEY_STORAGE, entered);
    return entered;
  }
  return null;
}

function resolveVoice(override?: string): string | null {
  if (override) return override;
  const cached = localStorage.getItem(VOICE_STORAGE);
  if (cached) return cached;
  const entered = window.prompt('Cartesia voice id (stored in localStorage):');
  if (entered) {
    localStorage.setItem(VOICE_STORAGE, entered);
    return entered;
  }
  return null;
}
