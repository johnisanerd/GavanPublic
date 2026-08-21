// Pure-JS MPEG-TS → raw ADTS AAC remux. No ffmpeg, no native deps.
//
// Typeform stores voice answers on Mux as HLS (MPEG-TS segments carrying AAC in
// ADTS framing). To persist a single playable file we demux the TS, pull the
// audio elementary stream out of its PES packets, and concatenate the ADTS
// frames — yielding a valid `.aac` file that browsers play as `audio/aac`.
// Verified against real recordings (ffprobe: correct codec/rate/duration).

const TS_PACKET = 188;
const AAC_ADTS_STREAM_TYPE = 0x0f;

// Extract the AAC (ADTS) elementary stream from a concatenated MPEG-TS buffer.
export function tsToAac(buf: Buffer): Buffer {
  let pmtPid = -1;
  let audioPid = -1;
  const out: Buffer[] = [];

  for (let off = 0; off + TS_PACKET <= buf.length; off += TS_PACKET) {
    // Resync if we drift off a packet boundary (sync byte 0x47).
    if (buf[off] !== 0x47) {
      let k = off;
      while (k < buf.length && buf[k] !== 0x47) k++;
      off = k - TS_PACKET; // loop's += TS_PACKET lands us on k
      continue;
    }

    const pusi = (buf[off + 1] & 0x40) !== 0; // payload unit start indicator
    const pid = ((buf[off + 1] & 0x1f) << 8) | buf[off + 2];
    const afc = (buf[off + 3] >> 4) & 0x3; // adaptation field control

    let p = off + 4;
    if (afc === 2 || afc === 3) {
      const afLen = buf[off + 4];
      p = off + 5 + afLen; // skip adaptation field
    }
    if (afc === 2 || p >= off + TS_PACKET) continue; // no payload in this packet

    if (pid === 0) {
      // PAT — first program's PMT PID.
      let q = p;
      if (pusi) q += 1 + buf[p]; // pointer_field
      pmtPid = ((buf[q + 10] & 0x1f) << 8) | buf[q + 11];
    } else if (pid === pmtPid && pmtPid >= 0) {
      // PMT — find the AAC/ADTS elementary stream PID.
      let q = p;
      if (pusi) q += 1 + buf[p];
      const sectionLen = ((buf[q + 1] & 0x0f) << 8) | buf[q + 2];
      const programInfoLen = ((buf[q + 10] & 0x0f) << 8) | buf[q + 11];
      let es = q + 12 + programInfoLen;
      const end = q + 3 + sectionLen - 4; // minus CRC32
      while (es + 5 <= end) {
        const streamType = buf[es];
        const elemPid = ((buf[es + 1] & 0x1f) << 8) | buf[es + 2];
        const esInfoLen = ((buf[es + 3] & 0x0f) << 8) | buf[es + 4];
        if (streamType === AAC_ADTS_STREAM_TYPE) audioPid = elemPid;
        es += 5 + esInfoLen;
      }
    } else if (pid === audioPid && audioPid >= 0) {
      let q = p;
      if (pusi && buf[q] === 0 && buf[q + 1] === 0 && buf[q + 2] === 1) {
        // PES header: start_code(3) stream_id(1) length(2) flags(2) hdrLen(1)
        const hdrLen = buf[q + 8];
        q = q + 9 + hdrLen;
      }
      out.push(buf.subarray(q, off + TS_PACKET));
    }
  }

  return Buffer.concat(out);
}

// Fetch an HLS playback URL (Mux) and return the remuxed AAC bytes.
// playbackUrl is the master .m3u8 (tokenized). Best-effort: returns null on
// any failure so callers never break ingestion over a recording.
export async function remuxHlsToAac(playbackUrl: string): Promise<Buffer | null> {
  try {
    const master = await (await fetch(playbackUrl)).text();
    // master playlist → first variant media playlist
    const mediaUrl = master
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("http") && l.includes(".m3u8"));
    if (!mediaUrl) return null;

    const media = await (await fetch(mediaUrl)).text();
    const segUrls = media
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("http"));
    if (!segUrls.length) return null;

    // Fetch all segments concurrently (preserving order). Mux serves each
    // segment slowly enough that sequential fetches run at ~realtime — a 2-min
    // clip took ~2 min — which would blow the webhook's maxDuration. Parallel
    // fetches cut that to a few seconds.
    const segs = await Promise.all(
      segUrls.map(async (u) => {
        const r = await fetch(u);
        if (!r.ok) throw new Error(`segment ${r.status}`);
        return Buffer.from(await r.arrayBuffer());
      }),
    );
    const aac = tsToAac(Buffer.concat(segs));
    return aac.length ? aac : null;
  } catch {
    return null;
  }
}
