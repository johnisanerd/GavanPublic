/**
 * Channel orchestrator — owns the state carriers and the front-mind
 * inbound loop that's invariant across channel adapters.
 *
 * What it owns
 * ------------
 * - State carriers (per-thread): TtsBusyTracker, StreamingControllers,
 *   ConversationHistory, BanterBroadcast, plus the back-mind
 *   processing flag and the buffered-banter ring.
 * - `runStreamingFrontMind` — wraps a banter-* invocation with abort
 *   plumbing + structured logging + sample-rate delta logging.
 * - `handleUserMessage` — the full inbound loop: push user text →
 *   banter-ack → push pat text → request-layer decide → forward
 *   (via host callback) or buffer-banter.
 *
 * What it doesn't own
 * -------------------
 * - HTTP transport — each channel adapter has its own server + routes.
 * - Auto-provision of messaging-groups / agent-groups — touches host
 *   DB rows, stays adapter-side via direct nanoclaw imports.
 * - `config.onInbound` (router → inbound.db write) — adapter passes
 *   that as the `forwardToBackMind` callback on the inbound args.
 * - Container barge-in (`killContainer`) — adapter wires that to its
 *   own `/barge-in` handler.
 *
 * Design notes
 * ------------
 * Thread keys are caller-supplied (channel adapters know their thread-
 * key convention — PSTN uses Cartesia call ids, anam-web uses
 * `anam-web-call-<sessionId>`). The orchestrator doesn't construct
 * keys; it just routes carrier ops by the key the caller passes.
 *
 * Per-instance state — each adapter constructs its own orchestrator.
 * If we end up wanting a single host-wide instance later (e.g. to
 * share TtsBusyTracker across PSTN and anam-web because thread keys
 * never collide), that's a tiny refactor — the constructor stays
 * compatible.
 */

import { streamBanterAck, streamBanterRender, type BanterHistoryEntry } from './banter.js';
import type {
  BanterStreamCallbacks,
  BanterUtteranceSource,
  LlmCallHook,
} from './banter.js';
import { BanterBroadcast } from './banter-broadcast.js';
import { ConversationHistory } from './conversation-history.js';
import { phraseErrorAnnounce, type ErrorSource } from './error-surfacing.js';
import type { HostAdapter } from './host-adapter.js';
import type { CallerContext } from './prompts/_capability-context.js';
import type { ScenarioContext } from './prompts/_scenario-context.js';
import { requestLayerOnUserMessage } from './request-layer.js';
import type { RequestLayerDecision } from './request-layer.js';
import {
  ScenarioActionStream,
  actionsFromText,
  type ScenarioAction,
} from './scenario-action-stream.js';
// PAT: Phase 7 (Task #7) — banter-dispatch handles the per-<say> Haiku
// rewrite. Wired into the sequencer's onSay handler.
import { banterDispatch } from './banter-dispatch.js';
import { emptyBackMindState } from './state.js';
import { StreamingControllers } from './streaming-controllers.js';
import { TagStreamParser } from './tag-stream-parser.js';
// PAT: timeline runtime (plans/timeline-runtime-and-scenarios.md) —
// queue + sequencer per-thread, linear-contract dispatch with abort.
import {
  Sequencer,
  TimelineQueue,
  AbortError as TimelineAbortError,
  findExtensionFor,
  actionKindLabel,
  buildActionEnqueued,
  buildActionStarted,
  buildActionCompleted,
  buildActionCancelled,
  renderCompletedActions,
  renderInboxWithCompletedActions,
  renderInboxWrapper,
  type CompletedAction,
} from './timeline/index.js';
import type {
  CompletedActionRecord,
  DispatchContext,
  SequencerRunResult,
  TimelineAction,
} from './timeline/index.js';
import { TtsBusyTracker } from './tts-busy.js';

/** Same sampling rate both adapters used inline before the lift. */
const STREAM_DELTA_LOG_SAMPLE = 8;

/** Default model slug used in `utterance.stream-started` events when
 *  `FAST_MODEL` is unset. The value is purely log metadata — the actual
 *  provider routing is done inside `getFastProvider(...)`. */
const DEFAULT_FAST_MODEL_FALLBACK = 'anthropic/claude-haiku-4-5-20251001';

/** Default fallback spoken when banter-ack fails (not silent — actual
 *  error path). Both adapters used the same line; if a channel wants
 *  to override, pass `errorBanterFallback` to handleUserMessage. */
const DEFAULT_ERROR_BANTER_FALLBACK = "hmm, my front-mind isn't quite there — let me try anyway.";

export type StreamCancelReason = 'bargein' | 'superseded' | 'error';

/**
 * Composite thread key — `<platformId>:<threadId>` with a `__null__`
 * sentinel for the legacy unscoped thread. This is the key shape every
 * per-thread carrier (history, processing, streams, TTS-busy, intent
 * accumulator, buffered banter) routes by.
 *
 * Channel adapters call this to derive the same key the orchestrator
 * uses internally — keeps "what's my thread key?" answers consistent
 * across the inbound HTTP handler, the back-mind callback, and the
 * dashboard SSE poll loop.
 */
export function conversationKey(threadId: string | null, platformId: string): string {
  return `${platformId}:${threadId ?? '__null__'}`;
}

/** Caller-supplied transport callbacks. The orchestrator handles
 *  structured logging + abort bookkeeping; this is where the adapter
 *  emits to its channel-specific surface (SSE to dashboard, banter
 *  broadcast to browser, OpenAI-style chunks to chat-completions
 *  response, etc.). Optional — omit any callback that doesn't apply. */
export interface ChannelTransport {
  onStreamStarted?(): void;
  onDelta?(text_delta: string, seq: number): void;
  onEnd?(fullText: string, deltaCount: number, streamMs: number, firstDeltaMs: number): void;
  onCancelled?(reason: StreamCancelReason, partialText: string, deltaCount: number): void;
}

export interface RunStreamingFrontMindArgs<R> {
  source: BanterUtteranceSource;
  threadId: string | null;
  threadKey: string;
  platformId: string;
  /** Adapter-side transport emit (channel-specific). */
  transport: ChannelTransport;
  /** Calls the realtime-lib primitive
   *  (`streamBanterAck` / `streamBanterRender` /
   *  `streamBanterNarration`) with the abortSignal + callbacks the
   *  orchestrator supplies. Wires through the `BanterStreamCallbacks`
   *  contract — adapters typically pass-through args.onDelta/onEnd to
   *  their transport callback inside their `invoke`. */
  invoke: (cb: BanterStreamCallbacks & { abortSignal: AbortSignal; onCall: import('./banter.js').LlmCallHook }) => Promise<R>;
  /** Optional LLM-call trace hook for the dashboard. Forwarded to the
   *  realtime-lib primitive's `onCall`. */
  onLlmCall?: import('./banter.js').LlmCallHook;
}

/** Resolver shape for scenario-context lookup. Channel adapter
 *  (host-side, knows about packet paths) supplies this; orchestrator
 *  calls it per inbound / chat-row and threads the result through the
 *  four front-mind call sites (banter-ack, banter-render,
 *  banter-narration, request-layer). Return null for non-scenario
 *  sessions — orchestrator skips the threading and front-mind runs
 *  as default Pat. Sync or async; orchestrator awaits either way. */
export type ScenarioContextResolver = (
  platformId: string,
  threadId: string | null,
) => ScenarioContext | null | Promise<ScenarioContext | null>;

/** Resolver shape for per-inbound caller-context lookup. Channel
 *  adapter (host-side, has DB access) supplies this; orchestrator
 *  calls it once per inbound and threads the resolved `CallerContext`
 *  (identity + known handles + permissions) into every front-mind call
 *  site's USER message via the prompt's `render()` function.
 *
 *  The install-side capability surface (channels, MCP tools, skills,
 *  etc. — agent-group-scoped, stable across inbounds) lives in a
 *  separate cache populated at boot via `setInstallCapabilities` from
 *  `prompts/_capability-context.js`. The orchestrator does NOT call
 *  this resolver for install-state; it just forwards the
 *  `agentGroupId` through to the prompt files, which look up the
 *  cached install block. This is the lifecycle split that lets
 *  Anthropic's prompt cache stay effective on SYSTEM across inbounds.
 *
 *  Args carry the caller's senderId in addition to platformId/threadId
 *  because the caller block varies per inbound (different callers in
 *  the same agent group have different roles + different known
 *  handles).
 *
 *  Return null when the adapter chooses not to thread caller context
 *  (e.g. renditions with no inbound sender, tests). The renderer emits
 *  a stub block so the front-mind defers recipient + permissions
 *  questions safely. */
export type CallerContextResolver = (args: {
  agentGroupId: string;
  platformId: string;
  threadId: string | null;
  senderId: string;
}) => CallerContext | null | Promise<CallerContext | null>;

/** PAT: host-side dispatcher for non-prose scenario actions (nav,
 *  fragment, ask-questions, tool). Library stays neutral about
 *  HOW these are dispatched; nanoclaw wires this to a slide-bus POST
 *  client. Prose actions stay inside the library — they ride the
 *  renditionTransport that the channel adapter supplied. */
export type ScenarioActionDispatcher = (
  action: ScenarioAction,
  ctx: { scenario: ScenarioContext; threadId: string | null; platformId: string },
) => Promise<void> | void;

export interface ChannelOrchestratorOpts {
  host: HostAdapter;
  /** Override the carrier instances (mainly for testing). Library
   *  constructs sensible defaults otherwise. */
  carriers?: {
    tts?: TtsBusyTracker;
    streams?: StreamingControllers;
    history?: ConversationHistory;
    banter?: BanterBroadcast;
  };
  /** Optional: scenario-context resolver. When supplied, orchestrator
   *  calls it per inbound/chat-row and threads the result through all
   *  four front-mind call sites. Omitted (or returning null) ⇒ session
   *  runs as default Pat. */
  scenarioResolver?: ScenarioContextResolver;
  /** Optional: per-inbound caller-context resolver. When supplied,
   *  orchestrator calls it once per inbound and threads the resolved
   *  `CallerContext` (identity, suffix-matched known handles,
   *  permissions) through every front-mind call site's USER message.
   *
   *  Install-side capability state is NOT threaded through this
   *  resolver — it lives in a separate cache populated at boot via
   *  `setInstallCapabilities` (see `prompts/_capability-context.js`).
   *  Orchestrator just forwards `agentGroupId` to the prompt files,
   *  which look up the cached install block.
   *
   *  Omitted (or returning null) ⇒ the renderer emits a stub caller
   *  block, and the front-mind defers recipient + permissions
   *  questions to the back-mind. */
  callerContextResolver?: CallerContextResolver;
  /** Optional: host-side dispatcher for non-prose tag-stream actions.
   *  Fires per non-prose action (slide-nav, fragment, ask-questions,
   *  tool, etc.) when the scenario has `tag_stream_enabled` and the
   *  chat row is parsed as a tag stream. Prose actions are emitted
   *  via the renditionTransport regardless of whether this is set. */
  scenarioActionDispatcher?: ScenarioActionDispatcher;
}

/** Args passed to `forwardToBackMind` — the adapter-supplied callback
 *  that actually writes the inbound row + wakes the back-mind
 *  container (via nanoclaw's router on the host side). */
export interface ForwardArgs {
  threadId: string | null;
  platformId: string;
  /** The directive the back-mind should act on. Identical to
   *  rawInvokeText except in scenario tag-stream mode, where it carries
   *  a prepended `<session_state>` block. Prior banter context is no
   *  longer inlined here — it lives in messages_in as kind:'banter'
   *  rows and reaches the back-mind via the `<banter>` block. */
  invokeText: string;
  /** Sender attribution for the inbound row. Channels map this from
   *  caller_number → `pstn:<E164>` (phone-call) or pass the platform
   *  id directly (anam-web). */
  senderId: string;
  /** Convenience: the bare request-layer invokeText with no
   *  scenario-tag-stream prefix. Adapters that want to stamp the raw
   *  text into history use this. */
  rawInvokeText: string;
}

export interface HandleUserMessageArgs {
  threadId: string | null;
  threadKey: string;
  platformId: string;
  /** Agent group identifier this inbound is wired to. Threaded into
   *  every front-mind call site so the prompt files can look up the
   *  cached install-capabilities block via
   *  `getInstallCapabilitiesBlock(agentGroupId)`. Adapters resolve
   *  this from the messaging-group → agent-group wiring before calling
   *  in. Empty string is permitted (the prompts fall back to the stub
   *  install block) but discouraged. */
  agentGroupId: string;
  /** Per-session id used to scope banter broadcasts. Pass `null` for
   *  channels that don't broadcast (phone-call today). */
  sessionId: string | null;
  userText: string;
  /** Sender id passed through to `forwardToBackMind`. */
  senderId: string;
  /** PAT: channel this inbound arrived on ('phone-call' | 'anam-web' |
   *  ...). Stamped onto the `inbound.received` event's `channel_type` so
   *  the centralized store can slice a person's history by venue. The
   *  realtime library can't import the host's channel registry, so the
   *  adapter shim supplies it. Optional for back-compat; defaults to
   *  'unknown' on the emit. */
  channelType?: string;
  /** PAT: OPAQUE person id resolved from `senderId` via the people-spine in
   *  the nanoclaw shim (the realtime library cannot import the people-spine —
   *  nanoclaw depends on realtime, not the reverse). Passed in so the
   *  `inbound.received` event carries the person anchor. null when the
   *  sender isn't linked / resolution failed. NO person_name — names must
   *  never land beside message bodies in `pat_events`; the id→name mapping
   *  lives in the `pat_enrichment` directory stream, resolved at query time. */
  personId?: string | null;
  /** Transport callbacks for the banter-ack stream emission. */
  transport: ChannelTransport;
  /** Forward inbound to the back-mind. Throws → orchestrator logs the
   *  error.surfaced event and returns `{ forwarded: false, error }`
   *  in the result; the adapter decides whether to speak a fallback
   *  to the user. */
  forwardToBackMind(args: ForwardArgs): Promise<void>;
  /** Persist a banter line to the session's messages_in as kind:'banter',
   *  trigger=0. Called once per spoken banter ack (from='pat') and once
   *  per noop user aside (from='user'). The back-mind reads these on its
   *  next wake and renders them as `<banter><said from=...>` before the
   *  actionable `<messages>` block. Optional for backward-compat with
   *  adapters that don't yet implement it — the orchestrator silently
   *  skips when undefined. */
  recordBanter?: (args: { from: 'pat' | 'user'; text: string }) => Promise<void> | void;
  /** Optional LLM-call trace hook (request-layer + ack). */
  onLlmCall?: LlmCallHook;
  /** Optional override for the error-banter fallback line. */
  errorBanterFallback?: string;
}

export interface HandleUserMessageResult {
  /** What was actually said. Null = intentional silence. */
  banterText: string | null;
  /** Request-layer's decision. Adapters typically include this in
   *  their HTTP response body for observability. */
  decision: RequestLayerDecision;
  /** True if forwardToBackMind was called and returned without throwing. */
  forwarded: boolean;
  /** Set if forwardToBackMind threw. Adapter may speak a fallback. */
  forwardError?: Error;
}

/** Args for `deliverChat` — orchestrator's chat-row dedup +
 *  rendition entrypoint. Adapters call this on every kind='chat'
 *  outbound row their `deliver` receives. */
export interface DeliverChatArgs {
  threadId: string | null;
  threadKey: string;
  platformId: string;
  /** Agent group identifier the rendition is being voiced for. Drives
   *  the install-side capability lookup in banter-render. Empty string
   *  permitted (stub install block); discouraged. */
  agentGroupId: string;
  /** Raw chat text from the back-mind. Will go through banter rendition
   *  before TTS unless multiple rows accumulate, in which case rows are
   *  merged into one multi-context rendition. */
  rawText: string;
  /** Per-channel transport for the rendition stream's
   *  `utterance.stream-delta` / `-end` / `-cancelled` callbacks. The
   *  orchestrator's `runStreamingFrontMind` wraps the rendition call
   *  with this transport — deltas reach the adapter's broadcast surface
   *  (SSE to voice-transport, banter SSE to browser) in lockstep with
   *  the structured log emit. */
  renditionTransport: ChannelTransport;
  /** Optional LLM-call trace hook. Forwarded to `streamBanterRender`'s
   *  `onCall`. */
  onLlmCall?: LlmCallHook;
  /** Optional per-rendition hook. Fires once per rendition cycle (after
   *  the spoken text is decided, before next-queued-iteration). Used
   *  for channel-specific persistence (e.g. phone-call's on-disk
   *  rendition log). */
  onRendered?: (info: DeliverChatRenderInfo) => void;
}

export interface DeliverChatRenderInfo {
  /** What was actually spoken (rendition output, or first context on
   *  fallback). */
  spoken: string;
  /** Rendition model output. Null when the model failed or returned
   *  empty (orchestrator fell back to first context). */
  renderedText: string | null;
  /** All raw back-mind texts merged into this rendition (length=1 for
   *  single, length>1 for multi-context). */
  contexts: string[];
  /** Render call wall-clock. */
  renderMs: number;
}

/** Per-thread accumulator for back-to-back chat rows. See class doc
 *  for the algorithm. Internal — adapters interact only via
 *  `deliverChat` / `clearIntent`. */
interface IntentAccumulator {
  /** Set while one rendition+broadcast cycle is in flight. */
  current: string | null;
  /** Raw back-mind texts queued behind currentIntent. */
  pending: string[];
}

export class ChannelOrchestrator {
  readonly host: HostAdapter;
  readonly tts: TtsBusyTracker;
  readonly streams: StreamingControllers;
  readonly history: ConversationHistory;
  readonly banter: BanterBroadcast;

  /** Back-mind processing flag per thread. SINGLE source of truth,
   *  read by the request-layer (forward vs noop) and the narrator
   *  (gate on whether to fire fillers). Written:
   *    - true: `handleUserMessage` when request-layer decides forward
   *      (covers cold-spawn gap before container's `query-start`)
   *    - false: host calls `setProcessing(...)` on container's
   *      `query-end` detail event (authoritative end-of-work) */
  private processingByThread = new Map<string, boolean>();

  /** Per-thread back-mind chat-row accumulator. Multi-row chat output
   *  for one user request (structurally multi-part OR
   *  streaming-staggered) gets merged into ONE rendition call so the
   *  user hears one coherent multi-part utterance rather than 3 jerky
   *  one-liners. See `deliverChat` for the algorithm. */
  private intentAccByThread = new Map<string, IntentAccumulator>();

  /** PAT: per-thread tag-stream cursor — slide_n + fragment-reveal
   *  index + accumulated prose. Updated by `dispatchTagStream` as
   *  actions fire. Read by `handleUserMessage` when the forward
   *  decision happens in tag-stream mode so the audience-Q&A snapshot
   *  can be prepended to the next forward. */
  private tagStreamCursorByThread = new Map<
    string,
    {
      slide_n: number;
      fragment_idx: number;
      prose_so_far: string;
    }
  >();

  /** PAT: per-thread set of open `<timeline>` ids — the state-machine
   *  surface for delivering | conversing modes. Mutated by:
   *    - `timeline-started` action → add id, log `timeline.started`
   *    - `timeline-finished` action → remove id, log `timeline.finished`
   *      with reason='completed'
   *    - barge-in / cancel paths → force-close all open ids, log
   *      `timeline.finished` with reason='interrupted'
   *  `isDelivering(threadKey)` returns true iff the set is non-empty.
   *  The narrator reads this to skip its tick during delivery. */
  private timelineActiveByThread = new Map<
    string,
    Map<string /* timeline_id */, { startedAt: number; scenarioSlug?: string }>
  >();

  /** PAT: per-thread active Sequencer — set while a timeline runs,
   *  cleared on completion / abort. Lets barge-in paths reach in and
   *  abort the in-flight action. See `runTimelineSequence` /
   *  `abortTimelineSequence`. */
  private timelineSequencers = new Map<string /* threadKey */, Sequencer>();

  /** PAT: last completed-or-aborted sequencer run per thread. Surfaces
   *  the structured `<completed_actions>` block on the agent's next
   *  inbound forward (plans/timeline-runtime-and-scenarios.md §3.6.5).
   *  Cleared by `clearCompletedActionsBlock(threadKey)` once the host
   *  has folded it into a forward (so a follow-up turn doesn't re-stamp
   *  the same history). */
  private lastTimelineRunByThread = new Map<
    string /* threadKey */,
    {
      timelineId: string;
      reason: 'completed' | 'aborted';
      records: readonly CompletedActionRecord[];
      finishedAt: number;
    }
  >();

  private scenarioResolver: ScenarioContextResolver | null;
  private callerContextResolver: CallerContextResolver | null;
  private scenarioActionDispatcher: ScenarioActionDispatcher | null;

  constructor(opts: ChannelOrchestratorOpts) {
    this.host = opts.host;
    this.tts = opts.carriers?.tts ?? new TtsBusyTracker();
    this.streams = opts.carriers?.streams ?? new StreamingControllers();
    this.history = opts.carriers?.history ?? new ConversationHistory();
    this.banter = opts.carriers?.banter ?? new BanterBroadcast({
      onSubscriberError: (err) =>
        this.host.log.warn('banter subscriber threw', { err: String(err) }),
    });
    this.scenarioResolver = opts.scenarioResolver ?? null;
    this.callerContextResolver = opts.callerContextResolver ?? null;
    this.scenarioActionDispatcher = opts.scenarioActionDispatcher ?? null;
  }

  /** Resolve scenario meta for a platform_id + thread. Wraps the
   *  optional caller-supplied resolver, swallows errors (default Pat
   *  is the safe fallback), normalizes to `Promise<null |
   *  ScenarioContext>`. Resolver receives `threadId` so per-thread
   *  state (e.g. the in-memory scenario cursor) can vary across
   *  parallel sessions of the same scenario slug. */
  private async resolveScenario(platformId: string, threadId: string | null): Promise<ScenarioContext | null> {
    if (!this.scenarioResolver) return null;
    try {
      const r = this.scenarioResolver(platformId, threadId);
      return r instanceof Promise ? await r : r;
    } catch (err) {
      this.host.log.warn('scenarioResolver threw — running as non-scenario', {
        err: String(err),
        platformId,
      });
      return null;
    }
  }

  /** Resolve the per-inbound caller context. Wraps the optional
   *  caller-supplied resolver, swallows errors (the renderer emits a
   *  safe stub block on null), normalizes to `Promise<null |
   *  CallerContext>`. Receives `senderId` + `agentGroupId` because
   *  the context varies by who's talking AND which agent group they're
   *  talking to (role is caller-scoped per agent group).
   *
   *  Emits a `capability.caller-context-resolved` structured-log event
   *  at level='debug' EVERY call (whether the resolver was wired,
   *  returned null, threw, or returned a context). Trace-based
   *  smoketests read this to assert against the live caller surface
   *  the model actually saw. The install-side surface is emitted
   *  separately as `capability.install-resolved` (per agent group at
   *  boot / provision time). The smoketest joins the two by
   *  `agentGroupId` to reconstruct the full surface.
   */
  private async resolveCallerContext(args: {
    agentGroupId: string;
    platformId: string;
    threadId: string | null;
    senderId: string;
    callSite: 'inbound' | 'rendition';
  }): Promise<CallerContext | null> {
    let snapshot: CallerContext | null = null;
    let resolverError: string | undefined;
    if (this.callerContextResolver) {
      try {
        const r = this.callerContextResolver({
          agentGroupId: args.agentGroupId,
          platformId: args.platformId,
          threadId: args.threadId,
          senderId: args.senderId,
        });
        snapshot = r instanceof Promise ? await r : r;
      } catch (err) {
        resolverError = err instanceof Error ? err.message : String(err);
        this.host.log.warn('callerContextResolver threw — rendering stub caller block', {
          err: resolverError,
          platformId: args.platformId,
          sender_id: args.senderId,
        });
        snapshot = null;
      }
    }
    this.emitCallerContextResolved({
      agentGroupId: args.agentGroupId,
      threadId: args.threadId,
      platformId: args.platformId,
      senderId: args.senderId,
      callSite: args.callSite,
      resolverPresent: this.callerContextResolver !== null,
      snapshot,
      resolverError,
    });
    return snapshot;
  }

  /** Emit the `capability.caller-context-resolved` structured log
   *  event. Mirrors `CallerContext` field-for-field with snake_case
   *  wire keys. Single emit site so the payload stays consistent
   *  across inbound + rendition call sites. */
  private emitCallerContextResolved(args: {
    agentGroupId: string;
    threadId: string | null;
    platformId: string;
    senderId: string;
    callSite: 'inbound' | 'rendition';
    resolverPresent: boolean;
    snapshot: CallerContext | null;
    resolverError?: string;
  }): void {
    const snap = args.snapshot;
    const wireSnapshot: Record<string, unknown> | null = snap === null ? null : {
      ...(snap.agentGroupId !== undefined ? { agent_group_id: snap.agentGroupId } : {}),
      ...(snap.permissions !== undefined ? {
        permissions: {
          caller_role: snap.permissions.callerRole,
          ...(snap.permissions.callerVerbs !== undefined ? { caller_verbs: snap.permissions.callerVerbs } : {}),
          ...(snap.permissions.approvalGatedVerbs !== undefined ? { approval_gated_verbs: snap.permissions.approvalGatedVerbs } : {}),
        },
      } : {}),
      ...(snap.caller !== undefined ? {
        caller: snap.caller === null ? null : {
          platform_id: snap.caller.platformId,
          channel_type: snap.caller.channelType,
          ...(snap.caller.displayName !== undefined ? { display_name: snap.caller.displayName } : {}),
          ...(snap.caller.role !== undefined ? { role: snap.caller.role } : {}),
          ...(snap.caller.suffix !== undefined ? { suffix: snap.caller.suffix } : {}),
        },
      } : {}),
      ...(snap.knownHandles !== undefined ? {
        known_handles: snap.knownHandles.map((h) => ({
          platform_id: h.platformId,
          channel_type: h.channelType,
          ...(h.label !== undefined ? { label: h.label } : {}),
          suffix: h.suffix,
          ...(h.isCurrentCaller !== undefined ? { is_current_caller: h.isCurrentCaller } : {}),
        })),
      } : {}),
    };
    this.host.log.event({
      kind: 'capability.caller-context-resolved',
      level: 'debug',
      thread_id: args.threadId,
      platform_id: args.platformId,
      data: {
        agent_group_id: args.agentGroupId,
        call_site: args.callSite,
        resolver_present: args.resolverPresent,
        resolved: snap !== null,
        sender_id: args.senderId,
        ...(args.resolverError !== undefined ? { resolver_error: args.resolverError } : {}),
        snapshot: wireSnapshot,
      },
    });
  }

  /** PAT: true iff at least one `<timeline>` is currently active for
   *  the thread. Used by the narrator's gate (`isDelivering` opt) so
   *  filler narration is suppressed during scripted delivery. */
  isDelivering(threadKey: string): boolean {
    const set = this.timelineActiveByThread.get(threadKey);
    return Boolean(set && set.size > 0);
  }

  /** PAT: open a timeline for a thread. Emits `timeline.started` log
   *  event. Idempotent — a duplicate id on the same thread is a no-op. */
  private openTimeline(args: {
    threadKey: string;
    threadId: string | null;
    platformId: string;
    timelineId: string;
    scenarioSlug?: string;
  }): void {
    let set = this.timelineActiveByThread.get(args.threadKey);
    if (!set) {
      set = new Map();
      this.timelineActiveByThread.set(args.threadKey, set);
    }
    if (set.has(args.timelineId)) return;
    set.set(args.timelineId, { startedAt: Date.now(), scenarioSlug: args.scenarioSlug });
    this.host.log.event({
      kind: 'timeline.started',
      thread_id: args.threadId,
      platform_id: args.platformId,
      data: {
        timeline_id: args.timelineId,
        ...(args.scenarioSlug ? { scenario_slug: args.scenarioSlug } : {}),
      },
    });
  }

  /** PAT: close a single timeline by id. Emits `timeline.finished` with
   *  the supplied reason and computed duration_ms. */
  private closeTimeline(args: {
    threadKey: string;
    threadId: string | null;
    platformId: string;
    timelineId: string;
    reason: 'completed' | 'interrupted';
  }): void {
    const set = this.timelineActiveByThread.get(args.threadKey);
    if (!set) return;
    const entry = set.get(args.timelineId);
    if (!entry) return;
    set.delete(args.timelineId);
    if (set.size === 0) this.timelineActiveByThread.delete(args.threadKey);
    const durationMs = Date.now() - entry.startedAt;
    this.host.log.event({
      kind: 'timeline.finished',
      thread_id: args.threadId,
      platform_id: args.platformId,
      data: {
        timeline_id: args.timelineId,
        reason: args.reason,
        duration_ms: durationMs,
        ...(entry.scenarioSlug ? { scenario_slug: entry.scenarioSlug } : {}),
      },
    });
  }

  /** PAT: force-close every open timeline for a thread with reason
   *  `interrupted`. Called from barge-in / cancellation paths so the
   *  state machine flips back to conversing mode promptly. */
  private interruptTimelines(args: {
    threadKey: string;
    threadId: string | null;
    platformId: string;
  }): void {
    // PAT: abort any in-flight queue-driven Sequencer first so the
    // dispatch loop unwinds + records partial actions. The closeTimeline
    // emit below still pairs with the matching `timeline.started`.
    this.abortTimelineSequence(args.threadKey, 'bargein');
    const set = this.timelineActiveByThread.get(args.threadKey);
    if (!set || set.size === 0) return;
    for (const id of Array.from(set.keys())) {
      this.closeTimeline({
        threadKey: args.threadKey,
        threadId: args.threadId,
        platformId: args.platformId,
        timelineId: id,
        reason: 'interrupted',
      });
    }
  }

  /** Set the processing flag for a thread. Emits a `state.transitioned`
   *  structured-log event on every actual change so the dashboard can
   *  render the timeline of when the back-mind was working. Idempotent
   *  — setting to the same value is a no-op. */
  setProcessing(args: {
    threadKey: string;
    threadId: string | null;
    platformId: string;
    value: boolean;
  }): void {
    const prev = this.processingByThread.get(args.threadKey);
    this.processingByThread.set(args.threadKey, args.value);
    if (prev !== args.value) {
      this.host.log.event({
        kind: 'state.transitioned',
        thread_id: args.threadId,
        platform_id: args.platformId,
        data: {
          state: 'isProcessingNarration',
          from: prev ?? false,
          to: args.value,
        },
      });
    }
  }

  /** Current processing flag — false when unset. Read by the
   *  request-layer (`isProcessing` arg) and the narrator brain
   *  (`isProcessingNarration` callback). */
  isProcessing(threadKey: string): boolean {
    return this.processingByThread.get(threadKey) ?? false;
  }

  /**
   * PAT Phase 6: inline-expand a `<timeline_span from=N to=M/>` against
   * the current slide's authored timeline.
   *
   * Approach: pull `current_slide_authored_timeline` (the raw
   * `<timeline>...</timeline>` XML) off the scenario context, run it
   * through the standard parser + interpreter, slice the resulting
   * action stream to indices [from..to] inclusive, return the
   * adapted TimelineActions.
   *
   * Emits `timeline.span-hydrated` with the outcome (number of actions
   * inlined, or a reason when zero). The span ScenarioAction is dropped
   * from the queue regardless — silent skip on failure, no synthetic
   * error to the audience.
   */
  private hydrateTimelineSpan(
    span: { from: number; to: number },
    scenario: ScenarioContext | null | undefined,
  ): TimelineAction[] {
    const authored = scenario?.current_slide_authored_timeline ?? null;
    const slideN = scenario?.current_slide ?? -1;
    const emit = (
      inlined: number,
      authoredCount: number,
      reason?: 'no-authored-timeline' | 'out-of-range' | 'parse-failed',
    ): void => {
      this.host.log.event({
        kind: 'timeline.span-hydrated',
        thread_id: null,
        platform_id: null,
        data: {
          ...(scenario?.slug ? { scenario_slug: scenario.slug } : {}),
          slide_n: slideN,
          from: span.from,
          to: span.to,
          inlined,
          authored_count: authoredCount,
          ...(reason ? { reason } : {}),
        },
      });
    };
    if (!authored) {
      emit(0, 0, 'no-authored-timeline');
      return [];
    }
    // PAT Phase 6: the authored timeline uses explicit `<say>` blocks
    // (post-`<verbatim>` deprecation), so no anchor lookup is needed
    // when re-parsing for span hydration. Slide context is optional;
    // we omit it.
    let actions: ScenarioAction[];
    try {
      actions = actionsFromText(authored, undefined).actions;
    } catch {
      emit(0, 0, 'parse-failed');
      return [];
    }
    // Drop wrapper markers — the indices are over PLAYABLE actions.
    const playable = actions.filter(
      (a) => a.type !== 'timeline-started' && a.type !== 'timeline-finished',
    );
    if (span.from >= playable.length || span.to < span.from) {
      emit(0, playable.length, 'out-of-range');
      return [];
    }
    const sliceEnd = Math.min(span.to + 1, playable.length); // inclusive `to`
    const sliced = playable.slice(span.from, sliceEnd);
    const out: TimelineAction[] = [];
    for (const a of sliced) {
      // Defensive: spans referencing nested spans aren't supported (the
      // authored slide should never contain `<timeline_span/>`). If one
      // shows up, skip + warn — don't recurse.
      if (a.type === 'timeline-span') continue;
      const tla = scenarioActionToTimeline(a);
      if (tla) out.push(tla);
    }
    emit(out.length, playable.length);
    return out;
  }

  /**
   * Wrap a caller-supplied `onLlmCall` hook so every LlmCallTrace also
   * lands in the structured host log as `kind: 'llm.call'` at
   * `level: 'debug'`. Carries the full system prompt + user message +
   * response so post-mortem can reconstruct exactly what context the
   * model saw. /admin/logs.jsonl default-excludes debug; opt in with
   * `?include_debug=1` or `?levels=debug,info,warn,error`.
   *
   * The user's `onLlmCall` (if any) still fires — this tees, doesn't
   * replace.
   */
  private teeOnLlmCall(
    threadId: string | null,
    platformId: string | null,
    userOnCall: LlmCallHook | undefined,
  ): LlmCallHook {
    return (trace) => {
      this.host.log.event({
        kind: 'llm.call',
        level: 'debug',
        thread_id: threadId,
        platform_id: platformId ?? undefined,
        data: {
          layer: trace.layer,
          model: trace.model,
          system_prompt: trace.systemPrompt,
          user_message: trace.userMessage,
          response: trace.response,
          latency_ms: trace.latencyMs,
          ok: trace.ok,
          ...(trace.ttfbMs !== undefined ? { ttfb_ms: trace.ttfbMs } : {}),
          ...(trace.connectionReused !== undefined ? { connection_reused: trace.connectionReused } : {}),
          ...(trace.connectMs !== undefined ? { connect_ms: trace.connectMs } : {}),
          ...(trace.provider !== undefined ? { provider: trace.provider } : {}),
          ...(trace.upstreamProvider !== undefined ? { upstream_provider: trace.upstreamProvider } : {}),
          ...(trace.inputTokens !== undefined ? { input_tokens: trace.inputTokens } : {}),
          ...(trace.outputTokens !== undefined ? { output_tokens: trace.outputTokens } : {}),
          ...(trace.promptChars !== undefined ? { prompt_chars: trace.promptChars } : {}),
          ...(trace.error !== undefined ? { error: trace.error } : {}),
        },
      });
      userOnCall?.(trace);
    };
  }

  /** Drop the per-thread chat-row accumulator. Adapters call on
   *  barge-in and call-ended so any chat row already through the
   *  pipeline doesn't speak about a directive the caller has pivoted
   *  away from. Returns the count of dropped contexts (current + pending)
   *  for the caller's structured log. */
  clearIntent(threadKey: string, ctx?: { threadId: string | null; platformId: string }): number {
    const acc = this.intentAccByThread.get(threadKey);
    const dropped = (acc?.pending.length ?? 0) + (acc?.current ? 1 : 0);
    this.intentAccByThread.delete(threadKey);
    // PAT: force-close any open <timeline> wrappers for this thread —
    // barge-in / call-ended kills delivery, so timeline.finished should
    // fire with reason='interrupted'. We need threadId+platformId for
    // the log emit; if the caller didn't pass ctx we skip the close
    // (the timeline_id will leak in the map until next session ends).
    if (ctx) {
      this.interruptTimelines({
        threadKey,
        threadId: ctx.threadId,
        platformId: ctx.platformId,
      });
    } else {
      // Last-resort: still drop the state so isDelivering() returns
      // false even without a clean log emit.
      this.timelineActiveByThread.delete(threadKey);
    }
    return dropped;
  }

  /** Render and broadcast a back-mind chat row.
   *
   *  Algorithm (Path C dedup):
   *    - Single slot `current` marks "rendition in flight."
   *    - Additional rows arriving while `current` is held land on
   *      `pending`.
   *    - When `current` finishes AND `pending` is non-empty, drain
   *      pending into ONE rendition call ("voice these N pieces as one
   *      multi-part utterance: A, B, C") and broadcast the merged
   *      rendition.
   *    - Repeat until pending is empty.
   *    - `clearIntent(threadKey)` clears both (barge-in / call-ended).
   *
   *  Concurrency: serialized per-thread by the adapter's `deliver()`
   *  flow (host-core awaits each routeDelivery call). Multiple
   *  concurrent `deliverChat` calls per thread happen when the
   *  agent-runner writes chat rows back-to-back faster than rendition
   *  runs — `pending` is the shared queue across those.
   *
   *  Logs `intent.accumulated` when queued, `banter.rendered` (single)
   *  / `intent.rendered-multi` (multi) when broadcast. Stamps
   *  `tts.busy-marked` after marking the tracker. Pushes the rendition
   *  into history with `basedOnBackMindResults`. */
  async deliverChat(args: DeliverChatArgs): Promise<void> {
    // PAT 2026-05-25: per-step timing instrumentation. Localizes the
    // 16-second gap observed between `chat.row-received` and the first
    // `utterance.stream-started src=banter-rendition` on prod 8f04
    // call. `deliverChatT0` is the entry timestamp; every emit's
    // `elapsed_ms` is delta from it. Compute once, reuse across steps.
    const deliverChatT0 = Date.now();
    this.host.log.event({
      kind: 'deliver-chat.step',
      thread_id: args.threadId,
      platform_id: args.platformId,
      data: { step: 'enter', elapsed_ms: 0 },
    });
    // PAT: removed prewarm-sentinel safety net 2026-05-26 — paired with
    // the deletion of the back-mind prewarm path in
    // nanoclaw/container/agent-runner/src/poll-loop.ts (and the
    // /anam-web/prewarm routes in nanoclaw/src/channels/anam-web.ts).
    // The filter dropped `<<online>>` chat rows so the user never heard
    // the prewarm sentinel out loud; with prewarm gone there is no
    // sentinel to filter.
    const acc = this.intentAccByThread.get(args.threadKey) ?? { current: null, pending: [] };
    if (!this.intentAccByThread.has(args.threadKey)) {
      this.intentAccByThread.set(args.threadKey, acc);
    }
    if (acc.current !== null) {
      acc.pending.push(args.rawText);
      this.host.log.event({
        kind: 'intent.accumulated',
        thread_id: args.threadId,
        platform_id: args.platformId,
        data: { raw_text: args.rawText, pending_total: acc.pending.length },
      });
      this.host.log.event({
        kind: 'deliver-chat.step',
        thread_id: args.threadId,
        platform_id: args.platformId,
        data: { step: 'accumulated', elapsed_ms: Date.now() - deliverChatT0, pending_count: acc.pending.length },
      });
      return;
    }
    acc.current = args.rawText;
    let firstRaw: string | null = args.rawText;
    let iter = 0;
    try {
      while (firstRaw !== null) {
        this.host.log.event({
          kind: 'deliver-chat.step',
          thread_id: args.threadId,
          platform_id: args.platformId,
          data: { step: 'loop-iter', elapsed_ms: Date.now() - deliverChatT0, iter, pending_count: acc.pending.length },
        });
        const contexts: string[] = [firstRaw, ...acc.pending];
        // Drain pending — anything that lands during render below
        // repopulates it for the next loop iteration.
        acc.pending = [];
        const t0 = Date.now();
        const history = this.history.get(args.threadKey);
        const scenario = await this.resolveScenario(args.platformId, args.threadId);
        this.host.log.event({
          kind: 'deliver-chat.step',
          thread_id: args.threadId,
          platform_id: args.platformId,
          data: { step: 'scenario-resolved', elapsed_ms: Date.now() - deliverChatT0, iter },
        });
        // Rendition has no inbound sender — we're delivering the
        // back-mind's output. Pass empty senderId; the host-side
        // resolver should fall back to "most-recent caller on this
        // thread" or render with caller=null. Caller context (known
        // handles) is still useful so the rendition voice references
        // recipients correctly ("your Signal", not a literal number).
        // Install-side capability surface lives in SYSTEM via the
        // prompt's render() lookup against args.agentGroupId — no
        // per-rendition resolver call for that surface.
        const callerContext = await this.resolveCallerContext({
          agentGroupId: args.agentGroupId,
          platformId: args.platformId,
          threadId: args.threadId,
          senderId: '',
          callSite: 'rendition',
        });
        this.host.log.event({
          kind: 'deliver-chat.step',
          thread_id: args.threadId,
          platform_id: args.platformId,
          data: { step: 'caller-context-resolved', elapsed_ms: Date.now() - deliverChatT0, iter },
        });

        // PAT: tag-stream mode (`plans/presenter-tag-stream.md`). When
        // the scenario opts in, skip banter-render and parse each
        // chat row INDIVIDUALLY as its own tag stream. Verbatim
        // anchors are resolved against the current cursor at dispatch
        // time, so merging multiple queued chat rows would scramble
        // content (slide-nav inside one row advances the cursor, then
        // verbatim in the next row would resolve against the new
        // slide). For tag-stream we dispatch firstRaw alone and let
        // the outer loop drain pending one at a time.
        if (scenario?.tag_stream_enabled) {
          await this.dispatchTagStream({
            rawText: firstRaw,
            contextCount: 1,
            scenario,
            threadId: args.threadId,
            threadKey: args.threadKey,
            platformId: args.platformId,
            renditionTransport: args.renditionTransport,
            onLlmCall: args.onLlmCall,
            onRendered: args.onRendered,
          });
          // After dispatch, the cursor on this thread has advanced
          // (slide-nav fired during dispatch). Reload scenario for
          // the next pending row so verbatim resolution sees the new
          // cursor. The loop's next `resolveScenario` call will pick
          // it up automatically on continue.
          if (acc.pending.length === 0) {
            firstRaw = null;
          } else {
            firstRaw = acc.pending.shift()!;
          }
          continue;
        }

        // Single vs multi-context only differ in the renderer's user
        // message — pick the input text first, then run one rendition.
        const renderInput =
          contexts.length === 1
            ? contexts[0]!
            : contexts.map((c, i) => `[piece ${i + 1} of ${contexts.length}]\n${c}`).join('\n\n');
        let renderedText: string | null = null;
        let renderMs = 0;
        let renderErr: unknown = null;
        this.host.log.event({
          kind: 'deliver-chat.step',
          thread_id: args.threadId,
          platform_id: args.platformId,
          data: {
            step: 'before-runStreamingFrontMind',
            elapsed_ms: Date.now() - deliverChatT0,
            iter,
            input_chars: renderInput.length,
          },
        });
        try {
          const r = await this.runStreamingFrontMind<{ text: string | null; silent: boolean }>({
            source: 'banter-rendition',
            threadId: args.threadId,
            threadKey: args.threadKey,
            platformId: args.platformId,
            transport: args.renditionTransport,
            onLlmCall: args.onLlmCall,
            invoke: (cb) =>
              streamBanterRender({
                backMindText: renderInput,
                history,
                scenario,
                agentGroupId: args.agentGroupId,
                callerContext,
                ...cb,
              }),
          });
          renderedText = r.text;
          renderMs = Date.now() - t0;
        } catch (err) {
          renderErr = err;
          renderMs = Date.now() - t0;
        }
        this.host.log.event({
          kind: 'deliver-chat.step',
          thread_id: args.threadId,
          platform_id: args.platformId,
          data: {
            step: 'after-runStreamingFrontMind',
            elapsed_ms: Date.now() - deliverChatT0,
            iter,
            render_ms: renderMs,
          },
        });
        iter++;
        // Fallback chain: rendition → raw text of first context (others
        // would otherwise be dropped here, which is acceptable — they're
        // forensically captured in outbound.db).
        const spoken = renderedText && renderedText.trim().length > 0 ? renderedText : contexts[0]!;
        if (renderErr) {
          this.host.log.warn('chat → banter rendition threw; falling back to raw first context', {
            err: renderErr instanceof Error ? renderErr.message : String(renderErr),
            contextCount: contexts.length,
          });
          const errMsg = renderErr instanceof Error ? renderErr.message : String(renderErr);
          this.host.log.event({
            kind: 'error.surfaced',
            level: 'warn',
            thread_id: args.threadId,
            platform_id: args.platformId,
            data: {
              source: 'rendition',
              error_preview: errMsg,
              error_raw: errMsg,
              announced: false,
              debounce_suppressed: false,
            },
          });
        } else if (!renderedText) {
          this.host.log.warn('chat → banter rendition empty; falling back to raw first context', {
            renderMs,
            contextCount: contexts.length,
          });
          this.host.log.event({
            kind: 'error.surfaced',
            level: 'warn',
            thread_id: args.threadId,
            platform_id: args.platformId,
            data: {
              source: 'rendition',
              error_preview: 'rendition returned empty text (model silent or cleaned to nothing)',
              error_raw: 'rendition returned empty text (model silent or cleaned to nothing)',
              announced: false,
              debounce_suppressed: false,
            },
          });
        }
        // Forensic event — single vs multi tagged distinctly.
        if (contexts.length === 1) {
          this.host.log.event({
            kind: 'banter.rendered',
            thread_id: args.threadId,
            platform_id: args.platformId,
            data: {
              raw_text: contexts[0]!,
              rendered_text: spoken,
              render_ms: renderMs,
            },
          });
        } else {
          this.host.log.event({
            kind: 'intent.rendered-multi',
            thread_id: args.threadId,
            platform_id: args.platformId,
            data: {
              context_count: contexts.length,
              rendered_text: spoken,
              render_ms: renderMs,
            },
          });
        }
        // Mark TTS busy AFTER we know what we're broadcasting (the
        // pre-Path-C version computed est_dur_ms off the raw text,
        // which was wrong because the rendition is typically shorter).
        // ~11 chars/s mirrors realtime/src/narration.ts TTS_CHARS_PER_SEC;
        // 400ms padding matches the channel-internal beat for chat
        // renditions (vs the 1000ms padding the narrator uses).
        const estDurMs = (spoken.length / 11) * 1000 + 400;
        this.tts.markStarted(args.threadId, estDurMs);
        this.host.log.event({
          kind: 'tts.busy-marked',
          thread_id: args.threadId,
          platform_id: args.platformId,
          data: { est_dur_ms: estDurMs, text_preview: spoken.slice(0, 200) },
        });
        // Stamp into history — basedOnBackMindResults is the joined raw
        // contexts so multi-context grounding chain stays intact.
        this.history.push(args.threadKey, {
          role: 'pat',
          text: spoken,
          basedOnBackMindResults: contexts.join('\n\n---\n\n'),
        });
        // Adapter post-rendition hook (e.g. phone-call's persistRendition).
        args.onRendered?.({ spoken, renderedText, contexts, renderMs });
        // If anything accumulated WHILE we were rendering, drain it
        // into another rendition. Otherwise this is the natural exit.
        if (acc.pending.length === 0) {
          firstRaw = null;
        } else {
          firstRaw = acc.pending.shift()!;
        }
      }
    } finally {
      // Always release the slot, even on throw. A subsequent chat row
      // will start a fresh accumulator pass.
      acc.current = null;
      // Defensive: if clearIntent fired while we were running, the
      // subsequent deliverChat will lazily recreate the slot. No
      // stale state.
    }
  }

  /** Wraps a streaming front-mind call with the invariant bookkeeping
   *  (AbortController + structured logging + sample-rate delta
   *  logging + auto-clear of the streaming-controller slot). The
   *  adapter's `transport` callbacks fire after each invariant log
   *  emit so channel-specific output (SSE broadcast, chat-completions
   *  chunk, banter SSE) lands in lockstep. */
  async runStreamingFrontMind<R extends { text: string | null; silent: boolean }>(
    args: RunStreamingFrontMindArgs<R>,
  ): Promise<R> {
    const controller = new AbortController();
    const slot = this.streams.getOrCreate(args.threadKey);
    if (args.source === 'banter-ack') slot.ack = controller;
    else if (args.source === 'banter-rendition') slot.rendition = controller;
    else if (args.source === 'banter-narration') slot.narration = controller;

    const model = process.env.FAST_MODEL ?? DEFAULT_FAST_MODEL_FALLBACK;

    this.host.log.event({
      kind: 'utterance.stream-started',
      thread_id: args.threadId,
      platform_id: args.platformId,
      data: { source: args.source, model },
    });
    args.transport.onStreamStarted?.();

    const result = await args.invoke({
      abortSignal: controller.signal,
      onCall: this.teeOnLlmCall(args.threadId, args.platformId, args.onLlmCall),
      onDelta: (text_delta, seq) => {
        if (seq === 0 || seq % STREAM_DELTA_LOG_SAMPLE === 0) {
          this.host.log.event({
            kind: 'utterance.stream-delta',
            thread_id: args.threadId,
            platform_id: args.platformId,
            data: { source: args.source, text_delta, seq },
          });
        }
        args.transport.onDelta?.(text_delta, seq);
      },
      onEnd: (fullText, deltaCount, streamMs, firstDeltaMs) => {
        this.host.log.event({
          kind: 'utterance.stream-ended',
          thread_id: args.threadId,
          platform_id: args.platformId,
          data: {
            source: args.source,
            full_text: fullText,
            delta_count: deltaCount,
            stream_ms: streamMs,
            first_delta_ms: firstDeltaMs,
          },
        });
        args.transport.onEnd?.(fullText, deltaCount, streamMs, firstDeltaMs);
      },
      onCancelled: (reason, partialText, deltaCount) => {
        this.host.log.event({
          kind: 'utterance.stream-cancelled',
          level: reason === 'error' ? 'warn' : 'info',
          thread_id: args.threadId,
          platform_id: args.platformId,
          data: { source: args.source, reason, partial_text: partialText, delta_count: deltaCount },
        });
        args.transport.onCancelled?.(reason, partialText, deltaCount);
      },
    });

    this.streams.clear(args.threadKey, args.source);
    return result;
  }

  /** The full inbound loop for a user message. Runs end-to-end:
   *  1. Push user text to conversationHistory.
   *  2. Stream banter-ack via the front-mind primitive; transport
   *     callbacks receive the deltas.
   *  3. Decide intentional-silence vs error fallback vs spoken banter.
   *  4. Emit `banter.called` structured-log event.
   *  5. Push pat text to conversationHistory (when banter spoke).
   *  6. Call request-layer (`requestLayerOnUserMessage`).
   *  7. Emit `request-layer.decided` structured-log event.
   *  8. Forward branch: setProcessing(true), drain bufferedBanter,
   *     push 'forwarded' history entry, call host's
   *     `forwardToBackMind`. Surfaces errors via `error.surfaced`.
   *  9. Noop branch: push user turn into the buffered-banter ring.
   *
   *  Returns `{ banterText, decision, forwarded, forwardError }`.
   *  Adapters typically include `decision` + a spoke-bit in their
   *  HTTP response body. */
  async handleUserMessage(args: HandleUserMessageArgs): Promise<HandleUserMessageResult> {
    const fallback = args.errorBanterFallback ?? DEFAULT_ERROR_BANTER_FALLBACK;
    this.host.log.event({
      kind: 'inbound.received',
      thread_id: args.threadId,
      platform_id: args.platformId,
      data: {
        // PAT: channel_type + opaque person_id so a person-scoped query over
        // inbound.received works uniformly across realtime + chat-SDK
        // channels. Person is resolved in the nanoclaw shim (people-spine
        // can't be imported here) and passed in via args. NO person_name —
        // names live in the pat_enrichment directory, never beside bodies.
        channel_type: args.channelType ?? 'unknown',
        text: args.userText,
        sender: 'realtime-user',
        sender_id: args.senderId,
        person_id: args.personId ?? null,
      },
    });

    this.history.push(args.threadKey, { role: 'user', text: args.userText });
    const wm = emptyBackMindState();
    const currentHistory: BanterHistoryEntry[] = this.history.get(args.threadKey);
    // Resolve scenario context once for this inbound — same value
    // threaded into banter-ack and request-layer below. Null when not
    // a scenario session; non-null when packet lookup succeeded.
    const scenario = await this.resolveScenario(args.platformId, args.threadId);
    // Resolve per-inbound caller context — identity, suffix-matched
    // known handles, permissions for the caller against this agent
    // group. Same value threaded into every front-mind call site so
    // the model sees one consistent caller surface per inbound. Null
    // when no resolver was supplied; renderer emits a stub block.
    // The install-side capability surface (channels, MCP tools,
    // skills, etc.) lives in SYSTEM via the cached install block —
    // looked up inside each prompt's render() against args.agentGroupId.
    const callerContext = await this.resolveCallerContext({
      agentGroupId: args.agentGroupId,
      platformId: args.platformId,
      threadId: args.threadId,
      senderId: args.senderId,
      callSite: 'inbound',
    });

    // Banter-ack — what Pat says immediately.
    let banter: { text: string | null; silent: boolean };
    try {
      banter = await this.runStreamingFrontMind({
        source: 'banter-ack',
        threadId: args.threadId,
        threadKey: args.threadKey,
        platformId: args.platformId,
        transport: args.transport,
        onLlmCall: args.onLlmCall,
        invoke: (cb) =>
          streamBanterAck({
            userText: args.userText,
            backMindState: wm,
            history: currentHistory,
            scenario,
            agentGroupId: args.agentGroupId,
            callerContext,
            ...cb,
          }),
      });
    } catch (err) {
      this.host.log.warn('banter-ack threw', { err: String(err) });
      banter = { text: null, silent: false };
    }

    // Three cases:
    //   text != null            → speak it.
    //   text == null, silent    → model deliberately chose silence.
    //   text == null, !silent   → real failure → speak fallback so
    //                             the user doesn't hear dead air.
    //
    // Failure path: emit the fallback through the transport ourselves
    // (synthesizing a single delta + end frame). The streaming-front-mind
    // path only forwards real deltas, so without this the adapter would
    // see silent failure and have to special-case writing the line. By
    // routing it back through transport, every channel inherits "speak
    // the fallback" without per-adapter glue.
    let banterText: string | null;
    if (banter.text !== null) {
      banterText = banter.text;
    } else if (banter.silent) {
      banterText = null;
    } else {
      banterText = fallback;
      args.transport.onDelta?.(fallback, 0);
      args.transport.onEnd?.(fallback, 1, 0, 0);
    }
    this.host.log.event({
      kind: 'banter.called',
      thread_id: args.threadId,
      platform_id: args.platformId,
      data: {
        user_text: args.userText,
        response_text: banterText,
        intentionally_silent: banter.silent,
        failed: banter.text === null && !banter.silent,
      },
    });
    if (banterText !== null) {
      this.history.push(args.threadKey, { role: 'pat', text: banterText });
      // PAT: persist the spoken ack into messages_in as kind:'banter'
      // so the back-mind sees it as `<said from="pat">` on its next wake.
      // Best-effort; recordBanter throwing must not derail the inbound.
      if (args.recordBanter) {
        try {
          await args.recordBanter({ from: 'pat', text: banterText });
        } catch (err) {
          this.host.log.warn('recordBanter(pat) threw', { err: String(err) });
        }
      }
    }

    // Request layer — does this need the back-mind?
    let decision: RequestLayerDecision;
    try {
      decision = await requestLayerOnUserMessage({
        userText: args.userText,
        backMindState: wm,
        banterResponse: banter.text,
        history: currentHistory,
        isProcessing: this.isProcessing(args.threadKey),
        scenario,
        agentGroupId: args.agentGroupId,
        callerContext,
        onCall: this.teeOnLlmCall(args.threadId, args.platformId, args.onLlmCall),
      });
    } catch (err) {
      this.host.log.warn('request-layer threw — defaulting to noop', { err: String(err) });
      decision = { decision: 'noop', reason: 'request-layer threw' };
    }
    this.host.log.event({
      kind: 'request-layer.decided',
      thread_id: args.threadId,
      platform_id: args.platformId,
      data: {
        decision: decision.decision,
        invoke_text: decision.decision === 'forward' ? decision.invokeText : undefined,
        reason: decision.reason,
        is_processing: this.isProcessing(args.threadKey),
      },
    });

    if (decision.decision === 'forward') {
      // Flip processing ON host-side immediately — container's
      // `query-start` arrives 5-15s later during cold spawn; gating
      // only off it leaves a silent gap. query-end from the container
      // flips it back off authoritatively.
      this.setProcessing({
        threadKey: args.threadKey,
        threadId: args.threadId,
        platformId: args.platformId,
        value: true,
      });
      // PAT: prior noop user asides are now persisted as kind:'banter'
      // rows via recordBanter (see the noop branch below), so the
      // back-mind picks them up via the `<banter>` block on its next
      // wake. No prose-prepending here — invokeText goes through clean.
      let invokeText = decision.invokeText;
      // PAT: scenario tag-stream session_state. Prepend a structured
      // state block to EVERY forward in scenario tag-stream mode.
      // Carries: where the deck cursor is, what the agent last
      // delivered, how much of that prose the audience actually heard,
      // and (critically) what front-mind banter just said this turn so
      // the back-mind doesn't reuse the same opener. Replaces the old
      // qa_snapshot path: one mechanism, fires regardless of whether
      // the inbound is a continue-cue or an audience interrupt — the
      // back-mind decides how to interpret based on the inbound text.
      if (scenario?.tag_stream_enabled) {
        const cursor = this.tagStreamCursorByThread.get(args.threadKey);
        const lines: string[] = [];
        lines.push(`<session_state>`);
        lines.push(`  scenario_slug: ${scenario.slug}`);
        if (typeof scenario.slide_count === 'number') {
          lines.push(`  slide_count: ${scenario.slide_count}`);
        }
        if (typeof scenario.current_slide === 'number') {
          lines.push(`  cursor_now: slide ${scenario.current_slide}`);
        }
        lines.push(`  delivery_started: ${scenario.delivery_started ? 'yes' : 'no'}`);
        if (cursor) {
          lines.push(`  last_delivered_slide: ${cursor.slide_n}`);
          if (cursor.fragment_idx !== 0) lines.push(`  fragment_idx: ${cursor.fragment_idx}`);
          if (cursor.prose_so_far.length > 0) {
            lines.push(`  last_delivered_prose: "${cursor.prose_so_far.slice(-400).replace(/"/g, '\\"').replace(/\n/g, ' ')}"`);
          }
        } else {
          lines.push(`  last_delivered_slide: (none yet)`);
        }
        if (banterText) {
          lines.push(`  front_mind_already_said: "${banterText.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`);
        }
        lines.push(`</session_state>`);
        lines.push(``);
        lines.push(`Interpret the above + the audience/operator inbound below.`);
        lines.push(`If the inbound is an audience question, answer using packet`);
        lines.push(`material (notes.off_script, deep-context, audience-qa).`);
        lines.push(`If the inbound is a continue cue, deliver the next slide.`);
        if (banterText) {
          lines.push(`Front-mind already spoke "front_mind_already_said" to the`);
          lines.push(`audience — do not re-open with the same phrase or echo the`);
          lines.push(`ack. Start your answer mid-substance.`);
        }
        lines.push(``);
        lines.push(`Inbound: ${args.userText}`);
        lines.push(``);
        lines.push(`Request from request-layer: ${decision.invokeText}`);
        invokeText = lines.join('\n');
        this.host.log.info('inbound: prepended scenario session_state', {
          scenario_slug: scenario.slug,
          cursor_slide: scenario.current_slide,
          last_delivered: cursor?.slide_n ?? null,
          prose_chars: cursor?.prose_so_far.length ?? 0,
          front_mind_already_said_chars: banterText?.length ?? 0,
        });
      }
      // Stamp the forward into the unified history so the next
      // request-layer / banter / rendition call can see what the
      // back-mind is on.
      this.history.push(args.threadKey, { role: 'forwarded', text: decision.invokeText });
      try {
        await args.forwardToBackMind({
          threadId: args.threadId,
          platformId: args.platformId,
          invokeText,
          rawInvokeText: decision.invokeText,
          senderId: args.senderId,
        });
        return { banterText, decision, forwarded: true };
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        this.host.log.event({
          kind: 'error.surfaced',
          level: 'error',
          thread_id: args.threadId,
          platform_id: args.platformId,
          data: {
            source: 'host-routing',
            error_preview: e.message.length > 500 ? `${e.message.slice(0, 497)}…` : e.message,
            error_raw: e.message.length > 3000 ? `${e.message.slice(0, 2100)}\n…[truncated]…\n${e.message.slice(-900)}` : e.message,
            announced: false,
            debounce_suppressed: false,
          },
        });
        return { banterText, decision, forwarded: false, forwardError: e };
      }
    }

    // Noop / silent — banter handled it. Persist the user's aside as a
    // kind:'banter' row in messages_in so the back-mind sees it as
    // `<said from="user">` in the `<banter>` block on its next wake.
    // (Previously this was buffered in-memory and inlined as prose into
    // the next forward; the messages_in path is cleaner and survives
    // restarts.) recordBanter is optional; older adapters silently skip.
    if (args.recordBanter) {
      try {
        await args.recordBanter({ from: 'user', text: args.userText });
      } catch (err) {
        this.host.log.warn('recordBanter(user) threw', { err: String(err) });
      }
    }
    return { banterText, decision, forwarded: false };
  }

  /**
   * PAT observability emitter for Apify Actor run completion. Apify MCP
   * responses have rich shape (`run.id`, `run.status`,
   * `stats.computeUnits`, `data.items`) that's worth surfacing to the
   * dashboard timeline as a discrete event. This is vendor-specific by
   * parse — a generic "tool finished" event would lose the structured
   * fields. When a second tool wants comparable observability we should
   * grow a per-tool parser registry; until then, leave this Apify-only.
   *
   * Best-effort field extraction; falls through to status='UNKNOWN' on
   * unparseable bodies. Synchronous — pure log emit.
   */
  emitApifyRunCompleted(args: {
    sessionId: string;
    threadId: string | null;
    platformId: string;
    tool: string;
    failed: boolean;
    resultPreview?: string;
    error?: string;
    startMs?: number;
  }): void {
    const actorId = args.tool.replace(/^mcp__apify__/, '');
    const durationMs = args.startMs ? Math.max(0, Date.now() - args.startMs) : 0;

    let runId: string | undefined;
    let status: string = args.failed ? 'FAILED' : 'UNKNOWN';
    let itemsReturned: number | undefined;
    let cuCharged: number | undefined;

    if (!args.failed && args.resultPreview) {
      try {
        const parsed = JSON.parse(args.resultPreview) as Record<string, unknown>;
        // Apify MCP responses can return either a run object or the
        // dataset items directly. Look for the run object first; then a
        // top-level items array. Conservative — only set fields we can
        // actually find.
        const run =
          (parsed.run as Record<string, unknown> | undefined) ??
          (parsed.data as Record<string, unknown> | undefined);
        if (run && typeof run === 'object') {
          if (typeof run.id === 'string') runId = run.id;
          if (typeof run.status === 'string') status = run.status;
          const stats = run.stats as Record<string, unknown> | undefined;
          if (stats && typeof stats.computeUnits === 'number') cuCharged = stats.computeUnits;
        } else if (typeof parsed.id === 'string') {
          runId = parsed.id;
          if (typeof parsed.status === 'string') status = parsed.status;
        }
        if (status === 'UNKNOWN') status = 'SUCCEEDED'; // tool-post + parseable body
        if (Array.isArray(parsed.items)) itemsReturned = parsed.items.length;
        else if (Array.isArray((parsed.data as { items?: unknown[] } | undefined)?.items))
          itemsReturned = (parsed.data as { items: unknown[] }).items.length;
      } catch {
        // Unparseable result body — leave status as UNKNOWN. duration
        // still works, which is the load-bearing signal for budget /
        // observability.
      }
    }

    this.host.log.event({
      kind: 'apify.run-completed',
      session_id: args.sessionId,
      thread_id: args.threadId,
      platform_id: args.platformId,
      data: {
        actor_id: actorId,
        run_id: runId,
        status,
        duration_ms: durationMs,
        items_returned: itemsReturned,
        cu_charged: cuCharged,
      },
    });
  }

  /**
   * PAT: tag-stream chat row dispatch. Bypasses banter-render and
   * parses the chat row into a ScenarioAction stream
   * (`plans/presenter-tag-stream.md`). Prose actions ride the
   * renditionTransport so they reach Anam via the existing banter
   * SSE channel (synthesized as one fake utterance with text deltas
   * — no second Haiku call). Non-prose actions go to the host
   * dispatcher (nav, fragment, tool, ask-questions). Emits
   * `scenario.tag-stream-started`, one `scenario.action` per
   * dispatched action, and `scenario.tag-stream-ended` for the
   * dashboard.
   */
  private async dispatchTagStream(args: {
    rawText: string;
    contextCount: number;
    scenario: ScenarioContext;
    threadId: string | null;
    threadKey: string;
    platformId: string;
    renditionTransport: ChannelTransport;
    onLlmCall?: LlmCallHook;
    onRendered?: (info: DeliverChatRenderInfo) => void;
  }): Promise<void> {
    const t0 = Date.now();
    const slideN = args.scenario.current_slide ?? -1;
    // PAT: reset per-slide cursor at the start of a fresh tag stream.
    // Q&A interrupt snapshot reads from this; reset on every new tag
    // stream so prior-slide state doesn't bleed forward.
    const cursorSlot = {
      slide_n: slideN,
      fragment_idx: 0,
      prose_so_far: '',
    };
    this.tagStreamCursorByThread.set(args.threadKey, cursorSlot);
    this.host.log.event({
      kind: 'scenario.tag-stream-started',
      thread_id: args.threadId,
      platform_id: args.platformId,
      data: {
        scenario_slug: args.scenario.slug,
        slide_n: slideN,
        raw_chars: args.rawText.length,
      },
    });

    // Synthesize a single rendition utterance carrying ALL prose
    // actions as deltas. Reuses the existing banter-rendition wire
    // path (TTS-busy marking, banter SSE broadcast, browser
    // talkStream pipe) without invoking the Haiku rewrite layer.
    // ALSO emits the structured `utterance.stream-*` log events so
    // dashboards / E2E harnesses (which subscribe to /anam-web/events
    // tail of the host log) see the prose as a rendition utterance,
    // identical to how the banter-render path is observed.
    const utteranceSource: BanterUtteranceSource = 'banter-rendition';
    let seq = 0;
    let prosePromise = Promise.resolve();
    let proseStreamOpen = false;
    let proseAccum = '';
    let firstDeltaMs = -1;
    const streamStartedAt = Date.now();
    const transport = args.renditionTransport;
    const ensureProseStream = (): void => {
      if (proseStreamOpen) return;
      proseStreamOpen = true;
      this.host.log.event({
        kind: 'utterance.stream-started',
        thread_id: args.threadId,
        platform_id: args.platformId,
        data: { source: utteranceSource, model: 'tag-stream-passthrough' },
      });
      transport.onStreamStarted?.();
    };
    const sendProseDelta = (text: string): void => {
      if (text.length === 0) return;
      ensureProseStream();
      if (firstDeltaMs < 0) firstDeltaMs = Date.now() - streamStartedAt;
      // Sample-rate log emit (matches runStreamingFrontMind sampling).
      if (seq === 0 || seq % 8 === 0) {
        this.host.log.event({
          kind: 'utterance.stream-delta',
          thread_id: args.threadId,
          platform_id: args.platformId,
          data: { source: utteranceSource, text_delta: text, seq },
        });
      }
      transport.onDelta?.(text, seq);
      proseAccum += text;
      seq++;
    };
    let actionCount = 0;
    let terminator = 'none';
    const dispatcher = this.scenarioActionDispatcher;
    const fireDispatcher = (action: ScenarioAction): void => {
      if (!dispatcher) return;
      // Best-effort fire-and-forget; the host dispatcher returns void
      // or Promise<void>. We don't await here so prose flow isn't
      // serialized on slide-bus POST latency. Errors get logged
      // inside the dispatcher (see slide-bus-client.ts).
      try {
        const ret = dispatcher(action, {
          scenario: args.scenario,
          threadId: args.threadId,
          platformId: args.platformId,
        });
        if (ret && typeof (ret as Promise<unknown>).then === 'function') {
          (ret as Promise<unknown>).catch((err) => {
            this.host.log.warn('scenarioActionDispatcher threw', { err: String(err) });
          });
        }
      } catch (err) {
        this.host.log.warn('scenarioActionDispatcher sync-threw', { err: String(err) });
      }
    };
    const emitActionEvent = (action: ScenarioAction, actionSeq: number): void => {
      const data: Record<string, unknown> = {
        scenario_slug: args.scenario.slug,
        action_type: action.type,
        slide_n: slideN,
        seq: actionSeq,
      };
      switch (action.type) {
        case 'prose':
          data.text = action.text.length > 280 ? `${action.text.slice(0, 277)}…` : action.text;
          break;
        case 'slide-nav':
          data.direction = action.direction;
          break;
        case 'slide-goto':
          data.target_slide = action.target_slide;
          break;
        case 'fragment':
          data.fragment_direction = action.direction;
          break;
        case 'tool':
          data.tool_name = action.tool_name;
          data.tool_args = action.tool_args;
          break;
        case 'pause':
          // PAT Phase 6: ms goes through `direction` since the
          // scenario.action payload doesn't have a dedicated ms field
          // and `direction` is the loosest existing slot. The
          // timeline.action-enqueued event for the pause carries
          // attrs.ms cleanly.
          data.direction = `${action.ms}ms`;
          break;
        case 'cartesia-passthrough':
          data.raw_tag = action.tag;
          break;
        case 'unknown-tag':
          data.raw_tag = action.raw_tag;
          data.text = action.passthrough_text.slice(0, 200);
          break;
        case 'ask-questions':
          break;
        case 'timeline-started':
        case 'timeline-finished':
          // No extra scenario.action fields — the dedicated
          // timeline.started / timeline.finished log events carry the
          // detail. We still emit a scenario.action for per-action
          // observability so the dashboard's scenario.action lane sees
          // the bracket alongside the inline actions.
          data.timeline_id = action.timeline_id;
          break;
      }
      this.host.log.event({
        kind: 'scenario.action',
        thread_id: args.threadId,
        platform_id: args.platformId,
        data: data as never,
      });
    };

    // PAT: Phase 7 (Task #7) — collect ScenarioActions into an array,
    // adapt them to TimelineActions, then drive via runTimelineSequence.
    // The legacy fire-and-forget per-action handler path is gone; the
    // sequencer's onSay / domain dispatch path replaces it.
    //
    // Why collect-then-drive rather than streaming-into-queue: the
    // parser delivers actions synchronously as it consumes raw text;
    // back-mind chat rows are fully buffered by the time we land here
    // (no token-streaming inbound). Collecting upfront keeps the
    // sequencer's enqueue-then-run model simple and lets us count
    // actions for the legacy scenario.tag-stream-* observability
    // events without an extra pass.
    const collected: ScenarioAction[] = [];
    let collectedTimelineId: string | null = null;
    const parser = new TagStreamParser();
    const stream = new ScenarioActionStream({
      slide: slideN > 0 ? { slide_n: slideN } : undefined,
      onAction: (action, actionSeq) => {
        actionCount++;
        emitActionEvent(action, actionSeq);
        if (action.type === 'timeline-started') {
          collectedTimelineId = action.timeline_id;
          this.openTimeline({
            threadKey: args.threadKey,
            threadId: args.threadId,
            platformId: args.platformId,
            timelineId: action.timeline_id,
            scenarioSlug: args.scenario.slug,
          });
          return;
        }
        if (action.type === 'timeline-finished') {
          // Defer closeTimeline until after the sequencer drains —
          // the wrapper's `reason` depends on whether the sequencer
          // completed cleanly or was interrupted mid-play. Recorded
          // here so we know the wrapper id even when the agent forgot
          // the closing tag (interpreter auto-closes on end()).
          collectedTimelineId = action.timeline_id;
          return;
        }
        collected.push(action);
      },
      onTerminator: (t) => {
        terminator = t;
      },
    });
    for (const ev of parser.push(args.rawText)) stream.feed(ev);
    for (const ev of parser.end()) stream.feed(ev);
    stream.end();

    // Update Q&A snapshot cursor from collected actions. (Was inline
    // in the legacy onAction; lifted here so the snapshot accuracy
    // doesn't depend on sequencer's per-action timing.) prose_so_far
    // is accumulated inside the per-say handler below as each beat
    // actually plays — that captures interrupted mid-stream correctly.
    for (const a of collected) {
      if (a.type === 'fragment') {
        cursorSlot.fragment_idx += a.direction === 'next' ? 1 : -1;
      }
    }

    // Adapt ScenarioActions → TimelineActions. The scenarios.presentation
    // extension (Phase 5) is registered globally and recognizes the
    // DomainAction.domainKind values produced here, dispatching via
    // `ctx.host.scenarioActionDispatcher`. Prose becomes a single say
    // each (linear contract); cartesia / unknown-tag stay in prose
    // so the rendition stream picks them up.
    //
    // PAT Phase 6: `timeline-span` ScenarioActions don't map to a single
    // TimelineAction — they expand inline against the slide's authored
    // timeline. `hydrateTimelineSpan` parses the authored XML and slices
    // [from..to]. On missing-source / out-of-range / parse-failure it
    // emits a `timeline.span-hydrated` event with `reason` set and
    // returns zero actions (the span is silently dropped from the
    // queue; the agent's prose around it still plays).
    const timelineActions: TimelineAction[] = [];
    for (const a of collected) {
      if (a.type === 'timeline-span') {
        const expanded = this.hydrateTimelineSpan(a, args.scenario);
        for (const t of expanded) timelineActions.push(t);
        continue;
      }
      const tla = scenarioActionToTimeline(a);
      if (tla) timelineActions.push(tla);
    }

    // Synthesize a timeline_id when the parser didn't emit a wrapper.
    // Pre-Phase-7 packets without `<timeline>...</timeline>` still
    // play through the new sequencer — they just don't bracket the
    // wrapper-lifecycle events.
    const effectiveTimelineId =
      collectedTimelineId ?? `tl-syn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const hadExplicitTimeline = collectedTimelineId !== null;
    if (!hadExplicitTimeline && timelineActions.length > 0) {
      // No wrapper but we have actions to play — open a synthetic
      // wrapper for state-machine bookkeeping (isDelivering=true while
      // the sequencer drains). Closed below with the appropriate reason.
      this.openTimeline({
        threadKey: args.threadKey,
        threadId: args.threadId,
        platformId: args.platformId,
        timelineId: effectiveTimelineId,
        scenarioSlug: args.scenario.slug,
      });
    }

    // Spoken accumulator — collected from each per-say handler's
    // banter-dispatched output so the post-stream bookkeeping (history
    // push, onRendered, TTS-busy mark) sees the actual broadcast text.
    let totalSpoken = '';
    const totalStreamStartedAt = Date.now();
    let totalFirstDeltaMs = -1;
    let totalDeltaCount = 0;
    const utteranceSourceForSay: BanterUtteranceSource = 'banter-rendition';
    const orchestratorSelf = this;

    const handlers: TimelineBaseHandlers = {
      onSay: async (action, ctx) => {
        // 1. Banter-dispatch — Haiku rewrite per-say. Failure falls back
        //    to the authored text; the call is bounded by ctx.signal so
        //    barge-in cancels the in-flight Haiku immediately.
        const history = orchestratorSelf.history.get(args.threadKey);
        const out = await banterDispatch({
          say: { text: action.text, target: action.target },
          scenario: args.scenario,
          recentHistory: history,
          onCall: args.onLlmCall,
          signal: ctx.signal,
        });
        const spoken = out.ok ? out.rewritten : out.raw;

        // 2. Structured-log emit — banter-dispatch.called per beat. Same
        //    shape banter-wire's BanterDispatchCalledLogData declares.
        orchestratorSelf.host.log.event({
          kind: 'banter-dispatch.called',
          thread_id: args.threadId,
          platform_id: args.platformId,
          data: {
            input_text: out.raw,
            output_text: spoken,
            latency_ms: out.latency_ms,
            ok: out.ok,
            ...(out.error ? { error: out.error } : {}),
          },
        });

        // 3. Capture partial-text — the sequencer threads
        //    capturePartialText through ctx. Stamp before opening the
        //    TTS stream so a barge-in lands the spoken prefix on
        //    `<completed_actions>` correctly.
        ctx.capturePartialText?.(spoken);

        // 4. Open a fresh per-say rendition utterance — linear contract
        //    means each say is its own stream with start / single delta
        //    / end. Reuses the banter-rendition wire path so dashboard
        //    + browser see identical utterance.stream-* events.
        const sayStartedAt = Date.now();
        orchestratorSelf.host.log.event({
          kind: 'utterance.stream-started',
          thread_id: args.threadId,
          platform_id: args.platformId,
          data: { source: utteranceSourceForSay, model: 'tag-stream-passthrough' },
        });
        transport.onStreamStarted?.();
        if (totalFirstDeltaMs < 0) {
          totalFirstDeltaMs = sayStartedAt - totalStreamStartedAt;
        }
        const deltaSeq = totalDeltaCount;
        orchestratorSelf.host.log.event({
          kind: 'utterance.stream-delta',
          thread_id: args.threadId,
          platform_id: args.platformId,
          data: { source: utteranceSourceForSay, text_delta: spoken, seq: deltaSeq },
        });
        transport.onDelta?.(spoken, deltaSeq);
        totalDeltaCount += 1;

        // 5. Mark TTS busy (with an est-dur fallback so the narrator's
        //    isBusy() gate still works), close the per-say stream so
        //    the transport tells the browser "no more deltas," then
        //    await the transport's actual end-of-audio signal via
        //    TtsBusyTracker.waitForEnded. Channels call markEnded() on
        //    the back-channel signal (anam-web: browser endOfSpeech;
        //    phone-call: Cartesia AgentTurnEnded), so this binds the
        //    linear contract to real audience-perceptible completion
        //    rather than a length estimate. The fallback timer inside
        //    waitForEnded fires after ~1.5x the est-dur if the
        //    back-channel drops, so the timeline never wedges.
        //
        // PAT (2026-05-19): tuned slightly faster than the original
        // chars/11 + 400ms — user feedback was the demo had too much
        // dead air between says. chars/13 + 200 trims ~20% off each
        // say. Risk: small clip on the previous say's tail if Anam
        // is slow. Adjust here if you hear either clipping or gaps.
        const estDurMs = (spoken.length / 13) * 1000 + 200;
        orchestratorSelf.tts.markStarted(args.threadId, estDurMs);
        orchestratorSelf.host.log.event({
          kind: 'tts.busy-marked',
          thread_id: args.threadId,
          platform_id: args.platformId,
          data: { est_dur_ms: estDurMs, text_preview: spoken.slice(0, 200) },
        });
        // Close the per-say stream FIRST — the browser needs the
        // "end of utterance" signal before it can fire endOfSpeech
        // (which is what triggers markEnded → resolves waitForEnded).
        const preWaitMs = Date.now() - sayStartedAt;
        orchestratorSelf.host.log.event({
          kind: 'utterance.stream-ended',
          thread_id: args.threadId,
          platform_id: args.platformId,
          data: {
            source: utteranceSourceForSay,
            full_text: spoken,
            delta_count: 1,
            stream_ms: preWaitMs,
            first_delta_ms: 0,
          },
        });
        transport.onEnd?.(spoken, 1, preWaitMs, 0);

        try {
          // PAT (2026-05-19 revert of 6cbd60f for anam-web): gate the
          // say's completion on the char-count duration estimate, NOT
          // on the markEnded back-channel. The earlier commit assumed
          // Anam's `endOfSpeech` was the audience-perceptible audio-end
          // signal like Cartesia's `AgentTurnEnded`; it isn't — Anam
          // fires endOfSpeech when the *text* stream ends, often 3-5s
          // before the audio actually finishes rendering. The sequencer
          // was advancing to the next say before the previous one was
          // audible. The chars/11 + 400ms estimate above is the
          // pre-6cbd60f primary timer that was working. Cartesia loses
          // a small amount of precision (estimate vs real
          // AgentTurnEnded) but never under-waits.
          //
          // markEnded is still tracked via markStarted (above) so the
          // narrator's isBusy() gate keeps working — that's a different
          // consumer with looser semantics.
          await runCancellablePause(estDurMs, ctx.signal);
        } catch (err) {
          // runCancellablePause throws TimelineAbortError on signal
          // abort — sequencer's isAbortError() picks it up by
          // duck-type.
          // On cancel: emit the cancelled signal so the transport can
          // mark partial / clean up. Let the rejection propagate so
          // the sequencer records the action as partial.
          orchestratorSelf.host.log.event({
            kind: 'utterance.stream-cancelled',
            thread_id: args.threadId,
            platform_id: args.platformId,
            level: 'info',
            data: {
              source: utteranceSourceForSay,
              reason: 'bargein',
              partial_text: spoken,
              delta_count: 1,
            },
          });
          transport.onCancelled?.('bargein', spoken, 1);
          // Still accumulate spoken — partial counts toward what the
          // audience heard for history / cursor purposes.
          totalSpoken += spoken;
          cursorSlot.prose_so_far += spoken;
          throw err;
        }

        totalSpoken += spoken;
        cursorSlot.prose_so_far += spoken;
      },

      onTool: async (action, ctx) => {
        // Phase 4 stub — actual round-trip lands later. Log only,
        // sequencer treats as instant-complete so the timeline keeps
        // moving. Async variant behaves identically here.
        orchestratorSelf.host.log.warn(
          'timeline: tool action not yet round-tripping (Phase 4)',
          {
            tool: action.name,
            timeline_id: ctx.timelineId,
            seq: ctx.seq,
            async: action.async === true,
          },
        );
      },

      onWaitForCue: async (action, ctx) => {
        // No host-side cue subscriber wired yet — emit + resolve so
        // the sequencer keeps moving. Concrete demos can wire a
        // host-side cue store later (plan §9 open item).
        orchestratorSelf.host.log.warn('timeline: wait-for-cue without subscriber — instant-resolve', {
          cue: action.cue,
          timeline_id: ctx.timelineId,
          seq: ctx.seq,
        });
      },
    };

    let timelineRunReason: 'completed' | 'aborted' = 'completed';
    if (timelineActions.length > 0) {
      const result = await this.runTimelineSequence({
        timelineId: effectiveTimelineId,
        threadKey: args.threadKey,
        threadId: args.threadId,
        platformId: args.platformId,
        actions: timelineActions,
        handlers,
        host: {
          scenario: args.scenario,
          scenarioActionDispatcher: this.scenarioActionDispatcher,
        },
      });
      timelineRunReason = result.reason;
    }

    // Close the timeline wrapper (synthetic or explicit). Closed-with-
    // reason mirrors the sequencer's outcome: 'completed' on clean
    // drain, 'interrupted' on abort.
    if (hadExplicitTimeline || timelineActions.length > 0) {
      this.closeTimeline({
        threadKey: args.threadKey,
        threadId: args.threadId,
        platformId: args.platformId,
        timelineId: effectiveTimelineId,
        reason: timelineRunReason === 'completed' ? 'completed' : 'interrupted',
      });
    }

    // Quiet the now-unused legacy synthesized-stream state so any later
    // reference is provably noop. The new per-say renditions emit the
    // utterance.stream-* events themselves.
    void utteranceSource;
    void prosePromise;
    void proseStreamOpen;
    void proseAccum;
    void seq;
    void firstDeltaMs;
    void streamStartedAt;
    void ensureProseStream;
    void sendProseDelta;
    void fireDispatcher;

    this.history.push(args.threadKey, {
      role: 'pat',
      text: totalSpoken,
      basedOnBackMindResults: args.rawText,
    });
    args.onRendered?.({
      spoken: totalSpoken,
      renderedText: totalSpoken,
      contexts: [args.rawText],
      renderMs: Date.now() - t0,
    });

    this.host.log.event({
      kind: 'scenario.tag-stream-ended',
      thread_id: args.threadId,
      platform_id: args.platformId,
      data: {
        scenario_slug: args.scenario.slug,
        slide_n: slideN,
        action_count: actionCount,
        duration_ms: Date.now() - t0,
        terminator,
      },
    });
    void totalStreamStartedAt;
    void totalFirstDeltaMs;
  }

  /**
   * Emit `error.surfaced` for a structured failure crossing the host.
   * Optionally broadcasts the spoken line through `broadcast` AND marks
   * the TTS-busy tracker (same dance the Narrator's `onUtterance` does).
   * When `announce` is suppressed (flag off, debounce, or rendition-soft),
   * still emit the log event so forensics shows the failure path.
   *
   * The error TEXT capture + announce decision stay deterministic; the
   * spoken line is model-phrased (via `phraseErrorAnnounce`) so the
   * verbatim error reaches the user in PAT's voice instead of a fixed
   * template. The deterministic template still runs as the fallback
   * inside `phraseErrorAnnounce`.
   *
   * Async because the model call is. Callers fire-and-forget — the
   * announce path has its own broadcast-failure guard and the function
   * never throws.
   */
  async emitErrorSurfaced(args: {
    source: ErrorSource;
    tool?: string;
    errorText: string;
    threadId: string | null;
    platformId: string | null;
    sessionId?: string | null;
    /** Optional spoken-line broadcaster. Adapter-supplied; omitted when
     *  the channel has no audible output for this code path. */
    broadcast?: (text: string, threadId: string | null) => void;
  }): Promise<void> {
    // Truncate preview so the dashboard row stays readable; full text
    // already lives in detail.row-received for tool-failed cases.
    const preview = args.errorText.length > 500 ? `${args.errorText.slice(0, 497)}…` : args.errorText;
    // Cap verbatim error_raw to ~3KB so log volume stays manageable.
    // Forensics gets a head-tail slice; full text remains in
    // detail.row-received upstream.
    const RAW_MAX = 3000;
    const raw =
      args.errorText.length > RAW_MAX
        ? `${args.errorText.slice(0, Math.floor(RAW_MAX * 0.7))}\n…[truncated]…\n${args.errorText.slice(-Math.floor(RAW_MAX * 0.3))}`
        : args.errorText;
    // Phrase the spoken line through the model. Errors INSIDE phrasing
    // fall back to the deterministic template inside
    // `phraseErrorAnnounce`, so this never throws and never blocks
    // longer than one model call.
    const decision = await phraseErrorAnnounce({
      source: args.source,
      tool: args.tool,
      errorText: args.errorText,
    });
    const willAnnounce = decision.announced && args.broadcast !== undefined;
    this.host.log.event({
      kind: 'error.surfaced',
      level: 'error',
      session_id: args.sessionId ?? null,
      thread_id: args.threadId,
      platform_id: args.platformId ?? undefined,
      data: {
        source: args.source,
        tool: args.tool,
        error_preview: preview,
        error_raw: raw,
        announced: willAnnounce,
        spoken_text: willAnnounce ? decision.spokenText : undefined,
        debounce_suppressed: decision.debounceSuppressed,
      },
    });
    if (willAnnounce && args.broadcast) {
      // Match the Narrator's onUtterance + broadcastUtterance cadence:
      // mark TTS busy for the projected utterance length + 1s tail pad,
      // emit tts.busy-marked so the dashboard attributes the next
      // tts.turn-ended to this announce path, then broadcast.
      const text = decision.spokenText;
      const estDurMs = (text.length / 11) * 1000 + 1000;
      this.tts.markStarted(args.threadId, estDurMs);
      this.host.log.event({
        kind: 'tts.busy-marked',
        thread_id: args.threadId,
        data: { est_dur_ms: estDurMs, text_preview: text.slice(0, 200) },
      });
      try {
        args.broadcast(text, args.threadId);
      } catch (err) {
        this.host.log.warn('emitErrorSurfaced broadcast threw', { err: String(err) });
      }
    }
  }

  // ──────────────────────── Timeline-runtime API ──────────────────────
  // PAT (plans/timeline-runtime-and-scenarios.md §3.2, §3.6.5, §3.6.6).
  // Queue-driven dispatch with linear contract — each action awaits its
  // completion signal before the next starts. Cancellation propagates
  // via AbortSignal; remaining queue is drained as cancelled. The
  // dispatch fn handles base actions inline; domain actions delegate
  // to the registry installed by scenario / robotics / etc. packages.

  /**
   * Run a timeline as a queue + sequencer. Returns when every action's
   * completion signal has fired OR an abort propagated.
   *
   * The dispatch fn closes over a `BaseDispatchOpts` so handlers know
   * where to broadcast / fire side effects. Domain actions delegate to
   * the registry — extensions own slide-nav / fragment / robotics-specific
   * dispatching. Base actions covered here: say, pause, tool (stubbed),
   * wait-for-cue (logged), terminator.
   *
   * Returns the sequencer's `SequencerRunResult` plus the timelineId so
   * the caller can pair it with the matching `timeline.started` /
   * `timeline.finished` lifecycle events.
   *
   * Note: this method intentionally does NOT call `openTimeline` /
   * `closeTimeline` itself — the caller controls the wrapper lifecycle
   * (so a `<timeline>` parser open can fire `timeline.started` before
   * the first action is enqueued). It DOES populate
   * `lastTimelineRunByThread` so `getCompletedActionsBlock` can render
   * the agent-facing block on the next forward.
   */
  async runTimelineSequence(args: {
    timelineId: string;
    threadKey: string;
    threadId: string | null;
    platformId: string;
    sessionId?: string | null;
    actions: readonly TimelineAction[];
    /** Optional handlers for base actions. When omitted the sequencer
     *  treats the action as instant-complete + logs a misc warning. */
    handlers?: TimelineBaseHandlers;
    /** Host-extras forwarded into every action's DispatchContext.host.
     *  Useful for handing the slide-bus client / scenario-cursor through
     *  to domain extensions without globals. */
    host?: Record<string, unknown>;
  }): Promise<TimelineSequencerOutcome> {
    const queue = new TimelineQueue();
    queue.enqueueMany(args.actions);

    // Log + count each enqueue so the dashboard sees the action ahead
    // of its dispatch. Sequence index is the position in the original
    // batch — sequencer dispatches in the same order so this matches
    // the eventual `timeline.action-completed.seq`.
    for (let i = 0; i < args.actions.length; i++) {
      this.host.log.event(
        toStructuredLogEvent(
          buildActionEnqueued({
            timelineId: args.timelineId,
            action: args.actions[i]!,
            seq: i,
            threadId: args.threadId,
            sessionId: args.sessionId ?? null,
            platformId: args.platformId,
          }),
        ),
      );
    }

    const dispatchFn = (action: TimelineAction, ctx: DispatchContext): Promise<void> => {
      return this.dispatchTimelineAction(action, ctx, args.handlers);
    };

    const sequencer = new Sequencer(queue, {
      timelineId: args.timelineId,
      dispatch: dispatchFn,
      threadId: args.threadId,
      sessionId: args.sessionId ?? null,
      platformId: args.platformId,
      host: args.host,
      hooks: {
        onActionStart: (action, ctx, tsStart) => {
          // PAT: emit `timeline.action-started` distinct from
          // -enqueued so the dashboard swimlane can render the actual
          // playback window (started → completed). Without this, a
          // next_slide terminator sitting in the queue behind a long
          // say looks like it ran for the say's whole duration.
          this.host.log.event(
            toStructuredLogEvent(
              buildActionStarted({
                timelineId: args.timelineId,
                action,
                seq: ctx.seq,
                tsStart,
                threadId: args.threadId,
                sessionId: args.sessionId ?? null,
                platformId: args.platformId,
              }),
            ),
          );
        },
        onActionComplete: (record) => {
          this.host.log.event(
            toStructuredLogEvent(
              buildActionCompleted({
                timelineId: args.timelineId,
                record,
                threadId: args.threadId,
                sessionId: args.sessionId ?? null,
                platformId: args.platformId,
              }),
            ),
          );
        },
        onActionCancelled: (record) => {
          this.host.log.event(
            toStructuredLogEvent(
              buildActionCancelled({
                timelineId: args.timelineId,
                action: record.action,
                seq: record.seq,
                reason: record.reason ?? 'aborted',
                partial: record.partialText,
                threadId: args.threadId,
                sessionId: args.sessionId ?? null,
                platformId: args.platformId,
              }),
            ),
          );
        },
        onActionDropped: (action, seq, reason) => {
          this.host.log.event(
            toStructuredLogEvent(
              buildActionCancelled({
                timelineId: args.timelineId,
                action,
                seq,
                reason,
                threadId: args.threadId,
                sessionId: args.sessionId ?? null,
                platformId: args.platformId,
              }),
            ),
          );
        },
      },
    });

    // Register before run so a barge-in that lands during the first
    // dispatch can find + abort us.
    this.timelineSequencers.set(args.threadKey, sequencer);
    let result: SequencerRunResult;
    try {
      result = await sequencer.run();
    } finally {
      // Clear iff we're still the registered sequencer — if a later
      // run started during finally (impossible today, defensive), don't
      // clobber its registration.
      if (this.timelineSequencers.get(args.threadKey) === sequencer) {
        this.timelineSequencers.delete(args.threadKey);
      }
    }

    // Stash the records so the next forward's completed_actions block
    // can render them. Replaces any prior stash for the thread.
    this.lastTimelineRunByThread.set(args.threadKey, {
      timelineId: args.timelineId,
      reason: result.reason,
      records: result.records,
      finishedAt: Date.now(),
    });

    return {
      timelineId: args.timelineId,
      reason: result.reason,
      records: result.records,
      dropped: result.dropped,
    };
  }

  /** Abort the in-flight Sequencer for a thread, if any. Safe to call
   *  when no timeline is active (no-op). Returns true iff a sequencer
   *  was running. */
  abortTimelineSequence(threadKey: string, reason: string): boolean {
    const seq = this.timelineSequencers.get(threadKey);
    if (!seq) return false;
    seq.abort(reason);
    return true;
  }

  /** Per-action dispatcher dispatch — handles base variants inline,
   *  delegates `domain` to the registry. */
  private async dispatchTimelineAction(
    action: TimelineAction,
    ctx: DispatchContext,
    handlers: TimelineBaseHandlers | undefined,
  ): Promise<void> {
    if (action.kind === 'domain') {
      const ext = findExtensionFor(action.domainKind);
      if (!ext) {
        this.host.log.warn('timeline: no extension registered for domain action', {
          domainKind: action.domainKind,
          timeline_id: ctx.timelineId,
          seq: ctx.seq,
        });
        return;
      }
      return ext.dispatch(action, ctx);
    }
    switch (action.kind) {
      case 'say': {
        if (handlers?.onSay) {
          return handlers.onSay(action, ctx);
        }
        // No handler — instant-complete so the linear contract still
        // moves forward in tests / unwired scenarios.
        return;
      }
      case 'pause': {
        return runCancellablePause(action.ms, ctx.signal);
      }
      case 'tool': {
        if (handlers?.onTool) {
          return handlers.onTool(action, ctx);
        }
        // PAT: tool round-trip is Phase 4. Until then, log the
        // request + treat as instant-complete so the sequencer keeps
        // moving. Async variants behave identically here.
        this.host.log.warn('timeline: tool action without handler — treating as no-op', {
          tool: action.name,
          timeline_id: ctx.timelineId,
          seq: ctx.seq,
        });
        return;
      }
      case 'wait-for-cue': {
        if (handlers?.onWaitForCue) {
          return handlers.onWaitForCue(action, ctx);
        }
        this.host.log.warn('timeline: wait-for-cue without handler — instant-complete', {
          cue: action.cue,
          timeline_id: ctx.timelineId,
          seq: ctx.seq,
        });
        return;
      }
      case 'terminator': {
        if (handlers?.onTerminator) {
          return handlers.onTerminator(action, ctx);
        }
        return;
      }
    }
  }

  /**
   * Build the `<completed_actions>` XML block for the agent's next
   * inbound forward. Returns null when no recent timeline run exists for
   * the thread. By default DOES NOT clear the stash — pass
   * `consume: true` to clear it (caller folds the block into the
   * forward and wants to ensure it isn't re-stamped on the next turn).
   *
   * Format follows plans/timeline-runtime-and-scenarios.md §3.6.5:
   * - reason="completed" | "interrupted"
   * - each action carries ts_start="HH:MM:SSZ" (and ts_end on
   *   non-partial actions)
   * - partial actions carry partial="true" and omit ts_end
   * - say actions render their (possibly partial) text content
   */
  getCompletedActionsBlock(
    threadKey: string,
    opts?: { consume?: boolean },
  ): string | null {
    const stash = this.lastTimelineRunByThread.get(threadKey);
    if (!stash) return null;
    const reason = stash.reason === 'completed' ? 'completed' : 'interrupted';
    const actions = stash.records.map(recordToCompletedAction);
    const xml = renderCompletedActions({ actions, reason });
    if (opts?.consume) {
      this.lastTimelineRunByThread.delete(threadKey);
    }
    return xml.length > 0 ? xml : null;
  }

  /** Clear the stashed timeline run for a thread. Useful when the
   *  caller renders the block out-of-band and wants to ensure the next
   *  forward starts fresh. Idempotent. */
  clearCompletedActionsBlock(threadKey: string): void {
    this.lastTimelineRunByThread.delete(threadKey);
  }

  /**
   * Stamp `<inbox now="HH:MM:SSZ">...</inbox>` around an inbound
   * message body. Per plans/timeline-runtime-and-scenarios.md §3.6.6 —
   * gives the back-mind a single authoritative clock per forward so it
   * doesn't have to infer one. Pass `now: <epoch ms>` to override the
   * host clock (tests).
   *
   * If a `<completed_actions>` block is stashed for the thread, it's
   * automatically appended inside the wrapper. Pass
   * `includeCompletedActions: false` to suppress; pass
   * `consumeCompletedActions: true` to clear the stash after
   * rendering so a subsequent forward doesn't re-stamp it.
   */
  wrapInbox(
    bodyXml: string,
    opts?: {
      threadKey?: string;
      now?: number;
      includeCompletedActions?: boolean;
      consumeCompletedActions?: boolean;
    },
  ): string {
    const nowMs = opts?.now ?? Date.now();
    const includeCompleted = opts?.includeCompletedActions !== false;

    // Resolve completed-actions stash (so the inbox wrapper can switch
    // to full-date format if the actions span a UTC midnight boundary
    // relative to `nowMs`).
    let actions: CompletedAction[] = [];
    let reason: 'completed' | 'interrupted' = 'completed';
    if (includeCompleted && opts?.threadKey) {
      const stash = this.lastTimelineRunByThread.get(opts.threadKey);
      if (stash) {
        actions = stash.records.map(recordToCompletedAction);
        reason = stash.reason === 'completed' ? 'completed' : 'interrupted';
        if (opts.consumeCompletedActions) {
          this.lastTimelineRunByThread.delete(opts.threadKey);
        }
      }
    }

    const { open, close } = renderInboxWrapper({ nowMs, actions });
    const body = bodyXml.trimEnd();
    const parts: string[] = [open, body];
    if (actions.length > 0) {
      parts.push(renderCompletedActions({ actions, reason }));
    }
    parts.push(close);
    return parts.join('\n');
  }
}

// ──────────────────────── Helpers — timeline-runtime ────────────────────

/** Base-action handler callbacks. Provided by the caller of
 *  `runTimelineSequence`. Each returns a Promise that resolves when
 *  the action's audience-perceptible completion has fired. */
export interface TimelineBaseHandlers {
  onSay?: (
    action: Extract<TimelineAction, { kind: 'say' }>,
    ctx: DispatchContext,
  ) => Promise<void>;
  onTool?: (
    action: Extract<TimelineAction, { kind: 'tool' }>,
    ctx: DispatchContext,
  ) => Promise<void>;
  onWaitForCue?: (
    action: Extract<TimelineAction, { kind: 'wait-for-cue' }>,
    ctx: DispatchContext,
  ) => Promise<void>;
  onTerminator?: (
    action: Extract<TimelineAction, { kind: 'terminator' }>,
    ctx: DispatchContext,
  ) => Promise<void>;
}

export interface TimelineSequencerOutcome {
  timelineId: string;
  reason: 'completed' | 'aborted';
  records: readonly CompletedActionRecord[];
  dropped: readonly { action: TimelineAction; seq: number }[];
}

/** Narrow a `BaseLogEvent`-typed event (whose `level` may include
 *  `'fatal'`) into the `StructuredLogEvent` shape the host's logger
 *  accepts. We never emit `'fatal'` from the timeline runtime — these
 *  paths are info-level — so the narrowing is safe. The cast pinpoints
 *  the deliberate impedance match instead of leaking a structural type
 *  through the call site. */
function toStructuredLogEvent<T extends { kind: string; data: Record<string, unknown> }>(
  ev: T,
): import('./host-adapter.js').StructuredLogEvent {
  return ev as unknown as import('./host-adapter.js').StructuredLogEvent;
}

/** Adapt the legacy `ScenarioAction` shape (what ScenarioActionStream
 *  emits today) into a `TimelineAction` the sequencer can dispatch.
 *
 *  Mapping (per plans/timeline-runtime-and-scenarios.md §3.1 + §3.11):
 *   - prose → `say` (each prose chunk becomes its own say; linear
 *     contract guarantees ordering)
 *   - verbatim-expanded / cartesia-passthrough / unknown-tag → null
 *     (already inlined into adjacent prose, or already logged elsewhere)
 *   - fragment(next|prev) → domain action with kind 'next_fragment' /
 *     'prev_fragment'; the scenarios.presentation extension's dispatch
 *     unwraps `payload.legacy` to fire the slide-bus POST
 *   - slide-nav(direction) → domain action with canonical direction kind
 *     ('next_slide' / 'prev_slide' / 'nav_slide_*'); payload.legacy
 *     carries the original ScenarioAction
 *   - slide-goto(target_slide) → domain 'goto_slide' with `n` payload
 *   - ask-questions → domain 'ask_for_questions'
 *   - tool → base `tool` action (synced; Phase 4 will round-trip)
 *   - timeline-started / timeline-finished → handled separately
 *
 *  The DomainAction.payload.legacy field carries the original action
 *  so the scenarios.presentation extension's `dispatch` can pass it
 *  verbatim to the host-side scenarioActionDispatcher (slide-bus). */
function scenarioActionToTimeline(action: ScenarioAction): TimelineAction | null {
  switch (action.type) {
    case 'prose':
      return { kind: 'say', text: action.text };
    case 'cartesia-passthrough':
    case 'unknown-tag':
    case 'timeline-started':
    case 'timeline-finished':
    case 'timeline-span':
      // PAT Phase 6: timeline-span is hydrated upstream (inline-
      // expanded into N actions) in the orchestrator's queue-build
      // loop; this adapter never sees a survivor.
      return null;
    case 'pause':
      return { kind: 'pause', ms: action.ms };
    case 'fragment':
      return {
        kind: 'domain',
        domainKind: action.direction === 'next' ? 'next_fragment' : 'prev_fragment',
        payload: { legacy: action },
      };
    case 'slide-nav': {
      const map: Record<typeof action.direction, string> = {
        next: 'next_slide',
        prev: 'prev_slide',
        up: 'nav_slide_up',
        down: 'nav_slide_down',
        left: 'nav_slide_left',
        right: 'nav_slide_right',
      };
      return {
        kind: 'domain',
        domainKind: map[action.direction],
        payload: { legacy: action },
      };
    }
    case 'slide-goto':
      return {
        kind: 'domain',
        domainKind: 'goto_slide',
        payload: { legacy: action, n: action.target_slide },
      };
    case 'ask-questions':
      return {
        kind: 'domain',
        domainKind: 'ask_for_questions',
        payload: { legacy: action },
      };
    case 'tool':
      return { kind: 'tool', name: action.tool_name, args: action.tool_args };
  }
}

/** setTimeout-backed pause that observes the dispatch signal so a
 *  barge-in cancel resolves the pause immediately as a rejection. */
function runCancellablePause(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new TimelineAbortError('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new TimelineAbortError('aborted'));
    };
    signal.addEventListener('abort', onAbort);
  });
}

/** Convert the sequencer's runtime CompletedActionRecord into the
 *  pure `CompletedAction` shape `renderCompletedActions` consumes.
 *
 *  Mapping rules:
 *    - `say` carries text (full text on completion; partialText on
 *      cancelled mid-flight; falls back to action.text).
 *    - `pause` carries `ms` as an attribute.
 *    - `tool` becomes `tool_<name>` with the args as attributes.
 *    - `wait-for-cue` becomes `wait_for_cue` with the `cue` attribute.
 *    - `terminator` becomes the terminator reason as the element
 *      name (e.g. `next_slide`, `ask_for_questions`).
 *    - `domain` becomes the domainKind name with its payload as attrs.
 *
 *  Partial flag propagates 1:1; the emitter omits `ts_end` when partial. */
function recordToCompletedAction(rec: CompletedActionRecord): CompletedAction {
  const action = rec.action;
  const base = {
    ts_start_ms: rec.tsStart,
    ts_end_ms: rec.tsEnd ?? undefined,
    partial: rec.partial || undefined,
  };
  switch (action.kind) {
    case 'say': {
      const text = rec.partial ? rec.partialText ?? action.text : action.text;
      const attrs: Record<string, string> | undefined = action.target
        ? { target: action.target }
        : undefined;
      return { kind: 'say', text, ...(attrs ? { attrs } : {}), ...base };
    }
    case 'pause':
      return { kind: 'pause', attrs: { ms: action.ms }, ...base };
    case 'tool':
      return {
        kind: `tool_${action.name}`,
        attrs: argsToAttrs(action.args),
        ...base,
      };
    case 'wait-for-cue':
      return { kind: 'wait_for_cue', attrs: { cue: action.cue }, ...base };
    case 'terminator':
      return {
        kind: action.reason,
        attrs: action.data ? argsToAttrs(action.data) : undefined,
        ...base,
      };
    case 'domain':
      return {
        kind: action.domainKind,
        attrs: action.payload ? argsToAttrs(action.payload) : undefined,
        ...base,
      };
    default: {
      const _exhaustive: never = action;
      void _exhaustive;
      return { kind: 'unknown', ...base };
    }
  }
}

function argsToAttrs(
  args: Record<string, unknown>,
): Record<string, string | number | boolean> | undefined {
  const out: Record<string, string | number | boolean> = {};
  let any = false;
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    } else {
      out[k] = JSON.stringify(v);
    }
    any = true;
  }
  return any ? out : undefined;
}

// Silence unused-import warnings if a future refactor drops a label
// helper; keeping the reference here so `actionKindLabel` is callable
// from the orchestrator scope when needed (e.g. dashboard helpers).
void actionKindLabel;
// Same for the convenience inbox combinator — exported through
// timeline/index but not used by the orchestrator today (which builds
// the wrapper + completed-actions block separately so it can mix in
// caller body XML).
void renderInboxWithCompletedActions;
