/**
 * Judge — single Sonnet call evaluates a transcript against a rubric.
 *
 * Returns `{ passed, reason }`. Used for `kind: 'judge'` scenario steps.
 *
 * Why Sonnet, not Haiku: judgment requires reading the whole transcript and
 * reasoning about whether the agent's behaviour matches the rubric. Haiku
 * tends to over-credit on partial matches in casual testing. Sonnet at
 * default settings is reliable enough and still cheap enough for per-step
 * use. Override via JUDGE_MODEL or AI_MODEL.
 */
import Anthropic from '@anthropic-ai/sdk';

import { getModel } from './models.js';
import type { TranscriptEntry } from './transcript.js';

export interface JudgeVerdict {
  passed: boolean;
  reason: string;
}

const SYSTEM_PROMPT = `You are an evaluator for a voice-agent smoke test. You read a transcript of a conversation between a simulated user and the agent, and decide whether a specific rubric was met.

Rules:
- Be specific in your reasoning. Quote (or paraphrase tightly) the parts of the transcript that drove your verdict.
- Be strict on the rubric: if the rubric asks "did the agent X without Y", a single Y entry means fail.
- Account for the front-mind/back-mind structure: short fillers ("yeah, lemme check") are not the agent's substantive answer; the agent-chat entries are.
- Do NOT credit the agent for speaking words it did not actually say. Only the transcript counts.

Output ONE JSON object: {"passed": true|false, "reason": "concise 1–3 sentence justification"}.`;

export interface JudgeOptions {
  model?: string;
}

export async function judge(
  rubric: string,
  transcript: readonly TranscriptEntry[],
  opts: JudgeOptions = {},
): Promise<JudgeVerdict> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { passed: false, reason: 'no ANTHROPIC_API_KEY (judge disabled)' };
  }
  const model = opts.model ?? getModel('judge');
  const client = new Anthropic();

  const lines: string[] = [];
  lines.push('## Rubric');
  lines.push(rubric);
  lines.push('');
  lines.push('## Transcript');
  // Skip trace entries — they're LLM-call introspection (system prompt +
  // user msg + response, often kilobytes each) for the test viewer, not
  // signal the judge needs.
  const visible = transcript.filter((e) => e.source !== 'trace');
  if (visible.length === 0) {
    lines.push('(empty)');
  } else {
    for (const e of visible) {
      lines.push(`- [${labelFor(e.source)}] ${e.text}`);
    }
  }
  lines.push('');
  lines.push('Verdict (one JSON object).');

  let resp: Anthropic.Message;
  try {
    resp = await client.messages.create({
      model,
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: lines.join('\n') }],
    });
  } catch (err) {
    return { passed: false, reason: `judge API error: ${(err as Error).message}` };
  }
  const block = resp.content.find((b) => b.type === 'text');
  if (!block || block.type !== 'text') {
    return { passed: false, reason: 'judge returned no text block' };
  }
  const parsed = tryParseJson(block.text);
  if (!parsed) {
    return { passed: false, reason: `judge emitted unparseable JSON: ${block.text.slice(0, 100)}` };
  }
  if (typeof parsed.passed !== 'boolean') {
    return { passed: false, reason: `judge omitted boolean "passed": ${JSON.stringify(parsed).slice(0, 120)}` };
  }
  return {
    passed: parsed.passed,
    reason: typeof parsed.reason === 'string' ? parsed.reason : '(no reason given)',
  };
}

function labelFor(source: TranscriptEntry['source']): string {
  switch (source) {
    case 'user':
      return 'USER';
    case 'agent-utterance':
      return 'AGENT-FILLER';
    case 'agent-chat':
      return 'AGENT-CHAT';
    case 'agent-other':
      return 'AGENT-OTHER';
    case 'trace':
      return 'TRACE';
    case 'judge':
      return 'PRIOR-JUDGE';
    case 'system':
      return 'SYSTEM';
  }
}

function tryParseJson(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  const stripped = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const first = stripped.indexOf('{');
  const last = stripped.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  try {
    return JSON.parse(stripped.slice(first, last + 1)) as Record<string, unknown>;
  } catch {
    try {
      return JSON.parse(stripped.slice(first, last + 1).replace(/,(\s*[}\]])/g, '$1')) as Record<
        string,
        unknown
      >;
    } catch {
      return null;
    }
  }
}
