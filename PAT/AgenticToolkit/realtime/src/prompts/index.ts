/**
 * Centralized barrel for the front-mind prompt call sites.
 *
 * One file per LLM call. Each file is fully self-contained: it shows
 * the SYSTEM prompt template, the user-message template (as a typed
 * function), and the context interface that lists every slot the
 * caller must fill. Open one of these to see the literal strings that
 * will be handed to the model.
 *
 *   - `banter-ack`        — what Pat says immediately on each user message.
 *   - `banter-narration`  — what Pat says while the back-mind is working.
 *   - `banter-render`     — back-mind output re-rendered in Pat's voice.
 *   - `request-layer`     — routing decision (no speech).
 *   - `error-surfacing`   — failure phrased for the user in Pat's voice.
 *
 * Shared partials (kept in `_*.ts`):
 *   - `_voice-tags`            — inline TTS tag style guide.
 *   - `_pat-voice`             — Pat's persona / voice DO/DON'T.
 *   - `_architecture`          — two-layer (front-mind/back-mind) brief.
 *   - `_capability-context`    — capability lifecycle split (TaskList
 *                                #8). Install-state (channels, MCP
 *                                tools, skills, sdk tools, host verbs)
 *                                lives in a process-local cache keyed
 *                                by agent_group_id, populated at boot
 *                                via `setInstallCapabilities`. Per-
 *                                inbound caller context (identity,
 *                                known handles, permissions) is
 *                                resolved fresh by the channel
 *                                orchestrator's `callerContextResolver`.
 *                                Each prompt's render() composes both —
 *                                install block → SYSTEM, caller block →
 *                                USER.
 *   - `_scenario-context`      — per-session scenario meta when running
 *                                a prepared experience.
 *
 * To see the literal {system, user} pair that will hit the API for a
 * given call, call `<call-site>.render(ctx)`. The pat-frontend
 * dashboard's LLM-call timeline also displays both verbatim via the
 * `onCall` trace hook (see `banter.ts:LlmCallTrace`).
 */

// Shared partials — exported in case external tooling wants to render
// them standalone or audit per-section.
export { VOICE_TAGS_GUIDE } from './_voice-tags.js';
export { PAT_PERSONA } from './_pat-voice.js';
export { ARCHITECTURE_BRIEF } from './_architecture.js';
export {
  renderInstallCapabilities,
  renderCallerContext,
  stubInstallCapabilitiesBlock,
  setInstallCapabilities,
  getInstallCapabilitiesBlock,
  getInstallCapabilities,
  clearInstallCapabilities,
  listRegisteredAgentGroups,
} from './_capability-context.js';
export type {
  InstallCapabilities,
  CallerContext,
  CapabilityEntry,
  ChannelCapability,
  CallerIdentity,
  KnownHandle,
  PermissionsSurface,
} from './_capability-context.js';
export { renderScenarioContext } from './_scenario-context.js';
export type { ScenarioContext } from './_scenario-context.js';

// Per-call-site namespaces. Each exposes `SYSTEM`, `buildUser(ctx)`,
// `render(ctx)`, and a `*Context` interface.
export * as banterAck from './banter-ack.js';
export * as banterNarration from './banter-narration.js';
export * as banterRender from './banter-render.js';
export * as requestLayer from './request-layer.js';
export * as errorSurfacing from './error-surfacing.js';

// Top-level type re-exports for convenience.
export type { BanterAckContext } from './banter-ack.js';
export type { BanterNarrationContext } from './banter-narration.js';
export type { BanterRenderContext } from './banter-render.js';
export type { RequestLayerContext } from './request-layer.js';
export type { ErrorSurfacingContext } from './error-surfacing.js';
