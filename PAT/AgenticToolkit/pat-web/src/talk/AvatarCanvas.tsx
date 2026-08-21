import { useEffect, useRef } from 'react';
import { ChromaVignetteRenderer, type ShaderParams } from './shader/renderer';

interface AvatarCanvasProps {
  /** Stable id for the hidden <video> that Anam streams into. */
  videoElementId: string;
  /** Path to the stand-in still image (used when params.standIn = true). */
  standInSrc: string;
  /** Shader controls. Updated live without re-mounting. */
  params: ShaderParams;
  /** Per-kiosk framing: CSS scale factor on the rendered canvas. 1 = no
   *  change. Source = URL `?zoom=` query param (read once at App.tsx
   *  mount). Applied to the wrapper div so overlays / vignette /
   *  control bar (mounted as sibling z-layers in App.tsx) are NOT
   *  affected — only the visible avatar pixels. */
  zoom?: number;
  /** Per-kiosk framing: vertical pixel shift after zoom (positive =
   *  down, negative = up). Source = URL `?offsetY=` query param.
   *  Same scope as `zoom` — only the canvas layer. */
  offsetY?: number;
}

/**
 * Three-element stack: a hidden <video> Anam streams into, a hidden
 * <img> for stand-in mode, and a WebGL2 canvas that pulls frames from
 * whichever source the params point at. The hidden elements never
 * display — we siphon their pixels into a texture and draw through
 * the shader.
 *
 * The hidden video lives ONCE per session lifecycle so its `id` is
 * stable for `client.streamToVideoElement(id)`.
 */
export function AvatarCanvas({
  videoElementId,
  standInSrc,
  params,
  zoom = 1,
  offsetY = 0,
}: AvatarCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const rendererRef = useRef<ChromaVignetteRenderer | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    const image = imageRef.current;
    if (!canvas || !video) return;

    const r = new ChromaVignetteRenderer(canvas, video);
    r.setImageSource(image);
    rendererRef.current = r;
    r.setParams(params);
    r.start();
    return () => {
      r.dispose();
      rendererRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push updated params on every render without rebuilding the renderer.
  useEffect(() => {
    rendererRef.current?.setParams(params);
  }, [params]);

  // PAT: per-kiosk framing transform. Skip the inline style entirely
  // when defaults are in effect so we don't introduce a stacking
  // context / composited layer on deployments that don't use this.
  const framingTransform =
    zoom !== 1 || offsetY !== 0
      ? `scale(${zoom}) translateY(${offsetY}px)`
      : undefined;
  return (
    <div
      className="pointer-events-none absolute inset-0 h-full w-full"
      style={
        framingTransform
          ? { transform: framingTransform, transformOrigin: 'center' }
          : undefined
      }
    >
      <video
        ref={videoRef}
        id={videoElementId}
        autoPlay
        playsInline
        muted={false}
        style={{
          position: 'absolute',
          left: '-99999px',
          top: '-99999px',
          width: 1,
          height: 1,
          opacity: 0,
        }}
      />
      <img
        ref={imageRef}
        src={standInSrc}
        alt=""
        crossOrigin="anonymous"
        style={{
          position: 'absolute',
          left: '-99999px',
          top: '-99999px',
          width: 1,
          height: 1,
          opacity: 0,
        }}
      />
      <canvas
        ref={canvasRef}
        className="block h-full w-full"
        style={{ background: 'transparent' }}
      />
    </div>
  );
}
