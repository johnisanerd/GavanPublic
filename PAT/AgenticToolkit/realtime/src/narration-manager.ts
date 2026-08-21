/**
 * NarrationManager — per-channel poll loop that drives the Narrator
 * brain off outbound.db detail rows.
 *
 * One instance per channel adapter. Each instance maintains its own
 * `Map<sessionId, Narrator>` (one brain per back-mind session) plus
 * lastSeq watermarks so each poll tick only reads new rows.
 *
 * On each detail row:
 *   1. Hand it to the brain (`narrator.observe`) so it can decide
 *      whether to fire a model call.
 *   2. Emit `detail.row-received` so the dashboard timeline can
 *      render tool-call tracks (skips `token-delta` — too noisy).
 *   3. Flip the orchestrator's processing flag false on `query-end`
 *      (authoritative end-of-work signal from the back-mind).
 *   4. Synthesize `apify.run-completed` from `mcp__apify__*`
 *      tool boundaries (orchestrator emits the structured event).
 *   5. Surface tool failures via `orchestrator.emitErrorSurfaced`
 *      (spoken via the channel's broadcaster when the announce
 *      decision says yes).
 *
 * What the host supplies (NarrationManagerOpts):
 *   - `listSessions()` — per-poll enumeration of active channel
 *     sessions. Adapter implements using its DB module.
 *   - `readOutbound(session, lastSeq)` — read newer rows from this
 *     session's outbound.db. Adapter implements via openOutboundDb.
 *   - `makeTransport(threadId, platformId)` — channel-specific
 *     `ChannelTransport` for the streaming-narration call's deltas.
 *     PSTN broadcasts `utterance-*` SSE events; anam-web posts
 *     to the banter-broadcast.
 *   - `broadcast(text)` — optional fan-out for the narrator's full
 *     utterance. PSTN uses it (drives Cartesia TTS); anam-web omits
 *     (deltas already reach the browser via the structured-log SSE
 *     feed).
 *   - `getModel()` — optional override of the model name used in
 *     `utterance.stream-started` events.
 *
 * Lifecycle: `start()` starts the poll timer, `stop()` clears it
 * and stops every brain. Idempotent — repeat start/stop calls are
 * no-ops.
 */

import {
  streamBanterNarration,
  Narrator,
  type NarrationCallRequest,
} from './narration.js';
import { conversationKey, type ChannelOrchestrator, type ChannelTransport } from './channel-orchestrator.js';
import { parseBashCommand } from './bash-parse.js';

// PAT: dropped from 1000 → 25. The original 1000ms cross-mount floor
// was justified by `journal_mode=DELETE` visibility, but agent-runner's
// reader-side `mmap_size=0` (nanoclaw/container/agent-runner/src/db/
// connection.ts:44-49) already mitigates that, and the sister poll in
// nanoclaw/src/delivery.ts was already at 100ms. 25ms = ~40 reads/sec/
// session, trivial for SQLite (microsecond reads, no I/O cost).
const NARRATION_POLL_INTERVAL_MS = 25;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
/** Hard session TTL — absolute wall-clock cap on session lifetime.
 *  Safety net against zombie sessions where continuous activity (e.g.
 *  narration loop firing LLM calls into a dead WebRTC/WS session)
 *  defeats the idle timeout. Default: 60 minutes. */
const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000;

export interface NarrationSession {
  sessionId: string;
  threadId: string | null;
  platformId: string;
  agentGroupId: string;
  messagingGroupId: string;
}

export interface NarrationOutboundRow {
  id: string;
  seq: number;
  kind: string;
  content: string;
}

export interface NarrationManagerOpts {
  /** Channel identifier — used for the dashboard label and as a
   *  natural debug aid; the host's `listSessions` callback already
   *  filters by channel. */
  channelType: string;
  /** Per-poll session enumeration. Empty array → tick is a no-op. */
  listSessions(): NarrationSession[];
  /** Read outbound.db rows newer than `lastSeq` for one session.
   *  Throws → manager skips this session for the tick (typical when
   *  outbound.db isn't created yet — session just started). */
  readOutbound(session: NarrationSession, lastSeq: number): NarrationOutboundRow[];
  /** Channel-specific transport for the streaming-narration call's
   *  deltas. */
  makeTransport(threadId: string | null, platformId: string): ChannelTransport;
  /** Optional broadcaster for the narrator's full-utterance output.
   *  When omitted, the brain still fires + history is stamped + TTS
   *  busy is marked, but no per-channel fan-out happens. */
  broadcast?: (text: string, threadId: string | null) => void;
  /** Optional poll interval override (default 1000ms — the cross-mount
   *  visibility floor for `journal_mode=DELETE`). */
  pollIntervalMs?: number;
  /** Force-close idle sessions after this many ms with no new outbound
   *  rows. Catches ungraceful hangups (PSTN dial-tone drop, browser
   *  tab close) where the channel-specific /call-ended hook never
   *  fires. Adapter's `markSessionClosed` callback handles the host
   *  DB write; the manager handles cognition cleanup (intent queue,
   *  in-flight stream aborts, processing flag, brain teardown).
   *  Default: 5 minutes. Set to 0 to disable. */
  idleTimeoutMs?: number;
  /** Adapter callback to close out a session host-side when
   *  `idleTimeoutMs` fires. Typically calls `updateSession(id,
   *  {status: 'closed'})` from `nanoclaw/src/db/sessions.js` so the
   *  next `listSessions()` tick stops returning the row. Required
   *  when `idleTimeoutMs > 0`. */
  markSessionClosed?: (session: NarrationSession) => void;
  /** Hard session TTL — absolute wall-clock cap on session lifetime.
   *  Unlike `idleTimeoutMs` (which resets on each outbound row), this
   *  is measured from the moment the NarrationManager first observes
   *  the session and never resets. Catches zombie sessions where the
   *  narration loop's own LLM calls keep producing outbound activity,
   *  defeating the idle timeout.
   *  Default: 60 minutes (DEFAULT_SESSION_TTL_MS). Set to 0 to
   *  disable. Requires `markSessionClosed` to be set. */
  sessionTtlMs?: number;
}

export class NarrationManager {
  readonly channelType: string;
  private readonly orchestrator: ChannelOrchestrator;
  private readonly opts: NarrationManagerOpts;
  private readonly pollIntervalMs: number;

  private brains = new Map<string, Narrator>();
  private lastSeq = new Map<string, number>();
  /** Wall-clock ms of the last new outbound row observed for each
   *  session. Bumped whenever rows.length > 0 in poll(). Used by the
   *  idle-timeout check to detect sessions that have gone silent
   *  past `idleTimeoutMs`. Bootstrapped to the spawn time of the
   *  brain so a fresh session gets a full grace period. */
  private lastActivityMs = new Map<string, number>();
  /** Wall-clock ms when the NarrationManager first observed each
   *  session. Never reset — used by the hard TTL check to detect
   *  zombie sessions whose continuous activity defeats the idle
   *  timeout. Bootstrapped on first encounter in poll(). */
  private firstSeenMs = new Map<string, number>();
  // Tracks tool-pre wall-clock ms by toolUseId for the apify
  // run-completed synthesis. Cleaned up on the matching tool-post
  // (or tool-failed); short-lived (a single Actor run, seconds to
  // minutes).
  private apifyStartMs = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private readonly idleTimeoutMs: number;
  private readonly sessionTtlMs: number;

  constructor(orchestrator: ChannelOrchestrator, opts: NarrationManagerOpts) {
    this.orchestrator = orchestrator;
    this.opts = opts;
    this.channelType = opts.channelType;
    this.pollIntervalMs = opts.pollIntervalMs ?? NARRATION_POLL_INTERVAL_MS;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.sessionTtlMs = opts.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () =>
        this.poll().catch((err) =>
          this.orchestrator.host.log.warn(`${this.channelType}: narration poll failed`, { err: String(err) }),
        ),
      this.pollIntervalMs,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const b of this.brains.values()) b.stop();
    this.brains.clear();
    this.lastSeq.clear();
    this.lastActivityMs.clear();
    this.firstSeenMs.clear();
    this.apifyStartMs.clear();
  }

  private getBrain(
    sessionId: string,
    threadIdForSession: string | null,
    platformIdForSession: string,
    agentGroupIdForSession: string,
  ): Narrator {
    let b = this.brains.get(sessionId);
    if (b) return b;

    this.orchestrator.host.log.event({
      kind: 'narrator.brain-spawned',
      session_id: sessionId,
      thread_id: threadIdForSession,
      data: {},
    });

    // Capture once so the closures hold stable identifiers for this
    // brain's lifetime. (Sessions are per-thread now, so these don't
    // change for the brain's life.)
    const threadKey = threadIdForSession;
    const platformKey = platformIdForSession;
    const agentGroupId = agentGroupIdForSession;
    const brainRef: { brain: Narrator | null } = { brain: null };
    const channelKey = conversationKey(threadKey, platformKey);
    const orchestrator = this.orchestrator;
    const opts = this.opts;
    const channelType = this.channelType;

    // Path A — narration always streams token-by-token via
    // runStreamingFrontMind. The transport carries deltas to the
    // channel-specific output (PSTN: utterance-delta SSE; anam-web:
    // banter-broadcast).
    //
    // Capability lifecycle (TaskList #8): pass agentGroupId so the
    // banter-narration prompt's render() can look up the cached
    // install-capabilities block for SYSTEM. Narration inherits the
    // install surface for free without a per-session resolver call.
    const streamingNarrationCall = async (req: NarrationCallRequest) => {
      const result = await orchestrator.runStreamingFrontMind<{
        text: string | null;
        silent: boolean;
      }>({
        source: 'banter-narration',
        threadId: threadKey,
        threadKey: channelKey,
        platformId: platformKey,
        transport: opts.makeTransport(threadKey, platformKey),
        invoke: async (cb) => {
          const r = await streamBanterNarration({
            recentEvents: req.recentEvents,
            history: req.history,
            currentBackMindProgress: req.currentBackMindProgress,
            agentGroupId,
            ...cb,
          });
          return { text: r.utterance ?? null, silent: r.utterance == null };
        },
      });
      return { utterance: result.text };
    };

    b = new Narrator({
      narrationCall: streamingNarrationCall,
      onUtterance: (text: string) => {
        orchestrator.host.log.event({
          kind: 'narrator.fired',
          session_id: sessionId,
          thread_id: threadKey,
          platform_id: platformKey,
          data: {
            utterance: text,
            events_observed: brainRef.brain?.peekProgressText().split('\n').slice(0, 5) ?? [],
          },
        });
        // Mark TTS busy for the projected utterance length + 1s tail
        // pad. ~11 chars/s mirrors realtime/src/narration.ts
        // TTS_CHARS_PER_SEC. The 1000ms padding (vs 400ms for chat
        // renditions) gives the caller a real beat between back-to-back
        // agent utterances. Mirrored on the Python side in
        // transports/main.py.
        const estDurMs = (text.length / 11) * 1000 + 1000;
        orchestrator.tts.markStarted(threadKey, estDurMs);
        orchestrator.host.log.event({
          kind: 'tts.busy-marked',
          thread_id: threadKey,
          data: { est_dur_ms: estDurMs, text_preview: text.slice(0, 200) },
        });
        // Push to the unified history so subsequent banter / rendition
        // / next-narration calls can see WHY this filler was said.
        const progress = brainRef.brain?.peekProgressText() ?? '';
        orchestrator.history.push(channelKey, {
          role: 'pat',
          text,
          basedOnBackMindProgress: progress || undefined,
        });
        // Optional channel-specific fan-out (PSTN: realtime-utterance
        // SSE → Cartesia TTS; anam-web: omitted — deltas already
        // reached the browser via the structured-log SSE feed).
        opts.broadcast?.(text, threadKey);
      },
      log: (msg: string, meta?: Record<string, unknown>) =>
        orchestrator.host.log.info(`${channelType} narration[${sessionId.slice(0, 12)}]: ${msg}`, meta),
      // Replace the brain's length-based TTS-busy estimate with the
      // real signal — sourced from voice-transport's
      // /agent-turn-ended POST (PSTN) or pat-web's /anam-web/turn-ended
      // POST (anam-web). The brain's local projection still acts as a
      // fallback inside the window between broadcast and the first
      // real end-of-speech arrival.
      isTtsBusy: () => orchestrator.tts.isBusy(threadKey),
      getLastTtsEndedAt: () => orchestrator.tts.getLastEndedAt(threadKey),
      // Hand the Narrator the same unified history banter / rendition
      // see. Lets it avoid repeating itself across turns and stay coherent.
      getHistory: () => orchestrator.history.get(channelKey),
      // Single source of truth for the processing gate is the
      // orchestrator's map. Written on forward (true) + query-end (false).
      isProcessingNarration: () => orchestrator.isProcessing(channelKey),
      // PAT: hard-suppress narration during scripted `<timeline>`
      // playback. Orchestrator tracks open timelines per thread; while
      // any is active, filler narration would speak over authored
      // content. Read on every tick BEFORE other gates.
      isDelivering: () => orchestrator.isDelivering(channelKey),
    });
    brainRef.brain = b;
    this.brains.set(sessionId, b);
    return b;
  }

  /** Tear down a session that hasn't seen new outbound activity for
   *  `idleTimeoutMs`. Emits `call.timed-out`, hands off to the
   *  adapter's `markSessionClosed` for the host DB write, then clears
   *  brain + lastSeq + lastActivityMs + apifyStartMs entries plus
   *  orchestrator-side per-thread state (intent queue, in-flight
   *  streams, processing flag). */
  private forceCloseIdleSession(session: NarrationSession, idleMs: number): void {
    const channelKey = conversationKey(session.threadId, session.platformId);
    this.orchestrator.host.log.event({
      kind: 'call.timed-out',
      session_id: session.sessionId,
      thread_id: session.threadId,
      platform_id: session.platformId,
      data: {
        idle_ms: idleMs,
        channel_type: this.channelType,
      },
    });
    try {
      this.opts.markSessionClosed?.(session);
    } catch (err) {
      this.orchestrator.host.log.warn(`${this.channelType}: markSessionClosed threw`, { err: String(err) });
    }
    // Cognition cleanup: drop the dedup queue, abort any in-flight
    // banter / rendition / narration streams, flip the processing
    // flag false. Belt-and-suspenders — narration poll won't see the
    // session again next tick, but anything mid-flight needs explicit
    // cancellation.
    this.orchestrator.clearIntent(channelKey, {
      threadId: session.threadId,
      platformId: session.platformId,
    });
    this.orchestrator.streams.abortAll(channelKey);
    this.orchestrator.setProcessing({
      threadKey: channelKey,
      threadId: session.threadId,
      platformId: session.platformId,
      value: false,
    });
    // Brain teardown.
    const brain = this.brains.get(session.sessionId);
    if (brain) {
      try {
        brain.stop();
      } catch (err) {
        this.orchestrator.host.log.warn(`${this.channelType}: brain.stop threw`, { err: String(err) });
      }
      this.brains.delete(session.sessionId);
    }
    this.lastSeq.delete(session.sessionId);
    this.lastActivityMs.delete(session.sessionId);
    this.firstSeenMs.delete(session.sessionId);
    // apifyStartMs entries are toolUseId-keyed, not session-keyed, so a
    // best-effort sweep would need a session-id back-reference. Apify
    // entries are short-lived (single Actor run) and bounded in number,
    // so leaving them is acceptable — they self-clear on the next
    // tool-post / tool-failed event for that toolUseId.
  }

  /** Tear down a session that has exceeded the hard TTL. Unlike
   *  `forceCloseIdleSession` (which checks idle time since last
   *  activity), this checks absolute session lifetime — catches zombie
   *  sessions where continuous outbound activity (e.g. narration loop
   *  firing LLM calls) defeats the idle timeout. */
  private forceCloseTtlExpiredSession(session: NarrationSession, aliveMs: number): void {
    const channelKey = conversationKey(session.threadId, session.platformId);
    this.orchestrator.host.log.event({
      kind: 'session.ttl-expired',
      session_id: session.sessionId,
      thread_id: session.threadId,
      platform_id: session.platformId,
      data: {
        alive_ms: aliveMs,
        ttl_ms: this.sessionTtlMs,
        channel_type: this.channelType,
      },
    });
    try {
      this.opts.markSessionClosed?.(session);
    } catch (err) {
      this.orchestrator.host.log.warn(`${this.channelType}: markSessionClosed threw (ttl)`, { err: String(err) });
    }
    // Same cognition cleanup as forceCloseIdleSession: drop intent
    // queue, abort in-flight streams, flip processing flag false.
    this.orchestrator.clearIntent(channelKey, {
      threadId: session.threadId,
      platformId: session.platformId,
    });
    this.orchestrator.streams.abortAll(channelKey);
    this.orchestrator.setProcessing({
      threadKey: channelKey,
      threadId: session.threadId,
      platformId: session.platformId,
      value: false,
    });
    // Brain teardown.
    const brain = this.brains.get(session.sessionId);
    if (brain) {
      try {
        brain.stop();
      } catch (err) {
        this.orchestrator.host.log.warn(`${this.channelType}: brain.stop threw (ttl)`, { err: String(err) });
      }
      this.brains.delete(session.sessionId);
    }
    this.lastSeq.delete(session.sessionId);
    this.lastActivityMs.delete(session.sessionId);
    this.firstSeenMs.delete(session.sessionId);
  }

  private async poll(): Promise<void> {
    const sessions = this.opts.listSessions();
    if (sessions.length === 0) return;
    const now = Date.now();
    for (const session of sessions) {
      // First-touch: bootstrap the activity clock and birth clock to
      // "now" so a fresh session gets a full grace period before timing
      // out (idle) or hitting the TTL cap.
      if (!this.lastActivityMs.has(session.sessionId)) {
        this.lastActivityMs.set(session.sessionId, now);
      }
      if (!this.firstSeenMs.has(session.sessionId)) {
        this.firstSeenMs.set(session.sessionId, now);
      }
      // Hard TTL sweep: absolute wall-clock cap on session lifetime.
      // Unlike the idle timeout below (which resets on each outbound
      // row), this never resets — catches zombie sessions where
      // continuous activity (e.g. narration loop firing LLM calls into a
      // dead WebRTC session) defeats the idle timeout. Checked BEFORE
      // the idle sweep so a session that's both TTL-expired and idle
      // gets the more informative ttl-expired event.
      if (this.sessionTtlMs > 0 && this.opts.markSessionClosed) {
        const aliveMs = now - (this.firstSeenMs.get(session.sessionId) ?? now);
        if (aliveMs >= this.sessionTtlMs) {
          this.forceCloseTtlExpiredSession(session, aliveMs);
          continue;
        }
      }
      // Idle-timeout sweep: a session that's gotten no new outbound rows
      // for `idleTimeoutMs` is treated as a hung-up call. Catches
      // ungraceful drops where /call-ended (PSTN) or tab-close
      // (anam-web) didn't fire. Emits `call.timed-out`, marks the
      // session closed host-side, and tears down the brain + per-thread
      // cognition state so the next poll tick stops touching it.
      if (this.idleTimeoutMs > 0 && this.opts.markSessionClosed) {
        const idleMs = now - (this.lastActivityMs.get(session.sessionId) ?? now);
        if (idleMs >= this.idleTimeoutMs) {
          this.forceCloseIdleSession(session, idleMs);
          continue;
        }
      }
      const brain = this.getBrain(session.sessionId, session.threadId, session.platformId, session.agentGroupId);
      let rows: NarrationOutboundRow[];
      try {
        rows = this.opts.readOutbound(session, this.lastSeq.get(session.sessionId) ?? 0);
      } catch {
        continue; // outbound.db not yet created (session just started) or transient read failure
      }
      if (rows.length > 0) {
        this.lastActivityMs.set(session.sessionId, now);
        this.orchestrator.host.log.info(`${this.channelType}: narration poll picked up rows`, {
          sessionId: session.sessionId,
          count: rows.length,
          kinds: rows.map((r) => r.kind),
        });
      }
      for (const row of rows) {
        this.lastSeq.set(session.sessionId, row.seq);
        if (row.kind === 'detail') {
          try {
            const parsed = JSON.parse(row.content) as {
              type: string;
              tool?: string;
              toolUseId?: string;
              input?: Record<string, unknown>;
              result_preview?: string;
              result_truncated?: boolean;
              result_total_chars?: number;
              error?: string;
              text?: string;
              // message-block-dispatched / -dropped fields
              to?: string;
              channel_type?: string;
              platform_id?: string;
              body_len?: number;
              match?: 'destination-name' | 'cold-contact';
              reason?: string;
              // back-mind-completion fields
              response?: string;
              system_prompt?: string;
              user_message?: string;
              model?: string;
              latency_ms?: number;
              ok?: boolean;
              // back-mind-llm-call fields (per-Anthropic-API-call usage
              // + timing, one row per assistant message in the SDK loop).
              turn_index?: number;
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
              duration_ms?: number;
              stop_reason?: string | null;
              request_id?: string;
              sdk_session_id?: string;
              // PAT: removed back-mind-prewarmed.success field 2026-05-26
              // alongside back-mind prewarm removal.
            };
            brain.observe(parsed);
            // PAT: back-mind completion → promote to a structured
            // `llm.call` event at level='debug' so forensics queries via
            // `?kind=llm.call&include_debug=1` see front-mind and
            // back-mind calls in the same stream. Don't also emit a
            // detail.row-received — the full prompt+response payload is
            // large and the dashboard timeline doesn't need it twice.
            if (parsed.type === 'back-mind-completion') {
              this.orchestrator.host.log.event({
                kind: 'llm.call',
                level: 'debug',
                session_id: session.sessionId,
                thread_id: session.threadId,
                platform_id: session.platformId,
                data: {
                  layer: 'back-mind',
                  model: parsed.model ?? '',
                  system_prompt: parsed.system_prompt ?? '',
                  user_message: parsed.user_message ?? '',
                  response: parsed.response ?? null,
                  latency_ms: parsed.latency_ms ?? 0,
                  ok: parsed.ok ?? false,
                  ...(parsed.error !== undefined ? { error: parsed.error } : {}),
                },
              });
              continue;
            }
            // PAT: per-Anthropic-API-call instrumentation for the
            // back-mind. One detail row per SDKAssistantMessage; carries
            // BetaUsage + stop_reason + duration. Promote to a
            // structured `back-mind.llm-call` event at level='debug' so
            // forensics queries via `?kind=back-mind.llm-call&include_debug=1`
            // can answer "why was that turn 12s — generating tokens, or
            // burning tool calls?" without inferring from latency_ms
            // alone. Don't also emit detail.row-received — payload is
            // typed-numeric, the dashboard timeline doesn't need a
            // pretty-print of token counts.
            if (parsed.type === 'back-mind-llm-call') {
              this.orchestrator.host.log.event({
                kind: 'back-mind.llm-call',
                level: 'debug',
                session_id: session.sessionId,
                thread_id: session.threadId,
                platform_id: session.platformId,
                data: {
                  model: parsed.model ?? '',
                  turn_index: parsed.turn_index ?? 0,
                  input_tokens: parsed.input_tokens ?? 0,
                  output_tokens: parsed.output_tokens ?? 0,
                  cache_read_input_tokens: parsed.cache_read_input_tokens ?? 0,
                  cache_creation_input_tokens: parsed.cache_creation_input_tokens ?? 0,
                  stop_reason: parsed.stop_reason ?? null,
                  ...(parsed.duration_ms !== undefined ? { duration_ms: parsed.duration_ms } : {}),
                  ...(parsed.request_id !== undefined ? { request_id: parsed.request_id } : {}),
                  ...(parsed.sdk_session_id !== undefined ? { sdk_session_id: parsed.sdk_session_id } : {}),
                },
              });
              continue;
            }
            // PAT: removed back-mind-prewarmed → back-mind.prewarmed
            // promotion 2026-05-26 — the prewarm path itself was removed
            // (nanoclaw/container/agent-runner/src/poll-loop.ts), so the
            // container no longer writes back-mind-prewarmed detail rows.
            // Emit detail.row-received for browser tool-card rendering.
            // Skip token-delta (too noisy); reasoning-streamed IS forwarded
            // — it's intentionally the model-thinking firehose.
            if (parsed.type !== 'token-delta') {
              // PAT: server-side categorize Bash commands so every
              // consumer (pat-web tool banners, dashboard timeline,
              // future Slack tooling) renders the same friendly label
              // without re-parsing. Only present when the command
              // matched one of the known patterns in bash-parse.ts.
              let parsedCommand:
                | { type: string; salient: string }
                | undefined;
              if (parsed.tool === 'Bash' && typeof parsed.input?.command === 'string') {
                const r = parseBashCommand(parsed.input.command);
                if (r) parsedCommand = r;
              }
              this.orchestrator.host.log.event({
                kind: 'detail.row-received',
                session_id: session.sessionId,
                thread_id: session.threadId,
                platform_id: session.platformId,
                data: {
                  seq: row.seq,
                  type: parsed.type as
                    | 'tool-pre'
                    | 'tool-post'
                    | 'tool-failed'
                    | 'token-delta'
                    | 'query-start'
                    | 'query-end'
                    | 'compact'
                    | 'reasoning-streamed'
                    | 'message-block-dispatched'
                    | 'message-block-dropped',
                  tool: parsed.tool,
                  tool_use_id: parsed.toolUseId,
                  input: parsed.input,
                  result_preview: parsed.result_preview,
                  result_truncated: parsed.result_truncated,
                  result_total_chars: parsed.result_total_chars,
                  error: parsed.error,
                  text: parsed.text,
                  to: parsed.to,
                  channel_type: parsed.channel_type,
                  platform_id: parsed.platform_id,
                  body_len: parsed.body_len,
                  match: parsed.match,
                  reason: parsed.reason,
                  ...(parsedCommand
                    ? {
                        parsed_command: parsedCommand as {
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
                        },
                      }
                    : {}),
                },
              });
            }
            // query-end is the authoritative "back-mind is done"
            // signal — flip the orchestrator's processing map off.
            // query-start is NOT observed for processing on; the
            // orchestrator already flipped it true at request-layer
            // forward time (5-15s earlier during cold spawn).
            if (parsed.type === 'query-end') {
              this.orchestrator.setProcessing({
                threadKey: conversationKey(session.threadId, session.platformId),
                threadId: session.threadId,
                platformId: session.platformId,
                value: false,
              });
            }

            // Synthesize apify.run-completed from mcp__apify__* tool
            // boundaries. tool-pre → remember start ms; tool-post or
            // tool-failed → emit + clean up. We don't own Apify's
            // runtime — this is the only signal we have that an Actor
            // run finished.
            if (parsed.tool && parsed.tool.startsWith('mcp__apify__') && parsed.toolUseId) {
              if (parsed.type === 'tool-pre') {
                this.apifyStartMs.set(parsed.toolUseId, Date.now());
              } else if (parsed.type === 'tool-post' || parsed.type === 'tool-failed') {
                const startMs = this.apifyStartMs.get(parsed.toolUseId);
                this.apifyStartMs.delete(parsed.toolUseId);
                this.orchestrator.emitApifyRunCompleted({
                  sessionId: session.sessionId,
                  threadId: session.threadId,
                  platformId: session.platformId,
                  tool: parsed.tool,
                  failed: parsed.type === 'tool-failed',
                  resultPreview: parsed.result_preview,
                  error: parsed.error,
                  startMs,
                });
              }
            }

            // Surface back-mind tool failures. MCP tools land here
            // too. Apify gets its dedicated apify.run-completed AND
            // this announce path; the two events are orthogonal — one
            // is forensic-shape, the other is user-legibility.
            if (parsed.type === 'tool-failed') {
              const isMcp = parsed.tool?.startsWith('mcp__') ?? false;
              // Fire-and-forget — emitErrorSurfaced is async (model-
              // phrased spoken line). The poller can't block on it
              // without stalling the detail-row stream. The function
              // never throws (its own catch wraps the broadcast); the
              // .catch here is defense for unforeseen rejection.
              void this.orchestrator
                .emitErrorSurfaced({
                  source: isMcp ? 'back-mind-mcp' : 'back-mind-tool',
                  tool: parsed.tool,
                  errorText: parsed.error ?? '',
                  threadId: session.threadId,
                  platformId: session.platformId,
                  sessionId: session.sessionId,
                  broadcast: this.opts.broadcast,
                })
                .catch((err: unknown) =>
                  this.orchestrator.host.log.warn('emitErrorSurfaced promise rejected', { err: String(err) }),
                );
            }
          } catch {
            // unparsable detail row — skip
          }
        } else if (row.kind === 'chat') {
          // No special-case handling. The brain runs continuously off
          // event freshness; a chat row landing just means events stop
          // flowing and the brain naturally goes quiet within a tick or
          // two. (The chat row itself doesn't go through observe().)
          this.orchestrator.host.log.event({
            kind: 'chat.row-received',
            session_id: session.sessionId,
            thread_id: session.threadId,
            platform_id: session.platformId,
            data: {
              seq: row.seq,
              preview: row.content.slice(0, 200),
              full_text: row.content,
            },
          });
        }
      }
    }
  }
}
