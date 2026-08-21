/**
 * Per-channel pairing targets for the "Link a new handle" modal.
 *
 * Each target tells the dashboard how to reach Pat on one channel: the display
 * contact, an optional actionable deep link (with a `{code}` slot the client
 * fills with the live pairing code), whether that link prefills the code, and
 * whether to render a QR. The client builds the final link + QR from this.
 *
 * Values are env-overridable so prod and staging pick the right identities
 * without a rebuild (e.g. the Telegram bot differs per env). Defaults are the
 * live PROD identities.
 */
export type PairingChannelId = 'signal' | 'telegram' | 'slack' | 'phone';

export interface PairingTarget {
  id: PairingChannelId;
  label: string;
  /** Human-readable contact shown under the QR (e.g. "+15550100003", "@pat_prod_bot"). */
  contact: string;
  /** Deep link with an optional `{code}` placeholder the client substitutes.
   *  Null = no link/QR (e.g. Slack — just instructions). */
  linkTemplate: string | null;
  /** Does following the link prefill the code into the message? (changes the copy) */
  prefill: boolean;
  /** One line of guidance shown in the tab. */
  instructions: string;
}

export function pairingTargets(): PairingTarget[] {
  // NO defaults: a channel is surfaced ONLY if its identity is configured for THIS
  // env. A prod fallback here is a cross-env footgun — a staging dashboard must never
  // deep-link people to prod's Signal/Telegram (they'd pair into prod). Set these per
  // env in fly.toml [env] (they're public config, not secrets).
  const signal = process.env.PAT_SIGNAL_NUMBER;
  const telegramBot = process.env.PAT_TELEGRAM_BOT;
  const slackBot = process.env.PAT_SLACK_BOT_NAME;
  const phone = process.env.PAT_PHONE_NUMBER;

  const targets: PairingTarget[] = [];
  if (signal) {
    targets.push({
      id: 'signal',
      label: 'Signal',
      contact: signal,
      // signal.me opens the conversation; Signal has no message-prefill scheme,
      // so the person types the code themselves.
      linkTemplate: `https://signal.me/#p/${signal}`,
      prefill: false,
      instructions: 'Scan to open the Signal chat, then send the code.',
    });
  }
  if (telegramBot) {
    targets.push({
      id: 'telegram',
      label: 'Telegram',
      contact: `@${telegramBot}`,
      // Telegram supports ?text= prefill for bot chats — scan, the code is
      // already typed, just hit send.
      linkTemplate: `https://t.me/${telegramBot}?text={code}`,
      prefill: true,
      instructions: 'Scan to open Telegram with the code prefilled — just hit send.',
    });
  }
  if (slackBot) {
    targets.push({
      id: 'slack',
      label: 'Slack',
      contact: slackBot,
      // Slack DM deep links are unreliable across clients/workspaces; just
      // instruct. No QR.
      linkTemplate: null,
      prefill: false,
      instructions: `DM ${slackBot} in your Slack workspace and send the code.`,
    });
  }
  if (phone) {
    targets.push({
      id: 'phone',
      label: 'Phone',
      contact: phone,
      // tel: link — tap/scan to call. Phone is special: the caller's number IS
      // the identity, so Pat links by caller ID automatically — no code needed.
      linkTemplate: `tel:${phone}`,
      prefill: false,
      instructions: 'Just call — Pat recognizes your number and links you automatically. No code needed.',
    });
  }
  return targets;
}
