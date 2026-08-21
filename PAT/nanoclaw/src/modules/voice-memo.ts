// PAT (task #15): outbound voice-memo dispatch.
//
// The container-side MCP tool `send_voice_memo` writes a `system` action
// row; this host-side handler picks it up, resolves the DM target
// (upsertUser → ensureUserDm), then calls the Signal-specific
// `sendVoiceMemo` extension method on the adapter.
//
// Channel scope: any adapter that implements a `sendVoiceMemo` extension
// method. Today that's Signal (signal-cli --voice-note) and Telegram (Bot
// API sendVoice). We duck-type the surface rather than hard-code channels,
// so a new channel gains voice the moment its adapter implements the method.
//
// Failure semantics: each adapter's sendVoiceMemo already falls back to a
// plain text send on any failure (Cartesia 4xx, ffmpeg failure, send
// failure) and returns false. This module surfaces the final outcome
// (voice-sent vs text-fallback vs error) to the agent via notifyAgent.

import { registerDeliveryAction } from '../delivery.js';
import { getChannelAdapter } from '../channels/channel-registry.js';
import { log } from '../log.js';
import type { Session } from '../types.js';
import { notifyAgent } from './approvals/index.js';
import { upsertUser } from './permissions/db/users.js';
import { ensureUserDm } from './permissions/user-dm.js';

export interface SendVoiceMemoRequest {
  /** `<channel>:<handle>` — e.g. `signal:+E164` or `telegram:<chatId>`. */
  platformId: string;
  /** Text to synthesize. Cartesia Sonic TTS, ~3-30 seconds works best. */
  text: string;
  /** Optional Cartesia voice ID override (defaults to PAT's neutral preset). */
  voiceId?: string;
}

/** Any channel adapter that can deliver a synthesized voice note. */
interface VoiceMemoCapableAdapter {
  sendVoiceMemo(platformId: string, text: string, voiceId?: string): Promise<boolean>;
}

function hasVoiceMemo(
  adapter: ReturnType<typeof getChannelAdapter>,
): adapter is ReturnType<typeof getChannelAdapter> & VoiceMemoCapableAdapter {
  return !!adapter && typeof (adapter as Partial<VoiceMemoCapableAdapter>).sendVoiceMemo === 'function';
}

export async function sendVoiceMemo(req: SendVoiceMemoRequest): Promise<string | null> {
  const { platformId, text, voiceId } = req;

  if (!platformId || typeof platformId !== 'string') return 'platformId is required';
  if (!text || typeof text !== 'string') return 'text is required';

  // PAT: accept BOTH the canonical `<channel>:<handle>` and the destination-name
  // form `<channel>-<handle>` (e.g. `signal-d4d9c1fd-…`) that the agent uses to
  // address text (`<message to="signal-HANDLE">`). Code-paired users are
  // addressed by a Signal ACI UUID, never an E.164, and the agent only ever
  // sees the `signal-<handle>` form — without this it had no value that matched
  // the old `signal:<E164>`-only contract and silently fell back to text.
  // Normalize the first `-` to `:` only when there's no `:` already (UUIDs
  // contain `-`, so split on the FIRST separator only).
  let normalizedId = platformId;
  if (!normalizedId.includes(':')) {
    const dash = normalizedId.indexOf('-');
    if (dash > 0) normalizedId = `${normalizedId.slice(0, dash)}:${normalizedId.slice(dash + 1)}`;
  }

  const idx = normalizedId.indexOf(':');
  if (idx < 0) return `platformId must be "<channel>:<handle>" or "<channel>-<handle>" (got: ${platformId})`;
  const channelType = normalizedId.slice(0, idx);
  const handle = normalizedId.slice(idx + 1);
  if (!channelType || !handle) return `platformId malformed (got: ${platformId})`;

  upsertUser({
    id: normalizedId,
    kind: channelType,
    display_name: handle,
    created_at: new Date().toISOString(),
  });

  const mg = await ensureUserDm(normalizedId);
  if (!mg) return 'could not resolve DM messaging_group for target';

  const adapter = getChannelAdapter(channelType);
  if (!hasVoiceMemo(adapter)) {
    return `send_voice_memo: ${channelType}:* does not support voice memos (adapter not registered or lacks sendVoiceMemo)`;
  }

  try {
    const ok = await adapter.sendVoiceMemo(mg.platform_id, text, voiceId);
    if (ok) {
      log.info('send_voice_memo: delivered as voice note', { platformId });
      return null;
    }
    // sendVoiceMemo already fell back to a text send_message; surface
    // that to the agent so they know the audible delivery didn't
    // happen.
    log.warn('send_voice_memo: synthesis or send failed, sent as text fallback', { platformId });
    return 'voice synthesis or send failed; sent as text instead';
  } catch (err) {
    log.error('send_voice_memo: dispatch failed', { platformId, err });
    return `dispatch failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function handleSendVoiceMemo(content: Record<string, unknown>, session: Session): Promise<void> {
  const platformId = content.platformId as string;
  const text = content.text as string;
  const voiceId = content.voiceId as string | undefined;

  const errorMessage = await sendVoiceMemo({ platformId, text, voiceId });
  if (errorMessage) {
    // ERROR path — the agent SHOULD see this so it can recover (e.g.
    // notify the user that audio failed, ask what to do next). Tag as
    // internal status so it doesn't get echoed verbatim.
    notifyAgent(
      session,
      `[internal] send_voice_memo error: ${errorMessage}. The voice memo did NOT reach the user — fall back to a text message if appropriate.`,
    );
    return;
  }

  // SUCCESS path: deliberately quiet. Prior versions wrote
  // "send_voice_memo ok: voice memo delivered to ..." which the LLM
  // parsed and echoed to the user as literal "Queued." / "Delivered ✓"
  // chat messages. The voice memo IS the message; no follow-up
  // confirmation needed.
}

registerDeliveryAction('send_voice_memo', handleSendVoiceMemo);
