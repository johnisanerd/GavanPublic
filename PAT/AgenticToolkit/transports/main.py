"""
Cartesia voice-transport — thin WS forwarder for the pat-transports
cartesia process group.

Implements `plans/streaming-banter-pipeline.md` Stage 3. We accept the
Cartesia hosted-agent WebSocket and forward to nanoclaw's HTTP+SSE
surface directly, without the Cartesia Line SDK's `AgentClass` /
`process()` / `run_filter` / `cancel_filter` turn abstraction. We still
speak the same JSON wire protocol Cartesia expects (StartInput,
TranscriptionInput, UserStateInput, MessageOutput, etc.) — we just
don't wrap it in a turn-shaped iterator.

Architectural properties:
  - No 90s BACK_MIND_TIMEOUT. No turn-drain dance. No `process()` at
    all to drain from.
  - Streaming utterance support: `utterance-delta` SSE events from
    nanoclaw → one `MessageOutput` WS frame per delta, all tagged
    with the SAME `responding_to` (= the user-turn `event_id` from
    the preceding `UserStateInput(idle)`). This matches Cartesia's
    hosted-agent SDK pattern (line/voice_agent_app.py:425-433) where
    all outputs from a single agent invocation share one
    `responding_to`; the server uses it for cancel correlation +
    multi-frame agent-response grouping. Cartesia handles
    server-side TTS prosody across the deltas inside that group.
  - Cancel propagation goes direct: STT user-started-speaking
    fires here → we POST /barge-in to nanoclaw immediately. No SDK
    `cancel_filter` middleman.

Env:
  REALTIME_BASE_URL   default http://127.0.0.1:8765
  ANTHROPIC_API_KEY   not used here (we don't call Claude)
  PORT                FastAPI listens here (default 8000)

Wire protocol (from line._harness_types):
  - Server (us) accepts WS at `/v1/calls/ws` (configurable via
    VOICE_TRANSPORT_WS_PATH).
  - First message from Cartesia: `start_data` (StartInput) — JSON dict
    with `call_id`, `from_`, `to`, `agent_call_id`, `agent`, `metadata`.
  - Subsequent messages from Cartesia: InputMessage union (transcription,
    user_state, agent_state, dtmf, validation_error, custom).
  - We send back OutputMessage union (message, dtmf, end_call,
    tool_call, log_event, update_call) as separate JSON frames.
"""
from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import sys
import time as _time
import uuid
from contextlib import suppress
from typing import Optional

# Force UTC pre-import to keep all log timestamps consistent.
os.environ["TZ"] = "UTC"
_time.tzset()

import httpx
import httpx_sse
import uvicorn
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect

# Reuse the Pydantic shape definitions from the Line SDK rather than
# duplicating them — we're not using AgentClass, but the wire-protocol
# types are public and stable.
from line._harness_types import (  # type: ignore
    # PAT: AgentSpeechInput / AgentStateInput / ValidationErrorInput added
    # for the Cartesia→transport observability hop (see _handle_input).
    # These were previously dropped silently in the fall-through; logging
    # them is what makes a "caller hears no TTS" incident diagnosable.
    AgentSpeechInput,
    AgentStateInput,
    DTMFInput,
    InputMessage,
    MessageOutput,
    TranscriptionInput,
    UserStateInput,
    ValidationErrorInput,
)
from line.voice_agent_app import CARTESIA_VERSION  # type: ignore
from pydantic import TypeAdapter


REALTIME_BASE_URL = os.getenv("REALTIME_BASE_URL", "http://127.0.0.1:8765")
WS_PATH = os.getenv("VOICE_TRANSPORT_WS_PATH", "/v1/calls/ws")

# PAT 2026-07-06: smoke-caller pre-auth. Cartesia's WS streaming API drops a
# client-set top-level `from` (verified 2026-07-04: WS callers always arrive
# as from="websocket"), but the start event's `metadata` object IS passed
# through to the agent's start message (docs.cartesia.ai/line/integrations/
# websocket-api — "These will be passed through to the agent code"). The smoke
# harness sends `metadata.smoke_preauth = <shared secret>`; when it matches
# SMOKE_PREAUTH_TOKEN we present the caller as SMOKE_CALLER_E164 — a
# SERVER-side value, never anything the client claims — so nanoclaw mints
# `pstn:<E164>` and the smoke call exercises the real people-spine admission
# path (auto-enroll → auto-approve for the linked person). Either env var
# unset ⇒ feature inert; tokenless WS callers stay "websocket".
SMOKE_PREAUTH_TOKEN = os.getenv("SMOKE_PREAUTH_TOKEN", "")
SMOKE_CALLER_E164 = os.getenv("SMOKE_CALLER_E164", "")


# ─────────────────────── Logging (UTC + structured) ───────────────────

logging.Formatter.converter = _time.gmtime
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s.%(msecs)03dZ %(levelname)s %(name)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
    force=True,
)
log = logging.getLogger("voice_transport.path_a")

_FORWARD_HTTP = httpx.Client(timeout=httpx.Timeout(connect=0.5, read=0.5, write=0.5, pool=0.5))

_PROCESS_START_MS = int(_time.time() * 1000)
_event_counter = 0


def _next_event_id() -> str:
    global _event_counter
    _event_counter += 1
    return f"vtA-{_PROCESS_START_MS}-{_event_counter}"


# Emit tasks are tracked module-level (GC guard) and deliberately NOT tied to
# a session's _bg_tasks: teardown cancels those to stop late /inbound posts,
# but a pending LOG emit at hangup is harmless and should still deliver.
_EMIT_TASKS: set = set()


async def _post_event_async(payload: dict) -> None:
    """Deliver one structured event via the shared async client. Never raises."""
    try:
        await _async_http.post(f"{REALTIME_BASE_URL}/admin/log-event", json=payload)
    except Exception:
        pass


def _emit_structured(
    kind: str,
    data: dict,
    *,
    thread_id: Optional[str] = None,
    platform_id: Optional[str] = None,
    level: str = "info",
) -> None:
    """Structured-event helper — events land in nanoclaw's unified host JSONL.

    Delivery must never block the event loop (this runs per TTS delta and per
    transcription chunk, and a stall here freezes ALL calls' audio + barge-in):
    with a running loop, fire-and-forget on the shared async client; the sync
    client is only the no-loop fallback (startup/shutdown contexts)."""
    try:
        payload: dict = {
            "source": "voice-transport",
            "id": _next_event_id(),
            "kind": kind,
            "level": level,
            "data": data,
        }
        if thread_id:
            payload["thread_id"] = thread_id
        if platform_id:
            payload["platform_id"] = platform_id
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        if loop is not None:
            task = loop.create_task(_post_event_async(payload))
            _EMIT_TASKS.add(task)
            task.add_done_callback(_EMIT_TASKS.discard)
        else:
            _FORWARD_HTTP.post(f"{REALTIME_BASE_URL}/admin/log-event", json=payload)
    except Exception:
        pass


# ─────────────────────── Async HTTP + SSE client ──────────────────────

_async_http = httpx.AsyncClient(
    timeout=httpx.Timeout(connect=5.0, read=None, write=5.0, pool=5.0),
)


async def _post_inbound(text: str, thread_id: str, caller_number: Optional[str]) -> None:
    """Fire-and-forget POST to nanoclaw /inbound. Per Path A this is the
    ONLY thing that needs to happen on a user turn end — no waiting,
    no blocking. Errors are logged, never raised."""
    payload: dict = {"text": text, "sender": "realtime-user", "thread_id": thread_id}
    if caller_number:
        payload["caller_number"] = caller_number
    try:
        r = await _async_http.post(
            f"{REALTIME_BASE_URL}/inbound",
            json=payload,
            # PAT: finite read timeout — the shared client is read=None, and now
            # that this runs off the WS read loop a hung host must not leak a
            # background task forever. Generous (the host may spawn a container).
            timeout=httpx.Timeout(connect=5.0, read=30.0, write=5.0, pool=5.0),
        )
        r.raise_for_status()
    except Exception as exc:
        log.warning("POST /inbound failed: %s", exc)


async def _post_barge_in(thread_id: str, reason: str = "user-started-speaking") -> None:
    """POST /barge-in to nanoclaw. Path A direct cancel propagation —
    no SDK cancel_filter middleman."""
    try:
        r = await _async_http.post(
            f"{REALTIME_BASE_URL}/barge-in",
            json={"thread_id": thread_id, "reason": reason},
            timeout=httpx.Timeout(connect=2.0, read=2.0, write=2.0, pool=2.0),
        )
        r.raise_for_status()
    except Exception as exc:
        log.warning("POST /barge-in failed: %s", exc)


async def _post_call_ended(thread_id: str) -> None:
    try:
        r = await _async_http.post(
            f"{REALTIME_BASE_URL}/call-ended",
            json={"thread_id": thread_id},
            timeout=httpx.Timeout(connect=2.0, read=2.0, write=2.0, pool=2.0),
        )
        r.raise_for_status()
    except Exception as exc:
        log.warning("POST /call-ended failed: %s", exc)


_input_message_adapter = TypeAdapter(InputMessage)


# ─────────────────────── Per-call session ─────────────────────────────


class CallSession:
    """Owns one Cartesia WebSocket connection's lifetime. Spawned per
    accepted WS by FastAPI. Two concurrent async tasks:
      1. `inbound_loop`: reads Cartesia → InputMessage events → POSTs
         /inbound or /barge-in to nanoclaw, never blocks on response.
      2. `outbound_loop`: opens SSE to nanoclaw /outbound, receives
         utterance-delta / utterance-end / utterance-cancel events,
         sends MessageOutput JSON frames back over the WS.
    Cancellation of one task cancels the other; WS close ends both."""

    def __init__(self, websocket: WebSocket, call_request: dict) -> None:
        self.ws = websocket
        self.call_request = call_request
        self.thread_id = f"call-{uuid.uuid4().hex[:12]}"
        # Cartesia's StartInput uses the JSON key `from` (aliased from
        # `from_` in Python — `from` is a reserved word). Accept both
        # to tolerate any client that sends the Python-side name.
        self.caller_number: Optional[str] = (
            call_request.get("from") or call_request.get("from_") or None
        )
        # PAT 2026-07-06: smoke pre-auth — see SMOKE_PREAUTH_TOKEN above.
        # Constant-time compare; the mapped number comes from OUR env, so a
        # valid token grants exactly one server-chosen identity and nothing
        # else. A present-but-wrong token is logged and ignored (caller stays
        # whatever Cartesia said, i.e. "websocket" for WS calls).
        md = call_request.get("metadata")
        client_token = md.get("smoke_preauth") if isinstance(md, dict) else None
        self.smoke_preauth = bool(
            SMOKE_PREAUTH_TOKEN
            and SMOKE_CALLER_E164
            and isinstance(client_token, str)
            and hmac.compare_digest(client_token, SMOKE_PREAUTH_TOKEN)
        )
        if self.smoke_preauth:
            self.caller_number = SMOKE_CALLER_E164
        elif client_token is not None:
            log.warning(
                "smoke_preauth token rejected (mismatch or feature disabled); caller stays %r",
                self.caller_number,
            )
        # Current user-turn's event_id. Set when Cartesia sends
        # UserStateInput(value="idle", event_id=...) — i.e. end-of-user-turn.
        # All MessageOutput frames emitted in response to that turn carry
        # this as `responding_to` so Cartesia treats them as one logical
        # agent response (multi-delta TTS prosody grouping + cancel
        # correlation). Mirrors line/voice_agent_app.py:425-433 — the
        # SDK's own pattern.
        # Cleared on UserTurnStarted (next barge-in) so a fresh turn
        # gets a fresh group.
        self.current_utterance_responding_to: Optional[str] = None
        # Accumulator for TranscriptionInput chunks; flushed on
        # UserStateInput(idle) → POST /inbound. Explicit None signals
        # "no buffer yet" but `""` is the active default.
        self._buffer: str = ""
        # PAT: monotonic ts of the last user-turn start (UserStateInput
        # "speaking"). Powers the `stt.empty-turn` signature — an idle that
        # closes a turn with an EMPTY buffer, i.e. Cartesia opened a user
        # turn and never delivered a transcript for it (the endpointer-
        # starvation drop, KNOWN_ISSUES 2026-07-04).
        self._turn_started_mono: Optional[float] = None
        # SSE consumer task — owns the long-lived /outbound subscription.
        self._sse_task: Optional[asyncio.Task] = None
        # PAT: fire-and-forget /inbound posts live here so the WS read loop
        # never blocks on the host round-trip (see _handle_input). Tracked so
        # they aren't garbage-collected mid-flight.
        self._bg_tasks: set[asyncio.Task] = set()
        self._send_lock = asyncio.Lock()
        self._closed = False

    def _spawn_bg(self, coro) -> None:
        """Fire-and-forget a coroutine, keeping a reference so it isn't garbage-
        collected mid-flight; the coro does its own error logging."""
        task = asyncio.create_task(coro)
        self._bg_tasks.add(task)
        task.add_done_callback(self._bg_tasks.discard)

    def _emit(self, kind: str, data: dict, *, level: str = "info") -> None:
        """Session-bound structured emit — always stamps THIS call's
        thread_id/platform_id. Never emit unbound from inside a session:
        attribution must survive concurrent calls."""
        self._emit(
            kind,
            data,
            thread_id=self.thread_id,
            platform_id=self.caller_number,
            level=level,
        )

    async def run(self) -> None:
        self._emit("call.started", {})
        # Keys only for start_data/metadata — metadata values can carry the
        # pre-auth secret. This line doubles as the permanent empirical record
        # of what Cartesia actually relays in the start message (pat_raw).
        md = self.call_request.get("metadata")
        log.info(
            "Path A call started: thread_id=%s caller=%s smoke_preauth=%s start_keys=%s metadata_keys=%s",
            self.thread_id,
            self.caller_number,
            self.smoke_preauth,
            sorted(self.call_request.keys()),
            sorted(md.keys()) if isinstance(md, dict) else md,
        )

        # Start the SSE consumer in the background.
        self._sse_task = asyncio.create_task(self._outbound_loop())

        # Immediate greeting (mirrors main.py's CallStarted yield).
        greeting = "Hey, you've got Pat. What's up?"
        await self._send_message_output(greeting, interruptible=True)
        self._emit("tts.agent-said", {"text": greeting, "source": "queued"})

        try:
            await self._inbound_loop()
        finally:
            self._closed = True
            # PAT: never DISCARD user speech silently. If Cartesia delivered
            # transcription that was still buffered (turn never finalized)
            # when the call ended, record it — observability only, no
            # /inbound post (the call is over; waking the agent now would
            # just produce an undeliverable reply).
            leftover = self._buffer.strip()
            if leftover:
                self._emit(
                    "stt.discarded-on-teardown",
                    {"text": leftover[:500]},
                    level="warn",
                )
                log.warning("call ended with undelivered user speech: %r", leftover[:200])
            if self._sse_task and not self._sse_task.done():
                self._sse_task.cancel()
                with suppress(asyncio.CancelledError):
                    await self._sse_task
            # PAT: cancel any in-flight fire-and-forget /inbound posts before we
            # tell nanoclaw the call ended — otherwise a late post (up to the
            # read timeout) could wake the front-mind/container for a dead call
            # and produce an undeliverable reply.
            for _t in list(self._bg_tasks):
                if not _t.done():
                    _t.cancel()
            for _t in list(self._bg_tasks):
                with suppress(asyncio.CancelledError):
                    await _t
            await _post_call_ended(self.thread_id)
            self._emit("call.ended", {})
            log.info("Path A call ended: thread_id=%s", self.thread_id)

    async def _inbound_loop(self) -> None:
        """Pump Cartesia → us. Parses each JSON message and dispatches
        on InputMessage union variants."""
        while not self._closed:
            try:
                raw = await self.ws.receive_text()
            except WebSocketDisconnect:
                log.info("Cartesia WS disconnected: thread_id=%s", self.thread_id)
                return
            except RuntimeError:
                # FastAPI raises if we try to receive after disconnect
                return
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                log.warning("non-JSON WS frame: %r", raw[:120])
                continue
            try:
                msg = _input_message_adapter.validate_python(data)
            except Exception as exc:
                log.warning("InputMessage validation failed: %s data=%r", exc, data)
                continue
            await self._handle_input(msg)

    async def _handle_input(self, msg: InputMessage) -> None:
        # Transcription chunks accumulate; we forward on user_state IDLE
        # (= turn end) per Cartesia's protocol.
        if isinstance(msg, TranscriptionInput):
            self._emit("cartesia.user-text-sent", {"text": msg.content})
            # Buffer is kept implicitly — Cartesia's protocol uses
            # a separate `agent_speech` for partial vs final. For our
            # purposes we re-buffer per-turn and flush on user_state.
            self._buffer = (self._buffer + " " + msg.content) if self._buffer else msg.content
            return

        if isinstance(msg, UserStateInput):
            value = msg.value  # "speaking" or "idle"
            self._emit(
                "cartesia.user-turn-boundary",
                {"edge": "start" if value == "speaking" else "stop"},
            )
            if value == "speaking":
                self._turn_started_mono = _time.monotonic()
                # Path A: barge-in detection is DIRECT — no cancel_filter.
                # We immediately POST /barge-in so nanoclaw aborts any
                # in-flight streaming Haiku calls + kills the back-mind
                # container if it's processing.
                self._emit(
                    "bargein.received",
                    {"reason": "user-started-speaking"},
                )
                # The barge-in supersedes any in-flight agent response.
                # Drop the responding_to so the user's NEXT idle (which
                # also stamps a fresh event_id) starts a clean group —
                # never reuse the previous turn's id for what is logically
                # a new turn.
                self.current_utterance_responding_to = None
                await _post_barge_in(self.thread_id)
            elif value == "idle":
                # End of user turn — flush buffer and POST to nanoclaw.
                # Capture the user-turn event_id (if Cartesia provided one)
                # so every MessageOutput emitted in response carries it as
                # responding_to. Matches line/voice_agent_app.py:425-433
                # behavior of the hosted-agent SDK.
                self.current_utterance_responding_to = msg.event_id
                full = self._buffer.strip()
                self._buffer = ""
                if full:
                    self._emit("stt.user-said", {"text": full})
                    log.info("user turn ended → POST /inbound: %r", full[:120])
                    # PAT: fire-and-forget (matches _post_inbound's docstring).
                    # Awaiting inline blocked the sole WS read task for the full
                    # host round-trip (front-mind + container wake), so the
                    # caller's barge-in frame sat unread and the agent talked
                    # over them; a hung host wedged the call entirely. Spawn it.
                    self._spawn_bg(_post_inbound(full, self.thread_id, self.caller_number))
                else:
                    # PAT: Cartesia closed a user turn WITHOUT ever delivering
                    # a transcript — the self-identifying signature of the
                    # endpointer-starvation drop (turn opened, no
                    # TranscriptionInput, idle with empty buffer). Emitting
                    # this makes the failure diagnosable from patobs alone
                    # instead of inferring it from an absence of events.
                    secs = (
                        _time.monotonic() - self._turn_started_mono
                        if self._turn_started_mono is not None
                        else None
                    )
                    self._emit(
                        "stt.empty-turn",
                        {"secs_since_turn_start": round(secs, 3) if secs is not None else None},
                        level="warn",
                    )
                    log.warning(
                        "user turn closed with EMPTY buffer (no transcription); secs_since_turn_start=%s",
                        secs,
                    )
            return

        if isinstance(msg, DTMFInput):
            self._emit("cartesia.user-dtmf", {"button": msg.button})
            return

        # PAT: AgentStateInput surfaces whether Cartesia actually started
        # TTS. value=="speaking" → Cartesia began synthesizing/playing
        # audio to the caller (SDK maps this to AgentTurnStarted); "idle"
        # → it finished (AgentTurnEnded). During the "no audio" incident
        # this transition NEVER fired despite us sending MessageOutput —
        # this event is how we'd have spotted that instantly. Emit it as
        # cartesia.agent-turn-boundary (edge=start|stop), the existing
        # schema kind that already means exactly "agent TTS turn edge".
        if isinstance(msg, AgentStateInput):
            value = msg.value  # "speaking" or "idle"
            edge = "start" if value == "speaking" else "stop"
            self._emit("cartesia.agent-turn-boundary", {"edge": edge})
            log.info("Cartesia agent-state: value=%s edge=%s", value, edge)
            return

        # PAT: AgentSpeechInput is the text Cartesia reports it is actually
        # speaking (cumulative per turn). Confirms TTS content reached the
        # caller — distinct from MessageOutput frames WE sent (which the
        # incident showed can be sent without any audio being produced).
        if isinstance(msg, AgentSpeechInput):
            self._emit("cartesia.agent-text-sent", {"text": msg.content})
            return

        # PAT: ValidationErrorInput is THE smoking gun — Cartesia rejected
        # a frame we sent (e.g. a malformed MessageOutput), which would
        # explain TTS silence while our send path looks healthy. Emit at
        # level=warn with the rejection detail so it stands out in the log.
        if isinstance(msg, ValidationErrorInput):
            self._emit(
                "cartesia.validation-error",
                {"error_type": msg.error_type, "error_message": msg.error_message},
                level="warn",
            )
            log.warning(
                "Cartesia validation error: type=%s msg=%s",
                msg.error_type,
                msg.error_message,
            )
            return

        # Other input kinds (CustomInput) are observability-only for
        # Path A — log and move on.
        log.debug("input msg type=%s", type(msg).__name__)

    async def _outbound_loop(self) -> None:
        """Long-lived SSE consumer. Reconnects with backoff on disconnect."""
        url = f"{REALTIME_BASE_URL}/outbound"
        backoff = 1.0
        attempt = 0
        while not self._closed:
            attempt += 1
            try:
                log.info("SSE: connecting (attempt=%d) %s", attempt, url)
                async with httpx_sse.aconnect_sse(
                    _async_http,
                    "GET",
                    url,
                    timeout=httpx.Timeout(connect=5.0, read=None, write=5.0, pool=5.0),
                ) as event_source:
                    backoff = 1.0
                    log.info("SSE: connected (attempt=%d)", attempt)
                    self._emit(
                        "transport.connected",
                        {"transport": "nanoclaw-sse", "detail": f"attempt={attempt}"},
                    )
                    async for sse in event_source.aiter_sse():
                        if self._closed:
                            return
                        await self._on_sse(sse.event, sse.data)
            except asyncio.CancelledError:
                return
            except Exception as exc:
                log.warning(
                    "SSE connection lost: %s; reconnecting in %.1fs", exc, backoff
                )
                self._emit(
                    "transport.disconnected",
                    {"transport": "nanoclaw-sse", "reason": str(exc)[:200]},
                    level="warn",
                )
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30.0)

    async def _on_sse(self, event_name: str, data: str) -> None:
        if not data:
            return
        try:
            payload = json.loads(data)
        except json.JSONDecodeError:
            log.warning("non-JSON SSE: %r", data[:120])
            return
        kind = payload.get("kind", "")
        content = payload.get("content")
        if isinstance(content, str):
            try:
                content = json.loads(content)
            except json.JSONDecodeError:
                pass

        # PAT: drop events destined for a DIFFERENT call. nanoclaw broadcasts
        # every utterance-*/realtime-utterance event to ALL connected SSE
        # clients and stamps content.thread_id; without this filter two
        # concurrent callers each heard the other's agent audio (cross-call
        # leak). Only filter events that actually carry a thread_id — some
        # control events legitimately don't.
        if isinstance(content, dict):
            evt_thread = content.get("thread_id")
            if evt_thread and evt_thread != self.thread_id:
                return

        # Path A streaming wire events from nanoclaw.
        if kind == "utterance-delta" and isinstance(content, dict):
            text_delta = content.get("text_delta") or ""
            if text_delta:
                # Each delta becomes a MessageOutput frame on the WS,
                # all tagged with the same `responding_to` (= the
                # user-turn event_id captured in _handle_input on
                # UserStateInput(idle)). Cartesia (we bet) groups
                # by `responding_to` and handles TTS prosody across
                # the deltas as one logical agent response.
                await self._send_message_output(text_delta, interruptible=True)
                self._emit(
                    "tts.agent-said",
                    {"text": text_delta, "source": "queued"},
                )
            return
        if kind == "utterance-end":
            # No turn-boundary emission — Path A is delta-streamed, no
            # SDK-side turn semantics to mirror. Cartesia infers TTS end
            # of turn from absence of further MessageOutput frames + its
            # own turn-state machine.
            return
        if kind == "utterance-cancel":
            # /barge-in flow ALREADY POSTed; Cartesia cancels TTS
            # locally via its own UserTurnStarted path. Nothing
            # additional to send here — log only.
            reason = content.get("reason") if isinstance(content, dict) else None
            self._emit("cartesia.task-cancelled", {"reason": reason or "bargein"})
            return

        # PAT 2026-07-04: host-side synthetic utterances — the caller-refusal
        # line ("Sorry, I don't recognize this number.") and routing-error
        # fallback speech ride SSE kind `realtime-utterance` (nanoclaw
        # phone-call.ts broadcastUtterance). This handler used to drop them
        # into the "skip" branch below, so a gate-refused caller heard the
        # greeting then PERMANENT DEAD AIR (KNOWN_ISSUES: inaudible refusal).
        # Speak them like any other agent output.
        if kind == "realtime-utterance" and isinstance(content, dict):
            text = content.get("text") or ""
            if text:
                await self._send_message_output(text, interruptible=True)
                self._emit("tts.agent-said", {"text": text, "source": "queued"})
            return

        # Trace and other internal kinds — silently ignore.
        log.debug("SSE: skipping kind=%s", kind)

    async def _send_message_output(self, text: str, *, interruptible: bool = True) -> None:
        """Serialize and send a MessageOutput JSON frame to Cartesia.
        Uses asyncio.Lock so concurrent _on_sse calls don't interleave
        on the WS write."""
        if self._closed:
            return
        out = MessageOutput(
            content=text,
            interruptible=interruptible,
            responding_to=self.current_utterance_responding_to,
        )
        async with self._send_lock:
            try:
                await self.ws.send_json(out.model_dump())
            except Exception as exc:
                log.warning("WS send_json failed: %s", exc)


# ─────────────────────── FastAPI app ──────────────────────────────────

fastapi_app = FastAPI()


@fastapi_app.get("/status")
async def status() -> dict:
    return {"status": "ok", "service": "voice-transport-path-a"}


@fastapi_app.post("/chats")
async def create_chat_session(request: Request) -> dict:
    # PAT: Cartesia self-hosted handshake. Cartesia POSTs /chats first,
    # expects {websocket_url, cartesia_version}, then opens WS to that URL.
    # Path A doesn't use AgentClass — this is the protocol's discovery step,
    # not Line SDK runtime restoration.
    return {
        "websocket_url": WS_PATH,
        "cartesia_version": CARTESIA_VERSION,
        "metadata": {},
    }


@fastapi_app.websocket(WS_PATH)
async def websocket_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    log.info("Path A WS connected")
    try:
        start_data = await websocket.receive_json()
    except WebSocketDisconnect:
        log.warning("WS disconnected before start_data")
        return
    except Exception as exc:
        log.error("failed to read start_data: %s", exc)
        with suppress(Exception):
            await websocket.close(code=1011)
        return

    session = CallSession(websocket, start_data)
    try:
        await session.run()
    except Exception:
        import traceback

        log.error("call session crashed:\n%s", traceback.format_exc())
    finally:
        with suppress(Exception):
            await websocket.close()


# Module-level `app` reference matching main.py's convention so
# deployment configs can switch by changing the entrypoint module
# without altering invocation. Both `app` and `fastapi_app` exported.
app = fastapi_app


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8000"))
    log.info("Starting voice-transport Path A on PORT=%s WS_PATH=%s", port, WS_PATH)
    uvicorn.run(fastapi_app, host="", port=port)
