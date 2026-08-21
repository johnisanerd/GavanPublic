/**
 * call-baseline — Tier 3A ONLY: a real Cartesia WS call (full acoustic
 * pipeline: harness TTS → Cartesia STT → transports → nanoclaw front/back
 * mind → Cartesia TTS → captured PCM). Assertions are AUDIO-LEVEL: the
 * /outbound SSE tap does not carry call-thread events (found live
 * 2026-07-03 — the call worked end-to-end while every SSE assertion timed
 * out blind), so "the agent audibly responded after the user turn" is the
 * reliable signal. `call.wav` in the artifact dir is the human-verifiable
 * record; listen to it when in doubt.
 */
import type { Scenario } from './index.js';

// Snapshot of agent PCM bytes taken between greeting and the user turn —
// module-level is fine: scenarios run sequentially within a process.
let agentBytesBeforeTurn = 0;

export const callBaseline: Scenario = {
  name: 'call-baseline',
  description:
    'real Cartesia call: ask a question, assert the agent SPOKE in response (audio-level delta); call.wav is the artifact. Run with --call.',
  steps: [
    {
      kind: 'check',
      label: 'call is live (greeting captured)',
      fn: async (ctx) => {
        if (!ctx.call) return { ok: false, details: 'call-baseline requires --call (Tier 3A)' };
        agentBytesBeforeTurn = ctx.call.agentAudioBytes();
        return {
          ok: agentBytesBeforeTurn > 0,
          details: `greeting audio: ${agentBytesBeforeTurn} bytes`,
        };
      },
    },
    {
      kind: 'check',
      label: 'agent answered the question (human-like repeat if the turn was swallowed)',
      fn: async (ctx) => {
        if (!ctx.call) return { ok: false, details: 'no call client' };
        // PAT 2026-07-04: robust ask — askWithRetry waits for fresh agent
        // audio arriving AFTER our clip ends (mid-clip banter over a
        // semantic-split fragment doesn't count as an answer), and repeats
        // the question once if nothing lands — like a human would. Detection
        // + repeat, not timing guesses. The colon pause in the text is KEPT
        // deliberately: it's the stress case that exercises the semantic
        // split + retry path.
        const r = await ctx.call.askWithRetry(
          'hey Pat, quick check: what is two plus two? just say the number.',
          { replyTimeoutMs: 45_000, retries: 1 },
        );
        const total = ctx.call.agentAudioBytes() - agentBytesBeforeTurn;
        return {
          ok: r.replied,
          details: r.replied
            ? `answered on attempt ${r.attempts} (${r.freshBytes} post-clip bytes, ${total} total fresh)`
            : `NO answer after ${r.attempts} attempts (${r.freshBytes} post-clip bytes)`,
        };
      },
    },
  ],
  acceptanceMs: 150_000,
};
