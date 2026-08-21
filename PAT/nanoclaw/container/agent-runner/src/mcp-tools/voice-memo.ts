/**
 * Voice-memo MCP tool — agent-initiated TTS voice note.
 *
 * Lets the agent synthesize speech via Cartesia Sonic and deliver it
 * as a voice note (the hold-to-listen bubble) on Signal. The agent
 * supplies the destination platformId and the text to speak; the
 * host synthesizes, transcodes to opus/ogg, and dispatches via
 * signal-cli's `send` RPC with the `voiceNote: true` flag.
 *
 * Wire-up: tool writes a system action row; the host handler is
 * registered in nanoclaw/src/modules/voice-memo.ts (`send_voice_memo`).
 * Same pattern as outbound.initiate — the container can't reach the
 * channel adapters directly, so we route through messages_out.
 *
 * Failure fallback: if Cartesia synthesis 4xxs, ffmpeg fails, or the
 * signal-cli send RPC errors, the host falls back to sending the same
 * text as a normal text message — the recipient always gets the
 * content, just not audibly. The system-chat reply tells the agent
 * which outcome happened.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const sendVoiceMemo: McpToolDefinition = {
  tool: {
    name: 'send_voice_memo',
    description:
      'Send a synthesized voice note to a user on Signal or Telegram. The ' +
      'text is converted to speech via Cartesia Sonic and delivered as a ' +
      'native voice message (the hold-to-listen / play-button bubble in the ' +
      "recipient's app, not a generic audio tile). " +
      'Use for casual conversational replies, jokes, expressive moments, ' +
      'or anything where the audible delivery materially adds something. ' +
      "Don't use for code, long-form answers, lists, links, anything the " +
      'user will want to scroll through later, or anything sensitive — voice ' +
      "notes can't be quoted or searched. " +
      'ADDRESSING — use the SAME recipient handle you send text to: take it ' +
      'from the inbound `<message from="signal-HANDLE">` (or `<message ' +
      'to="signal-HANDLE">` in destinations) and pass `signal:HANDLE`. HANDLE ' +
      'is whatever follows `signal-` — an E.164 phone (`signal:+15550100000`) ' +
      'OR a Signal account UUID (`signal:<redacted-uuid>...`) for users paired ' +
      'by code. Telegram: `telegram:<chatId>`. Either the `signal:HANDLE` or ' +
      'the raw `signal-HANDLE` destination-name form is accepted. ' +
      'On any synthesis or send failure (Cartesia 4xx, ffmpeg ' +
      'failure, send failure), the host falls back to sending ' +
      'the same text as a normal text message so the recipient still ' +
      'receives the content. ' +
      'IMPORTANT — DO NOT echo status to the user: this tool returns ' +
      'an internal pipeline confirmation (e.g. "queued", "ok delivered"). ' +
      'Those words are for YOU, not for the user — never send "Queued.", ' +
      '"Delivered ✓", "sending now", or any similar pipeline status to ' +
      'the user as a follow-up message. The voice memo IS the message; ' +
      'when this tool returns, the work is done. The system-chat outcome ' +
      'message you receive later is also internal — only act on it if it ' +
      'reports an ERROR; otherwise stay silent.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        platformId: {
          type: 'string',
          description:
            'Recipient — the SAME handle you address text to. From an inbound ' +
            '`<message from="signal-HANDLE">` pass `signal:HANDLE`. HANDLE may ' +
            'be an E.164 (`signal:+15550100000`) OR a Signal account UUID ' +
            '(`signal:<redacted-uuid>...`, for code-paired users). Telegram: ' +
            '`telegram:<chatId>`. The raw destination-name form (`signal-HANDLE`) ' +
            'is also accepted.',
        },
        text: {
          type: 'string',
          description:
            'Text to synthesize. Best results with 3-30 seconds of speech ' +
            '(roughly 5-60 words). Avoid URLs, code blocks, lists — Cartesia ' +
            "will read them literally and the recipient can't copy from a " +
            'voice note. Punctuation is honored for prosody.',
        },
        voiceId: {
          type: 'string',
          description:
            "Optional Cartesia voice ID override. Defaults to PAT's neutral " +
            "preset. You probably don't need this unless the user explicitly " +
            'asks for a different voice.',
        },
      },
      required: ['platformId', 'text'],
    },
  },
  async handler(args) {
    const platformId = args.platformId as string;
    const text = args.text as string;
    const voiceId = args.voiceId as string | undefined;
    if (!platformId) return err('platformId is required');
    if (!text) return err('text is required');

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'send_voice_memo',
        platformId,
        text,
        voiceId,
      }),
    });

    log(`send_voice_memo: ${requestId} → ${platformId} (${text.length} chars)`);
    return ok(
      // Terse, no "queued" / "delivered" / "sending" phrasing — the LLM
      // has a strong tendency to echo these as user-facing status updates.
      // The voice memo IS the message; nothing else to say.
      `[internal] send_voice_memo dispatched. Do not echo to user.`,
    );
  },
};

registerTools([sendVoiceMemo]);
