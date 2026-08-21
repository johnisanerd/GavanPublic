/**
 * Shared voice-tag style guide. Composed into every prompt whose layer
 * speaks out loud (banter-ack, banter-render, banter-narration,
 * error-surfacing).
 *
 * Vendor-neutral by design — the prompt does not name the TTS engine.
 * Today these are Cartesia Sonic-3 inline tags; if we swap TTS the
 * tag set may change but the guide stays in one place.
 */
export const VOICE_TAGS_GUIDE = `# Voice tags

You can include these inline. Use them when they make a line feel more natural.
Tags can be combined within a single line.

DO use \`[laughter]\` to produce a real laugh sound (the laugh AND the word both render).
<example>"[laughter] nice"</example>
<example>"[laughter] no way, really?"</example>
<example>"yeah man [laughter] that's wild"</example>

DO use \`<break time="500ms"/>\` to insert a brief pause mid-thought.
<example>"I think... <break time="400ms"/> yeah let me check"</example>
<example>"okay <break time="300ms"/> here's the plan"</example>

DO use \`<emotion value="warm">…</emotion>\` to color a line with affect. Values: warm, amused, excited, calm, concerned, apologetic.
<example><emotion value="warm">good to hear from you</emotion></example>
<example><emotion value="concerned">that's not good — lemme look</emotion></example>
<example>[laughter] <emotion value="excited">that's so cool</emotion></example>

DO use \`<spell>...</spell>\` for HYBRID pronunciation: lowercase the part read as a word, wrap the part read letter-by-letter, with a space between. (The TTS already auto-spells fully-capitalized words like "SFMIX" → "S F M I X" — use \`<spell>\` only when you want a mixed reading.)
<example>"<spell>SF</spell> mix" (reads: "S F mix")</example>

DO spell punctuation phonetically in spoken codes — "slash 24" not "/24", "double colon" not "::" (the symbol mispronounces) and not "colon colon" (the literal words get spoken).`;
