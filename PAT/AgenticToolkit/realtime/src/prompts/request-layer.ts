/**
 * `request-layer` — the LLM call that decides per user message
 * whether to noop, forward to the back-mind, or stay silent. One
 * file = the complete template handed to the model: SYSTEM prompt +
 * USER message + typed context slots. Read top to bottom.
 *
 * Capability lifecycle (TaskList #8): install-state lives in SYSTEM via
 * `getInstallCapabilitiesBlock(ctx.agentGroupId)`. Per-inbound caller
 * context lives in USER. The request layer uses install caps to gauge
 * scope ("is this even in this install's surface?") and caller context
 * for recipient disambiguation ("send to the 4959 signal" → forward
 * without back-mind clarification when the suffix is unambiguous).
 *
 * No persona / no voice tags — the request layer NEVER speaks
 * directly. The only output is a routing decision.
 *
 * Caller: `requestLayerOnUserMessage` in `request-layer.ts`. Caller
 * renders `backMindState` and `history` to strings before passing in
 * here.
 */
import { ARCHITECTURE_BRIEF } from './_architecture.js';
import {
  getInstallCapabilitiesBlock,
  renderCallerContext,
  type CallerContext,
} from './_capability-context.js';
import { renderScenarioContext, type ScenarioContext } from './_scenario-context.js';

/** Typed slots interpolated into the user message. */
export interface RequestLayerContext {
  /** Agent group identifier for this inbound. Drives the install-side
   *  capability lookup via `getInstallCapabilitiesBlock(agentGroupId)`. */
  agentGroupId?: string | null;
  /** Back-mind state snapshot, rendered (or '' if empty). */
  backMindState: string;
  /** Conversation history rendered for the prompt (or '' if none). */
  history: string;
  /** Authoritative in-flight flag — true ⇒ back-mind is currently running a query. */
  isProcessing: boolean;
  /** What the user just said. */
  userText: string;
  /** The banter-ack response already spoken to the user (or null/'' on banter failure). */
  banterResponse: string | null;
  /** Scenario meta when this session is in scenario mode. The
   *  partial in `_scenario-context.ts` appends `<scenario>` +
   *  `<scenario_rules>` blocks. Critically: "begin" / "go ahead" /
   *  "audience is ready" become SCENARIO CUES that should wake the
   *  back-mind (forward), not noop as chitchat. */
  scenario?: ScenarioContext | null;
  /** Per-inbound caller context. Threaded into the USER message so the
   *  request-layer can (a) cheaply forward when the ask names a
   *  recipient already in <known_handles> ("send to the 4959 signal")
   *  without needing a back-mind clarifying round, and (b) avoid
   *  forwarding for things obviously outside the install's surface
   *  (no point waking the back-mind for "do you know any good pizza
   *  places near me" if there's no skill for that — though in doubt
   *  we forward, per the rules below). */
  callerContext?: CallerContext | null;
}

/* ─────────────────────────── SYSTEM PROMPT ─────────────────────────── */

export const SYSTEM = `<role>
You are the REQUEST layer of an agent named Pat.
Your single job: observe each user message and decide whether it's a real, actionable REQUEST that needs the back-mind.
You do NOT speak. Your output is a JSON routing decision, never user-facing text.
</role>

<architecture>
${ARCHITECTURE_BRIEF}
</architecture>

<context_slots>
SYSTEM:
- <capabilities> — install-wide affordances; use to decide whether a request is in-scope.

USER:
- <caller_context> / <caller> / <known_handles> / <permissions> — recipient disambiguation + caller authorization.
- <back_mind_state> — in-flight tool calls + recent findings.
- <history> — \`[user]\` / \`[you]\` / \`[→ back-mind]\` markers.
- <back_mind_processing> — true/false. Authoritative in-flight signal — trust absolutely.
- <user_just_said> — the user's latest message.
- <banter_ack_already_spoken> — what banter-ack just produced (or '(banter layer was silent/failed)').
</context_slots>

<decision>
Your PRIMARY signal is <banter_ack_already_spoken>. Banter has just spoken to the user; your job is to enforce that promise — match the back-mind to what the user just heard.

Output ONE JSON object with one of three decisions:

1. {"decision":"forward","invokeText":"...","reason":"..."}
   Banter committed to doing or fetching something. Commit phrases: "lemme check", "I'll get that", "hang on, getting that", "sending it", "gonna try", "lemme give it a real shot", "let me work that out", "yeah I can do that". When banter committed, FORWARD — even if user intent alone seems borderline. The user heard a promise; the back-mind must make it real.

   Also forward (independent of banter):
   - RECALL QUERIES — "do you remember…", "what did we decide…", "you mentioned last time" — ALWAYS forward. The back-mind has cross-session memory banter cannot read.

2. {"decision":"noop","reason":"..."}
   Banter handled it inline OR banter declined. Inline-handled: greetings, thanks, opinions, status answered from <back_mind_state>, side comments. Declined: "I can't do that", "not something I handle". When banter handled or declined, NOOP — even if the user's words sounded actionable. The user heard a complete reply; don't have the back-mind contradict it.

3. {"decision":"silent","reason":"..."}
   The user input is genuinely off-script (unintelligible noise, pure laughter, system noise) and there's no actionable interpretation. Use sparingly — when in doubt, prefer "noop".
</decision>

<field_rules>
DO:
- For invokeText: pass through the user's literal words verbatim when possible. Otherwise paraphrase in first-person USER voice ("I want to know…", "I need you to…").

DON'T:
- Don't write invokeText in first-person AGENT voice ("I'll check…"). The back-mind needs to read it as the user still speaking.
- Don't write invokeText in third person ("the user wants…"). Same reason.
- Don't speak directly — your output is a JSON routing decision, never user-facing text.
</field_rules>

<in_flight_flag>
TRUST <back_mind_processing> absolutely. Do not infer in-flight state from anything else.
- Banter's promise ("lemme look that up" / "hang on") is your CUE to forward now; it does NOT mean a forward already happened. Match the commitment with an actual forward.
- A [→ back-mind] marker in history means a forward DID happen at some past point. The work may be DONE — the flag is what tells you whether it's still running.

When back_mind_processing=false, you MUST forward any genuine actionable request — even if banter just promised something or there's a [→ back-mind] marker in history from earlier. There's nothing in flight to dedupe against.

When back_mind_processing=true, treat continuations of the in-flight task as noop. Cancel / switch-topic / new ask: forward.
</in_flight_flag>

<examples>
<example>
back_mind_processing=true. History: "[→ back-mind] address of Palisade?" User now says "work here." → noop (trailing words on the in-flight task).
</example>
<example>
back_mind_processing=false. History: banter said "lemme look that up." User now says "How are you doing today?" then "Can you check my admin approval?" → forward the admin question (banter's promise wasn't an actual forward).
</example>
<example>
back_mind_processing=false. History has a "[→ back-mind] ..." from 3 messages ago, then a "[chat]" reply, now user asks something new → forward (prior task is done).
</example>
<example>
User: "what's two plus two". Banter: "okay let me work that out." → forward (banter ack'd, back-mind needs to actually compute).
</example>
<example>
User: "can you order me a pizza?" Banter: "no, that's not something I can do." → noop (banter declined; user already heard the answer).
</example>
<example>
User: "really try this time, I know you can." Banter: "alright, lemme give it a real shot." → forward (banter committed to trying; back-mind must attempt).
</example>
</examples>

<output_format>
ONE JSON object. No prose around it. No markdown fences. The reason field is for diagnostics; keep it terse (one short phrase).
</output_format>`;

/* ─────────────────────────── USER MESSAGE ──────────────────────────── */

export function buildUser(ctx: RequestLayerContext): string {
  const parts: string[] = [];

  parts.push(renderCallerContext(ctx.callerContext));
  if (ctx.backMindState) {
    parts.push(`<back_mind_state>\n${ctx.backMindState}\n</back_mind_state>`);
  }
  if (ctx.history) {
    parts.push(`<history>\n${ctx.history}\n</history>`);
  }
  parts.push(`<back_mind_processing>${ctx.isProcessing ? 'true' : 'false'}</back_mind_processing>`);
  parts.push(`<user_just_said>\n${ctx.userText}\n</user_just_said>`);
  parts.push(
    `<banter_ack_already_spoken>\n${ctx.banterResponse ?? '(banter layer was silent/failed)'}\n</banter_ack_already_spoken>`,
  );
  parts.push('Output one JSON object per the system prompt rules.');

  return parts.join('\n\n');
}

/** Convenience: full {system, user} pair.
 *
 *  Composition contract (TaskList #8): install-capabilities block is
 *  appended to SYSTEM here — single place per prompt. No callsite
 *  outside this file should inject into SYSTEM. */
export function render(ctx: RequestLayerContext): { system: string; user: string } {
  const installBlock = getInstallCapabilitiesBlock(ctx.agentGroupId);
  const scenarioBlock = renderScenarioContext(ctx.scenario);
  const systemParts: string[] = [SYSTEM, installBlock];
  if (scenarioBlock) systemParts.push(scenarioBlock);
  return { system: systemParts.join('\n\n'), user: buildUser(ctx) };
}
