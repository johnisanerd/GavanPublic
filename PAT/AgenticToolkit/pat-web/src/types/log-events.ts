/**
 * Local mirror of the structured log event kinds the browser dispatcher
 * cares about. Source of truth: `realtime/src/log-events.ts` in the
 * agentic_toolkit monorepo.
 *
 * We deliberately type ONLY the subset of kinds the pat-web frontend
 * reads — utterance streaming, detail rows (tool cards), request-layer
 * decisions, banter calls. Everything else lands in `PatEventUnknown`.
 *
 * The wire format is the structured-log JSON shape; see docs/log-schema.md:
 *   { ts, source, kind, level, id, thread_id?, session_id?, platform_id?, data }
 */

export interface PatEventBase {
  ts: string;
  source: string;
  kind: string;
  level?: 'info' | 'warn' | 'error' | 'fatal';
  id?: string;
  thread_id?: string | null;
  session_id?: string | null;
  platform_id?: string | null;
}

export type UtteranceSource = 'banter-ack' | 'banter-rendition' | 'banter-narration';

export interface UtteranceStreamDelta extends PatEventBase {
  kind: 'utterance.stream-delta';
  data: {
    source: UtteranceSource;
    text_delta: string;
    seq: number;
  };
}

export interface UtteranceStreamEnded extends PatEventBase {
  kind: 'utterance.stream-ended';
  data: {
    source: UtteranceSource;
    full_text: string;
    delta_count: number;
    stream_ms: number;
    first_delta_ms: number;
  };
}

export interface UtteranceStreamCancelled extends PatEventBase {
  kind: 'utterance.stream-cancelled';
  data: {
    source: UtteranceSource;
    reason: 'bargein' | 'superseded' | 'error';
    partial_text: string;
    delta_count: number;
  };
}

export type DetailRowType =
  | 'tool-pre'
  | 'tool-post'
  | 'tool-failed'
  | 'token-delta'
  | 'query-start'
  | 'query-end'
  | 'compact'
  | 'reasoning-streamed';

export interface DetailRowReceived extends PatEventBase {
  kind: 'detail.row-received';
  data: {
    seq: number;
    type: DetailRowType;
    tool?: string;
    tool_use_id?: string;
    input?: Record<string, unknown>;
    result_preview?: string;
    result_truncated?: boolean;
    result_total_chars?: number;
    error?: string;
    text?: string;
    /** Server-parsed friendly Bash description; see
     *  `realtime/src/bash-parse.ts`. Optional. */
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

export interface BanterCalled extends PatEventBase {
  kind: 'banter.called';
  data: {
    user_text: string;
    response_text: string | null;
    intentionally_silent: boolean;
    failed: boolean;
  };
}

export interface RequestLayerDecided extends PatEventBase {
  kind: 'request-layer.decided';
  data: {
    decision: 'forward' | 'noop' | 'silent';
    invoke_text?: string;
    clarify_hint?: string;
    reason: string;
    is_processing: boolean;
  };
}

export interface SttUserSaid extends PatEventBase {
  kind: 'stt.user-said';
  data: {
    text: string;
  };
}

export interface PatEventUnknown extends PatEventBase {
  data: Record<string, unknown>;
}

export type PatEvent =
  | UtteranceStreamDelta
  | UtteranceStreamEnded
  | UtteranceStreamCancelled
  | DetailRowReceived
  | BanterCalled
  | RequestLayerDecided
  | SttUserSaid
  | PatEventUnknown;
