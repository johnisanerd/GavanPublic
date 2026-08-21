/**
 * Structured log event schema — source of truth.
 *
 * Every persistent log line in the realtime stack conforms to one of
 * the variants in `LogEvent` below. Consumers (TUI, fly-call-log
 * timeline, future viewers) dispatch on the discriminator rather than
 * regex'ing free-form `msg` strings.
 *
 * Cross-language: `transports/log_events.py` is the Python mirror.
 * A drift test in `transports/test_log_events_match.py` asserts
 * the kind set matches at module load. Adding a new kind here
 * requires the matching Python entry or the test fails.
 *
 * Top-level shape (every event):
 *   ts          — ISO 8601 UTC, ms-precision
 *   source      — emitting process: 'nanoclaw-host' | 'agent-runner' | 'voice-transport'
 *   kind        — '<area>.<event>' (dotted, two-level)
 *   level       — 'info' default; 'warn' / 'error' / 'fatal' for problems
 *   thread_id?  — optional context promoted to top-level
 *   session_id? — optional context promoted to top-level
 *   platform_id?— optional venue identifier (channel-native, no prefix)
 *   data        — kind-specific payload (typed per variant below)
 */

export type LogSource =
  | 'nanoclaw-host'
  | 'agent-runner'
  | 'voice-transport'
  | 'host'
  // PAT: pat-web in-browser emit. Forwarded through pat-web's Hono
  // server to nanoclaw `/admin/log-event` so the browser's RTT signals
  // (inbound.sent + utterance.delta-received) land in the unified host
  // JSONL alongside server-side events.
  | 'pat-web-browser';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

interface BaseLogEvent {
  ts: string;
  source: LogSource;
  /** Stable, globally-unique event id. Stamped server-side at emit time
   *  in the format "<source-prefix>-<process-start-ms>-<counter>". A
   *  replay of the same persistent log entry carries the same id, so
   *  consumers can dedupe perfectly without resorting to fuzzy
   *  ts-based matching. Optional for backwards compatibility with
   *  pre-id log lines. */
  id?: string;
  level?: LogLevel;
  thread_id?: string | null;
  session_id?: string | null;
  platform_id?: string | null;
}

// ──────────────────────── Front-mind events ─────────────────────────────
// Origin: nanoclaw-host (realtime channel adapter + realtime library).

export interface InboundReceivedEvent extends BaseLogEvent {
  kind: 'inbound.received';
  data: {
    // PAT: channel the inbound arrived on — 'signal' | 'telegram' | 'slack'
    // | 'phone-call' | 'anam-web' | ... Always present so a person-scoped
    // query can also slice by venue. Realtime adapters pass it via
    // HandleUserMessageArgs.channelType; the chat-SDK funnel (router) reads
    // it from the InboundEvent.
    channel_type: string;
    text: string;
    sender: string;          // 'realtime-user' or whatever the transport posts
    sender_id: string;       // 'pstn:+15550100000' (cross-channel user identity)
    // PAT: OPAQUE person anchor — resolved via the people-spine
    // (getPersonByUser on the namespaced sender_id). null when the sender
    // isn't linked to a person, or when resolution failed (defensive —
    // logging enrichment never blocks delivery). person_name is DELIBERATELY
    // absent: names must never land beside message bodies in `pat_events`.
    // The id→name mapping lives in the `pat_enrichment` directory stream;
    // resolve a name→id (or id→name) there at query time. Lets the store
    // answer "what did <Person> say" via a one-hop person_id, or via the
    // resolver for the retroactive/general path.
    person_id: string | null;
  };
}

export interface BanterCalledEvent extends BaseLogEvent {
  kind: 'banter.called';
  data: {
    user_text: string;
    response_text: string | null;     // null when intentionally_silent
    intentionally_silent: boolean;
    failed: boolean;
    latency_ms: number;
  };
}

export interface BanterRenderedEvent extends BaseLogEvent {
  kind: 'banter.rendered';            // chat → banter rendition (back-mind chat → spoken text)
  data: {
    raw_text: string;
    rendered_text: string;
    render_ms: number;
  };
}

/**
 * Per-`<say>` banter-dispatch Haiku call inside a timeline. Fired once
 * per spoken beat before the sequencer broadcasts to TTS. The dispatch
 * preserves meaning + precise claims and adds emotion / pause / cartesia
 * tags layered on. See `realtime/src/banter-dispatch.ts` and
 * `plans/timeline-runtime-and-scenarios.md` §3.4.
 *
 * On failure (`ok=false`) the sequencer falls back to broadcasting the
 * raw authored text; the event still fires so forensics can compare
 * authored input vs. what was spoken.
 */
export interface BanterDispatchCalledEvent extends BaseLogEvent {
  kind: 'banter-dispatch.called';
  data: {
    /** The authored line handed to the dispatcher. */
    input_text: string;
    /** The Pat-voiced rewrite on success; equal to `input_text` when
     *  the call failed and the sequencer fell back to authored. */
    output_text: string;
    /** Wall-clock latency for the dispatcher call (Haiku roundtrip
     *  on success; fast short-circuit on circuit-breaker / no-API-key). */
    latency_ms: number;
    /** True iff a healthy model call produced the rewrite. False ⇒
     *  the sequencer broadcast the raw authored text. */
    ok: boolean;
    /** Failure reason when `ok=false` (e.g. 'no API key', 'sdk error: ...',
     *  'cleaned to empty', 'circuit-breaker open', 'aborted'). */
    error?: string;
  };
}

export interface RequestLayerDecidedEvent extends BaseLogEvent {
  kind: 'request-layer.decided';
  data: {
    decision: 'forward' | 'noop' | 'silent';
    invoke_text?: string;
    clarify_hint?: string;
    reason: string;
    is_processing: boolean;
    latency_ms: number;
  };
}

export interface NarratorFiredEvent extends BaseLogEvent {
  kind: 'narrator.fired';
  data: {
    utterance: string;
    events_observed: string[];        // 'tool-pre', 'tool-post', etc.
    /** Duration of the underlying model call, ms. Optional today —
     *  declared but never emitted by any current call site. */
    model_call_ms?: number;
  };
}

export interface NarratorBrainSpawnedEvent extends BaseLogEvent {
  kind: 'narrator.brain-spawned';
  data: {
    /* sessionId is in top-level session_id */
  };
}

export interface TtsTurnEndedEvent extends BaseLogEvent {
  kind: 'tts.turn-ended';
  data: {
    text_preview: string;
    est_dur_ms: number;
  };
}

export interface TtsBusyMarkedEvent extends BaseLogEvent {
  kind: 'tts.busy-marked';
  data: {
    est_dur_ms: number;
    text_preview: string;
  };
}

export interface SseClientChangedEvent extends BaseLogEvent {
  kind: 'sse.client-changed';
  data: {
    action: 'connected' | 'disconnected';
    total_clients: number;
    remote: string;
    reason?: string;
  };
}

export interface StateTransitionedEvent extends BaseLogEvent {
  kind: 'state.transitioned';
  data: {
    state: 'isProcessingNarration' | 'isGeneratingNarration' | 'isTtsBusy' | 'banter-buffer';
    from: unknown;
    to: unknown;
  };
}

/**
 * Emitted by the host at boot (and at agent-group provision time) once
 * per `agent_group_id`. Carries the install-state capability surface
 * — channels wired, MCP tools mounted, container skills present,
 * container.json contents, SDK tools, host verbs. Stable across
 * inbounds; cached in the realtime library by `setInstallCapabilities`
 * and threaded into every front-mind SYSTEM prompt via
 * `getInstallCapabilitiesBlock(agent_group_id)`.
 *
 * Trace-based smoketests join this event with
 * `capability.caller-context-resolved` (per-inbound) by
 * `agent_group_id` to reconstruct the full surface the model saw.
 *
 * Emit cadence: once per agent group at boot (one event per row in
 * `agent_groups`); additionally on provision time when
 * `setInstallCapabilities` lands a new agent group at runtime.
 *
 * Level: 'debug' (excluded by default from /admin/logs.jsonl reads).
 */
export interface CapabilityInstallResolvedEvent extends BaseLogEvent {
  kind: 'capability.install-resolved';
  level: 'debug';
  data: {
    /** The agent group this snapshot is keyed under. Smoketests join
     *  on this to pair with `capability.caller-context-resolved`. */
    agent_group_id: string;
    /** Whether the resolver returned a non-null snapshot. False ⇒
     *  `snapshot` is null and the realtime library will render the stub
     *  install block for this agent group. */
    resolved: boolean;
    /** Populated iff the host's install resolver threw and was
     *  swallowed. Carries the error message for forensics. */
    resolver_error?: string;
    /** The install-state snapshot, snake_cased. null iff resolved=false.
     *  Shape mirrors `InstallCapabilities` from
     *  `realtime/src/prompts/_capability-context.ts` field-for-field. */
    snapshot: null | {
      agent_group_id?: string;
      agent_group_name?: string;
      container_mcp_tools?: ReadonlyArray<{
        name: string;
        summary?: string;
        flags?: readonly string[];
      }>;
      container_skills?: ReadonlyArray<{
        name: string;
        summary?: string;
        flags?: readonly string[];
      }>;
      channels?: ReadonlyArray<{
        type: string;
        shapes?: readonly string[];
      }>;
      sdk_tools?: ReadonlyArray<{
        name: string;
        summary?: string;
        flags?: readonly string[];
      }>;
      in_tree_primitives?: ReadonlyArray<{
        name: string;
        summary?: string;
        flags?: readonly string[];
      }>;
      external_mcp_servers?: ReadonlyArray<{
        name: string;
        summary?: string;
        flags?: readonly string[];
      }>;
      slash_commands?: ReadonlyArray<{
        name: string;
        summary?: string;
        flags?: readonly string[];
      }>;
      host_verbs?: ReadonlyArray<{
        name: string;
        summary?: string;
        flags?: readonly string[];
      }>;
    };
  };
}

/**
 * Emitted by ChannelOrchestrator after `resolveCallerContext(...)`
 * returns (or returns null) on inbound + rendition paths. Carries the
 * resolved per-inbound `CallerContext` — caller identity,
 * suffix-matched known handles, permissions for the caller against
 * the agent group — so trace-based tests can read the caller surface
 * the model actually saw on this turn.
 *
 * Trace-based smoketests should:
 *   1. Subscribe to `capability.install-resolved`, group by
 *      `data.agent_group_id` for the install surface (stable).
 *   2. On each inbound, read this event filtered to the inbound's
 *      `thread_id` + `call_site='inbound'` for the caller surface
 *      (per-turn).
 *   3. Join the two by `data.agent_group_id` to reconstruct the full
 *      surface the front-mind saw.
 *
 * Level: 'debug' by default.
 */
export interface CapabilityCallerContextResolvedEvent extends BaseLogEvent {
  kind: 'capability.caller-context-resolved';
  level: 'debug';
  data: {
    /** Agent group this caller context was resolved for. Used to join
     *  with `capability.install-resolved` on the smoketest side. */
    agent_group_id: string;
    /** Where in the orchestrator the resolve happened.
     *  - 'inbound'    — fired once per inbound user message.
     *  - 'rendition' — fired per chat-row rendition cycle. */
    call_site: 'inbound' | 'rendition';
    /** Whether a `callerContextResolver` was wired on the orchestrator
     *  at construction. False ⇒ stub caller block rendered and
     *  `snapshot` is null. */
    resolver_present: boolean;
    /** True iff the resolver returned a non-null context. False ⇒
     *  `snapshot` is null (absent OR null by design OR threw — see
     *  `resolver_error`). */
    resolved: boolean;
    /** Caller identity the resolver was invoked with. Empty string on
     *  rendition emits (renditions have no inbound sender). */
    sender_id: string;
    /** Populated iff the resolver threw and the orchestrator swallowed
     *  the error to fall back to the stub renderer. */
    resolver_error?: string;
    /** The full `CallerContext` snapshot, snake_cased. Shape mirrors
     *  `CallerContext` from
     *  `realtime/src/prompts/_capability-context.ts`. */
    snapshot: null | {
      agent_group_id?: string;
      permissions?: {
        caller_role: 'owner' | 'admin' | 'member' | 'unknown';
        caller_verbs?: readonly string[];
        approval_gated_verbs?: readonly string[];
      };
      caller?: {
        platform_id: string;
        channel_type: string;
        display_name?: string | null;
        role?: 'owner' | 'admin' | 'member' | 'unknown';
        suffix?: string;
      } | null;
      known_handles?: ReadonlyArray<{
        platform_id: string;
        channel_type: string;
        label?: string | null;
        suffix: string;
        is_current_caller?: boolean;
      }>;
    };
  };
}

// ──────────────────────── Back-mind / routing events ─────────────────────
// Origin: nanoclaw-host (observing back-mind via session DBs).

export interface SessionCreatedEvent extends BaseLogEvent {
  kind: 'session.created';
  data: {
    agent_group_id: string;
    messaging_group_id: string;
    session_mode: string;
  };
}

export interface SessionClosedEvent extends BaseLogEvent {
  kind: 'session.closed';
  data: {
    reason: string;
  };
}

/** Emitted when a realtime channel session goes idle past the
 *  NarrationManager's threshold and gets force-closed. Catches
 *  ungraceful hangups (network drop, browser tab close, voice-transport
 *  crash) where the channel-specific /call-ended hook never fires.
 *
 *  Side effects when emitted:
 *    - Adapter callback marks `sessions.status='closed'` so the next
 *      poll tick drops the row.
 *    - Orchestrator clears intent queue + aborts in-flight streams +
 *      flips processing flag false for the thread.
 *    - NarrationManager drops the brain + lastSeq/apifyStartMs entries.
 *
 *  Threshold lives on `NarrationManagerOpts.idleTimeoutMs` (default 5
 *  min). Channels can override per-call cadence (anam-web users may
 *  read longer; phone calls hang up faster). */
export interface CallTimedOutEvent extends BaseLogEvent {
  kind: 'call.timed-out';
  data: {
    /** Wall-clock ms since the last detail/chat row arrived for this
     *  session — i.e. how long the call has been silent. */
    idle_ms: number;
    /** Channel that owned the session (e.g. 'phone-call', 'anam-web').
     *  Lets dashboards filter timeouts per channel. */
    channel_type: string;
  };
}

/** Emitted when a session exceeds the hard TTL safety net and gets
 *  force-closed. Catches zombie sessions where continuous activity
 *  (e.g. narration loop firing LLM calls into a dead WebRTC session)
 *  defeats the idle timeout — the session stays "active" because
 *  outbound rows keep flowing, even though no browser is listening.
 *
 *  The TTL is an absolute wall-clock cap on session lifetime. Real
 *  calls shouldn't last an hour; even if they do, reconnecting is
 *  better than burning API credits for days.
 *
 *  Side effects mirror `call.timed-out`: adapter marks the session
 *  closed, orchestrator clears cognition state, brain is torn down.
 *
 *  Threshold lives on `NarrationManagerOpts.sessionTtlMs` (default
 *  60 minutes). */
export interface SessionTtlExpiredEvent extends BaseLogEvent {
  kind: 'session.ttl-expired';
  data: {
    /** Wall-clock ms the session has been alive. */
    alive_ms: number;
    /** Configured TTL that was exceeded. */
    ttl_ms: number;
    /** Channel that owned the session. */
    channel_type: string;
  };
}

export interface ContainerSpawnedEvent extends BaseLogEvent {
  kind: 'container.spawned';
  data: {
    agent_group: string;
    container_name: string;
  };
}

export interface ContainerExitedEvent extends BaseLogEvent {
  kind: 'container.exited';
  data: {
    exit_code: number;
    container_name: string;
  };
}

// ──────────────────────── Agent (container-side) tool calls ──────────────
// Origin: agent-runner (inside the Claude Code container). For a back-mind /
// text turn (Telegram, etc.) the agent's tool calls run in the container and
// previously went ONLY to the bounded per-session `container.stderr.log` —
// unstructured and shipped nowhere, so "what tools did the agent call / did
// it search the web / why did it pick X" was unanswerable from `pat_events`.
// The container can't reach the forwarder directly (6PN / egress lockdown), so
// the agent-runner writes a sentinel-prefixed JSONL line to stderr
// (`@@PATEVENT@@ {json}`) from its PreToolUse hook; the host's stderr tee
// (`nanoclaw/src/container-runner.ts`) parses that line and re-emits it HERE
// with the authoritative session/thread/agent_group ids from the spawn
// context. One event per SDK tool_use. Observability only — never affects
// delivery.
export interface AgentToolUseEvent extends BaseLogEvent {
  kind: 'agent.tool_use';
  data: {
    /** Tool the back-mind agent invoked — an SDK builtin (Bash, Read,
     *  WebFetch, Task, …) or a namespaced MCP tool (`mcp__<server>__<tool>`). */
    tool: string;
    /** TRUNCATED single-line summary of the tool input (~2KB cap, bounded at the
     *  emit site). NEVER the full payload — keeps secrets / multi-MB inputs out
     *  of `pat_events`. */
    input_summary: string;
    /** SDK `tool_use` block id when the PreToolUse hook supplied one. Lets a
     *  consumer pair this with the matching agent.tool_result (output) and the
     *  back-mind detail-row stream (`detail.row-received` tool-pre/tool-post). */
    tool_use_id?: string;
    /** Agent group that owns the container (the `ag-…` id), stamped by the
     *  host re-emit from the spawn context. */
    agent_group_id?: string;
  };
}

export interface AgentToolResultEvent extends BaseLogEvent {
  kind: 'agent.tool_result';
  data: {
    /** Tool that returned — pairs with the agent.tool_use by `tool_use_id`. */
    tool: string;
    /** Did the tool succeed? false = the SDK PostToolUseFailure branch. */
    ok: boolean;
    /** TRUNCATED single-line summary of the tool OUTPUT (~2KB cap) — the result
     *  on success, the error on failure. NEVER the full payload; the full result
     *  still goes to the per-session container.stderr.log + the tool-post detail
     *  row (capped ~5KB). */
    output_summary: string;
    /** SDK `tool_use` block id — correlates this result to its agent.tool_use. */
    tool_use_id?: string;
    /** Agent group that owns the container, stamped by the host re-emit. */
    agent_group_id?: string;
  };
}

/** MCP server connect statuses at query() open — same sentinel transport as
 *  agent.tool_use. The Agent SDK spawns the claude subprocess with stderr
 *  discarded, so a failed MCP handshake (e.g. 401, credential missing from
 *  the vault) was previously invisible everywhere. One event per query()
 *  open; the failure signal the credential-gated activation flow verifies
 *  against (plans/mcp-management.md). */
export interface AgentMcpServersEvent extends BaseLogEvent {
  kind: 'agent.mcp-servers';
  data: {
    /** One entry per configured MCP server; status is the SDK's
     *  connected | failed | needs-auth | pending | disabled. */
    servers: Array<{ name: string; status: string }>;
    /** Agent group that owns the container, stamped by the host re-emit. */
    agent_group_id?: string;
  };
}

// ─────────────── Credential reconcile / MCP activation (host) ─────────────
// Origin: nanoclaw host. The credential_routing table (DB) is the source of
// truth for vault injection; reconcile derives the OneCLI vault from it at
// boot + on demand. An approved add_mcp_server whose credential isn't in the
// vault yet is parked (mcp.activation-pending) and auto-activated by the
// credential watcher when the credential lands (mcp.activation-activated);
// one crossing its fast-poll window emits mcp.activation-slow. Secret VALUES
// never appear in these events — names/hosts/counts only.
// See plans/credential-activation-implementation.md.

export interface SecretsReconcileSummaryEvent extends BaseLogEvent {
  kind: 'secrets.reconcile-summary';
  data: {
    /** Vault entry names created (AGENT_ value present, entry was missing). */
    created: string[];
    /** Entry names replaced to refresh the value (rotation propagation). */
    refreshed: string[];
    /** Entry names deleted (tombstoned routes). */
    deleted: string[];
    /** Routes declared but awaiting their AGENT_ value. */
    awaiting: string[];
    /** Entries left alone (no env value; hand-managed vault entry). */
    untouched: string[];
    /** "name: message" per route that errored. */
    errors: string[];
    dry_run: boolean;
  };
}

export interface McpActivationPendingEvent extends BaseLogEvent {
  kind: 'mcp.activation-pending';
  data: {
    /** MCP server name (config key). */
    name: string;
    /** Vault host the watcher waits for. */
    host_pattern: string;
    /** Canonical AGENT_<X> secret name (name only, never the value). */
    secret_name: string;
    agent_group_id: string;
  };
}

export interface McpActivationActivatedEvent extends BaseLogEvent {
  kind: 'mcp.activation-activated';
  data: {
    name: string;
    host_pattern: string;
    agent_group_id: string;
    /** ms between enqueue and the credential appearing. */
    waited_ms: number;
  };
}

export interface McpActivationSlowEvent extends BaseLogEvent {
  kind: 'mcp.activation-slow';
  data: {
    name: string;
    host_pattern: string;
    secret_name: string | null;
    agent_group_id: string;
    waited_ms: number;
  };
}

// ───────────────────────── File publishing (host) ─────────────────────────
// Origin: nanoclaw host (modules/file-publish). The agent publishes a
// workspace file to a public signed expiring URL; the host serves it on
// GET /files/pub/<name> (proxied publicly by pat-frontend). Names/sizes only —
// never signatures or URLs (a logged URL would be a live capability).

export interface FilePublishedEvent extends BaseLogEvent {
  kind: 'file.published';
  data: {
    /** Stored public name: <base>.<slug><ext>. */
    name: string;
    agent_group_id: string;
    session_id: string;
    size_bytes: number;
    ttl_hours: number;
    expires_at: string;
  };
}

export interface FileServedEvent extends BaseLogEvent {
  kind: 'file.served';
  data: {
    name: string;
    size_bytes: number;
  };
}

export interface ChatRowReceivedEvent extends BaseLogEvent {
  kind: 'chat.row-received';          // back-mind produced a chat reply
  data: {
    seq: number;
    preview: string;
    full_text?: string;               // when not truncated
  };
}

export interface DetailRowReceivedEvent extends BaseLogEvent {
  kind: 'detail.row-received';        // tool-pre / tool-post / reasoning / etc.
  data: {
    seq: number;
    type:
      | 'tool-pre'
      | 'tool-post'
      | 'tool-failed'
      | 'token-delta'
      | 'query-start'
      | 'query-end'
      | 'compact'
      | 'reasoning-streamed'
      | 'message-block-dispatched'
      | 'message-block-dropped';
    tool?: string;
    tool_use_id?: string;
    // ── message-block-dispatched / message-block-dropped fields ──
    /** dispatched/dropped only: the literal `to=` attribute the model
     *  wrote in the <message> block (destination name or namespaced
     *  platform-id). */
    to?: string;
    /** dispatched only: resolved routing fields after destination /
     *  cold-contact resolution. `match` distinguishes which path matched. */
    channel_type?: string;
    platform_id?: string;
    body_len?: number;
    match?: 'destination-name' | 'cold-contact';
    /** dropped only: human-readable explanation
     *  (`unknown-destination` or the cold-contact rejection message). */
    reason?: string;
    /** tool-pre only: raw `tool_input` block as captured by the SDK hook.
     *  Truncated downstream if extremely large but kept structured (object,
     *  not stringified) so the dashboard modal can render it as JSON. */
    input?: Record<string, unknown>;
    /** tool-post only: truncated string preview of `tool_response`. We
     *  stringify on the agent-runner side so multi-MB tool outputs don't
     *  bloat outbound.db beyond the configured cap. */
    result_preview?: string;
    /** True if `result_preview` was clipped from the original. */
    result_truncated?: boolean;
    /** Pre-truncation length of the stringified tool result, in chars. */
    result_total_chars?: number;
    /** tool-failed only: stringified error message / object preview. */
    error?: string;
    /** reasoning-streamed only: a chunk of model thinking text. Multiple
     *  rows may arrive per turn — concatenating in arrival order
     *  reconstructs the running thinking buffer. */
    text?: string;
    /** Optional, server-side-parsed friendly description of a Bash
     *  invocation. Populated only when `tool === 'Bash'` and the
     *  `command` matched one of the known categories in
     *  `realtime/src/bash-parse.ts`. Lets every consumer (pat-web tool
     *  banners, pat-frontend timeline, future Slack tooling) render a
     *  consistent human label without re-parsing. */
    parsed_command?: {
      type:
        | 'fetched-web-page'
        | 'ran-program'
        | 'git'
        | 'read-file'
        | 'listed-files'
        | 'searched-files'
        | 'installed-packages'
        | 'edited-file'
        | 'made-directory'
        | 'changed-directory'
        | 'other';
      salient: string;
    };
  };
}

export interface RoutingMessageRoutedEvent extends BaseLogEvent {
  kind: 'routing.message-routed';
  data: {
    agent_group: string;
    msg_kind: string;                 // 'chat' | 'banter' | etc.
    user_id: string;
    // PAT: OPAQUE person anchor — this event carries both session_id (top-level)
    // and the person_id, on every channel. Join its session_id to the session's
    // other events (which don't carry person). null = unknown sender. No
    // person_name — names live in the `pat_enrichment` directory, resolved at
    // query time (resolve_person / patobs resolve), never beside bodies.
    person_id: string | null;
    wake: boolean;
    created: boolean;
    agent_group_name: string;
  };
}

export interface RoutingMessageDeliveredEvent extends BaseLogEvent {
  kind: 'routing.message-delivered';
  data: {
    msg_id: string;
    msg_kind: string;
    channel_type: string;
    file_count?: number;
  };
}

/** PAT: which COMPONENT produced an outbound send. Drives `outbound.sent.origin`.
 *   - 'agent'    — a back-mind container reply (the per-session agent's
 *                  authored response, delivered by the host outbound poll).
 *   - 'system'   — nanoclaw host machinery: verification/pairing prompts,
 *                  approval / channel-request cards, permission denials,
 *                  scheduled-task delivery, error surfacing, signal-health
 *                  admin DMs, OneCLI approval cards.
 *   - 'realtime' — the realtime library doing a DISCRETE text send. Rare:
 *                  realtime is mostly spoken (covered by banter.* / tts.* /
 *                  narrator.*), so this is only stamped where the realtime
 *                  lib actually sends a discrete message. */
export type OutboundOrigin = 'agent' | 'system' | 'realtime';

/**
 * PAT: PAT's OUTBOUND message body — the symmetric counterpart of
 * `inbound.received`. Emitted once per delivered outbound message at the
 * channel-agnostic delivery seam (the host's `ChannelDeliveryAdapter` choke
 * point in `nanoclaw/src/channels/channel-registry.ts`), through which BOTH
 * the outbound delivery poll (back-mind/container replies) and every
 * host-module system send (verification/pairing prompts, approval /
 * channel-request cards, permission denials, signal-health admin DMs, OneCLI
 * approval cards) flow via `getDeliveryAdapter()`. Carries the message body +
 * who→who + which component authored it, so a full back-and-forth
 * conversation can be reconstructed from `pat_events` — today only the human
 * half is logged (`inbound.received`); outbound previously produced only a
 * body-less `signal.send-acked`. Purely additive: existing delivery events
 * (`signal.send-acked`, `routing.message-delivered`) are unchanged.
 */
export interface OutboundSentEvent extends BaseLogEvent {
  kind: 'outbound.sent';
  data: {
    /** Channel the message went out on — 'signal' | 'telegram' | 'slack'
     *  | 'phone-call' | 'anam-web' | ... Mirrors
     *  `inbound.received.channel_type` so a person-scoped query can slice
     *  the outbound half by venue too. */
    channel_type: string;
    /** The outbound message BODY (the text PAT sent). Empty string for
     *  bodyless sends (pure file attachment, ask_question card) — the
     *  event still records who→who. */
    text: string;
    /** Recipient's NAMESPACED handle (`<channel>:<handle>`), same convention
     *  as `inbound.received.sender_id` / nanoclaw `users.id` — e.g.
     *  `signal:a46c4625-…`, `pstn:+1808…`. */
    recipient_user_id: string;
    /** OPAQUE people-spine anchor for the recipient — resolved via the
     *  people module (`resolvePersonIdentity` / `getPersonByUser` on
     *  `recipient_user_id`). null when the recipient isn't linked to a
     *  person, or when resolution failed (defensive — enrichment never
     *  blocks the send). person_name is DELIBERATELY absent: names must
     *  never land beside message bodies in `pat_events`. The id→name
     *  mapping lives in the `pat_enrichment` directory stream; resolve at
     *  query time (mirrors the `inbound.received.person_id` rule). */
    recipient_person_id: string | null;
    /** PAT's own account as a NAMESPACED handle for this channel, e.g.
     *  `signal:+15550100003` (signal-cli reports `data_account` like
     *  `+15550100003`; prefix it with the channel). Best-effort — empty
     *  string when the delivery seam can't determine the sending account
     *  generically. */
    sender_user_id: string;
    /** Which agent group sent it (the `ag-…` id), when available. null on
     *  host-module/system sends that aren't tied to a specific agent
     *  group. */
    sender_agent_group_id: string | null;
    /** The COMPONENT that produced the send. See `OutboundOrigin`. */
    origin: OutboundOrigin;
  };
}

// ──────────────────────── People directory events ────────────────────────
// Origin: nanoclaw-host (src/people/index.ts). Emitted on every people-spine
// MUTATION so the `pat_enrichment` directory stream (built by the forwarder)
// stays fresh without a poll. These carry a person's display_name + handles —
// which is FINE: the forwarder routes `people.*` to `pat_enrichment`, NOT to
// `pat_events`, so names never land beside message bodies. `pat_enrichment` is
// the id→name/handles directory the resolver (`resolve_person` / `patobs
// resolve`) reads at query time. Defensive at the emit site — a logging
// failure must never break the underlying mutation.

/** A person was created or otherwise has a NEW/UPDATED directory snapshot:
 *  create, name update, identifier added, or a handle linked. Carries the
 *  full current snapshot so the directory can upsert one row per person. */
export interface PeopleUpsertedEvent extends BaseLogEvent {
  kind: 'people.upserted';
  data: {
    person_id: string;
    display_name: string;
    /** Current linked handles (the `users.id` namespaced sender_ids). */
    handles: string[];
    /** Current recognizable identifiers (email / phone). */
    identifiers: { kind: string; value: string }[];
  };
}

/** A person (or one of their links/identifiers) was REMOVED: person deleted,
 *  handle unlinked, or identifier removed. For a full delete, `handles` /
 *  `identifiers` are empty and the directory should tombstone the row. For a
 *  partial removal (unlink / identifier-remove) the snapshot reflects what
 *  REMAINS so the directory upserts the reduced row. */
export interface PeopleRemovedEvent extends BaseLogEvent {
  kind: 'people.removed';
  data: {
    person_id: string;
    display_name: string;
    handles: string[];
    identifiers: { kind: string; value: string }[];
  };
}

// ──────────────────────── Permissions events ────────────────────────────
// Origin: nanoclaw-host. Emitted by the permissions module when a
// realtime caller's identity is mapped to a privileged role.

// ──────────────────────── Barge-in / cancel events ──────────────────────
// Origin: voice-transport posts `bargein.received`; nanoclaw emits the
// rest. Together they form the cancel propagation chain — Cartesia
// cancels the SDK process(), voice-transport tells the host, host kills
// the back-mind container, accumulator drops in-flight intents.

export interface BargeinReceivedEvent extends BaseLogEvent {
  kind: 'bargein.received';
  data: {
    /** Why the SDK cancelled (mirrors `cartesia.task-cancelled.reason`). */
    reason: string;
  };
}

export interface BargeinPropagatedEvent extends BaseLogEvent {
  kind: 'bargein.propagated';
  data: {
    /** Whether a back-mind container was actively killed, vs there was
     *  nothing in flight to cancel. */
    killed_container: boolean;
    /** session_id of the killed container when applicable. */
    killed_session_id?: string;
    /** Pending contexts (raw back-mind chat texts) that were discarded
     *  alongside the kill. Count only; the texts themselves stay in the
     *  outbound.db record. */
    dropped_pending_contexts: number;
  };
}

export interface BackMindCancelledEvent extends BaseLogEvent {
  kind: 'back-mind.cancelled';
  data: {
    /** Where the cancel originated. `bargein` = user barged in;
     *  `superseded` = front-mind sent a new directive that supersedes
     *  the in-flight one. Today only `bargein` is wired. */
    reason: 'bargein' | 'superseded';
  };
}

export interface IntentAccumulatedEvent extends BaseLogEvent {
  kind: 'intent.accumulated';
  data: {
    /** Raw back-mind chat that just arrived while a prior intent was
     *  still rendering. Pushed onto `pending_contexts`. */
    raw_text: string;
    /** Total entries in pending_contexts after this push. */
    pending_total: number;
  };
}

export interface IntentRenderedMultiEvent extends BaseLogEvent {
  kind: 'intent.rendered-multi';
  data: {
    /** How many raw back-mind chats were merged into one rendition. */
    context_count: number;
    /** The single rendered utterance that covers all contexts. */
    rendered_text: string;
    /** How long the single model call took. */
    render_ms: number;
  };
}

/** PAT 2026-05-25: per-step timing inside `deliverChat`, used to localize
 *  the observed 16-second gap between `chat.row-received` and the first
 *  `utterance.stream-started src=banter-rendition`. One event per step;
 *  `elapsed_ms` is delta since the `enter` step (so steps form a
 *  cumulative timeline). Each step also carries `iter` (0-indexed loop
 *  iteration) and optionally `pending_count` / `input_chars` / `render_ms`
 *  for cross-checks. Debug-level — only present when SSE include_debug=1. */
export interface DeliverChatStepEvent extends BaseLogEvent {
  kind: 'deliver-chat.step';
  data: {
    step:
      | 'enter'
      | 'sentinel-dropped'
      | 'accumulated'
      | 'loop-iter'
      | 'scenario-resolved'
      | 'caller-context-resolved'
      | 'before-runStreamingFrontMind'
      | 'after-runStreamingFrontMind'
      | 'loop-exit';
    elapsed_ms: number;
    iter?: number;
    pending_count?: number;
    input_chars?: number;
    render_ms?: number;
  };
}

// ───────────────────── Scenario tag-stream events ───────────────────────
// Origin: nanoclaw-host. Emitted when a scenario-mode chat row is
// parsed as a tag stream (`plans/presenter-tag-stream.md`). One
// `scenario.tag-stream-started` per chat row, one
// `scenario.tag-stream-ended` per chat row, and one
// `scenario.action` per dispatched action (prose chunk, slide-nav,
// fragment advance, ask-questions, tool directive, etc.).

export type ScenarioActionType =
  | 'prose'
  | 'slide-nav'
  | 'slide-goto'
  | 'fragment'
  | 'ask-questions'
  | 'tool'
  | 'pause'
  | 'cartesia-passthrough'
  | 'unknown-tag'
  // PAT: <timeline>...</timeline> wrapper brackets. Carry `timeline_id`
  // on the scenario.action payload; the dedicated timeline.started /
  // timeline.finished log events have the same id for pairing.
  | 'timeline-started'
  | 'timeline-finished'
  // PAT Phase 6: `<timeline_span from="N" to="M"/>` — back-mind emission
  // hydrated by the orchestrator from the current slide's authored
  // timeline. The scenario.action payload carries `from` + `to`; the
  // separate `timeline.span-hydrated` event carries the expansion outcome
  // (actions appended, or warning if hydration source missing).
  | 'timeline-span';

export interface ScenarioTagStreamStartedEvent extends BaseLogEvent {
  kind: 'scenario.tag-stream-started';
  data: {
    scenario_slug: string;
    /** Cursor at the time the stream began (1-indexed slide number).
     *  -1 when unknown (pre-delivery / not yet advanced). */
    slide_n: number;
    /** Raw chat-row text length in chars — useful for forensic sizing. */
    raw_chars: number;
  };
}

export interface ScenarioActionEvent extends BaseLogEvent {
  kind: 'scenario.action';
  data: {
    scenario_slug: string;
    /** Discriminator for the action body — every consumer dispatches on
     *  this. Mirrors `ScenarioAction.type` in
     *  `realtime/src/scenario-action-stream.ts`. */
    action_type: ScenarioActionType;
    /** 1-indexed slide cursor at dispatch time. */
    slide_n: number;
    /** Sequence index within this tag stream (0-based). */
    seq: number;
    /** For prose: the spoken text. Truncated to
     *  ~280 chars in the structured-log emit; the full text rides the
     *  /anam-web/banter SSE through the rendition transport. */
    text?: string;
    /** For slide-nav: direction (`next` | `prev` | `up` | `down` |
     *  `left` | `right`). */
    direction?: string;
    /** For slide-goto: target slide (1-indexed). */
    target_slide?: number;
    /** For fragment: direction (`next` | `prev`). */
    fragment_direction?: 'next' | 'prev';
    /** For tool: tool name (without the `tool_` prefix). */
    tool_name?: string;
    /** For tool: coerced attribute payload. */
    tool_args?: Record<string, string | number | boolean>;
    /** For unknown-tag: the raw tag name + attrs. */
    raw_tag?: string;
    /** For timeline-started / timeline-finished: the wrapper id.
     *  Matches the dedicated `timeline.started` / `timeline.finished`
     *  log events. */
    timeline_id?: string;
    /** PAT Phase 6 — `<timeline_span from="N" to="M"/>` indices.
     *  Inclusive on both ends. The accompanying
     *  `timeline.span-hydrated` event carries the expansion outcome
     *  (how many actions inlined, or why hydration was skipped). */
    from?: number;
    to?: number;
  };
}

/** PAT Phase 6: emitted when the orchestrator inline-expands a
 *  `<timeline_span/>` action against the current slide's authored
 *  timeline. Carries the indices the back-mind asked for plus the
 *  expansion outcome (number of actions appended, or warning when
 *  the authored timeline is missing / indices out of range). Pairs
 *  with `scenario.action` of `action_type='timeline-span'` (same chat
 *  row, no shared id today — pair by seq). */
export interface TimelineSpanHydratedEvent extends BaseLogEvent {
  kind: 'timeline.span-hydrated';
  data: {
    scenario_slug?: string;
    /** Slide cursor at hydration time (1-indexed). -1 when unknown. */
    slide_n: number;
    from: number;
    to: number;
    /** Number of authored actions inlined into the action stream. 0
     *  when authored timeline missing OR indices out of range — see
     *  `reason`. */
    inlined: number;
    /** Total action count of the authored timeline (so consumers can
     *  see "asked for 0..5 but only 3 authored"). */
    authored_count: number;
    /** Populated when inlined=0; null on success. */
    reason?: 'no-authored-timeline' | 'out-of-range' | 'parse-failed';
  };
}

export interface ScenarioTagStreamEndedEvent extends BaseLogEvent {
  kind: 'scenario.tag-stream-ended';
  data: {
    scenario_slug: string;
    slide_n: number;
    /** Total actions dispatched. */
    action_count: number;
    /** Wall-clock ms from started → ended. */
    duration_ms: number;
    /** Terminator that closed the stream (e.g. `slide_next`,
     *  `ask_for_questions`, or `none` if the chat row ran to end
     *  without an explicit terminator). */
    terminator: string;
  };
}

// ──────────────────────── Timeline wrapper events ─────────────────────
// Origin: nanoclaw-host. Bracket the playback lifecycle of one
// `<timeline>...</timeline>` XML stream the back-mind emits in a chat
// row. Distinct from `scenario.tag-stream-*` (parser-bound, per chat
// row): timeline.* events are scoped to the agent's authored wrapper.
// The orchestrator manages timelineActiveByThread state and emits these
// for the state machine + narrator gate to read.

export interface TimelineStartedEvent extends BaseLogEvent {
  kind: 'timeline.started';
  data: {
    /** Per-stream synthetic id (matches the `timeline-started`
     *  ScenarioAction). Pair with `timeline.finished.timeline_id`. */
    timeline_id: string;
    /** Active scenario slug, if any. Omitted for non-scenario timelines. */
    scenario_slug?: string;
  };
}

export interface TimelineFinishedEvent extends BaseLogEvent {
  kind: 'timeline.finished';
  data: {
    timeline_id: string;
    /** How the timeline ended:
     *   - `completed`: parser saw `</timeline>` (or auto-closed at
     *     chat-row end — agent forgot the close tag; non-fatal).
     *   - `interrupted`: barge-in / user-speech cancelled mid-playback. */
    reason: 'completed' | 'interrupted';
    /** Wall-clock ms from started → finished. */
    duration_ms: number;
    scenario_slug?: string;
  };
}

// ──────────────────────── Timeline action-level events ────────────────
// Origin: nanoclaw-host (timeline runtime sequencer). One event per
// action dispatched by the sequencer. Together with the wrapper
// lifecycle events above, give per-action observability for the
// linear-contract dispatch loop. See
// plans/timeline-runtime-and-scenarios.md §3.2 + §6.

export interface TimelineActionEnqueuedEvent extends BaseLogEvent {
  kind: 'timeline.action-enqueued';
  data: {
    timeline_id: string;
    /** Short label of the action kind (e.g. 'say', 'pause',
     *  'next_fragment', 'tool:send_signal', 'terminator:next_slide'). */
    kind: string;
    /** 0-based sequence index within the timeline. */
    seq: number;
    /** Salient per-action fields — populated by the orchestrator so the
     *  dashboard can render the action's distinguishing payload without
     *  having to subscribe to the live action stream. Examples by kind:
     *  - say: `text` (preview, truncated)
     *  - pause: `ms`
     *  - tool:NAME / tool:NAME:async: `tool_name`, `args` (coerced)
     *  - next_fragment / prev_fragment: `direction`
     *  - next_slide / prev_slide / nav_slide_*: `direction`
     *  - goto_slide: `n`, optional `v`
     *  - terminator:REASON: `reason` (mirrored from kind for legibility)
     *  Keys are loosely typed; consumers dispatch on `data.kind` first
     *  and read the appropriate field. Optional — pre-attrs events from
     *  prior releases / tests omit it. */
    attrs?: Record<string, string | number | boolean>;
  };
}

export interface TimelineActionStartedEvent extends BaseLogEvent {
  kind: 'timeline.action-started';
  data: {
    timeline_id: string;
    kind: string;
    seq: number;
    /** ms-since-epoch when the sequencer peeked this action and began
     *  awaiting its dispatch. Distinct from the enqueue timestamp (which
     *  marks queue-push, before any sibling actions' waits resolve).
     *  Pair with `timeline.action-completed.ts_end` to get the actual
     *  playback window — what the dashboard swimlane bar should span. */
    ts_start: number;
  };
}

export interface TimelineActionCompletedEvent extends BaseLogEvent {
  kind: 'timeline.action-completed';
  data: {
    timeline_id: string;
    kind: string;
    seq: number;
    /** Wall-clock ms from dispatch start to completion signal. */
    duration_ms: number;
    /** ms-since-epoch when dispatch started — same value the
     *  agent-facing `<completed_actions>` block stamps. */
    ts_start: number;
    /** ms-since-epoch when the completion signal fired. */
    ts_end: number;
  };
}

export interface TimelineActionCancelledEvent extends BaseLogEvent {
  kind: 'timeline.action-cancelled';
  data: {
    timeline_id: string;
    kind: string;
    seq: number;
    /** Why the action was killed — sequencer-set string. Typical
     *  values: `'bargein'`, `'superseded'`, `'sequencer-stopped'`. */
    reason: string;
    /** Optional partial-text capture (for `say` actions whose TTS was
     *  cut off mid-speech — the prefix that audience actually heard). */
    partial?: string;
  };
}

// ──────────────────────── Streaming utterance events ────────────────────
// Origin: nanoclaw-host. Emitted by the streamBanterToSse helper that
// powers banter (acks), rendition (back-mind chat → Pat's voice), and
// narration (filler) — three call sites, one streaming abstraction.
// `source` discriminator lets dashboards distinguish without new kinds
// per call site. Behind `PAT_STREAMING_BANTER` flag during rollout.

export type UtteranceSource = 'banter-ack' | 'banter-rendition' | 'banter-narration';

export interface UtteranceStreamStartedEvent extends BaseLogEvent {
  kind: 'utterance.stream-started';
  data: {
    source: UtteranceSource;
    /** Hint at the model the helper used (fast LLM). */
    model: string;
  };
}

export interface UtteranceStreamDeltaEvent extends BaseLogEvent {
  kind: 'utterance.stream-delta';
  data: {
    source: UtteranceSource;
    /** The text fragment appended to the buffered utterance. We sample
     *  these emit-side (every Nth delta + always the first/last) so
     *  the log file isn't drowned by per-token rows. */
    text_delta: string;
    /** Sequence index of this delta within the stream (0-based). */
    seq: number;
  };
}

export interface UtteranceStreamEndedEvent extends BaseLogEvent {
  kind: 'utterance.stream-ended';
  data: {
    source: UtteranceSource;
    /** Full accumulated text, post-cleanBanterText. */
    full_text: string;
    /** Total deltas observed (including the ones we sampled out
     *  of the delta event stream). */
    delta_count: number;
    /** Wall-clock ms from stream-started to stream-ended. */
    stream_ms: number;
    /** ms to first delta — proxy for time-to-first-spoken-syllable. */
    first_delta_ms: number;
  };
}

export interface UtteranceStreamCancelledEvent extends BaseLogEvent {
  kind: 'utterance.stream-cancelled';
  level: 'info' | 'warn';
  data: {
    source: UtteranceSource;
    /** What aborted us. `bargein` = user barged in via /barge-in;
     *  `superseded` = a newer stream replaced this one mid-flight;
     *  `error` = SDK/network failure during streaming. */
    reason: 'bargein' | 'superseded' | 'error';
    /** How much text we'd accumulated before the cancel — useful
     *  for forensics on "how much did the user actually hear". */
    partial_text: string;
    delta_count: number;
  };
}

// ──────────────────────── Browser RTT instrumentation ──────────────────
// Origin: pat-web running in the browser (source='pat-web-browser').
// Forwarded through pat-web's Hono server to nanoclaw `/admin/log-event`.
// Together these two events bracket the round-trip from the moment the
// browser dispatches a user turn upstream to the moment the first
// banter delta lands back in the browser. Originally instrumented to
// measure whether a duplex WebSocket (Mode C′) was worth the cost; as
// of 2026-05-23 the WS is live, and both rows now fire over the WS path.

/**
 * Emitted by `pat-web/src/talk/hooks/use-banter-driver.ts` immediately
 * before sending a `user-message` frame down the realtime WebSocket
 * (`/api/realtime`). Pair with `utterance.delta-received` via
 * `correlation_id` to measure end-to-end RTT.
 */
export interface InboundSentEvent extends BaseLogEvent {
  kind: 'inbound.sent';
  data: {
    /** Length of the user transcript being sent upstream (chars). */
    user_text_length: number;
    /** Freshly-minted on the browser side; threaded into the matching
     *  `utterance.delta-received` rows so post-mortem can join. */
    correlation_id: string;
  };
}

/**
 * Emitted by `pat-web/src/talk/hooks/use-anam-session.ts` every time
 * the browser receives a banter delta chunk over the realtime
 * WebSocket (`/api/realtime`). Fires once per chunk arrival (typically
 * 5–20 per stream). The `utterance_id` is the same id the server
 * stamped on the matching `utterance.stream-started`; the
 * `correlation_id` ties the receive event back to the originating
 * `inbound.sent`.
 */
export interface UtteranceDeltaReceivedEvent extends BaseLogEvent {
  kind: 'utterance.delta-received';
  data: {
    /** Same id the server stamped on `utterance.stream-started` (when
     *  available). Empty string when the started event hasn't yet
     *  threaded an id through — kept as a key for ordered joining. */
    utterance_id: string;
    /** Mirrors `UtteranceSource` server-side — which banter layer the
     *  delta belongs to. */
    source_layer: UtteranceSource;
    /** 0-based sequence index, matches server-side stream-delta seq. */
    sequence: number;
    /** Length of THIS delta chunk in chars (not cumulative). */
    chars: number;
    /** Set on the matching `inbound.sent` (one per user turn). When
     *  the browser can't determine which inbound triggered this
     *  stream, falls back to ''. */
    correlation_id: string;
  };
}

/**
 * PAT: a realtime/phone caller was REFUSED at the inbound authorization gate.
 *
 * Emitted by the phone-call channel handler when the caller's messaging group
 * is on a gated `unknown_sender_policy` (`request_approval` or `strict`) and the
 * caller is NOT authorized (not owner/admin/member and does not resolve to a
 * known person even after auto-approve). The handler speaks a one-line refusal
 * via the realtime-utterance SSE and returns early WITHOUT writing the inbound
 * to the session, waking the agent, or running banter.
 *
 * Public/allow groups never produce this event — the gate is a no-op there
 * (prod behavior unchanged), so a `permissions.caller-refused` line always means
 * an operator has deliberately flipped the policy AND an unknown number called.
 */
export interface PermissionsCallerRefusedEvent extends BaseLogEvent {
  kind: 'permissions.caller-refused';
  level: 'warn';
  data: {
    /** Namespaced caller id, e.g. `pstn:+15555550100` or `realtime:<platform>`. */
    sender_id: string;
    /** The messaging group's `unknown_sender_policy` that gated this call —
     *  one of 'request_approval' | 'strict'. */
    policy: string;
    /** The routing platform id (caller's E.164, or 'unknown' fallback). */
    platform_id: string;
  };
}

export interface PermissionsRealtimeOwnerResolvedEvent extends BaseLogEvent {
  kind: 'permissions.realtime-owner-resolved';
  data: {
    /** The phone (E.164, with leading `+`) that matched the configured
     *  allowlist. Same value as the suffix of `user_id` for
     *  decision='granted' and 'already_owner'. */
    matched_phone: string;
    /** The namespaced user id, e.g. `pstn:+13415551234`. */
    user_id: string;
    /** What role was granted (or already held). Today always 'owner'; the
     *  field exists so a future scoped-admin variant doesn't break
     *  consumers. */
    role: 'owner' | 'admin';
    /** What the resolver decided this turn. `granted` = a new
     *  user_roles row was inserted; `already_owner` = the role was
     *  already in place; `refused` = phone matched no rule (not emitted
     *  today — non-matching phones produce no event at all to keep the
     *  log surface clean). */
    decision: 'granted' | 'already_owner';
    /** Where the decision came from (today only `env_PAT_OWNER_PHONES`).
     *  Lets us add additional sources later without schema churn. */
    reason: string;
  };
}

// ──────────────────────── Skill events ──────────────────────────────────
// Origin: agent-runner (container-side skill handlers). Today only the
// generate-image skill emits structured events; new skills should follow
// the same `<skill-area>.<event>` convention.

export interface ImagegenRequestedEvent extends BaseLogEvent {
  kind: 'imagegen.requested';
  data: {
    /** Full user prompt as passed to OpenRouter (forensic value > size).
     *  May be prefixed with a quality-bias preamble — the original is
     *  recoverable by stripping the known prefix for `quality='high'`. */
    prompt: string;
    quality: 'medium' | 'high';
    /** OpenRouter model slug, e.g. 'openai/gpt-5.4-image-2'. */
    model: string;
    /** Full SHA-256 hex of `<model>|<quality>|<prompt>`. Dashboards
     *  typically display only the first 8 chars; stored full so a
     *  cache_key is unambiguous when matching `imagegen.completed`. */
    cache_key: string;
  };
}

export interface ImagegenCompletedEvent extends BaseLogEvent {
  kind: 'imagegen.completed';
  /** `'error'` when the OpenRouter call or PNG write failed; otherwise
   *  defaults to 'info'. */
  level?: 'info' | 'warn' | 'error';
  data: {
    /** Matches the `cache_key` of the preceding `imagegen.requested`. */
    cache_key: string;
    /** `true` = served from `/workspace/agent/gen/<sha>.png`, no API
     *  call. `false` = fresh generation. */
    cache_hit: boolean;
    /** Wall-clock ms between request start and PNG written (or error
     *  raised). 0 on a cache hit. */
    latency_ms: number;
    /** PNG size in bytes when the generation succeeded. */
    bytes?: number;
    /** Absolute path under `/workspace/agent/gen/`. Populated on
     *  success; agent then pipes this to `send_file`. */
    output_path?: string;
    /** Populated only on failure; `level` is `'error'` in that case. */
    error?: string;
  };
}

// ──────────────────────── Error legibility ─────────────────────────────
// Origin: nanoclaw-host (realtime channel adapter). Emitted whenever a
// structured failure crosses the host — back-mind tool failure, host-side
// routing throw, rendition empty/throw, banter / narration circuit
// breaker. Always emitted (regardless of `PAT_ANNOUNCE_ERRORS`); the
// flag only gates whether the host also pushes a one-sentence
// announcement through the TTS broadcast path. See `error-surfacing.ts`
// for the decision logic + debounce window.

export interface ErrorSurfacedEvent extends BaseLogEvent {
  kind: 'error.surfaced';
  /** `'error'` default; `'warn'` for soft surfaces like a rendition
   *  failure that fell back to raw text (user-visible UX preserved). */
  level?: 'warn' | 'error';
  data: {
    /** Where the failure originated. Drives both the spoken-text
     *  template AND the per-source debounce window. */
    source:
      | 'back-mind-tool'
      | 'back-mind-mcp'
      | 'back-mind-sandbox'
      | 'host-routing'
      | 'rendition'
      | 'banter'
      | 'narration';
    /** Tool name when `source === 'back-mind-tool'`. */
    tool?: string;
    /** Truncated error message captured at emit time. Caller is
     *  responsible for keeping this under ~500 chars; the back-mind
     *  detail-row pipeline already truncates via `previewToolResult`. */
    error_preview: string;
    /** PAT (#36): Verbatim error text captured deterministically at the
     *  emit site — what the back-mind / host actually reported, with no
     *  rewording. Present when the caller has the full text on hand;
     *  bounded only by what the caller chose to forward (we suggest
     *  ~2-3KB upstream of this layer so the log volume stays
     *  manageable). Forensics can compare `error_raw` against the
     *  model-phrased `spoken_text` to verify the verbatim rule held. */
    error_raw?: string;
    /** `true` ⇒ host also pushed `spoken_text` through the TTS broadcast
     *  path. `false` ⇒ dashboard-only (flag off, debounced, or
     *  source-suppressed). */
    announced: boolean;
    /** The spoken voice line. Present iff `announced=true`. With #36
     *  this is model-phrased output (deterministic template only as
     *  fallback when the model call itself fails). */
    spoken_text?: string;
    /** `true` ⇒ this emit is recording a debounce-window suppress
     *  (a same-source error fired < 3s ago). Dashboard renders these
     *  collapsed so a burst of 5 failures shows "1 announced + 4
     *  suppressed" rather than 5 indistinguishable rows. */
    debounce_suppressed?: boolean;
  };
}

// ──────────────────────── Voice-transport events ─────────────────────────

export interface CallStartedEvent extends BaseLogEvent {
  kind: 'call.started';
  data: { /* thread_id is in top-level */ };
}

export interface CallEndedEvent extends BaseLogEvent {
  kind: 'call.ended';
  data: { /* thread_id is in top-level */ };
}

export interface SttUserSaidEvent extends BaseLogEvent {
  kind: 'stt.user-said';
  data: {
    text: string;
  };
}

/** PAT 2026-07-04: Cartesia closed a user turn with an EMPTY transcript
 *  buffer — the self-identifying signature of the endpointer-starvation
 *  drop (turn opened, no TranscriptionInput ever arrived, idle flushed
 *  nothing). Emitted by the voice-transport's idle branch at level=warn. */
export interface SttEmptyTurnEvent extends BaseLogEvent {
  kind: 'stt.empty-turn';
  data: {
    /** Seconds between the turn's speaking edge and the empty idle close;
     *  null if no speaking edge was observed for this turn. */
    secs_since_turn_start: number | null;
  };
}

/** PAT 2026-07-04: the call ended while transcription was still buffered
 *  (turn never finalized) — the speech was NOT delivered to nanoclaw.
 *  Observability only; the transport deliberately does not post /inbound
 *  at teardown (the call is over). */
export interface SttDiscardedOnTeardownEvent extends BaseLogEvent {
  kind: 'stt.discarded-on-teardown';
  data: {
    /** The undelivered user speech (truncated to 500 chars). */
    text: string;
  };
}

export interface TtsAgentSaidEvent extends BaseLogEvent {
  kind: 'tts.agent-said';
  data: {
    text: string;
    /** 'queued' = full utterance dispatched. 'per-word' = Cartesia
     *  per-word callback during render. We mostly care about queued.  */
    source: 'queued' | 'per-word';
  };
}

// ──────────────────────── Vendor events ────────────────────────────────
// Events whose origin is an external vendor's SDK or service — the
// triggering signal isn't our own logic, it's something the vendor's
// runtime reported to us. Kind always starts with `<vendor>.<event>`
// (no extra `vendor.` prefix — redundant). Add new vendors to the
// `VENDORS` const + the `Vendor` union below; existing dashboard /
// timeline code dispatches on `vendorOf(kind)` so it picks them up
// automatically.

export interface CartesiaAgentTurnBoundaryEvent extends BaseLogEvent {
  kind: 'cartesia.agent-turn-boundary';
  data: {
    edge: 'start' | 'stop';
    /** Concatenated text Cartesia reports having spoken in this turn
     *  (only on `edge='stop'`; populated from AgentTurnEnded.content). */
    text?: string;
  };
}

export interface CartesiaUserTurnBoundaryEvent extends BaseLogEvent {
  kind: 'cartesia.user-turn-boundary';
  data: {
    edge: 'start' | 'stop';
  };
}

export interface CartesiaUserTextSentEvent extends BaseLogEvent {
  kind: 'cartesia.user-text-sent';
  data: {
    /** A single STT chunk; multiple arrive between
     *  cartesia.user-turn-boundary edge='start' and edge='stop'. */
    text: string;
  };
}

export interface CartesiaAgentTextSentEvent extends BaseLogEvent {
  kind: 'cartesia.agent-text-sent';
  data: {
    /** Cumulative text Cartesia reports having spoken so far in the
     *  current turn (NOT a delta). Each successive event re-includes
     *  the prior text plus the next token, so the final event before
     *  cartesia.agent-turn-boundary edge='stop' equals the full turn
     *  text. Dashboards should generally collapse these to just the
     *  final value or render only the latest. */
    text: string;
  };
}

export interface CartesiaTaskCancelledEvent extends BaseLogEvent {
  kind: 'cartesia.task-cancelled';
  data: {
    /** Why the SDK cancelled the in-flight `process()` task — barge-in
     *  (UserTurnStarted matched the cancel_filter), call ended, etc. */
    reason: 'user-turn-started' | 'call-ended' | 'shutdown' | 'unknown';
  };
}

export interface CartesiaUserDtmfEvent extends BaseLogEvent {
  kind: 'cartesia.user-dtmf';
  data: {
    button: string;
  };
}

export interface CartesiaAgentDtmfEvent extends BaseLogEvent {
  kind: 'cartesia.agent-dtmf';
  data: {
    button: string;
  };
}

export interface CartesiaValidationErrorEvent extends BaseLogEvent {
  kind: 'cartesia.validation-error';
  level: 'warn' | 'error';
  data: {
    error_type: string;
    error_message: string;
  };
}

export interface CartesiaAgentHandoffEvent extends BaseLogEvent {
  kind: 'cartesia.agent-handoff';
  data: {
    target_phone_number?: string;
  };
}

// ──────────────────────── Vendor: apify ────────────────────────────────
// Origin: host-side synthesis. The agent-runner emits `detail.row-received`
// for every back-mind tool call; the realtime channel observer filters
// for `tool` matching `mcp__apify__*` on `type: 'tool-post'` and
// synthesizes `apify.run-completed`. There is no in-container emit
// path — Apify itself doesn't push events to us, we synthesize on the
// observed tool-result. (Same pattern we'd use for any future vendor
// MCP whose runtime we don't directly own.)

export interface ApifyRunCompletedEvent extends BaseLogEvent {
  kind: 'apify.run-completed';
  data: {
    /** Apify Actor slug — recovered from the MCP tool name. The SDK
     *  prefixes with `mcp__apify__`; the rest is the Actor identifier
     *  with `/` converted to `_` by the SDK's sanitizer. */
    actor_id: string;
    /** Apify-side run UUID — useful for cross-ref in their console.
     *  Populated only when the Actor surfaces it in the MCP response. */
    run_id?: string;
    /** Final status. SDK-typical values are SUCCEEDED / FAILED /
     *  TIMED-OUT / ABORTED; UNKNOWN when the response shape doesn't
     *  expose status. */
    status: 'SUCCEEDED' | 'FAILED' | 'TIMED-OUT' | 'ABORTED' | 'UNKNOWN' | string;
    /** Wall-clock duration between tool-pre and tool-post for the
     *  matching tool_use_id. Host-measured, not Apify-reported. */
    duration_ms: number;
    /** Item count when the Actor returns a dataset (most scrapers). */
    items_returned?: number;
    /** Compute units charged — populated only when the Actor surfaces
     *  it in the MCP response. */
    cu_charged?: number;
  };
}

// ──────────────────────── Channel: signal (host-side delivery acks) ────
// Origin: nanoclaw-host. Emitted by `src/channels/signal.ts` immediately
// after the signal-cli `send` JSON-RPC returns. Closes the observability
// gap where the only signal-related log event today is
// `routing.message-routed` (which fires on enqueue, not on actual
// delivery to the Signal Service). Three send paths (`sendText`,
// `sendAttachments`, `sendVoiceNote`) each emit one of these per RPC.

export interface SignalSendAckedEvent extends BaseLogEvent {
  kind: 'signal.send-acked';
  data: {
    /** Sender E164 (the linked signal-cli account). */
    account: string;
    /** Recipient E164 for DMs; for group sends this is empty and
     *  `group_id` is set instead. */
    recipient: string;
    /** Set when the send targeted a Signal group. */
    group_id?: string;
    /** signal-cli's response `timestamp` — the canonical success
     *  identifier on the Signal Service side. Cross-refs to the
     *  receiver's inbound `dataMessage.timestamp`. */
    signal_timestamp: number;
    /** Retry attempt number (1 = first try). Optional. */
    attempt_no?: number;
    /** Distinguishes which send path produced the ack:
     *  'text'         — `sendText` (plain message body + optional textStyle)
     *  'attachment'   — `sendAttachments` (file attachments)
     *  'voice-memo'   — `sendVoiceNote` (voice-note attachment with
     *                   voiceNote=true on the params) */
    kind_detail?: 'text' | 'attachment' | 'voice-memo';
  };
}

export interface SignalSendFailedEvent extends BaseLogEvent {
  kind: 'signal.send-failed';
  level: 'error';
  data: {
    /** Sender E164 (the linked signal-cli account). */
    account: string;
    /** Recipient E164 for DMs; empty when `group_id` is set. */
    recipient: string;
    /** Set when the send targeted a Signal group. */
    group_id?: string;
    /** The exception message from the failed RPC call (signal-cli
     *  rejection, TCP write error, JSON-RPC error response, etc.). */
    error: string;
    /** Retry attempt number (1 = first try). Optional. */
    attempt_no?: number;
    /** Same routing as `signal.send-acked.kind_detail`. */
    kind_detail?: 'text' | 'attachment' | 'voice-memo';
  };
}

// ──────────────────────── Channel: signal (health probe) ──────────────
// Origin: nanoclaw-host. Emitted by the external Signal health probe
// (`src/modules/signal-health/`), which runs on nanoclaw — the only
// observer EXTERNAL to the signal-cli daemon machine, so it can report
// the daemon's death (a self-check on the daemon box can't). One event
// per probe tick. Dedup for ALERTING is state-change-based (the module
// only DMs admins on healthy→degraded and recovery), but the event
// itself fires every tick so the dashboard sees a continuous signal.

export interface SignalHealthOkEvent extends BaseLogEvent {
  kind: 'signal.health-ok';
  data: {
    /** The linked signal-cli account the probe verified. */
    account: string;
    /** Round-trip ms for the daemon RPC reachability + registration check. */
    probe_ms: number;
    /** True iff this tick is a recovery (previous tick was degraded). The
     *  module DMs admins a recovery notice when set. */
    recovered?: boolean;
  };
}

export interface SignalHealthDegradedEvent extends BaseLogEvent {
  kind: 'signal.health-degraded';
  level: 'error';
  data: {
    /** The linked signal-cli account the probe targeted. */
    account: string;
    /** Machine-readable failure class. Drives the alert text + dashboard.
     *  'daemon-unreachable' — TCP connect to :7583 refused/timed out
     *                          (daemon or machine DOWN — the worst case).
     *  'account-unregistered' — daemon up but the account is no longer
     *                          registered / not in listAccounts (LAPSED).
     *  'receive-wedged'     — daemon up + registered but no inbound has
     *                          decrypted in the staleness window (receive
     *                          loop dead — watchdog should be restarting).
     *  'probe-error'        — RPC threw / unexpected shape. */
    reason: 'daemon-unreachable' | 'account-unregistered' | 'receive-wedged' | 'probe-error';
    /** Human-readable detail (exception message, last-inbound age, etc.). */
    detail: string;
    /** Consecutive degraded ticks for this reason (1 = first). The module
     *  alerts admins only when this crosses the configured threshold, so a
     *  single transient blip during a daemon restart doesn't page anyone. */
    consecutive: number;
    /** True iff this tick crossed the alert threshold and an admin DM was
     *  dispatched. Lets the dashboard distinguish "degraded, watching" from
     *  "degraded, paged". */
    alerted?: boolean;
  };
}

// ──────────────────────── anam-web channel events ───────────────────────

// PAT: removed AnamWebPrewarmRequestedEvent 2026-05-26 — paired with the
// deletion of the back-mind prewarm path (handlePrewarm /
// handlePrewarmWarmup in nanoclaw/src/channels/anam-web.ts).
// `anam-web.llm-prewarmed` below (fast-LLM TLS warmup) is kept.

/**
 * PAT: fast-LLM TLS prewarm — fires alongside container prewarm on
 * `/anam-web/prewarm`. Sends a 1-token throwaway stream through the
 * same provider the first banter-ack will use, so turn-1 doesn't pay
 * the TCP+TLS handshake cost. Latency tells us how long the warm-up
 * actually took; the next real banter-ack should ride a kept-alive
 * socket if the prewarm completed first.
 */
export interface AnamWebLlmPrewarmedEvent extends BaseLogEvent {
  kind: 'anam-web.llm-prewarmed';
  data: {
    /** Did the throwaway call return content (or at least headers)? */
    ok: boolean;
    /** Wall time from prewarm start to completion. */
    latency_ms: number;
    /** Provider-reported time-to-first-byte (headers/first SSE
     *  for raw fetch; first stream event for SDK paths). */
    ttfb_ms?: number;
    /** Provider that handled the prewarm — distinguishes
     *  cerebras vs openrouter vs anthropic. */
    provider?: string;
    /** Model id sent on the wire. */
    model?: string;
    /** True iff the prewarm itself rode on a kept-alive socket
     *  (false on a fresh process; true on subsequent prewarms
     *  within the keep-alive window). Sanity-checks that the next
     *  banter-ack should see `connection_reused: true`. */
    connection_reused?: boolean;
    /** TCP+TLS handshake time for the prewarm itself, ms. Absent
     *  on warm-reused prewarms. */
    connect_ms?: number;
    /** Failure reason when `ok=false`. */
    error?: string;
  };
}

/**
 * PAT: nanoclaw accepted a `/anam-web/ws` WebSocket upgrade from the
 * pat-web realtime bridge. One event per accepted connection (per
 * browser-side anam-web call). The matching `anam-web.ws-closed` fires
 * when the socket terminates. Lets dashboards count live realtime
 * bridges and notice early closes (network blip, browser tab close).
 */
export interface AnamWebWsOpenedEvent extends BaseLogEvent {
  kind: 'anam-web.ws-opened';
  data: {
    /** Remote socket address (`<ip>:<port>`) for forensic correlation
     *  with platform-edge logs. Empty string when not available. */
    remote: string;
    /** True iff the bridge passed `?session=` on the upgrade — i.e.
     *  banter.subscribe() ran immediately rather than waiting for the
     *  first per-frame sessionId. The current pat-web bridge always
     *  sets this. */
    session_id_present: boolean;
  };
}

/**
 * PAT: nanoclaw closed the matching `/anam-web/ws` socket. Carries the
 * RFC-6455 close code (1000 = normal, 1001 = going away, 1011 = server
 * error, 1006 = abnormal/no close frame). Pair with `anam-web.ws-opened`
 * by `thread_id` for per-call socket lifetime.
 */
export interface AnamWebWsClosedEvent extends BaseLogEvent {
  kind: 'anam-web.ws-closed';
  data: {
    /** WebSocket close code per RFC 6455. */
    code: number;
    /** Optional close reason string (truncated server-side to 200
     *  chars). Empty when the peer didn't send a reason. */
    reason: string;
  };
}

// ──────────────────────── Internal voice-transport events ──────────────

export interface TransportConnectedEvent extends BaseLogEvent {
  kind: 'transport.connected';
  data: {
    /** What link reports the connect: 'cartesia-ws' (Cartesia control
     *  WebSocket — *our* WS to their cloud), 'nanoclaw-sse'
     *  (voice-transport ↔ nanoclaw /outbound), 'nanoclaw-http'. */
    transport: 'cartesia-ws' | 'nanoclaw-sse' | 'nanoclaw-http';
    detail?: string;
  };
}

export interface TransportDisconnectedEvent extends BaseLogEvent {
  kind: 'transport.disconnected';
  level: 'info' | 'warn' | 'error';
  data: {
    transport: 'cartesia-ws' | 'nanoclaw-sse' | 'nanoclaw-http';
    reason?: string;
  };
}

// ──────────────────────── Generic / fallback ─────────────────────────────

/**
 * For lines that don't fit a structured kind yet — boot messages, ad-hoc
 * diagnostics, errors during migration. `msg` keeps the original string;
 * `fields` keeps any extra structured data. Consumers that don't recognize
 * `kind === 'misc'` should still render `msg`.
 */
export interface MiscEvent extends BaseLogEvent {
  kind: 'misc';
  data: {
    msg: string;
    [key: string]: unknown;
  };
}

export interface ErrorEvent extends BaseLogEvent {
  kind: 'error';
  level: 'error' | 'fatal' | 'warn';
  data: {
    msg: string;
    err?: string;
    stack?: string;
    [key: string]: unknown;
  };
}

export interface LifecycleEvent extends BaseLogEvent {
  kind: 'lifecycle';
  data: {
    phase: 'boot' | 'shutdown' | 'ready' | 'config-loaded';
    [key: string]: unknown;
  };
}

/**
 * Full LLM call trace — emitted at level='debug' (excluded by default
 * from /admin/logs.jsonl reads; opt-in via `?include_debug=1` or
 * `?levels=debug,info,warn,error`). Carries the entire system prompt,
 * user message, and response so forensics can reconstruct exactly
 * what context a given call saw. Useful when the model is doing
 * something weird (e.g. narrator repeating the same beat 24 times)
 * and you need to verify what history / progress slots actually
 * arrived.
 *
 * Lines can be large (10-100KB) — query with thread_id + kind filters
 * to keep the read window bounded.
 */
/**
 * PAT: silent provider fallback — primary returned ok:false and
 * FallbackProvider retried against the layer's fallback (default
 * Anthropic Haiku). Emitted at level='warn' so dashboards surface it
 * without `?include_debug=1`. This event class exists because we
 * shipped the dispatcher bug in 2026-05-23 that silently routed every
 * OpenRouter call to Haiku for a full day before anyone noticed —
 * fallbacks should be loud, not silent.
 */
export interface LlmProviderFallbackEvent extends BaseLogEvent {
  kind: 'llm.provider-fallback';
  level: 'warn';
  data: {
    /** Front-mind layer the call came from. */
    layer: string;
    /** Provider name that failed. */
    primary: string;
    /** Provider name we retried against. */
    fallback: string;
    /** Why the primary failed. */
    primary_error: string;
    /** Wall-time the primary took before failing. */
    primary_latency_ms: number;
  };
}

/**
 * PAT: TLS keepalive ping result. Fired by `FastLlmKeepalivePinger`
 * (realtime/src/fast-llm-keepalive.ts) every 3s while a session is
 * active. Sends a 1-token throwaway completion through the same
 * provider+model the next real banter-ack will use, so Node's undici
 * keep-alive socket stays warm across the 8-15s inter-turn gaps
 * typical of voice traffic.
 *
 * Per-tick, per-target (provider+model) — multi-layer sessions emit
 * one event per unique socket pool kept warm. After process boot the
 * first ping is `connection_reused: false` (TLS handshake performed);
 * subsequent pings within the keep-alive window should be
 * `connection_reused: true`. The latter is the proof that the warm
 * socket is being held open — and that the next real banter-ack will
 * inherit it.
 *
 * Level: 'debug' (excluded by default from /admin/logs.jsonl reads,
 * gated behind `?include_debug=1`).
 */
export interface FastLlmKeepaliveEvent extends BaseLogEvent {
  kind: 'fast-llm.keepalive';
  level?: 'debug';
  data: {
    /** Monotonically increasing per-pinger tick counter. Lets
     *  consumers spot dropped ticks (timer skew, GC pause). */
    tick_seq: number;
    /** Provider keeping the socket warm (e.g. 'cerebras',
     *  'openrouter', 'anthropic'). */
    provider: string;
    /** Model id sent on the wire — useful when multiple sessions
     *  hit the same provider with different models. */
    model: string;
    /** First front-mind layer that resolved to this (provider,
     *  model). Multiple layers can share a target; only the first
     *  one's name is recorded for greppability. */
    layer: string;
    /** True iff the ping landed headers / a stream-start signal.
     *  False on every failure path (no key, http error, network).
     *  ok=false WITHOUT a paired ttfb_ms means the TLS handshake
     *  also failed — the socket was NOT warmed. */
    ok?: boolean;
    /** Wall-clock time the ping took. Absent on skipped ticks. */
    latency_ms?: number;
    /** Provider-reported time-to-first-byte (headers / first SSE
     *  for raw fetch; first stream event for SDK paths). Absent on
     *  pre-flight failures (no API key, abort-before-call). */
    ttfb_ms?: number;
    /** True iff the ping itself rode on a kept-alive socket — the
     *  proof we're successfully holding the socket open between
     *  pings. Should flip false→true after the very first ping. */
    connection_reused?: boolean;
    /** TCP+TLS handshake time when `connection_reused=false`.
     *  Should only appear on the first ping of a session (or after
     *  a server-side close). */
    connect_ms?: number;
    /** True iff the ping was skipped because a previous ping is
     *  still in flight. Defensive against fan-out on stalled
     *  providers; rare in practice. */
    skipped_inflight?: boolean;
    /** True iff the ping was aborted by the pinger's stop() path
     *  during session teardown. */
    aborted?: boolean;
    /** Failure reason when `ok=false`. */
    error?: string;
  };
}

/**
 * PAT: per-API-call instrumentation for the back-mind (Claude Agent SDK
 * running inside the per-session container). Distinct from `llm.call`,
 * which fires once per front-mind layer call (banter / request /
 * narration / error-surfacing). Back-mind queries fan out into multiple
 * Anthropic API calls — one per agent-loop iteration (initial call,
 * tool-result followups, more tool calls, …). This event fires once per
 * underlying API call, indexed by `turn_index`.
 *
 * Captures provider-reported usage (input/output tokens, cache
 * read/creation tokens) plus wall time of the API call. Lets forensics
 * answer "why was that back-mind response 12s — was it generating tons
 * of output, or burning the agent loop on tool calls?" without
 * guessing.
 *
 * Emit cadence: one event per SDKAssistantMessage observed in the
 * agent-runner. Wall time is measured from the first stream_event of
 * the API call (the SDK's `message_start` SSE) to the assistant
 * message landing.
 *
 * Level: 'debug' (excluded by default from /admin/logs.jsonl reads,
 * gated behind `?include_debug=1` like `llm.call`).
 */
export interface BackMindLlmCallEvent extends BaseLogEvent {
  kind: 'back-mind.llm-call';
  level: 'debug';
  data: {
    /** Model id used for this call (e.g. 'claude-sonnet-4-6'). Read
     *  from the assistant message's `model` field, which is the
     *  authoritative source for what the API actually billed against —
     *  may differ from the operator-set NANOCLAW_MODEL if Claude Code
     *  routes (rare). */
    model: string;
    /** Zero-indexed iteration of the agent loop within a single
     *  `query()` open. `turn_index: 0` is the initial call after the
     *  user prompt; subsequent indices are tool-result followups. A
     *  back-mind response that does N tool calls produces N+1
     *  back-mind.llm-call events. */
    turn_index: number;
    /** Provider-reported token counts (BetaUsage on the assistant
     *  message). Always present — the SDK guarantees a usage block on
     *  the final assistant message of each API call. */
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    /** Wall-clock duration of this API call. Measured from the first
     *  `stream_event` of the call (SSE `message_start`) to the
     *  assistant message landing. Absent when the API call streamed
     *  no events before the assistant message (shouldn't happen with
     *  `includePartialMessages: true` but documented as optional for
     *  safety). */
    duration_ms?: number;
    /** Why the API stopped — 'end_turn', 'tool_use', 'max_tokens',
     *  etc. Surfaced as-reported by BetaMessage.stop_reason. null
     *  when the SDK delivered an assistant message without a stop
     *  reason (rare; truncated stream / mid-call cancel). */
    stop_reason: string | null;
    /** BetaMessage.id — Anthropic-side request identifier. Lets
     *  forensics cross-reference a slow back-mind turn against
     *  Anthropic's own logs / dashboards. Absent when the SDK
     *  delivered an assistant message without an id field. */
    request_id?: string;
    /** Session id from the SDK — same as the top-level `session_id`
     *  on this event but echoed here for joins with non-PAT log
     *  streams. */
    sdk_session_id?: string;
  };
}

// PAT: removed BackMindPrewarmedEvent 2026-05-26 — paired with the
// deletion of the back-mind prewarm path in
// nanoclaw/container/agent-runner/src/poll-loop.ts (and the
// /anam-web/prewarm routes in nanoclaw/src/channels/anam-web.ts).

export interface LlmCallEvent extends BaseLogEvent {
  kind: 'llm.call';
  level: 'debug';
  data: {
    /** Which prompt layer made the call (e.g. 'banter:ack',
     *  'banter:render', 'banter:narration', 'request-layer',
     *  'error-surfacing'). */
    layer: string;
    /** Model id used for this call. */
    model: string;
    /** Full system prompt as sent to the API. */
    system_prompt: string;
    /** Full user message as sent to the API. */
    user_message: string;
    /** Model response (text). null when the call failed before any
     *  text came back. */
    response: string | null;
    /** Wall-clock latency for the call. */
    latency_ms: number;
    /** Time from call start to first response signal (response headers
     *  for OpenRouter raw fetch / first stream `text` event for
     *  Anthropic SDK). High `ttfb_ms` paired with `connection_reused:
     *  false` indicates we're paying a TLS+handshake cost. Absent on
     *  layers that bail before issuing the call (circuit-breaker, no
     *  API key, pre-call abort) and on layers that don't route through
     *  the shared front-mind dispatcher (e.g. error-surfacing,
     *  banter-dispatch, back-mind). */
    ttfb_ms?: number;
    /** True iff this call rode on a kept-alive socket. False ⇒ a fresh
     *  TCP/TLS handshake was performed. Inferred from undici's
     *  `diagnostics_channel` connection lifecycle events
     *  (see realtime/src/llm-http-instrumentation.ts). Same absence
     *  rules as `ttfb_ms`, plus undefined when no prior connection
     *  to that host has been observed yet (typically the first call
     *  after process start).
     *
     *  ALSO undefined on `provider:'cerebras'` calls — the Cerebras
     *  SDK rides node-fetch, not undici, so the diagnostics_channel
     *  subscriber never fires for those. The SDK's built-in
     *  agentkeepalive holds sockets warm by default, so the absence of
     *  this field on Cerebras calls IS the signal that we're on the
     *  pooled-socket path (alongside `upstream_provider:'cerebras-sdk'`). */
    connection_reused?: boolean;
    /** TCP+TLS handshake time (ms) when `connection_reused === false`.
     *  Useful for splitting "cold socket cost" out of `ttfb_ms`. Absent
     *  on warm-reused calls, when timing wasn't observed, and on all
     *  `provider:'cerebras'` calls (see `connection_reused` note). */
    connect_ms?: number;
    /** Which provider class actually served the request — `'anthropic'`,
     *  `'openrouter'`, or `'cerebras'`. Distinct from `model`: a single
     *  model id may be reachable via multiple providers (e.g. routing
     *  Haiku through OpenRouter). Absent on pre-call short-circuit
     *  paths. */
    provider?: string;
    /** Upstream backend reported by OpenRouter on the SSE stream
     *  (e.g. 'Groq', 'Cerebras') when `provider === 'openrouter'`. Set
     *  to `'cerebras-sdk'` on `provider === 'cerebras'` calls — marker
     *  that the call rode the official @cerebras/cerebras_cloud_sdk
     *  Node SDK path (node-fetch + agentkeepalive) rather than the
     *  prior raw-fetch implementation. */
    upstream_provider?: string;
    /** Input + output token counts reported by the provider. Absent
     *  when the provider didn't emit a `usage` block (some streaming
     *  paths) or the call failed before usage landed. */
    input_tokens?: number;
    output_tokens?: number;
    /** Combined size of `system_prompt + user_message` in characters
     *  (not tokens). Always present on calls that actually issued; lets
     *  forensic queries spot prompt growth without waiting for the
     *  provider's `usage.prompt_tokens` (which only lands at end-of-
     *  stream, not at TTFB time). */
    prompt_chars?: number;
    /** True when the call succeeded end-to-end (got a non-empty
     *  response). False on circuit-breaker / API error / parse
     *  failure / empty response. */
    ok: boolean;
    /** Failure reason if ok=false. */
    error?: string;
  };
}

// ──────────────────────── Discriminated union ────────────────────────────

export type LogEvent =
  // Front-mind
  | InboundReceivedEvent
  | BanterCalledEvent
  | BanterRenderedEvent
  | BanterDispatchCalledEvent
  | RequestLayerDecidedEvent
  | NarratorFiredEvent
  | NarratorBrainSpawnedEvent
  | TtsTurnEndedEvent
  | TtsBusyMarkedEvent
  | SseClientChangedEvent
  | StateTransitionedEvent
  | CapabilityInstallResolvedEvent
  | CapabilityCallerContextResolvedEvent
  // Back-mind / routing
  | SessionCreatedEvent
  | SessionClosedEvent
  | CallTimedOutEvent
  | SessionTtlExpiredEvent
  | ContainerSpawnedEvent
  | ContainerExitedEvent
  | AgentToolUseEvent
  | AgentToolResultEvent
  | AgentMcpServersEvent
  | SecretsReconcileSummaryEvent
  | McpActivationPendingEvent
  | McpActivationActivatedEvent
  | McpActivationSlowEvent
  | FilePublishedEvent
  | FileServedEvent
  | ChatRowReceivedEvent
  | DetailRowReceivedEvent
  | RoutingMessageRoutedEvent
  | RoutingMessageDeliveredEvent
  | OutboundSentEvent
  | PeopleUpsertedEvent
  | PeopleRemovedEvent
  // Barge-in / cancel
  | BargeinReceivedEvent
  | BargeinPropagatedEvent
  | BackMindCancelledEvent
  | IntentAccumulatedEvent
  | IntentRenderedMultiEvent
  | DeliverChatStepEvent
  // Scenario tag-stream
  | ScenarioTagStreamStartedEvent
  | ScenarioActionEvent
  | ScenarioTagStreamEndedEvent
  // Timeline wrapper lifecycle (PAT — bracket <timeline>...</timeline>)
  | TimelineStartedEvent
  | TimelineFinishedEvent
  | TimelineSpanHydratedEvent
  // Timeline action-level events (per-action sequencer dispatch)
  | TimelineActionEnqueuedEvent
  | TimelineActionStartedEvent
  | TimelineActionCompletedEvent
  | TimelineActionCancelledEvent
  // Streaming utterances (banter / rendition / narration)
  | UtteranceStreamStartedEvent
  | UtteranceStreamDeltaEvent
  | UtteranceStreamEndedEvent
  | UtteranceStreamCancelledEvent
  // Browser-emitted RTT instrumentation (source='pat-web-browser')
  | InboundSentEvent
  | UtteranceDeltaReceivedEvent
  // Permissions
  | PermissionsCallerRefusedEvent
  | PermissionsRealtimeOwnerResolvedEvent
  // Skill events (container-side skill handlers)
  | ImagegenRequestedEvent
  | ImagegenCompletedEvent
  // Error legibility (host-side surfaces)
  | ErrorSurfacedEvent
  // Voice-transport — internal (our own logic / observation of state we own)
  | CallStartedEvent
  | CallEndedEvent
  | SttUserSaidEvent
  | SttEmptyTurnEvent
  | SttDiscardedOnTeardownEvent
  | TtsAgentSaidEvent
  | TransportConnectedEvent
  | TransportDisconnectedEvent
  // Channel: anam-web (host-side fast-LLM TLS prewarm + realtime WS lifecycle).
  // PAT: removed AnamWebPrewarmRequestedEvent 2026-05-26 alongside back-mind
  // prewarm removal; AnamWebLlmPrewarmedEvent (fast-LLM TLS) kept.
  | AnamWebLlmPrewarmedEvent
  | AnamWebWsOpenedEvent
  | AnamWebWsClosedEvent
  // Vendor — events whose trigger is an external SDK / service. Kind
  // begins with `<vendor>.`; see `VENDORS` and `vendorOf()` below.
  | CartesiaAgentTurnBoundaryEvent
  | CartesiaUserTurnBoundaryEvent
  | CartesiaUserTextSentEvent
  | CartesiaAgentTextSentEvent
  | CartesiaTaskCancelledEvent
  | CartesiaUserDtmfEvent
  | CartesiaAgentDtmfEvent
  | CartesiaValidationErrorEvent
  | CartesiaAgentHandoffEvent
  // Vendor: apify
  | ApifyRunCompletedEvent
  // Channel: signal (host-side delivery acks)
  | SignalSendAckedEvent
  | SignalSendFailedEvent
  | SignalHealthOkEvent
  | SignalHealthDegradedEvent
  // Generic
  | MiscEvent
  | ErrorEvent
  | LifecycleEvent
  | LlmCallEvent
  | LlmProviderFallbackEvent
  | FastLlmKeepaliveEvent
  | BackMindLlmCallEvent;
// PAT: removed BackMindPrewarmedEvent 2026-05-26 (back-mind prewarm removed).

/**
 * Enum of all valid `kind` values. The drift test on the Python side
 * compares this to its mirror; adding a kind here requires a matching
 * entry there or the test fails.
 */
export const LOG_EVENT_KINDS = [
  // Front-mind
  'inbound.received',
  'banter.called',
  'banter.rendered',
  'banter-dispatch.called',
  'request-layer.decided',
  'narrator.fired',
  'narrator.brain-spawned',
  'tts.turn-ended',
  'tts.busy-marked',
  'sse.client-changed',
  'state.transitioned',
  'capability.install-resolved',
  'capability.caller-context-resolved',
  // Back-mind / routing
  'session.created',
  'session.closed',
  'call.timed-out',
  'session.ttl-expired',
  'container.spawned',
  'container.exited',
  // PAT: agent-runner (container-side) tool calls, piggybacked on the
  // container stderr tee and re-emitted by the host. See AgentToolUseEvent.
  'agent.tool_use',
  'agent.tool_result',
  'agent.mcp-servers',
  // PAT: credential reconcile / MCP activation (host). See
  // SecretsReconcileSummaryEvent + McpActivation*Event.
  'secrets.reconcile-summary',
  'mcp.activation-pending',
  'mcp.activation-activated',
  'mcp.activation-slow',
  'file.published',
  'file.served',
  'chat.row-received',
  'detail.row-received',
  'routing.message-routed',
  'routing.message-delivered',
  // PAT: outbound message body — symmetric counterpart of inbound.received
  // (emitted at the host's channel-agnostic delivery seam). → pat_events.
  'outbound.sent',
  // People directory (→ pat_enrichment, not pat_events)
  'people.upserted',
  'people.removed',
  // Barge-in / cancel
  'bargein.received',
  'bargein.propagated',
  'back-mind.cancelled',
  'intent.accumulated',
  'intent.rendered-multi',
  'deliver-chat.step',
  // Scenario tag-stream
  'scenario.tag-stream-started',
  'scenario.action',
  'scenario.tag-stream-ended',
  // Timeline wrapper lifecycle (<timeline>...</timeline>)
  'timeline.started',
  'timeline.finished',
  'timeline.span-hydrated',
  // Timeline action-level events (sequencer dispatch loop)
  'timeline.action-enqueued',
  'timeline.action-started',
  'timeline.action-completed',
  'timeline.action-cancelled',
  // Streaming utterances (banter / rendition / narration)
  'utterance.stream-started',
  'utterance.stream-delta',
  'utterance.stream-ended',
  'utterance.stream-cancelled',
  // Browser-emitted RTT instrumentation (source = pat-web-browser)
  'inbound.sent',
  'utterance.delta-received',
  // Permissions
  'permissions.caller-refused',
  'permissions.realtime-owner-resolved',
  // Skill events
  'imagegen.requested',
  'imagegen.completed',
  // Error legibility
  'error.surfaced',
  // Voice-transport — internal
  'call.started',
  'call.ended',
  'stt.user-said',
  'stt.empty-turn',
  'stt.discarded-on-teardown',
  'tts.agent-said',
  'transport.connected',
  'transport.disconnected',
  // Channel: anam-web (host-side fast-LLM TLS prewarm + realtime WS lifecycle).
  // PAT 2026-05-26: removed anam-web.prewarm-requested (back-mind prewarm
  // removed). anam-web.llm-prewarmed (fast-LLM TLS warmup) kept.
  'anam-web.llm-prewarmed',
  'anam-web.ws-opened',
  'anam-web.ws-closed',
  // Vendor: cartesia
  'cartesia.agent-turn-boundary',
  'cartesia.user-turn-boundary',
  'cartesia.user-text-sent',
  'cartesia.agent-text-sent',
  'cartesia.task-cancelled',
  'cartesia.user-dtmf',
  'cartesia.agent-dtmf',
  'cartesia.validation-error',
  'cartesia.agent-handoff',
  // Vendor: apify
  'apify.run-completed',
  // Channel: signal (host-side delivery acks)
  'signal.send-acked',
  'signal.send-failed',
  // Channel: signal (external health probe → admin alert)
  'signal.health-ok',
  'signal.health-degraded',
  // Generic
  'misc',
  'error',
  'lifecycle',
  // Debug-level forensic trace
  'llm.call',
  // Warn-level — primary LLM provider failed, retried against fallback
  'llm.provider-fallback',
  // Debug-level — TLS keepalive ping result (per-session pinger keeps
  // undici keep-alive socket warm between turns). See FastLlmKeepaliveEvent.
  'fast-llm.keepalive',
  // Debug-level — per-API-call back-mind instrumentation (one event per
  // SDKAssistantMessage in the Claude Agent SDK loop). See
  // BackMindLlmCallEvent above for field documentation.
  'back-mind.llm-call',
  // PAT 2026-05-26: removed back-mind.prewarmed — back-mind prewarm path
  // deleted from nanoclaw/container/agent-runner/src/poll-loop.ts.
] as const;

export type LogEventKind = (typeof LOG_EVENT_KINDS)[number];

/** Mind the event belongs to — derived from kind area. Not stored in
 *  the wire format; computed by consumers (TUI, timeline) for grouping. */
export function mindFor(kind: LogEventKind): 'front-mind' | 'back-mind' | 'voice-transport' | 'host' {
  if (kind.startsWith('inbound.') || kind.startsWith('banter.') || kind.startsWith('banter-dispatch.') ||
      kind.startsWith('request-layer.') ||
      kind.startsWith('narrator.') || kind.startsWith('tts.turn') || kind.startsWith('tts.busy') ||
      kind.startsWith('sse.') || kind.startsWith('state.') ||
      kind.startsWith('bargein.') || kind.startsWith('intent.') ||
      kind.startsWith('utterance.') || kind.startsWith('scenario.') ||
      kind.startsWith('timeline.') || kind.startsWith('capability.')) {
    return 'front-mind';
  }
  if (kind.startsWith('session.') || kind.startsWith('container.') ||
      kind.startsWith('agent.') ||
      kind.startsWith('chat.') || kind.startsWith('detail.') || kind.startsWith('routing.') ||
      kind.startsWith('imagegen.') ||
      kind.startsWith('signal.') ||
      kind.startsWith('anam-web.') ||
      kind.startsWith('back-mind.')) {
    return 'back-mind';
  }
  if (kind === 'call.started' || kind === 'call.ended' ||
      kind.startsWith('stt.') ||
      kind === 'tts.agent-said' ||
      kind.startsWith('transport.') ||
      vendorOf(kind) !== null) {
    return 'voice-transport';
  }
  return 'host';
}

// ─────────────────────── Vendor classification ───────────────────────────
//
// "Vendor" = an external SDK / hosted service whose runtime emits the
// signals we observe. The kind prefix maps 1:1 to the vendor name. Add
// new vendors here AND a matching kind family above (e.g. for an avatar
// vendor, add `'anam'` here and define `anam.frame-rendered` events).
//
// Rationale: `source` tells you which of *our* processes emitted the
// event (nanoclaw-host, voice-transport). `vendor` tells you whether
// the trigger came from one of our processes' own logic, or from an
// external vendor whose SDK is reporting state to us. Different filter
// axes; both useful in the dashboard.

export const VENDORS = ['cartesia', 'apify'] as const;
export type Vendor = (typeof VENDORS)[number];

/** Returns the vendor name iff `kind` is a vendor-originated event. */
export function vendorOf(kind: string): Vendor | null {
  for (const v of VENDORS) {
    if (kind.startsWith(`${v}.`)) return v;
  }
  return null;
}
