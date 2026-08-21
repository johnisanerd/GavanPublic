/**
 * VoiceBlob — voice-reactive SVG blob shown in place of the avatar
 * canvas when the user picks the 'voice' avatar mode.
 *
 * Pipeline:
 *   1. Find the hidden <video> Anam streams into (by id).
 *   2. Pull its srcObject MediaStream's first audio track.
 *   3. Pipe through a Web Audio AnalyserNode (read-only — the analyser
 *      is NOT connected to ctx.destination, so the avatar's audio
 *      still plays through the <video>'s implicit audio output and
 *      we don't double it).
 *   4. On every frame, derive an overall RMS amplitude + a low-band
 *      and high-band amplitude from the frequency data.
 *   5. Rebuild an N-point SVG path around a unit circle where each
 *      point's radius wobbles with a per-point sine offset (so the
 *      blob has organic character even in silence) plus an audio-
 *      amplitude term (so it visibly reacts to speech). Two concentric
 *      paths — an inner gradient-filled blob and an outer stroked
 *      halo with Gaussian blur — sell the "pulsing light" feel
 *      without depending on the actual frequency spectrum.
 *
 * Deliberately abstract: this isn't a literal waveform — it's a
 * voice-presence visualization. The user asked for "live animated
 * waveform but just abstract not precise frequency", which I read as
 * "looks alive, modulates with voice, doesn't have to be a spectrum
 * analyser".
 */
import { useEffect, useRef } from 'react';

interface VoiceBlobProps {
  /** id of the hidden <video> in AvatarCanvas. We attach Web Audio
   *  to its srcObject's audio track. */
  videoElementId: string;
  /** Render is gated by the parent; this prop is the live signal we
   *  use to start/stop the audio + animation pipelines. Mounting
   *  with `visible=false` is harmless (returns null). */
  visible: boolean;
}

/** Number of points around each blob. The path is built as a closed
 *  Catmull-Rom spline through these points, so even at low N the
 *  result reads as smooth (no polygon faceting). 48 leaves headroom
 *  for high-frequency wobble without ever looking facet-y. */
const N_POINTS = 48;

/** Per-blob parameter set. Two seeds animate slightly out of phase
 *  with different period multipliers, so the pair never aligns into
 *  visible symmetry — exactly the "organic overlap" feel.
 *
 *  - baseR / radialOffset: drives the base size and how far this
 *    blob's center pushes from the SVG origin. Both stay near 0
 *    here so the blobs share a centre but small offsets break the
 *    perfect-circle alignment.
 *  - ampSwell: how much audio amplitude expands the blob.
 *  - idleAmp / breathePeriod: silent-state pulse.
 *  - wobblePeriods / wobbleOffsets: prime-ish multipliers so the
 *    per-point sines don't resolve into a low-order symmetry.
 *  - phase: time offset, so the two blobs aren't lockstep.
 *  - fillStop0 / fillStop1 / strokeColor / haloColor: per-blob
 *    palette — both warm, hue offset by ~25° for a "twin flame"
 *    look without clashing.
 */
interface BlobSeed {
  baseR: number;
  /** Centre offset within the SVG viewBox. Two seeds sit slightly
   *  apart so the rest-state silhouette reads as "two wonky circles
   *  almost overlapping" instead of perfectly concentric. */
  cx: number;
  cy: number;
  /** Audio amplitude → arm growth. Higher = arms swing further out
   *  when there's signal in the spectrum. */
  ampSwell: number;
  /** Global breathing pulse amplitude. Single sine over the whole
   *  blob, not per-point, so the rest state breathes uniformly
   *  rather than spinning. */
  idleAmp: number;
  breathePeriod: number;
  /** Static per-point distortion at rest — no time term, so the
   *  silhouette is "wonky but still". staticWonkLobes controls how
   *  many gentle lobes the static distortion contributes. */
  staticWonkAmp: number;
  staticWonkLobes: number;
  staticWonkPhase: number;
  /** Audio-driven arm pattern. `armLobes` sets the spatial frequency
   *  (≈ number of arms when amp = 1). `armRotRate` is the slow
   *  time-driven phase shift that rotates the arm angles around the
   *  blob — small (≈0.2 rad/s) so the arms drift slowly. */
  armLobes: number;
  armRotRate: number;
  phase: number;
  fillColor: string;
  strokeColor: string;
  haloColor: string;
  haloOpacity: number;
}

// Rest state: two slightly wonky teal circles, centres offset by a
// few units so they almost overlap. The only motion is a slow global
// breathe + permanent static lobes — no "spinning" wobble.
//
// When audio arrives: the audio term wakes up and the arms grow in a
// pattern that itself slowly rotates (armRotRate, ±0.2 rad/s). B
// rotates the opposite direction from A so the pair reads as two
// independent organisms instead of one rotating clump.
const SEED_A: BlobSeed = {
  baseR: 50,
  cx: -3,
  cy: 2,
  ampSwell: 17,
  idleAmp: 2.5,
  breathePeriod: 0.55,
  staticWonkAmp: 2.0,
  staticWonkLobes: 3,
  staticWonkPhase: 0.3,
  armLobes: 4,
  armRotRate: 0.22,
  phase: 0,
  // Palette mirrors the observatory's "agent voice" colour token
  // (front-mind cyan candle, hue 190). Slightly darker than the
  // bright candle so the blob has body; alpha pushed high so the
  // shape reads as solid rather than ghostly.
  fillColor: 'oklch(0.78 0.13 190 / 0.78)',
  strokeColor: 'oklch(0.92 0.10 190 / 0.55)',
  haloColor: 'oklch(0.78 0.13 190 / 0.45)',
  haloOpacity: 1,
};

const SEED_B: BlobSeed = {
  baseR: 46,
  cx: 4,
  cy: -1,
  ampSwell: 20,
  idleAmp: 1.8,
  breathePeriod: 0.42,
  staticWonkAmp: 2.3,
  staticWonkLobes: 2,
  staticWonkPhase: 1.2,
  armLobes: 5,
  armRotRate: -0.18,
  phase: Math.PI / 2.4,
  // Palette mirrors the observatory's "user voice" colour token
  // (back-mind azure candle, hue 255). Sits under screen-blend so
  // the overlap with seed A produces a luminous bright core.
  fillColor: 'oklch(0.72 0.14 255 / 0.62)',
  strokeColor: 'oklch(0.85 0.11 255 / 0.45)',
  haloColor: 'oklch(0.72 0.14 255 / 0.38)',
  haloOpacity: 0.9,
};

/** Build a closed smooth path through N points using Catmull-Rom →
 *  cubic Bézier conversion (tension 0.5 / "centripetal-ish"). Avoids
 *  the polygonal look of straight-line segments at the same N. */
function buildSmoothPath(pts: { x: number; y: number }[]): string {
  const n = pts.length;
  if (n < 3) return '';
  let d = `M${pts[0]!.x.toFixed(2)},${pts[0]!.y.toFixed(2)}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n]!;
    const p1 = pts[i]!;
    const p2 = pts[(i + 1) % n]!;
    const p3 = pts[(i + 2) % n]!;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += `C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`;
  }
  d += 'Z';
  return d;
}

/** Compute the radial points for one blob at time `t` with smoothed
 *  audio amplitude `amp`. Returned points feed straight into
 *  `buildSmoothPath`. Halo radius offset is passed separately so the
 *  inner + outer share their wobble.
 *
 *  Radius decomposition (rest → speech):
 *    baseR + breathe(t)             // slow global pulse, no spin
 *           + staticWonk(i)         // permanent gentle deformation
 *           + audioArms(t, i, amp)  // arms ONLY when amp > 0,
 *                                      angle slowly rotates over time
 *
 *  The arm term is scaled directly by amplitude so the blob is
 *  near-circular in silence and arms grow outward as speech arrives.
 *  Replacing the previous per-point time-driven wobble with a single
 *  rotating arm pattern is what kills the "spinny at rest" feel. */
function buildBlobPoints(
  seed: BlobSeed,
  t: number,
  amp: number,
  radiusBump = 0,
): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  const ts = t + seed.phase;
  // Global breathing pulse — uniform around the blob.
  const breathe = seed.idleAmp * Math.sin(ts * seed.breathePeriod);
  // Spatial frequency that produces `staticWonkLobes` full cycles
  // around the circle. Precomputed once per frame.
  const wonkK = (seed.staticWonkLobes * Math.PI * 2) / N_POINTS;
  // Same for the audio arm pattern, plus a slow time rotation so the
  // arms drift around the silhouette as the blob talks.
  const armK = (seed.armLobes * Math.PI * 2) / N_POINTS;
  const armPhase = ts * seed.armRotRate;
  for (let i = 0; i < N_POINTS; i++) {
    const a = (i / N_POINTS) * Math.PI * 2;
    const staticWonk = seed.staticWonkAmp * Math.sin(i * wonkK + seed.staticWonkPhase);
    const audioArms = amp * seed.ampSwell * Math.sin(armPhase + i * armK);
    const r = seed.baseR + breathe + staticWonk + audioArms + radiusBump;
    out.push({
      x: seed.cx + Math.cos(a) * r,
      y: seed.cy + Math.sin(a) * r,
    });
  }
  return out;
}

interface BlobRefs {
  innerPath: SVGPathElement | null;
  outerPath: SVGPathElement | null;
}

export function VoiceBlob({ videoElementId, visible }: VoiceBlobProps) {
  // One pair of refs per blob seed so we can mutate paths imperatively
  // without re-rendering React for every animation frame.
  const refsA = useRef<BlobRefs>({ innerPath: null, outerPath: null });
  const refsB = useRef<BlobRefs>({ innerPath: null, outerPath: null });
  // Hold all the per-frame state we need to clean up.
  const rafRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);

  useEffect(() => {
    if (!visible) return;

    const video = document.getElementById(videoElementId) as HTMLVideoElement | null;
    if (!video) return;

    let cancelled = false;
    let setupRaf: number | null = null;
    let lastAmp = 0; // low-pass smoothed amplitude for a softer reaction

    /** Try to wire the analyser. The video's srcObject is set by
     *  Anam asynchronously, so on first mount it's usually null;
     *  poll on RAF until it appears. Gives up silently if the user
     *  flips back to a non-voice mode before the stream arrives. */
    const trySetup = (): void => {
      if (cancelled) return;
      const stream = video.srcObject as MediaStream | null;
      const tracks = stream?.getAudioTracks() ?? [];
      if (!stream || tracks.length === 0) {
        setupRaf = requestAnimationFrame(trySetup);
        return;
      }
      try {
        // Some browsers gate AudioContext creation behind a user
        // gesture. The session-start click satisfies that — by the
        // time the video has a stream the user has already gestured.
        const Ctx: typeof AudioContext =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext!;
        const ctx = new Ctx();
        // Resume in case the policy starts the context suspended.
        ctx.resume().catch(() => {
          /* harmless: some browsers reject without a gesture */
        });
        // Wrap the single audio track in its own MediaStream so the
        // source node doesn't also try to tap the video track.
        const src = ctx.createMediaStreamSource(new MediaStream([tracks[0]!]));
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.7;
        src.connect(analyser);
        // Intentionally NOT connecting analyser → ctx.destination.
        // The <video> element already plays the audio; piping again
        // through Web Audio would double it.
        audioCtxRef.current = ctx;
        sourceRef.current = src;
        analyserRef.current = analyser;

        const data = new Uint8Array(analyser.frequencyBinCount);
        const start = performance.now();

        const tick = (now: number): void => {
          if (cancelled) return;
          analyser.getByteFrequencyData(data);
          // RMS amplitude across the spectrum, 0..1.
          let sum = 0;
          for (let i = 0; i < data.length; i++) sum += data[i]! * data[i]!;
          const rms = Math.sqrt(sum / data.length) / 255;
          // Low-pass smoothing so step changes don't make the blob jitter.
          lastAmp = lastAmp * 0.7 + rms * 0.3;

          const t = (now - start) / 1000;
          // Two blobs. Each renders an inner gradient-filled body and
          // an outer halo (same shape, +6 radius bump, blurred via
          // filter). They share the same time / amplitude inputs but
          // each seed has its own period multipliers + phase offset
          // so the pair never aligns into an obvious symmetry — the
          // organic-overlap feel the user asked for.
          const ptsAInner = buildBlobPoints(SEED_A, t, lastAmp, 0);
          const ptsAOuter = buildBlobPoints(SEED_A, t, lastAmp, 6);
          const ptsBInner = buildBlobPoints(SEED_B, t, lastAmp, 0);
          const ptsBOuter = buildBlobPoints(SEED_B, t, lastAmp, 6);
          const innerA = buildSmoothPath(ptsAInner);
          const outerA = buildSmoothPath(ptsAOuter);
          const innerB = buildSmoothPath(ptsBInner);
          const outerB = buildSmoothPath(ptsBOuter);
          if (refsA.current.innerPath) refsA.current.innerPath.setAttribute('d', innerA);
          if (refsA.current.outerPath) refsA.current.outerPath.setAttribute('d', outerA);
          if (refsB.current.innerPath) refsB.current.innerPath.setAttribute('d', innerB);
          if (refsB.current.outerPath) refsB.current.outerPath.setAttribute('d', outerB);
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch (err) {
        console.warn('[voice-blob] audio setup failed', err);
      }
    };
    trySetup();

    return () => {
      cancelled = true;
      if (setupRaf != null) cancelAnimationFrame(setupRaf);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      try {
        sourceRef.current?.disconnect();
      } catch {
        /* ignore */
      }
      try {
        audioCtxRef.current?.close();
      } catch {
        /* ignore */
      }
      sourceRef.current = null;
      analyserRef.current = null;
      audioCtxRef.current = null;
    };
  }, [videoElementId, visible]);

  if (!visible) return null;
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <svg
        viewBox="-100 -100 200 200"
        // 60vmin = 60% of the smaller viewport dimension; caps so the
        // blob doesn't get absurdly large on ultrawide displays.
        style={{ width: '60vmin', height: '60vmin', maxWidth: 640, maxHeight: 640 }}
        aria-hidden
      >
        <defs>
          <filter id="voice-blob-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="4" />
          </filter>
        </defs>
        {/* Two blobs stacked. Solid teal fills (very slight
            transparency — see seed alpha) rather than radial
            gradients, so the silhouette reads as a deliberate shape
            and the arms have visible mass. Group B uses
            mix-blend-mode: screen so the overlap brightens into a
            luminous core instead of just double-stacking alpha. */}
        <g>
          <path
            ref={(el) => { refsA.current.outerPath = el; }}
            fill="none"
            stroke={SEED_A.haloColor}
            strokeWidth="1.4"
            filter="url(#voice-blob-glow)"
            opacity={SEED_A.haloOpacity}
          />
          <path
            ref={(el) => { refsA.current.innerPath = el; }}
            fill={SEED_A.fillColor}
            stroke={SEED_A.strokeColor}
            strokeWidth="0.6"
          />
        </g>
        <g style={{ mixBlendMode: 'screen' }}>
          <path
            ref={(el) => { refsB.current.outerPath = el; }}
            fill="none"
            stroke={SEED_B.haloColor}
            strokeWidth="1.2"
            filter="url(#voice-blob-glow)"
            opacity={SEED_B.haloOpacity}
          />
          <path
            ref={(el) => { refsB.current.innerPath = el; }}
            fill={SEED_B.fillColor}
            stroke={SEED_B.strokeColor}
            strokeWidth="0.5"
          />
        </g>
      </svg>
    </div>
  );
}
