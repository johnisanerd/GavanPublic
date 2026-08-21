import { put } from "@vercel/blob";
import { remuxHlsToAac } from "./remux";

export interface PersistedRecording {
  blobUrl: string;
  blobPathname: string;
  contentType: string;
  byteSize: number;
  durationSeconds: number | null;
}

// Resolve a Typeform voice answer's media URL → remux the HLS to a single AAC
// file → store it as a PRIVATE Vercel Blob. Returns the metadata to record in
// the voice_recording table. Best-effort: returns null on any failure so a
// recording problem never breaks ingestion (we still keep the transcript).
export async function persistVoiceRecording(
  audioUrl: string,
  opts: { responseId: string; fieldRef: string },
): Promise<PersistedRecording | null> {
  const tf = process.env.TYPEFORM_API_TOKEN;
  if (!tf || !process.env.BLOB_READ_WRITE_TOKEN) return null;

  // Typeform media endpoint → Mux HLS playback URL + duration.
  const mediaRes = await fetch(audioUrl, { headers: { Authorization: `Bearer ${tf}` } });
  if (!mediaRes.ok) return null;
  const media = await mediaRes.json();
  const playbackUrl: string | undefined = media?.playback_url;
  const durationSeconds: number | null =
    typeof media?.duration_seconds === "number" ? Math.round(media.duration_seconds) : null;
  if (!playbackUrl) return null;

  const aac = await remuxHlsToAac(playbackUrl);
  if (!aac || !aac.length) return null;

  // Private store → URL is useless without BLOB_READ_WRITE_TOKEN. Random suffix
  // for defense in depth. Pathname groups by response for easy auditing.
  const blob = await put(`voice/${opts.responseId}/${opts.fieldRef}.aac`, aac, {
    access: "private",
    addRandomSuffix: true,
    contentType: "audio/aac",
  });

  return {
    blobUrl: blob.url,
    blobPathname: blob.pathname,
    contentType: "audio/aac",
    byteSize: aac.length,
    durationSeconds,
  };
}
