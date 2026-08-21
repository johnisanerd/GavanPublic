/**
 * PAT: Slack → person linking for cross-channel auto-approve.
 *
 * A Slack handle is a user id (`slack:U0ABC123`), which carries no email or
 * phone — so `parseHandle` can't auto-enroll it the way it does signal/pstn.
 * But Slack's `users.info` API DOES carry the user's email
 * (`user.profile.email`, present when the bot has the `users:read.email`
 * scope). So: on first sight of an unlinked Slack handle, look up its email
 * and, if it matches a known person's `email` identifier, link the handle.
 * Once linked, the access gate's `autoApproveKnownPerson` recognizes the
 * sender on every future message.
 *
 * Wired as an onInbound interceptor in slack.ts (mirrors the Telegram pairing
 * interceptor). It is BEST-EFFORT and FAIL-OPEN: the message always forwards
 * to the host; linking happens as a side effect before forwarding. The API
 * call only fires when the handle is NOT already linked to a person — once
 * linked, `getPersonByUser` short-circuits and we never call Slack again for
 * that user. A negative result (no person, no email scope) is cached
 * in-process so we don't re-hit the API on every message from a stranger.
 */
import { log } from '../log.js';
import { getPersonByUser, linkHandleByIdentifier } from '../people/index.js';
import type { ChannelSetup, InboundMessage } from './adapter.js';

/** Slack user ids we've already tried and failed to resolve to a person — don't re-hit the API. */
const negativeCache = new Set<string>();

interface SlackUserInfo {
  ok: boolean;
  user?: { profile?: { email?: string } };
  error?: string;
}

/**
 * Fetch a Slack user's email via `users.info`. Returns null when the call
 * fails, the scope is missing, or the profile carries no email. Direct fetch
 * to the Slack Web API with the bot token — same pattern telegram.ts uses for
 * getChat/getMe rather than reaching into the adapter's private WebClient.
 */
async function fetchSlackUserEmail(token: string, slackUserId: string): Promise<string | null> {
  try {
    const res = await fetch('https://slack.com/api/users.info', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Bearer ${token}`,
      },
      body: new URLSearchParams({ user: slackUserId }).toString(),
    });
    const data = (await res.json()) as SlackUserInfo;
    if (!data.ok) {
      // `missing_scope` here means the app lacks users:read.email — log once so
      // an operator can add the scope; the negative cache suppresses repeats.
      log.warn('Slack users.info non-OK — cannot resolve email for person-link', {
        slackUserId,
        error: data.error,
      });
      return null;
    }
    const email = data.user?.profile?.email;
    return email && email.length > 0 ? email : null;
  } catch (err) {
    log.warn('Slack users.info failed', { slackUserId, err });
    return null;
  }
}

function readAuthorUserId(message: InboundMessage): string | null {
  if (message.kind !== 'chat-sdk' || !message.content || typeof message.content !== 'object') return null;
  const c = message.content as { author?: { userId?: string } };
  return c.author?.userId ?? null;
}

/**
 * Try to link a Slack handle to a known person via its email. Fire-and-forget
 * side effect; never throws. No-op when the handle is already linked or already
 * known-unresolvable (negative cache).
 */
async function tryLinkSlackPerson(token: string, slackUserId: string): Promise<void> {
  const userId = `slack:${slackUserId}`;
  if (negativeCache.has(userId)) return;
  if (getPersonByUser(userId)) return; // already linked — never re-hit Slack

  const email = await fetchSlackUserEmail(token, slackUserId);
  if (!email) {
    negativeCache.add(userId);
    return;
  }
  const personId = linkHandleByIdentifier(userId, 'email', email);
  if (personId) {
    log.info('Slack handle linked to person via email', { userId, personId });
  } else {
    // Email resolved but no person owns it — cache the miss.
    negativeCache.add(userId);
  }
}

/**
 * Build an onInbound interceptor that opportunistically links the Slack sender
 * to a known person (by email) before forwarding. Fail-open: the host always
 * receives the message; linking is a side effect that makes the very next
 * access-gate check (autoApproveKnownPerson) succeed for a vouched-for human.
 */
export function createSlackPersonLinkInterceptor(
  token: string,
  hostOnInbound: ChannelSetup['onInbound'],
): ChannelSetup['onInbound'] {
  return async (platformId, threadId, message) => {
    const slackUserId = readAuthorUserId(message);
    if (slackUserId) {
      // Await so the link lands BEFORE the message hits the access gate — that
      // makes the FIRST message from a known person auto-approve, not just the
      // second. The Slack API call only fires once per user (subsequent
      // messages short-circuit on the link or the negative cache), so the
      // latency cost is a one-time round-trip per Slack person. Errors are
      // swallowed inside tryLinkSlackPerson — we never block delivery on them.
      await tryLinkSlackPerson(token, slackUserId).catch((err) => log.warn('Slack person-link threw', { err }));
    }
    return hostOnInbound(platformId, threadId, message);
  };
}

/** Test helper — clear the in-process negative cache. */
export function _resetSlackPersonLinkCacheForTest(): void {
  negativeCache.clear();
}
