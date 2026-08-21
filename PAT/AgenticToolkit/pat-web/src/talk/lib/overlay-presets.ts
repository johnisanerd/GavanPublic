export type OverlayKind = 'off' | 'code-rain' | 'light-leak' | 'scanlines';

export interface OverlayPreset {
  id: string;
  label: string;
  kind: OverlayKind;
  /** Default opacity multiplier — overlays should always read as ambient. */
  opacity: number;
}

export const OVERLAY_PRESETS: OverlayPreset[] = [
  { id: 'off',         label: 'off',           kind: 'off',         opacity: 0.0  },
  { id: 'rain-sparse', label: 'code rain',     kind: 'code-rain',   opacity: 0.55 },
  { id: 'light-leak',  label: 'light leak',    kind: 'light-leak',  opacity: 0.45 },
  { id: 'scanlines',   label: 'scanlines',     kind: 'scanlines',   opacity: 0.20 },
];

export const DEFAULT_OVERLAY = OVERLAY_PRESETS[0]!;
