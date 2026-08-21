import type { OverlayPreset } from './lib/overlay-presets';

interface OverlayLayerProps {
  preset: OverlayPreset;
}

/**
 * Foreground effect layer that sits ABOVE the avatar but BELOW the
 * vignette. Use it for ambient grounding — scanlines, light leak,
 * sparse code rain drifting "in front of" the face. The vignette
 * still darkens the corners of whatever this layer paints.
 *
 * v0 surfaces three CSS-only effects + an off mode. A canvas-based
 * sparse code-rain (matched to BackgroundLayer.EventsRain but with
 * mix-blend-mode: lighten and lower density) is a TODO — file a
 * follow-up once we've watched the v0 on real projection hardware.
 */
export function OverlayLayer({ preset }: OverlayLayerProps) {
  if (preset.kind === 'off') return null;

  const baseStyle: React.CSSProperties = {
    opacity: preset.opacity,
    pointerEvents: 'none',
    mixBlendMode: preset.kind === 'light-leak' ? 'screen' : 'normal',
  };

  if (preset.kind === 'scanlines') {
    return (
      <div
        className="absolute inset-0"
        style={{
          ...baseStyle,
          background:
            'repeating-linear-gradient(0deg, oklch(0 0 0 / 0.5) 0px, oklch(0 0 0 / 0.5) 1px, transparent 1px, transparent 3px)',
        }}
      />
    );
  }

  if (preset.kind === 'light-leak') {
    return (
      <div
        className="absolute inset-0"
        style={{
          ...baseStyle,
          background:
            'radial-gradient(circle at 18% 12%, oklch(0.85 0.16 65 / 0.55) 0%, transparent 35%), radial-gradient(circle at 82% 88%, oklch(0.78 0.14 240 / 0.45) 0%, transparent 40%)',
        }}
      />
    );
  }

  // 'code-rain' — placeholder while the canvas implementation is being
  // ported from BackgroundLayer.EventsRain at lower density.
  return (
    <div
      className="absolute inset-0"
      style={{
        ...baseStyle,
        background:
          'repeating-linear-gradient(90deg, oklch(0.86 0.13 200 / 0.05) 0px, transparent 2px, transparent 24px)',
      }}
    />
  );
}
