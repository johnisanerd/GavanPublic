"""
Mirror of `realtime/src/log-events.ts`.

This file is hand-maintained against the TS source of truth. The drift
test (test_log_events_match.py) parses both at module load and asserts
the kind set matches; adding a new kind in TS without adding it here
fails the test.

Top-level shape (every event):
    ts          — ISO 8601 UTC, ms-precision
    source      — 'nanoclaw-host' | 'agent-runner' | 'voice-transport' | 'host'
    kind        — '<area>.<event>' (dotted, two-level)
    level       — optional; 'info' default
    thread_id?  — optional context, top-level
    session_id? — optional context, top-level
    platform_id?— optional venue identifier
    data        — kind-specific payload (see KIND_DATA_KEYS for shape)
"""
from __future__ import annotations

from typing import Final, Literal, TypedDict

LogSource = Literal[
    "nanoclaw-host",
    "agent-runner",
    "voice-transport",
    "host",
    # PAT: pat-web in-browser emit. Forwarded through pat-web's Hono
    # server to nanoclaw `/admin/log-event` so the browser's RTT
    # signals land in the unified host JSONL.
    "pat-web-browser",
]
LogLevel = Literal["debug", "info", "warn", "error", "fatal"]


# Source of truth = the TypeScript file. Order matches LOG_EVENT_KINDS
# in log-events.ts so a side-by-side diff is trivial.
LOG_EVENT_KINDS: Final[tuple[str, ...]] = (
    # Front-mind
    "inbound.received",
    "banter.called",
    "banter.rendered",
    "banter-dispatch.called",
    "request-layer.decided",
    "narrator.fired",
    "narrator.brain-spawned",
    "tts.turn-ended",
    "tts.busy-marked",
    "sse.client-changed",
    "state.transitioned",
    "capability.install-resolved",
    "capability.caller-context-resolved",
    # Back-mind / routing
    "session.created",
    "session.closed",
    "call.timed-out",
    "session.ttl-expired",
    "container.spawned",
    "container.exited",
    # PAT: agent-runner (container-side) tool calls, piggybacked on the
    # container stderr tee and re-emitted by the host. → pat_events.
    "agent.tool_use",
    "agent.tool_result",
    "agent.mcp-servers",
    # PAT: credential reconcile / MCP activation (host). Names/hosts only —
    # secret values never appear in these events.
    "secrets.reconcile-summary",
    "mcp.activation-pending",
    "mcp.activation-activated",
    "mcp.activation-slow",
    # PAT: publish_file — agent-published signed expiring public file URLs.
    "file.published",
    "file.served",
    "chat.row-received",
    "detail.row-received",
    "routing.message-routed",
    "routing.message-delivered",
    # PAT: outbound message body — symmetric counterpart of inbound.received
    # (emitted at the host's channel-agnostic delivery seam). → pat_events.
    "outbound.sent",
    # People directory (→ pat_enrichment, not pat_events)
    "people.upserted",
    "people.removed",
    # Barge-in / cancel
    "bargein.received",
    "bargein.propagated",
    "back-mind.cancelled",
    "intent.accumulated",
    "intent.rendered-multi",
    "deliver-chat.step",
    # Scenario tag-stream
    "scenario.tag-stream-started",
    "scenario.action",
    "scenario.tag-stream-ended",
    # Timeline wrapper lifecycle (<timeline>...</timeline>)
    "timeline.started",
    "timeline.finished",
    "timeline.span-hydrated",
    # Timeline action-level events (sequencer dispatch loop)
    "timeline.action-enqueued",
    "timeline.action-started",
    "timeline.action-completed",
    "timeline.action-cancelled",
    # Streaming utterances (banter / rendition / narration)
    "utterance.stream-started",
    "utterance.stream-delta",
    "utterance.stream-ended",
    "utterance.stream-cancelled",
    # Browser-emitted RTT instrumentation (source='pat-web-browser')
    "inbound.sent",
    "utterance.delta-received",
    # Permissions
    "permissions.caller-refused",
    "permissions.realtime-owner-resolved",
    # Skill events
    "imagegen.requested",
    "imagegen.completed",
    # Error legibility
    "error.surfaced",
    # Voice-transport — internal
    "call.started",
    "call.ended",
    "stt.user-said",
    "stt.empty-turn",
    "stt.discarded-on-teardown",
    "tts.agent-said",
    "transport.connected",
    "transport.disconnected",
    # Channel: anam-web (host-side fast-LLM TLS prewarm + realtime WS lifecycle).
    # PAT: removed 'anam-web.prewarm-requested' 2026-05-26 (back-mind prewarm
    # removed). 'anam-web.llm-prewarmed' (fast-LLM TLS warmup) kept.
    "anam-web.llm-prewarmed",
    "anam-web.ws-opened",
    "anam-web.ws-closed",
    # Vendor: cartesia
    "cartesia.agent-turn-boundary",
    "cartesia.user-turn-boundary",
    "cartesia.user-text-sent",
    "cartesia.agent-text-sent",
    "cartesia.task-cancelled",
    "cartesia.user-dtmf",
    "cartesia.agent-dtmf",
    "cartesia.validation-error",
    "cartesia.agent-handoff",
    # Vendor: apify (host-synthesized from mcp__apify__* tool-post)
    "apify.run-completed",
    # Channel: signal (host-side delivery acks from src/channels/signal.ts)
    "signal.send-acked",
    "signal.send-failed",
    # Channel: signal (external health probe → admin alert; emitted by
    # nanoclaw src/modules/signal-health/)
    "signal.health-ok",
    "signal.health-degraded",
    # Generic
    "misc",
    "error",
    "lifecycle",
    "llm.call",
    "llm.provider-fallback",
    "fast-llm.keepalive",
    # Per-API-call back-mind instrumentation (one event per
    # SDKAssistantMessage in the Claude Agent SDK loop running inside
    # the per-session container). Distinct from llm.call (which fires
    # once per front-mind layer call). See BackMindLlmCallEvent in
    # realtime/src/log-events.ts for full schema.
    "back-mind.llm-call",
    # PAT: removed 'back-mind.prewarmed' 2026-05-26 — back-mind prewarm
    # path deleted (nanoclaw/container/agent-runner/src/poll-loop.ts).
)


# Recognised vendors. Mirror of `VENDORS` in TS.
VENDORS: Final[tuple[str, ...]] = ("cartesia", "apify")


def vendor_of(kind: str) -> str | None:
    """Returns the vendor name iff `kind` is vendor-originated."""
    for v in VENDORS:
        if kind.startswith(f"{v}."):
            return v
    return None


# What `data` keys each kind carries. Used by the drift test as a
# shape assertion; not enforced at emit time (cheap optimism).
KIND_DATA_KEYS: Final[dict[str, frozenset[str]]] = {
    # Front-mind
    # PAT: channel_type + OPAQUE person_id added so a person-scoped query over
    # inbound.received works across realtime + chat-SDK channels. person_id is
    # always present (null when the sender isn't linked / resolution failed).
    # NO person_name — names live in the pat_enrichment directory stream, never
    # beside message bodies; resolve id↔name at query time.
    "inbound.received": frozenset({"channel_type", "text", "sender", "sender_id", "person_id"}),
    "banter.called": frozenset({"user_text", "response_text", "intentionally_silent", "failed", "latency_ms"}),
    "banter.rendered": frozenset({"raw_text", "rendered_text", "render_ms"}),
    # `error` is optional (only populated on ok=false paths).
    "banter-dispatch.called": frozenset({"input_text", "output_text", "latency_ms", "ok"}),
    "request-layer.decided": frozenset({"decision", "reason", "is_processing"}),  # invoke_text/clarify_hint optional
    "narrator.fired": frozenset({"utterance", "events_observed"}),  # model_call_ms optional
    "narrator.brain-spawned": frozenset(),
    "tts.turn-ended": frozenset({"text_preview", "est_dur_ms"}),
    "tts.busy-marked": frozenset({"est_dur_ms", "text_preview"}),
    "sse.client-changed": frozenset({"action", "total_clients", "remote"}),  # reason optional
    "state.transitioned": frozenset({"state", "from", "to"}),
    # Capability install surface — emitted by host at boot per agent
    # group AND on agent-group provision. `snapshot` is the full
    # InstallCapabilities (snake_cased) or null when resolver returned
    # null / threw. `resolver_error` is optional.
    "capability.install-resolved": frozenset({"agent_group_id", "resolved", "snapshot"}),
    # Per-inbound caller context — emitted by ChannelOrchestrator after
    # every resolveCallerContext call. `snapshot` is the full
    # CallerContext (caller identity + known handles + permissions),
    # snake_cased, or null when resolver absent / threw / returned null.
    "capability.caller-context-resolved": frozenset({"agent_group_id", "call_site", "resolver_present", "resolved", "sender_id", "snapshot"}),
    # Back-mind / routing
    "session.created": frozenset({"agent_group_id", "messaging_group_id", "session_mode"}),
    "session.closed": frozenset({"reason"}),
    "call.timed-out": frozenset({"idle_ms", "channel_type"}),
    "session.ttl-expired": frozenset({"alive_ms", "ttl_ms", "channel_type"}),
    "container.spawned": frozenset({"agent_group", "container_name"}),
    "container.exited": frozenset({"exit_code", "container_name"}),
    # PAT: container-side tool call. tool_use_id / agent_group_id optional.
    "agent.tool_use": frozenset({"tool", "input_summary"}),
    "agent.tool_result": frozenset({"tool", "ok", "output_summary"}),
    # PAT: MCP connect statuses at query() open. agent_group_id optional.
    "agent.mcp-servers": frozenset({"servers"}),
    # PAT: credential reconcile / MCP activation (host). Values never appear.
    "secrets.reconcile-summary": frozenset(
        {"created", "refreshed", "deleted", "awaiting", "untouched", "errors", "dry_run"}
    ),
    "mcp.activation-pending": frozenset({"name", "host_pattern", "secret_name", "agent_group_id"}),
    "mcp.activation-activated": frozenset({"name", "host_pattern", "agent_group_id", "waited_ms"}),
    "mcp.activation-slow": frozenset({"name", "host_pattern", "secret_name", "agent_group_id", "waited_ms"}),
    # PAT: publish_file. Names/sizes only — never signatures or URLs.
    "file.published": frozenset({"name", "agent_group_id", "session_id", "size_bytes", "ttl_hours", "expires_at"}),
    "file.served": frozenset({"name", "size_bytes"}),
    "chat.row-received": frozenset({"seq", "preview"}),  # full_text optional
    "detail.row-received": frozenset({"seq", "type"}),  # tool/tool_use_id optional
    "routing.message-routed": frozenset({"agent_group", "msg_kind", "user_id", "person_id", "wake", "created", "agent_group_name"}),
    "routing.message-delivered": frozenset({"msg_id", "msg_kind", "channel_type"}),
    # PAT: outbound message body — symmetric counterpart of inbound.received.
    # All seven keys are always present (recipient_person_id /
    # sender_agent_group_id may be null; sender_user_id may be '' when the
    # delivery seam can't determine PAT's account). NO person_name — names
    # live in the pat_enrichment directory stream, resolved id↔name at query
    # time, never beside message bodies. origin ∈ {agent, system, realtime}.
    "outbound.sent": frozenset(
        {
            "channel_type",
            "text",
            "recipient_user_id",
            "recipient_person_id",
            "sender_user_id",
            "sender_agent_group_id",
            "origin",
        }
    ),
    # People directory mutations → routed to pat_enrichment by the forwarder
    # (names are FINE here; they never reach pat_events). Snapshot per person.
    "people.upserted": frozenset({"person_id", "display_name", "handles", "identifiers"}),
    "people.removed": frozenset({"person_id", "display_name", "handles", "identifiers"}),
    # Barge-in / cancel
    "bargein.received": frozenset({"reason"}),
    "bargein.propagated": frozenset({"killed_container", "dropped_pending_contexts"}),  # killed_session_id optional
    "back-mind.cancelled": frozenset({"reason"}),
    "intent.accumulated": frozenset({"raw_text", "pending_total"}),
    "intent.rendered-multi": frozenset({"context_count", "rendered_text", "render_ms"}),
    # PAT 2026-05-25: per-step timing inside deliverChat. Optional
    # iter/pending_count/input_chars/render_ms fields not required.
    "deliver-chat.step": frozenset({"step", "elapsed_ms"}),
    # Scenario tag-stream (most fields are action-type dependent; the
    # drift test enforces only the always-present fields).
    "scenario.tag-stream-started": frozenset({"scenario_slug", "slide_n", "raw_chars"}),
    "scenario.action": frozenset({"scenario_slug", "action_type", "slide_n", "seq"}),
    "scenario.tag-stream-ended": frozenset({"scenario_slug", "slide_n", "action_count", "duration_ms", "terminator"}),
    # Timeline wrapper lifecycle
    "timeline.started": frozenset({"timeline_id"}),
    "timeline.finished": frozenset({"timeline_id", "reason", "duration_ms"}),
    # reason ∈ {'completed', 'interrupted'}
    # PAT Phase 6: `<timeline_span/>` hydration outcome
    "timeline.span-hydrated": frozenset({"slide_n", "from", "to", "inlined", "authored_count"}),
    # reason optional, ∈ {'no-authored-timeline', 'out-of-range', 'parse-failed'}
    # Timeline action-level events. `attrs` is optional on action-enqueued
    # — carries kind-specific salient fields (text, ms, direction, n,
    # tool_name) for dashboard rendering. Drift test enforces only the
    # always-present keys.
    "timeline.action-enqueued": frozenset({"timeline_id", "kind", "seq"}),
    "timeline.action-started": frozenset({"timeline_id", "kind", "seq", "ts_start"}),
    "timeline.action-completed": frozenset({"timeline_id", "kind", "seq", "duration_ms", "ts_start", "ts_end"}),
    "timeline.action-cancelled": frozenset({"timeline_id", "kind", "seq", "reason"}),  # partial optional
    # Streaming utterances
    "utterance.stream-started": frozenset({"source", "model"}),
    "utterance.stream-delta": frozenset({"source", "text_delta", "seq"}),
    "utterance.stream-ended": frozenset({"source", "full_text", "delta_count", "stream_ms", "first_delta_ms"}),
    "utterance.stream-cancelled": frozenset({"source", "reason", "partial_text", "delta_count"}),
    # Browser-emitted RTT instrumentation (source='pat-web-browser').
    # `correlation_id` is minted by the browser; pairs an inbound.sent
    # with the utterance.delta-received rows it eventually drove.
    "inbound.sent": frozenset({"user_text_length", "correlation_id"}),
    "utterance.delta-received": frozenset({"utterance_id", "source_layer", "sequence", "chars", "correlation_id"}),
    # Permissions
    "permissions.caller-refused": frozenset({"sender_id", "policy", "platform_id"}),
    "permissions.realtime-owner-resolved": frozenset({"matched_phone", "user_id", "role", "decision", "reason"}),
    # Skill events
    "imagegen.requested": frozenset({"prompt", "quality", "model", "cache_key"}),
    "imagegen.completed": frozenset({"cache_key", "cache_hit", "latency_ms"}),  # bytes/output_path/error optional
    # Error legibility (host-side surfaces; tool / spoken_text / debounce_suppressed optional)
    "error.surfaced": frozenset({"source", "error_preview", "announced"}),
    # Voice-transport — internal
    "call.started": frozenset(),
    "call.ended": frozenset(),
    "stt.user-said": frozenset({"text"}),
    # PAT 2026-07-04: empty-turn = Cartesia closed a user turn with no
    # transcript (endpointer-starvation signature); discarded-on-teardown =
    # call ended with undelivered buffered speech. Both level=warn.
    "stt.empty-turn": frozenset({"secs_since_turn_start"}),
    "stt.discarded-on-teardown": frozenset({"text"}),
    "tts.agent-said": frozenset({"text", "source"}),
    "transport.connected": frozenset({"transport"}),  # detail optional
    "transport.disconnected": frozenset({"transport"}),  # reason optional
    # PAT: removed 'anam-web.prewarm-requested' 2026-05-26 — back-mind prewarm
    # path removed (nanoclaw/src/channels/anam-web.ts handlePrewarm).
    # Channel: anam-web — fast-LLM TLS prewarm result (kept; unrelated to back-mind).
    "anam-web.llm-prewarmed": frozenset({"ok", "latency_ms"}),
    # Channel: anam-web — realtime WS open / close (pat-web realtime bridge ↔ nanoclaw)
    "anam-web.ws-opened": frozenset({"remote", "session_id_present"}),
    "anam-web.ws-closed": frozenset({"code", "reason"}),
    # Vendor: cartesia
    "cartesia.agent-turn-boundary": frozenset({"edge"}),  # `text` optional on edge='stop'
    "cartesia.user-turn-boundary": frozenset({"edge"}),
    "cartesia.user-text-sent": frozenset({"text"}),
    "cartesia.agent-text-sent": frozenset({"text"}),
    "cartesia.task-cancelled": frozenset({"reason"}),
    "cartesia.user-dtmf": frozenset({"button"}),
    "cartesia.agent-dtmf": frozenset({"button"}),
    "cartesia.validation-error": frozenset({"error_type", "error_message"}),
    "cartesia.agent-handoff": frozenset(),  # target_phone_number optional
    # Channel: signal (host-side delivery acks; group_id / attempt_no /
    # kind_detail are optional, so only the always-present keys land
    # in the drift-test enforced shape).
    "signal.send-acked": frozenset({"account", "recipient", "signal_timestamp"}),
    "signal.send-failed": frozenset({"account", "recipient", "error"}),
    # Channel: signal health probe. `recovered` (ok) and `alerted` (degraded)
    # are optional, so only the always-present keys land in the drift-test
    # enforced shape.
    "signal.health-ok": frozenset({"account", "probe_ms"}),
    "signal.health-degraded": frozenset({"account", "reason", "detail", "consecutive"}),
    # Generic
    "misc": frozenset({"msg"}),  # extra fields allowed
    "error": frozenset({"msg"}),
    "lifecycle": frozenset({"phase"}),
    # llm.call data fields:
    #   required: layer, model, system_prompt, user_message, response, latency_ms, ok
    #   optional: ttfb_ms          — time to first response signal (headers
    #                                 for raw fetch / first stream event)
    #             connection_reused — true ⇒ kept-alive socket reuse,
    #                                 false ⇒ TLS handshake during this call.
    #                                 ALWAYS undefined for provider='cerebras'
    #                                 (SDK rides node-fetch, not undici).
    #             connect_ms        — TCP+TLS handshake duration when
    #                                 connection_reused === false. Always
    #                                 undefined for provider='cerebras'.
    #             provider          — 'anthropic' | 'openrouter' | 'cerebras'
    #             upstream_provider — OpenRouter's reported backend ('Groq', …)
    #                                 when provider='openrouter'. Set to
    #                                 'cerebras-sdk' on provider='cerebras'
    #                                 to mark the SDK-backed path.
    #             input_tokens      — provider-reported prompt token count
    #             output_tokens     — provider-reported completion token count
    #             prompt_chars      — system_prompt + user_message char count
    #             error             — failure reason
    "llm.call": frozenset({"layer", "model", "system_prompt", "user_message", "response", "latency_ms", "ok"}),
    # llm.provider-fallback data fields:
    # - layer / primary / fallback / primary_error / primary_latency_ms — emitted at level='warn'
    "llm.provider-fallback": frozenset({"layer", "primary", "fallback", "primary_error", "primary_latency_ms"}),
    # fast-llm.keepalive data fields (per-tick TLS keepalive ping):
    #   required: tick_seq, provider, model, layer
    #   optional: ok, latency_ms, ttfb_ms, connection_reused, connect_ms,
    #             skipped_inflight, aborted, error
    "fast-llm.keepalive": frozenset({"tick_seq", "provider", "model", "layer"}),
    # back-mind.llm-call data fields (one event per Anthropic API call
    # inside the back-mind Claude Agent SDK loop):
    #   required: model, turn_index, input_tokens, output_tokens,
    #             cache_read_input_tokens, cache_creation_input_tokens,
    #             stop_reason
    #   optional: duration_ms      — wall time from message_start SSE to
    #                                 assistant message landing
    #             request_id        — BetaMessage.id (Anthropic side)
    #             sdk_session_id    — SDK session id (echoed from top-level)
    "back-mind.llm-call": frozenset({
        "model",
        "turn_index",
        "input_tokens",
        "output_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
        "stop_reason",
    }),
    # PAT: removed 'back-mind.prewarmed' data spec 2026-05-26 — back-mind
    # prewarm path deleted.
}


class LogEvent(TypedDict, total=False):
    ts: str
    source: LogSource
    kind: str  # one of LOG_EVENT_KINDS
    level: LogLevel
    thread_id: str | None
    session_id: str | None
    platform_id: str | None
    data: dict


def mind_for(kind: str) -> Literal["front-mind", "back-mind", "voice-transport", "host"]:
    """Same logic as TS `mindFor`. Used by TUI / timeline rendering to
    group events into Front Mind / Back Mind / Voice-Transport columns."""
    if (
        kind.startswith("inbound.")
        or kind.startswith("banter.")
        or kind.startswith("banter-dispatch.")
        or kind.startswith("request-layer.")
        or kind.startswith("narrator.")
        or kind.startswith("tts.turn")
        or kind.startswith("tts.busy")
        or kind.startswith("sse.")
        or kind.startswith("state.")
        or kind.startswith("bargein.")
        or kind.startswith("intent.")
        or kind.startswith("utterance.")
        or kind.startswith("scenario.")
        or kind.startswith("timeline.")
        or kind.startswith("capability.")
    ):
        return "front-mind"
    if (
        kind.startswith("session.")
        or kind.startswith("container.")
        or kind.startswith("agent.")
        or kind.startswith("chat.")
        or kind.startswith("detail.")
        or kind.startswith("routing.")
        or kind.startswith("imagegen.")
        or kind.startswith("signal.")
        or kind.startswith("anam-web.")
        or kind.startswith("back-mind.")
    ):
        return "back-mind"
    if (
        kind in ("call.started", "call.ended", "stt.user-said", "tts.agent-said")
        or kind.startswith("transport.")
        or vendor_of(kind) is not None
    ):
        return "voice-transport"
    return "host"
