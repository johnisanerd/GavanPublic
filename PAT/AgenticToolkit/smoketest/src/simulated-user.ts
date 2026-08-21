/**
 * SimulatedUser — LLM-driven "human" that takes a persona + goal and the
 * running transcript, and produces the next user turn.
 *
 * Two compatible patterns inside one class:
 *   - **scripted**: scenarios that hand the next turn directly bypass the
 *     LLM (cheap, deterministic). Just call `respondTo(...)` with the
 *     scripted line as the override.
 *   - **goal-directed**: the user gets a persona + goal and decides what
 *     to say each turn, possibly ending by emitting `{ type: 'end' }`.
 */
import Anthropic from '@anthropic-ai/sdk';

import { getModel } from './models.js';
import type { TranscriptEntry } from './transcript.js';

export interface SimulatedUserOptions {
  persona: string;
  goal: string;
  /** Override the model ID (else getModel('sim-user')). */
  model?: string;
  /** Soft cap on how many turns the user will produce before giving up. */
  maxTurns?: number;
}

export type SimulatedUserResponse =
  | { type: 'turn'; text: string; reason: string }
  | { type: 'end'; reason: string };

const SYSTEM_PROMPT = `You are role-playing as a human user in a smoke test of a voice agent named Pat.

Pat is a real-time conversational AI with a fast front-mind (acks, narrations) and a slow back-mind (full reasoning replies). Pat speaks aloud, so its replies are short conversational sentences.

You will be given a persona and a goal. Your job is to play the role and naturally drive the conversation toward your goal. You'll see the transcript so far and decide what to say next.

Rules:
- Speak as the user would, casually and naturally — short turns (one sentence, occasionally two).
- Don't impersonate Pat or narrate the agent's behaviour. Only say what the user would say.
- Stay in character. If Pat goes off the rails, react like a frustrated/confused user.
- When your goal has been achieved (or you decide it can't be), output {"type":"end","reason":"..."}.
- Otherwise output {"type":"turn","text":"...what you would say...","reason":"why you're saying it"}.

Output format: ONE JSON object, no fences, no prose around it.`;

export class SimulatedUser {
  private client: Anthropic | null = null;
  private readonly model: string;
  private readonly persona: string;
  private readonly goal: string;
  private readonly maxTurns: number;
  private turnsTaken = 0;

  constructor(opts: SimulatedUserOptions) {
    this.persona = opts.persona;
    this.goal = opts.goal;
    this.model = opts.model ?? getModel('sim-user');
    this.maxTurns = opts.maxTurns ?? 10;
  }

  private getClient(): Anthropic {
    if (!this.client) this.client = new Anthropic();
    return this.client;
  }

  /**
   * Compute the next user turn given the current transcript. If the turnsTaken
   * has hit the cap, we emit `end` reflexively to avoid runaway scenarios.
   */
  async respondTo(transcript: readonly TranscriptEntry[]): Promise<SimulatedUserResponse> {
    if (this.turnsTaken >= this.maxTurns) {
      return { type: 'end', reason: 'turn cap reached' };
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return { type: 'end', reason: 'no ANTHROPIC_API_KEY (sim user disabled)' };
    }

    const userMsg = this.buildUserMessage(transcript);
    let resp: Anthropic.Message;
    try {
      resp = await this.getClient().messages.create({
        model: this.model,
        max_tokens: 256,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMsg }],
      });
    } catch (err) {
      return { type: 'end', reason: `sim-user API error: ${(err as Error).message}` };
    }
    const block = resp.content.find((b) => b.type === 'text');
    if (!block || block.type !== 'text') {
      return { type: 'end', reason: 'sim-user returned no text' };
    }
    const parsed = tryParseJson(block.text);
    if (!parsed) {
      return { type: 'end', reason: `sim-user emitted unparseable JSON: ${block.text.slice(0, 80)}` };
    }
    if (parsed.type === 'turn' && typeof parsed.text === 'string' && parsed.text.length > 0) {
      this.turnsTaken += 1;
      return { type: 'turn', text: parsed.text, reason: typeof parsed.reason === 'string' ? parsed.reason : '' };
    }
    if (parsed.type === 'end') {
      return { type: 'end', reason: typeof parsed.reason === 'string' ? parsed.reason : '' };
    }
    return { type: 'end', reason: `sim-user emitted unrecognised payload: ${JSON.stringify(parsed).slice(0, 120)}` };
  }

  /** Used by scripted scenarios to count a hard-coded turn against the cap. */
  noteScriptedTurn(): void {
    this.turnsTaken += 1;
  }

  private buildUserMessage(transcript: readonly TranscriptEntry[]): string {
    const lines: string[] = [];
    lines.push('## Persona');
    lines.push(this.persona);
    lines.push('');
    lines.push('## Goal');
    lines.push(this.goal);
    lines.push('');
    lines.push('## Transcript so far');
    if (transcript.length === 0) {
      lines.push('(empty — you go first)');
    } else {
      for (const e of transcript) {
        let prefix: string;
        switch (e.source) {
          case 'user':
            prefix = 'YOU';
            break;
          case 'agent-utterance':
            prefix = 'PAT(filler)';
            break;
          case 'agent-chat':
            prefix = 'PAT';
            break;
          default:
            prefix = 'system';
        }
        lines.push(`- ${prefix}: ${e.text}`);
      }
    }
    lines.push('');
    lines.push('Output ONE JSON object: either {"type":"turn","text":"...","reason":"..."} or {"type":"end","reason":"..."}.');
    return lines.join('\n');
  }
}

function tryParseJson(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  const stripped = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const first = stripped.indexOf('{');
  const last = stripped.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  const candidate = stripped.slice(first, last + 1);
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    try {
      const parsed = JSON.parse(candidate.replace(/,(\s*[}\]])/g, '$1'));
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
}
