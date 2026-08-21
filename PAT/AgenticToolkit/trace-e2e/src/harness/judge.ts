/**
 * Optional LLM judge for content assertions.
 *
 * Trace-based testing handles "did the right event sequence fire in
 * the right order." For content quality — "did the agent's answer
 * actually address the question?" — we need a semantic judge.
 *
 * Pattern: collect the agent's spoken text (from `utterance.stream-ended`
 * events of the relevant source) over the test window, hand it to an
 * Anthropic Haiku call with a yes/no rubric, and assert on the
 * structured response.
 *
 * Cheap-and-cheerful: ~$0.001 per judgment. Indeterminacy is fine per
 * user's call — the test is graded "did the operator agree this was
 * an acceptable response," not "did the bytes match exactly."
 *
 * Requires `ANTHROPIC_API_KEY` in env.
 */
import Anthropic from '@anthropic-ai/sdk';

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('LLM judge requires ANTHROPIC_API_KEY in env');
    client = new Anthropic({ apiKey });
  }
  return client;
}

export interface JudgeResult {
  pass: boolean;
  reason: string;
}

export interface JudgeOpts {
  /** Model id; defaults to a fast Haiku for cheap iteration. */
  model?: string;
  /** Max tokens for the judge response. */
  maxTokens?: number;
}

/**
 * Ask the judge a yes/no question about a transcript. Returns
 * `{pass, reason}`. Throws on API failure.
 *
 * Prompt design: the judge MUST respond with valid JSON
 * `{"pass": boolean, "reason": string}`. We instruct it explicitly and
 * parse the response. If the response isn't parseable JSON, we treat
 * that as a judge failure (returns pass=false).
 */
export async function judge(
  rubric: string,
  transcript: string,
  opts: JudgeOpts = {},
): Promise<JudgeResult> {
  const c = getClient();
  const model = opts.model ?? 'claude-sonnet-4-6';
  const maxTokens = opts.maxTokens ?? 200;

  const system = `You are a strict judge evaluating whether an AI assistant's spoken response satisfies a rubric.

Respond with EXACTLY this JSON shape (no markdown, no commentary):
{"pass": true|false, "reason": "<one sentence>"}

Be strict but fair: the assistant doesn't need to use exact phrasing, but it must address the substance.`;

  const user = `Rubric: ${rubric}

Transcript of the assistant's response:
"""
${transcript}
"""

Did the response satisfy the rubric? Respond with the JSON shape only.`;

  const res = await c.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  });

  const block = res.content.find((b) => b.type === 'text');
  if (!block || block.type !== 'text') {
    return { pass: false, reason: 'judge returned no text block' };
  }
  const raw = block.text.trim();
  // Strip code fences if the model insists.
  const stripped = raw.replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    const parsed = JSON.parse(stripped) as JudgeResult;
    if (typeof parsed.pass !== 'boolean') {
      return { pass: false, reason: `judge returned non-boolean pass field: ${raw.slice(0, 120)}` };
    }
    return { pass: parsed.pass, reason: parsed.reason ?? '' };
  } catch (e) {
    return { pass: false, reason: `judge JSON parse failed: ${raw.slice(0, 200)}` };
  }
}
