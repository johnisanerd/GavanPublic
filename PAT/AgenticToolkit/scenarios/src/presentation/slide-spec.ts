/**
 * Slide DSL — the canonical typed spec the agent authors and the
 * compile step renders. See `plans/presenter-channel-plan.md` for
 * design rationale. Layout vocabulary deliberately small (6
 * structured layouts + a `section` divider) — every successful
 * AI-slide tool we surveyed converges on a fixed-template approach.
 *
 * Mirror lives at `nanoclaw/container/agent-runner/src/lib/slide-spec.ts`
 * so the in-container MCP tool can validate before injection. Keep
 * the two in sync — the drift test (TODO Phase B) will enforce.
 */

/** Stage direction — a *suggested* mid-paragraph action with a beat
 *  anchor in the spoken text.
 *
 *  Default behavior: the agent renders `notes.spoken` verbatim and
 *  fires the action at the indicated beat. But the agent may deviate
 *  from the verbatim text (e.g. an audience member pushed back on
 *  wording mid-delivery, or the moment passed by the time the agent
 *  reached the anchor) — in which case the agent is responsible for
 *  firing this action itself via tool call at an appropriate moment,
 *  or explicitly acknowledging skipping it.
 *
 *  Not deterministic — see SKILL.md for the suggestion-not-hardwired
 *  philosophy. Strict-marker mode could be opted into per-direction
 *  later via a `strict?: true` flag.
 */
export interface StageDirection {
  /** Substring of `notes.spoken` to anchor at. Authored as a
   *  human-readable phrase; the action fires immediately after this
   *  substring is emitted to TTS. */
  after: string;
  /** 0-indexed occurrence of `after` to anchor at, when `after`
   *  appears multiple times in `notes.spoken`. Default 0 (first
   *  occurrence). Validator warns on multi-match without explicit
   *  `occurrence`. */
  occurrence?: number;
  /** MCP tool name registered for this packet. The orchestrator
   *  maps name → tool invocation at runtime. */
  action: string;
  /** JSON-serializable args passed to the tool. */
  args?: Record<string, unknown>;
  /** When true, the channel doesn't await the tool result before
   *  continuing TTS. Useful for long-running actions where blocking
   *  the spoken flow would be jarring. */
  fireAndForget?: boolean;
}

/** A single Q&A entry — anticipated audience question with prepared
 *  answer (either inline `a` or cross-reference `a_ref` into the
 *  packet's deep-context.md). */
export interface FaqEntry {
  q: string;
  a?: string;
  a_ref?: string;
}

export interface SlideNotes {
  /** Verbatim source the presenter renders. Default behavior is
   *  exact copy; agent may rephrase if context demands.
   *
   *  PAT: on-disk YAML packets may use a `Record<string, string>` shape
   *  too — the key is the anchor name a `<verbatim a="..."/>` directive
   *  splices in tag-stream mode. The host-side loader normalizes both
   *  shapes; the TS type stays string for the in-memory fixtures /
   *  dev preview to keep layout consumers simple. Object form is read
   *  directly by `realtime/src/scenario-action-stream.ts`. */
  spoken: string;
  /** Suggested mid-paragraph actions with beat anchors. See
   *  StageDirection doc — these are suggestions, not hardwired. */
  stage_directions?: StageDirection[];
  /** Reference material for the back-mind during Q&A. Not spoken
   *  unless the audience interrupts or asks something. */
  off_script?: {
    /** Anticipated audience questions with prepared answers. */
    faq?: FaqEntry[];
    /** Extra facts the agent can deploy if the moment is right.
     *  Not part of the default delivery. */
    additional_context?: string[];
    /** Pre-baked phrases for returning to the deck after an
     *  interrupt or pivot — the agent picks one to bridge back. */
    transitions?: string[];
  };
}

/** Base fields every spec shares. */
interface SlideBase {
  /** 1-indexed cursor position within the packet. */
  slide: number;
  /** Target spoken duration in seconds — used by the validator to
   *  flag specs that exceed their packet's overall budget. */
  duration_s?: number;
  notes: SlideNotes;
  /** Opt into reveal's `data-auto-animate` cross-slide animation,
   *  matching elements with the named prior slide. */
  auto_animate_from?: string;
}

// ─── Layout-specific specs ──────────────────────────────────────────

export interface TitleSpec extends SlideBase {
  layout: 'title';
  title: string;
  subtitle?: string;
  background?: {
    image?: string;
    color?: string;
    gradient?: string;
  };
}

export interface SectionSpec extends SlideBase {
  layout: 'section';
  label: string;
}

export interface BulletsSpec extends SlideBase {
  layout: 'bullets';
  title: string;
  items: string[];
  /** Reveal items one-by-one as fragments rather than all at once.
   *  When true, every `<li>` gets `class="fragment"`. */
  fragment?: boolean;
  /** Style preset: `default` for body-sized bullets; `large` for
   *  callout-style emphasis. */
  emphasis?: 'default' | 'large';
  figure?: string;
}

interface TwoColSlot {
  kind: 'text' | 'list' | 'figure' | 'code';
  /** For `text`: the prose. For `list`: items array. For `figure`:
   *  image path. For `code`: source. */
  body: string | string[];
  /** Language hint for `code` kind. */
  language?: string;
  /** Caption shown beneath a `figure` slot. */
  caption?: string;
}

export interface TwoColSpec extends SlideBase {
  layout: 'two-col';
  title?: string;
  left: TwoColSlot;
  right: TwoColSlot;
  /** CSS grid template; `1fr 1fr` (equal) is the default. */
  ratio?: string;
}

export interface ImageFullSpec extends SlideBase {
  layout: 'image-full';
  figure: string;
  caption?: string;
}

export interface QuoteSpec extends SlideBase {
  layout: 'quote';
  text: string;
  attribution?: string;
  source?: string;
}

/** Hero-stat layout — one massive number/figure with a short label.
 *  Brand-native scale (160-200pt). The persuasive-briefing primitive
 *  for landing a single quantitative beat ("81%", "10×", "$2/hr") that
 *  would otherwise get buried in a table or sentence. */
export interface StatSpec extends SlideBase {
  layout: 'stat';
  /** Hero number/figure rendered at ~6em. Short — "81%", "10×",
   *  "$1-2/hr", "30 min", "2:41". ≤ 12 chars. */
  value: string;
  /** Short label rendered below the value. Plain sentence-case
   *  description of what the value measures. ≤ 70 chars. */
  label: string;
  /** Optional eyebrow above the value — DM Mono caps, small. Used
   *  for context like the source or comparison reference. ≤ 50 chars. */
  context?: string;
  /** Background style. Default `stone` (light); `steel` for
   *  full-bleed statement variant. */
  background?: 'stone' | 'steel';
}

export interface TableSpec extends SlideBase {
  layout: 'table';
  title?: string;
  columns: string[];
  rows: string[][];
}

export type SlideSpec =
  | TitleSpec
  | SectionSpec
  | BulletsSpec
  | TwoColSpec
  | ImageFullSpec
  | QuoteSpec
  | StatSpec
  | TableSpec;

export type LayoutName = SlideSpec['layout'];

/** Packet-level manifest. Loaded once at deck start. */
export interface PacketManifest {
  /** Slug used for routing + group folder naming. Required. */
  slug: string;
  /** Human-readable title shown in the Scenarios tab. */
  title: string;
  /** Brief audience descriptor ("Senate staffer", "ML researcher"). */
  audience?: string;
  /** Soft cap in seconds; validator warns if sum(slide.duration_s) > this. */
  duration_budget_s?: number;
  /** Presenter persona; null means inherit the operator's default Pat
   *  avatar/voice. */
  persona?: {
    name?: string;
    avatar_id?: string;
    voice_id?: string;
  };
  /** Total slide count expected (sanity check at load). */
  slide_count: number;
  /** Layout-library version this packet was authored against. Used
   *  to surface mismatches at load — adding a layout in code is
   *  fine; removing one might silently break older packets. */
  layouts_version?: string;
}
