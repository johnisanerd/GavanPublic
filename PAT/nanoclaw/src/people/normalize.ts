/**
 * PAT: identifier normalization + handle parsing for the people spine.
 *
 * The whole point of `person_identifiers (kind, value)` being a deterministic
 * match key is that we normalize both sides identically — at seed time and at
 * auto-enroll time — so a phone seeded as "+1 (555) 010-0001" matches an
 * inbound `signal:+15550100001`.
 *
 * `parseHandle` is deliberately CONSERVATIVE. It was audited 2026-06-22 against
 * how `users.id` is actually constructed (`${channelType}:${handle}` at
 * src/modules/permissions/index.ts:95). The id prefix IS the channel_type — so
 * the prefixes are `signal` / `pstn` / `telegram` / `whatsapp` / `imessage` /
 * `resend` / `anam-web` / …, NOT the `tg:` / `phone:` examples that schema.ts
 * comments suggest. Findings that shaped the rules below:
 *   - signal handles are usually `+E164` but FALL BACK to a UUID when signal-cli
 *     only knows the recipient by ACI/PNI → we require a leading '+' so a UUID
 *     is skipped, not mangled into a fake "+<hexdigits>" number.
 *   - whatsapp handles are JIDs (`15551234567@s.whatsapp.net`, `…@lid`,
 *     `<phone>:<device>@…`), NOT plain E164 → excluded entirely until host-side
 *     JID→E164 resolution exists. Auto-enrolling them by coincidence is worse
 *     than not.
 *   - imessage handles are E164 OR an email address → branch on shape.
 *   - resend (the only live email channel today) is `resend:<address>`; the
 *     dedicated `email:` prefix is reserved for the future OAuth login path.
 * The net "trust" set is small on purpose — a handle we can't confidently
 * normalize returns null (no auto-enroll) rather than a wrong match.
 */

export type IdentifierKind = 'email' | 'phone';

/**
 * Channel prefixes whose handle is a real E164 phone (after the '+'). We
 * REQUIRE the leading '+' at parse time, so non-E164 handles on these channels
 * (signal's UUID fallback, an imessage email) fall through to null / the email
 * branch instead of being normalized into a bogus number.
 */
const PHONE_CHANNELS = new Set(['signal', 'pstn', 'imessage']);

/** Channel prefixes whose handle MAY be an email address (detected by '@'). */
const EMAIL_CHANNELS = new Set(['imessage', 'resend']);

/** Lowercase + trim. Email is the canonical case-insensitive identifier. */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Normalize a phone to E164: keep a single leading '+', strip everything
 * non-digit. Returns null if there are no digits.
 *
 * PAT: a bare 10-digit number is never valid E164 (no country code), and a human
 * entering a phone in the dashboard types the local format ("5550100000" or
 * "555-010-0000"), so we assume US (+1) for exactly-10-digit input. Channels +
 * seed scripts deliver real `+E164` (country code included, 11+ digits), so they
 * are unaffected — the inference only fires on the human-entry case it's for.
 */
export function normalizePhone(value: string): string | null {
  let digits = value.replace(/[^0-9]/g, '');
  if (digits.length === 0) return null;
  if (digits.length === 10) digits = `1${digits}`;
  return `+${digits}`;
}

/** Normalize a value for a given kind. Returns null if it can't be normalized. */
export function normalizeIdentifier(kind: IdentifierKind, value: string): string | null {
  return kind === 'email' ? normalizeEmail(value) : normalizePhone(value);
}

export interface ParsedHandle {
  kind: IdentifierKind;
  value: string;
}

/**
 * Parse a namespaced user id (`signal:+1555…`, `email:a@x.com`,
 * `imessage:a@x.com`, `tg:123`) into the normalized identifier it can be
 * auto-enrolled by, or null if the handle carries no email/phone identifier we
 * trust (telegram/discord/slack ids, anam-web UUIDs, signal UUIDs, whatsapp
 * JIDs).
 */
export function parseHandle(userId: string): ParsedHandle | null {
  const idx = userId.indexOf(':');
  if (idx < 0) return null;
  const prefix = userId.slice(0, idx).toLowerCase();
  const rest = userId.slice(idx + 1).trim();
  if (rest.length === 0) return null;

  // Dedicated email handle (future OAuth login mints these).
  if (prefix === 'email') {
    const value = normalizeEmail(rest);
    return value ? { kind: 'email', value } : null;
  }

  // Email-by-shape on channels that can carry one (imessage, resend).
  if (EMAIL_CHANNELS.has(prefix) && rest.includes('@')) {
    const value = normalizeEmail(rest);
    return value ? { kind: 'email', value } : null;
  }

  // Phone channels: require a real E164 (leading '+'); skip anything else.
  if (PHONE_CHANNELS.has(prefix) && rest.startsWith('+')) {
    const value = normalizePhone(rest);
    return value ? { kind: 'phone', value } : null;
  }

  return null;
}
