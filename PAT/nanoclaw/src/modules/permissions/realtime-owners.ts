/**
 * Realtime owner-phone allowlist.
 *
 * The realtime channel (PSTN voice, etc.) lands a phone caller as
 * `users.id = 'pstn:+E164'`. Unlike Slack/Discord/Telegram, there's no
 * platform-side "this is the workspace owner" signal we can mint a role
 * from. Bootstrap was a chicken-and-egg: a phone caller has to BE
 * recognized as owner before any access gate runs, but the owner role
 * row gets written by `init-first-agent` against a DM channel — which
 * the phone caller never used.
 *
 * Solution: a small env-driven allowlist of phone numbers that should
 * be auto-granted the global `owner` role on first sight. Once granted,
 * the role lives in `user_roles` like any other (visible to the
 * dashboard, returned by `getOwners()`, walked by `pickApprover`, etc.) —
 * the env var only matters for the FIRST inbound from a given number.
 *
 * Configuration:
 *   PAT_OWNER_PHONES="+13415551234,+15555550100"
 *
 * Numbers are matched literally against the E.164 string the realtime
 * channel adapter stamps into `senderId` (the value of `caller_number`
 * in voice-transport's `/inbound` POST, which Cartesia provides as
 * E.164 with leading `+`). No normalization beyond trimming whitespace.
 *
 * The auto-elevation hook lives in `extractAndUpsertUser`
 * (`modules/permissions/index.ts`) so every gate (canAccessAgentGroup,
 * command-gate, pickApprover, OneCLI approvals) sees a real owner row
 * the moment the caller's first utterance is processed.
 */

const ENV_VAR = 'PAT_OWNER_PHONES';

let cached: Set<string> | null = null;

/** Parse the env var lazily so tests can manipulate `process.env` and
 *  call `resetOwnerPhonesCache()` to re-read. */
export function getOwnerPhones(): Set<string> {
  if (cached !== null) return cached;
  const raw = process.env[ENV_VAR] ?? '';
  const set = new Set<string>();
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (trimmed) set.add(trimmed);
  }
  cached = set;
  return cached;
}

/** Test helper — drop the cache so `process.env.PAT_OWNER_PHONES` is
 *  re-read on the next `getOwnerPhones()` call. */
export function resetOwnerPhonesCache(): void {
  cached = null;
}

/**
 * Decide whether `userId` is configured as a realtime owner. Only
 * `pstn:` user ids are eligible — non-realtime callers (slack:, discord:,
 * etc.) go through the normal init-first-agent / DM-based owner flow.
 *
 * Returns the matched phone string when eligible, null otherwise. The
 * matched phone is included in the auto-elevation log event so operators
 * can confirm config matches reality.
 */
export function matchOwnerPhone(userId: string): string | null {
  const PSTN_PREFIX = 'pstn:';
  if (!userId.startsWith(PSTN_PREFIX)) return null;
  const phone = userId.slice(PSTN_PREFIX.length);
  const allow = getOwnerPhones();
  return allow.has(phone) ? phone : null;
}
