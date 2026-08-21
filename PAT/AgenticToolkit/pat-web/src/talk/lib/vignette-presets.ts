export interface VignetteShape {
  inner: number;
  outer: number;
  power: number;
}

export interface VignettePreset {
  id: string;
  label: string;
  aspect: [number, number];
  shape: VignetteShape;
}

export const VIGNETTE_PRESETS: VignettePreset[] = [
  {
    id: 'portrait-9x16',
    label: 'portrait 9:16',
    aspect: [9, 16],
    shape: { inner: 0.78, outer: 1.25, power: 3.5 },
  },
  {
    id: 'portrait-3x4',
    label: 'portrait 3:4',
    aspect: [3, 4],
    shape: { inner: 0.60, outer: 1.05, power: 3.2 },
  },
  {
    id: 'square',
    label: 'square 1:1',
    aspect: [1, 1],
    shape: { inner: 0.55, outer: 1.05, power: 3.0 },
  },
  {
    id: 'landscape-16x9',
    label: 'landscape 16:9',
    aspect: [16, 9],
    shape: { inner: 0.55, outer: 1.05, power: 3.5 },
  },
  {
    id: 'oval',
    label: 'soft oval',
    aspect: [4, 5],
    shape: { inner: 0.35, outer: 0.95, power: 2.0 },
  },
];

export const DEFAULT_VIGNETTE = VIGNETTE_PRESETS[0]!;
