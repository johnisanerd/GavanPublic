// Transcribe a Typeform voice answer with ElevenLabs Scribe.
// Typeform stores the recording on Mux (HLS); ElevenLabs accepts that HLS URL
// directly via `source_url`, so this is pure HTTP — no download/ffmpeg.
// Best-effort: returns null on any failure (caller leaves the answer untouched).
export async function transcribeTypeformAudio(
  audioUrl: string | null | undefined,
): Promise<string | null> {
  const el = process.env.ELEVENLABS_API_KEY;
  const tf = process.env.TYPEFORM_API_TOKEN;
  if (!el || !tf || !audioUrl) return null;

  // 1. resolve the Typeform media URL → a Mux playback (HLS) URL with a token
  const mediaRes = await fetch(audioUrl, { headers: { Authorization: `Bearer ${tf}` } });
  if (!mediaRes.ok) return null;
  const media = await mediaRes.json();
  const playbackUrl: string | undefined = media?.playback_url;
  if (!playbackUrl) return null;

  // 2. transcribe via ElevenLabs (it fetches the HLS source itself)
  const fd = new FormData();
  fd.append("model_id", "scribe_v1");
  fd.append("source_url", playbackUrl);
  fd.append("language_code", "en");
  const sttRes = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": el },
    body: fd,
  });
  if (!sttRes.ok) return null;
  const out = await sttRes.json();
  const text: string | undefined = out?.text;
  return text && text.trim() ? text.trim() : null;
}
