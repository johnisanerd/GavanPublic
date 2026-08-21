/**
 * Shared multi-turn transcript example. Imported into every banter
 * prompt (ack, render, narration) so each layer sees how all four
 * cooperate during an idealized call.
 *
 * IMPORTANT FORMAT NOTE: layer markers are written as bracketed
 * pseudocode labels (e.g. `[banter-ack]`, `[narration]`) rather than
 * XML tags. This is deliberate — earlier versions used XML wrappers
 * (`<banter_ack>...</banter_ack>`) and the model treated them as part
 * of its own output format, leaking layer envelopes into TTS. The
 * bracket labels here are documentation of HOW THE SYSTEM WORKS, not
 * an output shape any single layer should reproduce.
 *
 * Each layer's actual output is the *inner content only* of its
 * label — for example the narration layer outputs `fetching their
 * site list now.` and never `[narration] fetching their site list
 * now.`
 *
 * Voice tags like <spell>, <break>, and <emotion> ARE real XML
 * because the TTS engine consumes them — keep them as XML below.
 *
 *   - ACK is brief and conversational; can fulfill drill-ins from
 *     history's `basedOnBackMindResults` without re-forwarding.
 *   - NARRATION fills the silence while the back-mind works. Each
 *     narration anchors to a specific beat (a new tool firing, OR a
 *     "still working" gap when the back-mind is reading/composing
 *     without firing new tools). Never repeat the same beat in two
 *     different words.
 *   - BACK-MIND produces fact-rich text for the renderer to work from.
 *   - RENDER compresses to the most salient fact + offers two concrete
 *     drill-in paths so the listener can deep-dive without us dumping
 *     the whole answer in one breath.
 *   - REQUEST LAYER decides forward vs noop; here it noops on the
 *     drill-in because ack already answered from history.
 *
 * Voice tag conventions used below:
 *   - <spell>SF</spell> mix → reads "S F mix" (force letter-by-letter
 *     for the upper-case prefix; lowercase + space lets the model say
 *     the rest as a word).
 *   - <spell>IPv4</spell> / <spell>IPv6</spell> → "I P V 4" / "I P V 6".
 *   - "slash 24" / "double colon" → spell punctuation phonetically;
 *     don't write literal slashes or "colon colon" because the model
 *     will say the words "colon colon" out loud.
 *
 * The format is illustrative — actual prompts will see history in a
 * different templated shape — but the SHAPE of an ideal call is what
 * matters.
 */
export const SHARED_TRANSCRIPT_EXAMPLE = `<example>
Multi-turn flow showing all four layers — ack, narration, tool activity, render — working together. Bracket labels like [banter-ack] mark WHICH LAYER produced each line; they are NOT output format. Each layer outputs only the text after its label.

Narration anchors to a specific beat each time: a new tool firing, OR a stretch of "still working" silence (no new tool, back-mind composing or reading) needing presence-maintenance.

USER: where is SFMIX hosted?
[banter-ack] lemme check where <spell>SF</spell> mix is actually located
[request-layer] forward → "Where is the SFMIX internet exchange physically located?"
[tool-event] fetched sfmix.org
[narration] fetching their site list now.
[tool-event] fetched sfmix.org/locations
[narration] got the page — nine sites, picking out the addresses.
[back-mind-result] SFMIX is a distributed internet exchange with 9 sites across the Bay Area. Flagship is 365 Main Street San Francisco (Digital Realty), plus 200 Paul Ave (SF), and Equinix/CoreSite/QTS/Digital Realty/Hurricane Electric/OpenColo facilities in Fremont, San Jose, Santa Clara.
[banter-render] spread across nine sites in the Bay Area <break time="300ms"/> the flagship is at 365 Main in San Francisco. want the rest of the locations, or how the sites tie together?
</example>`;
