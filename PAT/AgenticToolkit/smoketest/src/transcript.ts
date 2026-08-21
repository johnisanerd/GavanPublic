/**
 * Transcript — append-only log of everything that happened during a scenario,
 * plus end-of-run metrics and a markdown rendering for human review.
 *
 * Shapes are kept loose so a future audio-mode harness can stuff additional
 * fields (audio durations, TTS time, STT text vs typed text) into `metadata`
 * without breaking the schema.
 */
export type TranscriptSource =
  | 'user'                    // posted by us via /inbound
  | 'agent-utterance'         // SSE kind='realtime-utterance' (front-mind filler / narration)
  | 'agent-chat'              // SSE kind='chat' (back-mind final reply)
  | 'agent-other'             // SSE kind=other (system events, etc.)
  | 'trace'                   // SSE kind='trace' — LLM call introspection (system + user msg + response + timing)
  | 'judge'                   // judge verdict
  | 'system';                 // harness lifecycle events

export interface TranscriptEntry {
  ts: number;
  source: TranscriptSource;
  text: string;
  /** Free-form metadata: kind, sender, latency, judge rubric, etc. */
  metadata?: Record<string, unknown>;
}

export interface TranscriptMetrics {
  totalDurationMs: number;
  userTurnCount: number;
  agentUtteranceCount: number;
  agentChatCount: number;
  /** ms between each user turn and its first agent-utterance. */
  ackLatenciesMs: number[];
  /** ms between each user turn and its first agent-chat (back-mind). */
  chatLatenciesMs: number[];
  /** Did the harness see the audible-error fallbacks fire? */
  errorFallbackCount: number;
}

const KNOWN_ERROR_FALLBACKS = [
  // From nanoclaw/src/channels/realtime.ts:
  "yeah, lemme check that.", // default chat filler — not an error per se
  "hmm, my front-mind didn't respond",
  "Hmm, I couldn't route your message internally",
  // From transports/main.py:
  "Hmm, I'm not getting a response from the back-end",
];

export class Transcript {
  private readonly entries: TranscriptEntry[] = [];
  private readonly startTs = Date.now();

  add(source: TranscriptSource, text: string, metadata?: Record<string, unknown>): void {
    this.entries.push({ ts: Date.now(), source, text, metadata });
  }

  all(): readonly TranscriptEntry[] {
    return this.entries;
  }

  metrics(): TranscriptMetrics {
    const userTurns = this.entries.filter((e) => e.source === 'user');
    const utterances = this.entries.filter((e) => e.source === 'agent-utterance');
    const chats = this.entries.filter((e) => e.source === 'agent-chat');
    const ackLatenciesMs: number[] = [];
    const chatLatenciesMs: number[] = [];
    for (const turn of userTurns) {
      const nextUtterance = utterances.find((u) => u.ts >= turn.ts);
      if (nextUtterance) ackLatenciesMs.push(nextUtterance.ts - turn.ts);
      const nextChat = chats.find((c) => c.ts >= turn.ts);
      if (nextChat) chatLatenciesMs.push(nextChat.ts - turn.ts);
    }
    let errorFallbackCount = 0;
    for (const e of this.entries) {
      if (e.source !== 'agent-utterance' && e.source !== 'agent-chat') continue;
      for (const phrase of KNOWN_ERROR_FALLBACKS) {
        if (e.text.toLowerCase().includes(phrase.toLowerCase())) {
          errorFallbackCount++;
          break;
        }
      }
    }
    return {
      totalDurationMs: Date.now() - this.startTs,
      userTurnCount: userTurns.length,
      agentUtteranceCount: utterances.length,
      agentChatCount: chats.length,
      ackLatenciesMs,
      chatLatenciesMs,
      errorFallbackCount,
    };
  }

  toMarkdown(title: string): string {
    const lines: string[] = [];
    lines.push(`# ${title}`);
    lines.push('');
    const m = this.metrics();
    lines.push('## Metrics');
    lines.push('');
    lines.push(`- Duration: ${m.totalDurationMs}ms`);
    lines.push(`- User turns: ${m.userTurnCount}`);
    lines.push(`- Agent utterances: ${m.agentUtteranceCount}`);
    lines.push(`- Agent chats: ${m.agentChatCount}`);
    if (m.ackLatenciesMs.length > 0) {
      lines.push(`- Ack latency (ms): ${m.ackLatenciesMs.join(', ')}`);
    }
    if (m.chatLatenciesMs.length > 0) {
      lines.push(`- Chat latency (ms): ${m.chatLatenciesMs.join(', ')}`);
    }
    lines.push(`- Error-fallback count: ${m.errorFallbackCount}`);
    lines.push('');
    lines.push('## Transcript');
    lines.push('');
    for (const e of this.entries) {
      const dt = e.ts - this.startTs;
      const tag = e.source.padEnd(18);
      lines.push(`- [+${dt}ms] **${tag}** ${e.text}`);
    }
    return lines.join('\n');
  }

  toJson(): { startTs: number; entries: TranscriptEntry[]; metrics: TranscriptMetrics } {
    return { startTs: this.startTs, entries: this.entries, metrics: this.metrics() };
  }
}
