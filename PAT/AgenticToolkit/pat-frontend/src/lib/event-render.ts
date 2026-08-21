/**
 * Per-kind rendering rules. Mirrors the original vanilla-JS impl in
 * nanoclaw's MONITOR_HTML, but typed against the discriminated union.
 *
 * Returns a body string and a kind-class for color tinting. Keep these
 * cheap — invoked once per row.
 */
import type { LogEvent } from '@/types/log-events';

export interface RenderedEvent {
  body: string;
  kindClass: string;
}

export function renderEvent(rec: LogEvent): RenderedEvent | null {
  // Skip noise outright.
  if (rec.kind === 'misc') return null;

  switch (rec.kind) {
    case 'inbound.received':
      return { body: `"${rec.data.text || ''}"`, kindClass: 'inbound' };

    case 'banter.called':
      if (rec.data.intentionally_silent) {
        return { body: '(silent)', kindClass: 'noop' };
      }
      return {
        body: `"${rec.data.response_text || ''}"`,
        kindClass: 'banter',
      };

    case 'banter.rendered':
      return {
        body: `"${rec.data.rendered_text || ''}"  (${rec.data.render_ms}ms)`,
        kindClass: 'rendition',
      };

    case 'banter-dispatch.called': {
      const d = rec.data;
      if (!d.ok) {
        return {
          body: `dispatch FAIL (${d.error || 'unknown'}) — raw: "${d.input_text || ''}"`,
          kindClass: 'rendition',
        };
      }
      const changed = d.input_text !== d.output_text;
      const arrow = changed ? '→' : '=';
      return {
        body: `"${d.input_text || ''}" ${arrow} "${d.output_text || ''}"  (${d.latency_ms}ms)`,
        kindClass: 'rendition',
      };
    }

    case 'request-layer.decided':
      if (rec.data.decision === 'forward') {
        return {
          body: `▶ FORWARD: ${rec.data.invoke_text || ''}  — ${rec.data.reason || ''}`,
          kindClass: 'forward',
        };
      }
      return {
        body: `${rec.data.decision}: ${rec.data.reason || ''}`,
        kindClass: 'noop',
      };

    case 'narrator.fired':
      return { body: `"${rec.data.utterance || ''}"`, kindClass: 'narrator' };

    case 'narrator.brain-spawned':
      return { body: 'narrator brain spawned', kindClass: 'narrator' };

    case 'tts.turn-ended':
      return {
        body: `tts ended: "${rec.data.text_preview || ''}"`,
        kindClass: 'tts',
      };

    case 'tts.busy-marked':
      return { body: `tts busy +${Math.round(rec.data.est_dur_ms)}ms`, kindClass: 'tts' };

    case 'tts.agent-said':
      return { body: `"${rec.data.text || ''}"`, kindClass: 'tts' };

    case 'utterance.stream-started':
      return { body: `stream-start [${rec.data.source}] (${rec.data.model})`, kindClass: 'tts' };

    case 'utterance.stream-delta':
      return {
        body: `Δ[${rec.data.source}#${rec.data.seq}] "${rec.data.text_delta}"`,
        kindClass: 'tts',
      };

    case 'utterance.stream-ended':
      return {
        body: `stream-end [${rec.data.source}] (${rec.data.delta_count}Δ, ${rec.data.stream_ms}ms): "${rec.data.full_text}"`,
        kindClass: 'tts',
      };

    case 'utterance.stream-cancelled':
      return {
        body: `stream-cancel [${rec.data.source}] (${rec.data.reason}, ${rec.data.delta_count}Δ): "${rec.data.partial_text}"`,
        kindClass: 'state',
      };

    case 'stt.user-said':
      return { body: `"${rec.data.text || ''}"`, kindClass: 'stt' };

    case 'stt.empty-turn':
      return {
        body: `user turn closed with NO transcript${
          rec.data.secs_since_turn_start != null ? ` (${rec.data.secs_since_turn_start}s after turn start)` : ''
        } — endpointer starvation signature`,
        kindClass: 'stt',
      };

    case 'stt.discarded-on-teardown':
      return { body: `undelivered user speech at call end: "${rec.data.text || ''}"`, kindClass: 'stt' };

    case 'transport.connected':
      return {
        body: `connected: ${rec.data.transport}${rec.data.detail ? ' (' + rec.data.detail + ')' : ''}`,
        kindClass: 'detail',
      };

    case 'transport.disconnected':
      return {
        body: `disconnected: ${rec.data.transport}${rec.data.reason ? ' — ' + rec.data.reason : ''}`,
        kindClass: 'detail',
      };

    case 'cartesia.agent-turn-boundary':
      return {
        body:
          rec.data.edge === 'stop' && rec.data.text
            ? `cartesia agent ${rec.data.edge} — "${rec.data.text}"`
            : `cartesia agent ${rec.data.edge}`,
        kindClass: 'tts',
      };

    case 'cartesia.user-turn-boundary':
      return { body: `cartesia user ${rec.data.edge}`, kindClass: 'stt' };

    case 'cartesia.user-text-sent':
      return { body: `cartesia stt: "${rec.data.text}"`, kindClass: 'stt' };

    case 'cartesia.agent-text-sent':
      // Cumulative — render the latest text only. Final event before
      // turn-stop equals the full turn text.
      return { body: `cartesia tts: "${rec.data.text}"`, kindClass: 'tts' };

    case 'cartesia.task-cancelled':
      return {
        body: `cartesia cancelled task — reason: ${rec.data.reason}`,
        kindClass: 'state',
      };

    case 'cartesia.user-dtmf':
      return { body: `dtmf user: ${rec.data.button}`, kindClass: 'detail' };

    case 'cartesia.agent-dtmf':
      return { body: `dtmf agent: ${rec.data.button}`, kindClass: 'detail' };

    case 'cartesia.validation-error':
      return {
        body: `cartesia validation error: ${rec.data.error_type} — ${rec.data.error_message}`,
        kindClass: 'call-end',
      };

    case 'cartesia.agent-handoff':
      return {
        body: `cartesia handoff${rec.data.target_phone_number ? ' → ' + rec.data.target_phone_number : ''}`,
        kindClass: 'state',
      };

    case 'sse.client-changed':
      return {
        body: `sse ${rec.data.action} (total=${rec.data.total_clients})`,
        kindClass: 'detail',
      };

    case 'state.transitioned':
      return {
        body: `${rec.data.state}: ${String(rec.data.from)} → ${String(rec.data.to)}`,
        kindClass: 'state',
      };

    case 'capability.install-resolved': {
      const d = rec.data;
      if (!d.resolved || !d.snapshot) {
        const reason = d.resolver_error ? `error: ${d.resolver_error}` : 'no snapshot';
        return {
          body: `capability install [${d.agent_group_id}] — ${reason}`,
          kindClass: 'state',
        };
      }
      const snap = d.snapshot;
      const parts: string[] = [];
      if (snap.channels?.length) parts.push(`${snap.channels.length} channels`);
      if (snap.container_mcp_tools?.length) parts.push(`${snap.container_mcp_tools.length} mcp`);
      if (snap.container_skills?.length) parts.push(`${snap.container_skills.length} skills`);
      if (snap.sdk_tools?.length) parts.push(`${snap.sdk_tools.length} sdk`);
      if (snap.external_mcp_servers?.length) parts.push(`${snap.external_mcp_servers.length} ext-mcp`);
      return {
        body: `capability install [${d.agent_group_id}] · ${parts.join(' · ') || 'empty'}`,
        kindClass: 'state',
      };
    }

    case 'capability.caller-context-resolved': {
      const d = rec.data;
      if (!d.resolved || !d.snapshot) {
        const reason = d.resolver_error
          ? `error: ${d.resolver_error}`
          : d.resolver_present
            ? 'returned null'
            : 'no resolver wired';
        return {
          body: `caller-context (${d.call_site}) [${d.agent_group_id}] — ${reason}`,
          kindClass: 'state',
        };
      }
      const snap = d.snapshot;
      const callerSuffix = snap.caller?.suffix ? `…${snap.caller.suffix}` : snap.caller?.platform_id || '?';
      const handles = snap.known_handles?.length ? ` · ${snap.known_handles.length} handles` : '';
      return {
        body: `caller-context (${d.call_site}) ${callerSuffix}${handles}`,
        kindClass: 'state',
      };
    }

    case 'session.created':
      return {
        body: `session created (mode=${rec.data.session_mode})`,
        kindClass: 'session',
      };

    case 'session.closed':
      return {
        body: `session closed: ${rec.data.reason || ''}`,
        kindClass: 'session',
      };

    case 'session.ttl-expired':
      return {
        body: `session TTL expired (alive ${Math.round(rec.data.alive_ms / 1000)}s > ${Math.round(
          rec.data.ttl_ms / 1000,
        )}s, ${rec.data.channel_type})`,
        kindClass: 'session',
      };

    case 'container.spawned':
      return {
        body: `container spawned: ${rec.data.container_name || ''}`,
        kindClass: 'container',
      };

    case 'container.exited':
      return {
        body: `container exited code=${rec.data.exit_code}`,
        kindClass: 'container',
      };

    case 'chat.row-received':
      return {
        body: `seq=${rec.data.seq}  ${rec.data.preview || ''}`,
        kindClass: 'chat',
      };

    case 'detail.row-received': {
      const d = rec.data;
      // PAT: when the back-mind ran a Bash command, prefer the
      // server-parsed friendly label so the dashboard reads "git push"
      // instead of "Bash". Falls back to the bare tool name + type.
      let label = `detail ${d.type}`;
      if (d.tool === 'Bash' && d.parsed_command) {
        const friendly = friendlyBashLabel(d.parsed_command);
        label = `${d.type === 'tool-pre' ? '▶' : d.type === 'tool-failed' ? '✗' : '✓'} ${friendly}`;
      } else if (d.tool) {
        label += ` tool=${d.tool}`;
      }
      return { body: label, kindClass: 'detail' };
    }

    case 'routing.message-routed':
      return {
        body: `routed → ${rec.data.agent_group_name} [${rec.data.msg_kind}] (wake=${rec.data.wake})`,
        kindClass: 'routing',
      };

    case 'routing.message-delivered':
      return {
        body: `delivered ${rec.data.msg_kind} via ${rec.data.channel_type}`,
        kindClass: 'routing',
      };

    case 'permissions.realtime-owner-resolved':
      return {
        body:
          rec.data.decision === 'granted'
            ? `owner ${rec.data.role} GRANTED → ${rec.data.user_id} (${rec.data.matched_phone})`
            : `owner ${rec.data.role} confirmed → ${rec.data.user_id}`,
        kindClass: 'state',
      };

    case 'call.started':
      return { body: '☎ call started', kindClass: 'call-start' };

    case 'call.ended':
      return { body: '☎ call ended', kindClass: 'call-end' };

    case 'error':
      return { body: rec.data.msg, kindClass: 'call-end' };

    case 'lifecycle':
      return { body: `lifecycle: ${rec.data.phase}`, kindClass: 'detail' };

    case 'apify.run-completed': {
      const d = rec.data;
      const parts = [`apify ${d.actor_id}`, d.status];
      if (typeof d.items_returned === 'number') parts.push(`${d.items_returned} items`);
      parts.push(`${d.duration_ms}ms`);
      return { body: parts.join(' · '), kindClass: 'detail' };
    }

    case 'signal.send-acked': {
      // Closes the "did signal-cli actually ship it?" gap. The previous
      // observability surface (routing.message-routed) only confirmed
      // enqueue. This event fires after signal-cli's send RPC returns
      // with the canonical Signal Service timestamp.
      const d = rec.data;
      const detail = d.kind_detail ?? 'text';
      const target = d.group_id ? `group:${d.group_id}` : d.recipient;
      const attempt = d.attempt_no && d.attempt_no > 1 ? ` (attempt ${d.attempt_no})` : '';
      return {
        body: `✓ signal send [${detail}] → ${target} · ts=${d.signal_timestamp}${attempt}`,
        kindClass: 'routing',
      };
    }

    case 'signal.send-failed': {
      // Mirror of signal.send-acked for the rejection / timeout / network
      // path. Today the host swallowed these via a silent try/catch; this
      // event surfaces them in the timeline so "user heard PAT say
      // 'sent it' but nothing arrived" is debuggable.
      const d = rec.data;
      const detail = d.kind_detail ?? 'text';
      const target = d.group_id ? `group:${d.group_id}` : d.recipient;
      const attempt = d.attempt_no && d.attempt_no > 1 ? ` (attempt ${d.attempt_no})` : '';
      const errPreview = d.error.length > 120 ? `${d.error.slice(0, 117)}…` : d.error;
      return {
        body: `✗ signal send [${detail}] → ${target}${attempt} · "${errPreview}"`,
        kindClass: 'call-end',
      };
    }

    case 'imagegen.requested': {
      const d = rec.data;
      const preview = d.prompt.length > 80 ? `${d.prompt.slice(0, 77)}…` : d.prompt;
      const parts = [`imagegen → ${d.quality}`, `"${preview}"`, d.cache_key.slice(0, 8)];
      return { body: parts.join(' · '), kindClass: 'detail' };
    }

    case 'imagegen.completed': {
      const d = rec.data;
      const parts = [`imagegen ✓ ${d.cache_key.slice(0, 8)}`];
      if (d.error) {
        parts.push(`error: ${d.error}`);
      } else if (d.cache_hit) {
        parts.push('cached');
      } else {
        parts.push(`${d.latency_ms}ms`);
      }
      if (typeof d.bytes === 'number') parts.push(`${Math.round(d.bytes / 1024)}KB`);
      return { body: parts.join(' · '), kindClass: 'detail' };
    }

    case 'error.surfaced': {
      const d = rec.data;
      // Lead with source; a tool name (when present) is the sharpest
      // forensic hint. `debounce_suppressed=true` together with
      // `announced=false` = "another error of this source fired < 3s
      // ago and we muted the voice line." Render that distinctly so a
      // 5-burst doesn't read as 5 indistinguishable failures.
      const parts: string[] = [`error: ${d.source}`];
      if (d.tool) parts.push(`tool=${d.tool}`);
      if (d.debounce_suppressed) parts.push('SUPPRESSED');
      else if (!d.announced) parts.push('quiet');
      else parts.push('announced');
      const preview =
        d.error_preview.length > 120 ? `${d.error_preview.slice(0, 117)}…` : d.error_preview;
      parts.push(`"${preview}"`);
      return { body: parts.join(' · '), kindClass: 'call-end' };
    }

    case 'call.timed-out': {
      const d = rec.data;
      const mins = (d.idle_ms / 60_000).toFixed(1);
      return { body: `${d.channel_type}: idle ${mins}m → force-closed`, kindClass: 'call-end' };
    }

    case 'llm.call': {
      const d = rec.data;
      const ok = d.ok ? '✓' : '✗';
      return {
        body: `${ok} ${d.layer} ${d.model} ${d.latency_ms}ms${d.error ? ' err=' + d.error : ''}`,
        kindClass: 'detail',
      };
    }

    case 'fast-llm.keepalive': {
      const d = rec.data;
      const ok = d.skipped_inflight ? '⊘' : d.ok === false ? '✗' : '✓';
      const reuse = d.connection_reused === true ? ' reused' : d.connection_reused === false ? ' fresh' : '';
      const connect = d.connect_ms !== undefined ? ` connect=${d.connect_ms}ms` : '';
      const ttfb = d.ttfb_ms !== undefined ? ` ttfb=${d.ttfb_ms}ms` : '';
      const err = d.error ? ` err=${d.error}` : '';
      return {
        body: `${ok} keepalive ${d.provider}/${d.model}#${d.tick_seq}${reuse}${connect}${ttfb}${err}`,
        kindClass: 'detail',
      };
    }

    case 'bargein.received':
      return { body: `bargein: ${rec.data.reason}`, kindClass: 'state' };

    case 'bargein.propagated': {
      const d = rec.data;
      const bits = [d.killed_container ? 'killed-container' : 'no-container'];
      if (d.dropped_pending_contexts > 0) bits.push(`dropped ${d.dropped_pending_contexts}`);
      return { body: `bargein → ${bits.join(', ')}`, kindClass: 'state' };
    }

    case 'back-mind.cancelled':
      return { body: `back-mind cancelled: ${rec.data.reason}`, kindClass: 'state' };

    case 'back-mind.llm-call': {
      const d = rec.data;
      const bits: string[] = [`turn=${d.turn_index}`];
      if (d.duration_ms !== undefined) bits.push(`${d.duration_ms}ms`);
      bits.push(`in=${d.input_tokens}`);
      bits.push(`out=${d.output_tokens}`);
      if (d.cache_read_input_tokens) bits.push(`cache_r=${d.cache_read_input_tokens}`);
      if (d.cache_creation_input_tokens) bits.push(`cache_w=${d.cache_creation_input_tokens}`);
      bits.push(`stop=${d.stop_reason}`);
      return { body: `back-mind LLM: ${bits.join(' · ')}`, kindClass: 'state' };
    }

    // PAT 2026-05-26: removed back-mind.prewarmed render case — back-mind
    // prewarm path deleted from nanoclaw/container/agent-runner/src/poll-loop.ts.

    case 'intent.accumulated':
      return {
        body: `+pending (${rec.data.pending_total}): "${rec.data.raw_text}"`,
        kindClass: 'chat',
      };

    case 'intent.rendered-multi':
      return {
        body: `merged ${rec.data.context_count} → "${rec.data.rendered_text}" (${rec.data.render_ms}ms)`,
        kindClass: 'rendition',
      };

    case 'deliver-chat.step': {
      const d = rec.data;
      const bits: string[] = [`${d.step} +${d.elapsed_ms}ms`];
      if (d.iter !== undefined) bits.push(`iter=${d.iter}`);
      if (d.pending_count !== undefined) bits.push(`pending=${d.pending_count}`);
      if (d.input_chars !== undefined) bits.push(`input=${d.input_chars}c`);
      if (d.render_ms !== undefined) bits.push(`render=${d.render_ms}ms`);
      return { body: `deliver-chat: ${bits.join(' · ')}`, kindClass: 'state' };
    }

    case 'scenario.tag-stream-started': {
      const d = rec.data;
      return {
        body: `↓ tag-stream ${d.scenario_slug} slide=${d.slide_n} (${d.raw_chars} chars)`,
        kindClass: 'scenario-stream',
      };
    }

    case 'scenario.action': {
      const d = rec.data;
      const parts: string[] = [`${d.action_type}`];
      if (d.action_type === 'prose') {
        const text = d.text ?? '';
        const preview = text.length > 80 ? `${text.slice(0, 77)}…` : text;
        parts.push(`"${preview}"`);
      } else if (d.action_type === 'slide-nav') {
        parts.push(d.direction ?? '?');
      } else if (d.action_type === 'slide-goto') {
        parts.push(`→ slide ${d.target_slide}`);
      } else if (d.action_type === 'fragment') {
        parts.push(d.fragment_direction ?? '?');
      } else if (d.action_type === 'tool') {
        parts.push(d.tool_name ?? '?');
        if (d.tool_args) parts.push(JSON.stringify(d.tool_args));
      } else if (d.action_type === 'unknown-tag') {
        parts.push(d.raw_tag ?? '?');
      }
      const colorClass =
        d.action_type === 'unknown-tag'
          ? 'call-end'
          : d.action_type === 'tool'
          ? 'detail'
          : 'scenario-action';
      return {
        body: `→ ${parts.join(' ')}  [seq ${d.seq}, slide ${d.slide_n}]`,
        kindClass: colorClass,
      };
    }

    case 'scenario.tag-stream-ended': {
      const d = rec.data;
      return {
        body: `↑ tag-stream end · ${d.action_count} actions · ${d.duration_ms}ms · terminator=${d.terminator}`,
        kindClass: 'scenario-stream',
      };
    }

    // ── Timeline wrapper lifecycle ────────────────────────────────────
    // Brackets the playback of one <timeline>...</timeline> stream from
    // the back-mind. Pair started/finished by `timeline_id`. See
    // plans/timeline-runtime-and-scenarios.md §3.2.
    case 'timeline.started': {
      const d = rec.data;
      const scenario = d.scenario_slug ? ` · ${d.scenario_slug}` : '';
      return {
        body: `▶ timeline [${d.timeline_id}]${scenario}`,
        kindClass: 'timeline-bracket',
      };
    }

    case 'timeline.finished': {
      const d = rec.data;
      return {
        body: `■ timeline [${d.timeline_id}] · ${d.reason} · ${d.duration_ms}ms`,
        kindClass: 'timeline-bracket',
      };
    }

    case 'timeline.span-hydrated': {
      const d = rec.data;
      // Two flavors: success (`inlined` > 0) and skipped (`reason` set).
      // Render both inline so forensics see what the back-mind asked
      // for vs what hydration produced.
      const badge = d.reason ? `✗ ${d.reason}` : `✓ ${d.inlined} actions`;
      return {
        body: `↔ timeline_span [${d.from}..${d.to}] · ${badge} (of ${d.authored_count} authored)`,
        kindClass: 'timeline-bracket',
      };
    }

    // ── Timeline action-level events ──────────────────────────────────
    // One per action that the sequencer enqueues, completes, or cancels.
    // `kind` here is the action kind (say, pause, next_fragment, etc.),
    // distinct from the log event `kind` discriminator.
    case 'timeline.action-enqueued': {
      const d = rec.data;
      return {
        body: `+ ${d.kind} [seq ${d.seq}]`,
        kindClass: 'timeline-action',
      };
    }

    case 'timeline.action-started': {
      const d = rec.data;
      return {
        body: `▸ ${d.kind} [seq ${d.seq}]`,
        kindClass: 'timeline-action',
      };
    }

    case 'timeline.action-completed': {
      const d = rec.data;
      return {
        body: `✓ ${d.kind} [seq ${d.seq}] · ${d.duration_ms}ms`,
        kindClass: 'timeline-action',
      };
    }

    case 'timeline.action-cancelled': {
      const d = rec.data;
      // `partial` carries the partial-text capture (a string) when the
      // action was mid-flight at cancel time. Falsy when there was none.
      const partialTag = d.partial ? ' · partial' : '';
      return {
        body: `✗ ${d.kind} [seq ${d.seq}] · ${d.reason}${partialTag}`,
        kindClass: 'timeline-action',
      };
    }

    // PAT 2026-05-26: removed anam-web.prewarm-requested render case —
    // back-mind prewarm routes deleted from nanoclaw/src/channels/anam-web.ts.

    case 'anam-web.ws-opened': {
      const d = rec.data;
      return {
        body: `anam-web WS opened · ${d.remote || 'remote?'}`,
        kindClass: 'state',
      };
    }

    case 'anam-web.ws-closed': {
      const d = rec.data;
      const r = d.reason ? ` · ${d.reason}` : '';
      return {
        body: `anam-web WS closed [${d.code}]${r}`,
        kindClass: 'state',
      };
    }

    // ── Browser RTT instrumentation (source='pat-web-browser') ────────
    // Paired by correlation_id. inbound.sent fires once per user turn
    // dispatched upstream; utterance.delta-received fires once per
    // banter chunk arrival back in the browser. Use a diff of the two
    // timestamps to measure browser→server→browser round-trip.
    case 'inbound.sent': {
      const d = rec.data;
      const corr = d.correlation_id ? ` · ${d.correlation_id.slice(0, 8)}` : '';
      return {
        body: `↗ inbound sent · ${d.user_text_length} chars${corr}`,
        kindClass: 'inbound',
      };
    }

    case 'utterance.delta-received': {
      const d = rec.data;
      const corr = d.correlation_id ? ` · ${d.correlation_id.slice(0, 8)}` : '';
      return {
        body: `↘ delta recv [${d.source_layer}#${d.sequence}] · ${d.chars} chars${corr}`,
        kindClass: 'tts',
      };
    }

    // ── Signal health probe (external observer on nanoclaw) ───────────
    case 'signal.health-ok': {
      const d = rec.data;
      const rec_ = d.recovered ? ' · recovered' : '';
      return {
        body: `🟢 signal healthy · ${d.account} · ${d.probe_ms}ms${rec_}`,
        kindClass: 'state',
      };
    }

    case 'signal.health-degraded': {
      const d = rec.data;
      const paged = d.alerted ? ' · ALERTED' : '';
      return {
        body: `🔴 signal DEGRADED [${d.reason}] · ${d.account} · ${d.detail} · ${d.consecutive}x${paged}`,
        kindClass: 'state',
      };
    }

    // ── Inbound authorization gate (phone/realtime caller refused) ────
    case 'permissions.caller-refused': {
      const d = rec.data;
      return {
        body: `⛔ caller refused [${d.policy}] · ${d.sender_id} · ${d.platform_id}`,
        kindClass: 'state',
      };
    }

    default: {
      // Intentionally NON-exhaustive (fail-soft): not every event kind needs a
      // bespoke renderer. Un-themed kinds render generically here; missing renderers
      // are flagged at BUILD time by scripts/check-renderers.ts (a non-fatal warning
      // in the build output) — so a new kind never blocks the build/deploy. (This
      // replaces the old `never` exhaustiveness assertion, which build-broke on every
      // schema addition.)
      const { kind, data } = rec as { kind: string; data?: unknown };
      return { body: `${kind}${data ? ' ' + JSON.stringify(data) : ''}`, kindClass: 'misc' };
    }
  }
}

/** Friendly label for a server-parsed Bash command. Mirrors the
 *  `parsed_command` shape on `detail.row-received`. */
export function friendlyBashLabel(p: { type: string; salient: string }): string {
  switch (p.type) {
    case 'fetched-web-page':
      return p.salient ? `fetched ${p.salient}` : 'fetched a web page';
    case 'ran-program':
      return p.salient ? `ran ${p.salient}` : 'ran a program';
    case 'git':
      return p.salient ? `git ${p.salient}` : 'git';
    case 'read-file':
      return p.salient ? `read ${p.salient}` : 'read a file';
    case 'listed-files':
      return p.salient ? `listed ${p.salient}` : 'listed files';
    case 'searched-files':
      return p.salient ? `searched "${p.salient}"` : 'searched files';
    case 'installed-packages':
      return p.salient ? `${p.salient} install` : 'installed packages';
    case 'edited-file':
      return p.salient ? `edited ${p.salient}` : 'edited a file';
    case 'made-directory':
      return p.salient ? `mkdir ${p.salient}` : 'made a directory';
    case 'changed-directory':
      return p.salient ? `cd ${p.salient}` : 'changed directory';
    default:
      return p.salient ? `bash ${p.salient}` : 'bash';
  }
}

/** Tailwind class for the kind-class returned above. */
export function kindClassToken(kindClass: string): string {
  switch (kindClass) {
    case 'inbound':
      return 'text-[var(--color-kind-inbound)]';
    case 'banter':
      return 'text-[var(--color-kind-banter)] font-semibold';
    case 'rendition':
      return 'text-[var(--color-kind-rendition)] font-semibold';
    case 'narrator':
      return 'text-[var(--color-kind-narrator)]';
    case 'forward':
      return 'text-[var(--color-kind-forward)] font-semibold';
    case 'noop':
      return 'text-[var(--color-kind-noop)]';
    case 'state':
      return 'text-[var(--color-kind-state)]';
    case 'call-start':
      return 'text-[var(--color-kind-call-start)] font-semibold';
    case 'call-end':
      return 'text-[var(--color-kind-call-end)] font-semibold';
    case 'session':
      return 'text-[var(--color-kind-session)]';
    case 'container':
      return 'text-[var(--color-kind-container)]';
    case 'chat':
      return 'text-[var(--color-kind-chat)]';
    case 'tts':
      return 'text-[var(--color-kind-tts)]';
    case 'stt':
      return 'text-[var(--color-kind-stt)]';
    case 'routing':
      return 'text-[var(--color-kind-routing)]';
    case 'scenario-stream':
      // PAT: tag-stream lifecycle markers. Rendered with banter color
      // so the eye groups scenario.* alongside prose/rendition rows.
      return 'text-[var(--color-kind-banter)] font-semibold';
    case 'scenario-action':
      // PAT: prose / nav / fragment dispatches inside a
      // tag stream. Rendered as rendition (so say segments read
      // as "spoken") with slight de-emphasis vs the stream-bracket.
      return 'text-[var(--color-kind-rendition)]';
    case 'detail':
    default:
      return 'text-[var(--color-kind-detail)]';
  }
}
