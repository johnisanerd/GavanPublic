import { useEffect, useRef } from 'react';

export interface VignetteParams {
  enabled: boolean;
  /** Aspect ratio of the visible safe zone, e.g. [9,16] portrait. */
  aspect: [number, number];
  /** 0..1 — radius where the fade starts (still fully transparent). */
  inner: number;
  /** 0..1+ — radius where the fade ends (fully black). */
  outer: number;
  /** Superellipse power: 2 = ellipse, 4 = squircle, large = rectangle. */
  power: number;
  /** Apply 4×4 Bayer dither to break gradient banding on 8-bit displays. */
  dither: boolean;
  /** Overall darkness multiplier — 1 = full black at edges, 0.7 = subtler. */
  intensity: number;
  /** Vertical center offset in canvas-height units. -0.5 = top edge,
   *  0 = centered, +0.5 = bottom. Useful when the avatar's head sits
   *  high or low in the frame and the safe zone should follow. */
  offsetY: number;
}

export const DEFAULT_VIGNETTE_PARAMS: VignetteParams = {
  enabled: true,
  aspect: [9, 16],
  inner: 0.78,
  outer: 1.25,
  power: 3.5,
  dither: true,
  intensity: 1.0,
  offsetY: 0,
};

/**
 * Vignette as a top layer — paints black with graduated alpha over
 * whatever's behind it (avatar canvas + background HTML). For a
 * projection setup, "black" reads as "no light," which is exactly
 * what a vignette wants to do.
 *
 * Costs are static: we re-paint only when params or canvas size
 * change, never per-frame. The shader-driven avatar continues to run
 * its RAF underneath untouched.
 */
const BAYER_4 = [
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
];

export function VignetteOverlay({ params }: { params: VignetteParams }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const paramsRef = useRef(params);
  paramsRef.current = params;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: false });
    if (!ctx) return;

    const paint = () => {
      const p = paramsRef.current;
      const dpr = window.devicePixelRatio || 1;
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      const w = Math.max(1, Math.floor(cssW * dpr));
      const h = Math.max(1, Math.floor(cssH * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }

      if (!p.enabled) {
        ctx.clearRect(0, 0, w, h);
        return;
      }

      const img = ctx.createImageData(w, h);
      const data = img.data;

      // Aspect normalization: a portrait safe zone makes the vertical
      // dimension larger in safe-zone units, so the radius is
      // calculated in a stretched coordinate system.
      const aMax = Math.max(p.aspect[0], p.aspect[1]);
      const ax = p.aspect[0] / aMax;
      const ay = p.aspect[1] / aMax;
      const pow = Math.max(1.0, p.power);
      const inner = p.inner;
      const outer = Math.max(p.outer, p.inner + 0.001);
      const intensity = Math.max(0, Math.min(1, p.intensity));
      const cy = 0.5 + p.offsetY;

      for (let y = 0; y < h; y++) {
        const ny = (y / h - cy) / (0.5 * ay);
        for (let x = 0; x < w; x++) {
          const nx = (x / w - 0.5) / (0.5 * ax);
          const r = Math.pow(
            Math.pow(Math.abs(nx), pow) + Math.pow(Math.abs(ny), pow),
            1.0 / pow,
          );

          // smoothstep(inner, outer, r)
          let t = (r - inner) / (outer - inner);
          if (t < 0) t = 0;
          else if (t > 1) t = 1;
          else t = t * t * (3 - 2 * t);

          let alpha = t * intensity * 255;

          if (p.dither && alpha > 0 && alpha < 255) {
            // Bayer threshold matrix sized to physical pixels. ±0.5
            // jitter / 1.0 = ±0.5 of an 8-bit alpha step.
            const bx = x & 3;
            const by = y & 3;
            const thr = BAYER_4[(by << 2) | bx]! / 16 - 0.5;
            alpha += thr;
            if (alpha < 0) alpha = 0;
            else if (alpha > 255) alpha = 255;
          }

          const i = (y * w + x) * 4;
          data[i] = 0;
          data[i + 1] = 0;
          data[i + 2] = 0;
          data[i + 3] = alpha | 0;
        }
      }

      ctx.putImageData(img, 0, 0);
    };

    paint();

    const ro = new ResizeObserver(() => paint());
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [
    params.enabled,
    params.aspect[0],
    params.aspect[1],
    params.inner,
    params.outer,
    params.power,
    params.dither,
    params.intensity,
    params.offsetY,
  ]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full"
    />
  );
}
