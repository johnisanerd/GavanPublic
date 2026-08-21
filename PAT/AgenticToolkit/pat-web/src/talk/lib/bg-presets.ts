export type BackgroundKind = 'solid' | 'gradient' | 'image' | 'events';

export interface BackgroundPreset {
  id: string;
  label: string;
  kind: BackgroundKind;
  /** CSS background value for solid / gradient. */
  css?: string;
  /** Image URL for kind:image. */
  src?: string;
}

export const BG_PRESETS: BackgroundPreset[] = [
  { id: 'ink',     label: 'ink',          kind: 'solid',    css: 'var(--color-bg-base)' },
  { id: 'graphite',label: 'graphite',     kind: 'solid',    css: 'oklch(0.18 0.012 250)' },
  { id: 'ember',   label: 'ember',        kind: 'gradient', css: 'radial-gradient(ellipse at 50% 60%, oklch(0.30 0.13 50) 0%, oklch(0.08 0.02 250) 70%)' },
  { id: 'oceanic', label: 'oceanic',      kind: 'gradient', css: 'radial-gradient(ellipse at 50% 50%, oklch(0.30 0.12 230) 0%, oklch(0.06 0.02 250) 75%)' },
  { id: 'crisp',   label: 'crisp paper',  kind: 'solid',    css: 'oklch(0.93 0.005 95)' },
  { id: 'events',  label: 'events stream',kind: 'events' },
];

export const DEFAULT_BG = BG_PRESETS[0]!;
