import type { SessionMode } from '@/types/anam';

/**
 * Avatar modes — the single source of truth for "what's in the avatar
 * slot and how the backend is wired". Four discrete options the user
 * picks from a single chip strip in the settings panel; every other
 * piece of state (SessionMode, shader.standIn, voiceOnly) is derived.
 *
 * - "pat"     — Pat-mode session, video shown, PAT backend dispatch.
 * - "voice"   — Same pipeline as Pat, but the avatar canvas is hidden
 *               and an audio-reactive SVG blob is shown in its place.
 *               Useful when the visual avatar would be a distraction
 *               or the device can't render WebGL smoothly.
 * - "generic" — Anam's default brain owns the conversation. No PAT
 *               backend, no banter driver. Stress-tests the UI/voice/
 *               avatar plumbing without standing up a backend.
 * - "image"   — Chroma-key stand-in. No session at all; the canvas
 *               pulls pixels from a known-good still so the shader
 *               can be tuned without burning Anam concurrent slots.
 */
export type AvatarMode = 'pat' | 'voice' | 'generic' | 'image';

export interface AvatarModeDescriptor {
  id: AvatarMode;
  label: string;
  description: string;
}

/** Order matters: this is the left-to-right order rendered in the
 *  settings panel chip strip. */
export const AVATAR_MODES: AvatarModeDescriptor[] = [
  { id: 'pat',     label: 'pat',     description: 'Full video avatar' },
  { id: 'voice',   label: 'voice',   description: 'Voice only' },
  { id: 'generic', label: 'generic', description: 'No intelligence' },
  { id: 'image',   label: 'image',   description: 'Placeholder image' },
];

/** Backend SessionMode that the server-side token endpoint cares about.
 *  Voice piggybacks on the Pat pipeline; image has no session at all
 *  but we return 'pat' so the type stays a discriminated `SessionMode`
 *  (the value is ignored — image mode never calls start()). */
export function sessionModeFor(m: AvatarMode): SessionMode {
  return m === 'generic' ? 'demo' : 'pat';
}

/** True when the avatar canvas should be hidden in favour of the
 *  voice-reactive blob. Single derivation site so other consumers
 *  don't have to remember the rule. */
export function isVoiceOnly(m: AvatarMode): boolean {
  return m === 'voice';
}

/** True when the chroma shader should pull from the stand-in image
 *  rather than the live video. */
export function isStandIn(m: AvatarMode): boolean {
  return m === 'image';
}
