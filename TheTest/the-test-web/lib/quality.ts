// Per-answer "qualities": derived, extensible attributes of a freeform answer
// (NOT a grade — that's the separate scored_answer layer). Stored as an open
// JSONB blob on survey_answer so future keys (language, classifier outputs)
// need no schema change. Response-level rollups are derived from these.
const MIN_WORDS = 8;

// The em dash (—) is effectively never typed by a Prolific participant into a
// plain survey textarea — its presence means the text was composed elsewhere
// (an LLM) and pasted in. High-precision "AI-assisted" signal. Voice answers
// are machine-transcribed (ElevenLabs emits em-dashes itself), so the em-dash
// signal is meaningless there — ai_likelihood stays 0 for multi_format.
const EM_DASH = /—/;

// Compute the canonical qualities blob for ONE answer.
//   - Non-freeform answers: {} (no qualities apply).
//   - Freeform answers: { word_count, too_short, ai_likelihood }.
//     * word_count: whitespace-delimited tokens in trimmed text; 0 if empty.
//     * too_short: word_count < MIN_WORDS (applies to ALL freeform, incl. voice).
//     * ai_likelihood: 1 when TYPED freeform (field_type !== 'multi_format')
//       contains an em-dash; else 0. (Analog scores later; 0/1 for now.)
export function computeAnswerQualities(
  answerText: string | null,
  fieldType: string | null,
  isFreeform: boolean,
): Record<string, unknown> {
  if (!isFreeform) return {};
  const text = answerText?.trim() ?? "";
  const wordCount = text ? (text.match(/\S+/g) ?? []).length : 0;
  const tooShort = wordCount < MIN_WORDS;
  const aiLikelihood =
    fieldType !== "multi_format" && EM_DASH.test(text) ? 1 : 0;
  return {
    word_count: wordCount,
    too_short: tooShort,
    ai_likelihood: aiLikelihood,
  };
}

// Derive the response-level rollups from its answers' qualities blobs.
//   - is_low_quality: any freeform answer too_short OR ai_likelihood >= 1
//     (exactly the old is_rejected || is_ai_suspected — drives "Low Quality").
//   - is_ai_likely:   any freeform answer ai_likelihood >= 1 (drives "AI?").
// Non-freeform answers carry {} and contribute nothing.
export function rollupResponseQualities(
  answers: Array<{ qualities: Record<string, unknown> }>,
): { is_low_quality: boolean; is_ai_likely: boolean } {
  let isAiLikely = false;
  let anyTooShort = false;
  for (const { qualities } of answers) {
    if (Number(qualities.ai_likelihood) >= 1) isAiLikely = true;
    if (qualities.too_short === true) anyTooShort = true;
  }
  return { is_low_quality: anyTooShort || isAiLikely, is_ai_likely: isAiLikely };
}
