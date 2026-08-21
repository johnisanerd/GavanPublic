/**
 * Minimal local mirror of the Anam JS SDK shapes we touch. We don't try
 * to re-declare the whole SDK — just enough to keep our hooks typed
 * without leaking SDK types across the app.
 *
 * Source of truth: @anam-ai/js-sdk types and
 *   https://anam.ai/docs/javascript-sdk/reference/event-types
 */

export type AnamRole = 'user' | 'persona';

export interface AnamMessage {
  role: AnamRole;
  content: string;
}

export interface AnamMessageStreamEvent {
  role: AnamRole;
  content: string;
  /** True on the last delta of a persona turn — Anam's "I'm done
   *  rendering this turn's audio" signal. Equivalent to Cartesia
   *  AgentTurnEnded on the PSTN path. */
  endOfSpeech: boolean;
  /** True if a user barge-in cut the persona stream short. */
  interrupted: boolean;
}

/** Mode picks how Anam routes its "what does the agent say" decision. */
export type SessionMode = 'demo' | 'pat';

export interface SessionConfig {
  mode: SessionMode;
}
