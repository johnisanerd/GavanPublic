/**
 * @agentic-toolkit/realtime — entry point.
 *
 * For the spike this file is a placeholder. The library will eventually:
 *   1. Resolve the active NanoClaw session (env or arg)
 *   2. Build initial working memory by replaying the session's event log
 *   3. Tail-read outbound.db detail rows on a poll loop
 *   4. Run the narration pipeline (cadence rules per design doc)
 *   5. Expose a local HTTP surface for transports (voice-transport et al.)
 *
 * For now: re-export the surface so the channel adapter and transports can
 * import what they need without reaching into individual modules.
 */
export * as nanoclawClient from './nanoclaw-client.js';
export * as state from './state.js';
export * as narration from './narration.js';
export * as banter from './banter.js';
export * as requestLayer from './request-layer.js';

export type { SessionLocator, DetailRow, DetailContent, RealtimeSender } from './nanoclaw-client.js';
export type { BackMindState } from './state.js';

export { emptyBackMindState, applyDetailRow, rebuildBackMindState, renderBackMindState } from './state.js';
export { Narrator, streamBanterNarration, cleanUtterance } from './narration.js';
export type {
  DetailEvent,
  NarratorOptions,
  NarrationCallRequest,
  NarrationCallResponse,
  NarrationStreamRequest,
} from './narration.js';
export { runBanterAck, runBanterRender, resetBanterFailures, formatHistory, BASED_ON_RECENT_MAX, streamBanterToSse, streamBanterAck, streamBanterRender } from './banter.js';
export type { BanterRequest, BanterResponse, BanterHistoryEntry, RenderBackMindRequest, LlmCallTrace, LlmCallHook, StreamBanterRequest, StreamBanterResponse, BanterUtteranceSource, BanterStreamCallbacks, BanterStreamAckRequest, BanterStreamRenderRequest } from './banter.js';
export { banterDispatch, resetBanterDispatchFailures } from './banter-dispatch.js';
export type { BanterDispatchInput, BanterDispatchOutput, BanterDispatchSay, BanterDispatchCalledLogData } from './banter-dispatch.js';
export { requestLayerOnUserMessage, resetRequestLayerFailures } from './request-layer.js';
export type { RequestLayerRequest, RequestLayerDecision } from './request-layer.js';

// PAT: Wave 3.1 error legibility — surface back-mind / host failures
// verbally (flag-on, default 1) + always to dashboard. Task #36 reframe:
// decision stays deterministic; phrasing goes through the model with a
// verbatim-error-preserving prompt + deterministic fallback.
export {
  decideAnnounce,
  summarizeForVoice,
  phraseErrorAnnounce,
  phraseErrorForVoice,
  resetDebounce,
  resetErrorSurfacingFailures,
  ANNOUNCE_ERRORS,
  DEBOUNCE_WINDOW_MS,
} from './error-surfacing.js';
export type { ErrorSource, ErrorInput, AnnounceDecision, PhrasingCallbacks } from './error-surfacing.js';

// Channel-orchestration carriers — extracted from
// nanoclaw/src/channels/{realtime,anam-web}.ts so both adapters share
// one implementation. Step toward the full ChannelOrchestrator lift
// (plans/channel-orchestration-dedup.md).
export { TtsBusyTracker } from './tts-busy.js';
export { StreamingControllers } from './streaming-controllers.js';
export type { BanterStreamSlot } from './streaming-controllers.js';
export { ConversationHistory, CONVERSATION_HISTORY_MAX_DEFAULT } from './conversation-history.js';
export { BanterBroadcast, BANTER_BACKLOG_MAX_DEFAULT } from './banter-broadcast.js';
export type { BanterEvent, BanterEventKind, BanterSubscriber } from './banter-broadcast.js';
export { ChannelOrchestrator, conversationKey } from './channel-orchestrator.js';
export type { ChannelOrchestratorOpts, ChannelTransport, RunStreamingFrontMindArgs, StreamCancelReason, HandleUserMessageArgs, HandleUserMessageResult, ForwardArgs, DeliverChatArgs, DeliverChatRenderInfo, ScenarioContextResolver, CallerContextResolver, ScenarioActionDispatcher } from './channel-orchestrator.js';
// PAT (TaskList #8): capability lifecycle split. Install-state lives
// in a process-local cache keyed by agent_group_id and populated at
// boot via `setInstallCapabilities`. Per-inbound caller context is
// resolved fresh by the channel adapter's CallerContextResolver and
// threaded into the USER message. Each front-mind prompt's render()
// composes both surfaces — install block → SYSTEM, caller block →
// USER. See `prompts/_capability-context.ts` for the full design.
export {
  renderInstallCapabilities,
  renderCallerContext,
  stubInstallCapabilitiesBlock,
  setInstallCapabilities,
  getInstallCapabilitiesBlock,
  getInstallCapabilities,
  clearInstallCapabilities,
  listRegisteredAgentGroups,
} from './prompts/_capability-context.js';
export type {
  InstallCapabilities,
  CallerContext,
  CapabilityEntry,
  ChannelCapability,
  CallerIdentity,
  KnownHandle,
  PermissionsSurface,
} from './prompts/_capability-context.js';
// PAT: tag-stream + action-stream — see plans/presenter-tag-stream.md
export { TagStreamParser, parseTagStream } from './tag-stream-parser.js';
export type { TagEvent } from './tag-stream-parser.js';
// PAT: timeline runtime — see plans/timeline-runtime-and-scenarios.md
export * as timeline from './timeline/index.js';
export {
  TimelineQueue,
  Sequencer,
  AbortError as TimelineAbortError,
  registerActionDomain,
  findExtensionFor,
  listExtensions,
  resetRegistry,
  setRegistryConflictHook,
  isBaseAction,
  actionKindLabel,
  buildActionEnqueued,
  buildActionCompleted,
  buildActionCancelled,
} from './timeline/index.js';
export type {
  TimelineAction,
  BaseTimelineAction,
  DomainAction,
  TerminatorReason,
  DispatchContext,
  DispatchFn,
  CompletedActionRecord,
  SequencerOpts,
  SequencerHooks,
  SequencerRunResult,
  ActionDomainExtension,
  RegistryConflictHook,
} from './timeline/index.js';
export { ScenarioActionStream, actionsFromText } from './scenario-action-stream.js';
export type { ScenarioAction, InterpreterSlideContext, InterpreterOpts } from './scenario-action-stream.js';
export { renderScenarioContext } from './prompts/_scenario-context.js';
export type { ScenarioContext } from './prompts/_scenario-context.js';
export { NarrationManager } from './narration-manager.js';
export type { NarrationManagerOpts, NarrationSession, NarrationOutboundRow } from './narration-manager.js';
export type { HostAdapter, StructuredLogger, StructuredLogEvent } from './host-adapter.js';
// PAT: fast-LLM provider surface — exposed for prewarm paths and any
// external callers that need to instantiate a provider directly
// (channel adapters' /prewarm handlers, smoke tests, etc.).
export { getFastProvider, parseFastModelSlug, makeProvider, awaitFullResponse, awaitJson, setProviderFallbackHook, getDefaultProviderFallbackHook } from './llm-provider.js';
export type { FastLlmLayer, FastLlmProviderName, FastLlmProvider, FastLlmCallArgs, FastLlmStreamArgs, FastLlmResult, ProviderFallbackHook } from './llm-provider.js';
// PAT: per-session TLS keepalive pinger — keeps Node's undici keep-alive
// socket warm to the fast-LLM provider so back-to-back turns reuse the
// same TCP+TLS connection. Channel adapters start() on session open
// and stop() on session close. See fast-llm-keepalive.ts header.
export { FastLlmKeepalivePinger } from './fast-llm-keepalive.js';
export type { FastLlmKeepalivePingerOpts } from './fast-llm-keepalive.js';

if (import.meta.url === `file://${process.argv[1]}`) {
  // Direct run — print scaffold notice and exit. Replace with real boot
  // sequence when the library has a runtime entry point worth running.
  console.error(
    '@agentic-toolkit/realtime: scaffold only — see ./README.md and ../docs/front-mind-design.md for what comes next.',
  );
  process.exit(0);
}
