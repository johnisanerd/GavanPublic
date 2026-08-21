"""Path A WS protocol probe — exercises the wire contract main
speaks against a hosted Cartesia agent harness without needing a real
Cartesia connection.

Cartesia's hosted-agent harness opens a WS to our voice-transport,
sends `StartInput` first, then a stream of `InputMessage` variants
(transcription, user_state, dtmf, ...). We respond with `MessageOutput`
JSON frames whenever nanoclaw's SSE stream emits utterance deltas.

The protocol is documented in `line._harness_types` (we re-use those
Pydantic shapes). This test stands up `main.app` under FastAPI's
TestClient + WS support, plays the hosted-agent role, and asserts:

  - WS accept + StartInput acceptance
  - greeting MessageOutput sent on session start
  - TranscriptionInput accumulated → POST /inbound on user_state IDLE
  - UserStateInput SPEAKING → POST /barge-in
  - utterance-delta SSE → MessageOutput frames forwarded in order
  - utterance-cancel SSE → no further MessageOutput frames

We mock nanoclaw with a minimal in-process FastAPI app to capture
POSTs and feed back SSE — no real http://127.0.0.1:8765 required.

No CARTESIA_API_KEY needed; runs in the default pytest invocation.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import threading
import uuid
from queue import Empty, Queue
from typing import Any, AsyncIterator

import httpx
import pytest
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
from starlette.testclient import TestClient


def _free_port() -> int:
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class FakeNanoclaw:
    """In-process stand-in for nanoclaw. Captures inbound + barge-in
    POSTs and pushes SSE events to subscribers."""

    def __init__(self) -> None:
        self.app = FastAPI()
        self.inbound_calls: list[dict] = []
        self.bargein_calls: list[dict] = []
        self.call_ended_calls: list[dict] = []
        self.log_events: list[dict] = []
        self._sse_queues: list[asyncio.Queue] = []
        self._loop: asyncio.AbstractEventLoop | None = None

        @self.app.post("/inbound")
        async def inbound(req: Request) -> dict:
            self.inbound_calls.append(await req.json())
            return {"ok": True}

        @self.app.post("/barge-in")
        async def bargein(req: Request) -> dict:
            self.bargein_calls.append(await req.json())
            return {"ok": True}

        @self.app.post("/call-ended")
        async def call_ended(req: Request) -> dict:
            self.call_ended_calls.append(await req.json())
            return {"ok": True}

        @self.app.post("/admin/log-event")
        async def log_event(req: Request) -> dict:
            self.log_events.append(await req.json())
            return {"ok": True}

        @self.app.get("/outbound")
        async def outbound() -> StreamingResponse:
            q: asyncio.Queue = asyncio.Queue()
            self._sse_queues.append(q)
            self._loop = asyncio.get_running_loop()

            async def stream() -> AsyncIterator[bytes]:
                try:
                    while True:
                        item = await q.get()
                        if item is None:
                            return
                        kind, payload = item
                        yield f"event: {kind}\ndata: {json.dumps(payload)}\n\n".encode()
                except asyncio.CancelledError:
                    return

            return StreamingResponse(stream(), media_type="text/event-stream")

    def push_sse(self, kind: str, content: dict) -> None:
        """Push an SSE event to ALL active subscribers."""
        payload = {"kind": kind, "content": content}
        for q in list(self._sse_queues):
            if self._loop is not None:
                asyncio.run_coroutine_threadsafe(q.put((kind, payload)), self._loop)


class UvicornServerThread:
    """Run a uvicorn server in a background thread for WS test harness."""

    def __init__(self, app: Any, port: int) -> None:
        cfg = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", access_log=False)
        self.server = uvicorn.Server(cfg)
        self.thread = threading.Thread(target=self.server.run, daemon=True)

    def start(self) -> None:
        self.thread.start()
        # Wait for ready
        import time as _t
        for _ in range(50):
            if self.server.started:
                return
            _t.sleep(0.1)
        raise RuntimeError("uvicorn server did not start")

    def stop(self) -> None:
        self.server.should_exit = True
        self.thread.join(timeout=5)


@pytest.fixture
def fake_nanoclaw() -> FakeNanoclaw:
    return FakeNanoclaw()


@pytest.fixture
def nanoclaw_server(fake_nanoclaw, monkeypatch):
    port = _free_port()
    srv = UvicornServerThread(fake_nanoclaw.app, port)
    srv.start()
    base_url = f"http://127.0.0.1:{port}"
    # main reads REALTIME_BASE_URL at import time — set BEFORE
    # importing main in tests.
    monkeypatch.setenv("REALTIME_BASE_URL", base_url)
    yield base_url
    srv.stop()


def _start_input_frame() -> dict:
    """Mimics the StartInput shape from line._harness_types."""
    return {
        "type": "start",
        "call_id": "test-call-001",
        "from": "+15555550100",
        "to": "+15550100000",
        "agent_call_id": "agent-call-001",
        "agent": {"id": "test-agent"},
        "metadata": {},
    }


# PAT: deterministic session thread_id so tests can tag pushed SSE events with
# the session's real thread_id — _on_sse drops events whose thread_id belongs to
# a different call (cross-call audio-leak fix).
_FIXED_THREAD_ID = "call-abcdef012345"


def _import_path_a_fresh(monkeypatch):
    """Reload main so REALTIME_BASE_URL env var picks up.
    Returns the module."""
    import importlib
    import sys

    if "main" in sys.modules:
        del sys.modules["main"]
    main = importlib.import_module("main")
    monkeypatch.setattr(
        main.uuid, "uuid4", lambda: uuid.UUID("abcdef01-2345-6789-abcd-ef0123456789")
    )
    return main


def test_start_input_accepted_and_greeting_sent(fake_nanoclaw, nanoclaw_server, monkeypatch):
    """Open WS, send StartInput, expect greeting MessageOutput."""
    main = _import_path_a_fresh(monkeypatch)
    with TestClient(main.app) as client:
        with client.websocket_connect("/v1/calls/ws") as ws:
            ws.send_json(_start_input_frame())
            # First frame back should be the greeting MessageOutput.
            msg = ws.receive_json()
            assert msg["type"] == "message", f"expected MessageOutput, got: {msg}"
            assert "Pat" in msg["content"] or len(msg["content"]) > 0
            assert msg["interruptible"] is True


def test_transcription_then_idle_posts_to_inbound(fake_nanoclaw, nanoclaw_server, monkeypatch):
    """User says something + UserStateInput=idle → POST /inbound."""
    main = _import_path_a_fresh(monkeypatch)
    with TestClient(main.app) as client:
        with client.websocket_connect("/v1/calls/ws") as ws:
            ws.send_json(_start_input_frame())
            ws.receive_json()  # greeting

            ws.send_json({"type": "message", "content": "hello pat"})
            ws.send_json({"type": "user_state", "value": "idle"})

            # Wait for the POST /inbound to land.
            import time as _t
            for _ in range(50):
                if fake_nanoclaw.inbound_calls:
                    break
                _t.sleep(0.05)

    assert len(fake_nanoclaw.inbound_calls) == 1, fake_nanoclaw.inbound_calls
    payload = fake_nanoclaw.inbound_calls[0]
    assert payload["text"].strip() == "hello pat"
    assert payload["sender"] == "realtime-user"
    assert payload["thread_id"].startswith("call-")
    assert payload["caller_number"] == "+15555550100"


def test_user_speaking_state_posts_bargein(fake_nanoclaw, nanoclaw_server, monkeypatch):
    """UserStateInput=speaking → POST /barge-in."""
    main = _import_path_a_fresh(monkeypatch)
    with TestClient(main.app) as client:
        with client.websocket_connect("/v1/calls/ws") as ws:
            ws.send_json(_start_input_frame())
            ws.receive_json()  # greeting
            ws.send_json({"type": "user_state", "value": "speaking"})
            import time as _t
            for _ in range(50):
                if fake_nanoclaw.bargein_calls:
                    break
                _t.sleep(0.05)

    assert len(fake_nanoclaw.bargein_calls) == 1
    payload = fake_nanoclaw.bargein_calls[0]
    assert payload["thread_id"].startswith("call-")
    assert payload["reason"] == "user-started-speaking"


def test_utterance_delta_sse_forwards_to_ws(fake_nanoclaw, nanoclaw_server, monkeypatch):
    """SSE utterance-delta → MessageOutput frame on WS, in delta order."""
    main = _import_path_a_fresh(monkeypatch)
    with TestClient(main.app) as client:
        with client.websocket_connect("/v1/calls/ws") as ws:
            ws.send_json(_start_input_frame())
            ws.receive_json()  # greeting

            # Give the SSE consumer a beat to subscribe.
            import time as _t
            _t.sleep(0.3)

            deltas = ["yeah", ", ", "lemme ", "work that out."]
            for d in deltas:
                fake_nanoclaw.push_sse(
                    "utterance-delta",
                    {"thread_id": _FIXED_THREAD_ID, "source": "banter-ack", "text_delta": d},
                )

            received: list[str] = []
            for _ in range(len(deltas)):
                msg = ws.receive_json()
                assert msg["type"] == "message"
                received.append(msg["content"])

            assert received == deltas, f"order/content mismatch: {received}"


def test_sse_drops_events_for_other_calls(fake_nanoclaw, nanoclaw_server, monkeypatch):
    """_on_sse must drop utterance events whose thread_id belongs to a DIFFERENT
    call — nanoclaw broadcasts every call's events to all SSE subscribers, so
    without the filter two concurrent callers hear each other (cross-call leak)."""
    main = _import_path_a_fresh(monkeypatch)
    with TestClient(main.app) as client:
        with client.websocket_connect("/v1/calls/ws") as ws:
            ws.send_json(_start_input_frame())
            ws.receive_json()  # greeting

            import time as _t

            _t.sleep(0.3)

            # A delta tagged for a DIFFERENT call must not reach this WS...
            fake_nanoclaw.push_sse(
                "utterance-delta",
                {"thread_id": "call-someone-else", "source": "banter-ack", "text_delta": "not for you"},
            )
            # ...while a matching-thread delta must still be forwarded.
            fake_nanoclaw.push_sse(
                "utterance-delta",
                {"thread_id": _FIXED_THREAD_ID, "source": "banter-ack", "text_delta": "for you"},
            )
            msg = ws.receive_json()
            assert msg["type"] == "message"
            assert msg["content"] == "for you", f"leaked a foreign-call delta: {msg}"


def test_utterance_cancel_sse_emits_log_event(fake_nanoclaw, nanoclaw_server, monkeypatch):
    """utterance-cancel SSE → structured log event 'cartesia.task-cancelled'.

    Path A doesn't need to send anything to Cartesia on cancel —
    voice-transport already POSTed /barge-in earlier, and Cartesia
    drives TTS-stop locally via its STT UserSpeakingStarted hook.
    The log-event emission is the observable side-effect we can
    assert on.
    """
    main = _import_path_a_fresh(monkeypatch)
    with TestClient(main.app) as client:
        with client.websocket_connect("/v1/calls/ws") as ws:
            ws.send_json(_start_input_frame())
            ws.receive_json()

            import time as _t
            _t.sleep(0.3)

            fake_nanoclaw.push_sse(
                "utterance-cancel",
                {"thread_id": _FIXED_THREAD_ID, "reason": "bargein"},
            )

            # Allow the SSE consumer + log POST to fire.
            for _ in range(50):
                if any(e.get("kind") == "cartesia.task-cancelled" for e in fake_nanoclaw.log_events):
                    break
                _t.sleep(0.05)

    cancel_events = [e for e in fake_nanoclaw.log_events if e.get("kind") == "cartesia.task-cancelled"]
    assert len(cancel_events) >= 1, f"expected cartesia.task-cancelled, got: {[e.get('kind') for e in fake_nanoclaw.log_events]}"
    assert cancel_events[0]["data"].get("reason") == "bargein"


def test_responding_to_carries_user_turn_event_id(fake_nanoclaw, nanoclaw_server, monkeypatch):
    """MessageOutput.responding_to is set to the latest UserStateInput(idle).event_id.

    Path A's TTS-prosody-grouping bet: Cartesia treats multiple
    MessageOutput frames with the same `responding_to` as one logical
    agent response, enabling cross-delta prosody. The user-turn
    event_id from the triggering UserStateInput(idle) is the grouping
    key — same pattern as the hosted-agent SDK
    (line/voice_agent_app.py:425-433).
    """
    main = _import_path_a_fresh(monkeypatch)
    with TestClient(main.app) as client:
        with client.websocket_connect("/v1/calls/ws") as ws:
            ws.send_json(_start_input_frame())
            ws.receive_json()  # greeting

            import time as _t
            _t.sleep(0.3)

            # User speaks, ends turn with event_id set.
            ws.send_json({"type": "message", "content": "hello", "event_id": "user-turn-42"})
            ws.send_json({"type": "user_state", "value": "idle", "event_id": "user-turn-42"})

            # Now push three SSE deltas for the agent's response.
            for d in ["yeah", ", ", "got it."]:
                fake_nanoclaw.push_sse(
                    "utterance-delta",
                    {"thread_id": _FIXED_THREAD_ID, "source": "banter-ack", "text_delta": d},
                )

            # Every MessageOutput should carry responding_to="user-turn-42".
            received: list[dict] = []
            for _ in range(3):
                received.append(ws.receive_json())

    for msg in received:
        assert msg["type"] == "message"
        assert msg["responding_to"] == "user-turn-42", (
            f"expected responding_to='user-turn-42', got: {msg!r}"
        )


def test_responding_to_clears_on_barge_in(fake_nanoclaw, nanoclaw_server, monkeypatch):
    """UserStateInput(speaking) supersedes the in-flight turn — the
    NEXT idle (with a fresh event_id) should be the grouping key,
    never re-using the previous turn's id."""
    main = _import_path_a_fresh(monkeypatch)
    with TestClient(main.app) as client:
        with client.websocket_connect("/v1/calls/ws") as ws:
            ws.send_json(_start_input_frame())
            ws.receive_json()  # greeting
            import time as _t
            _t.sleep(0.3)

            # First turn — event_id A.
            ws.send_json({"type": "message", "content": "first", "event_id": "turn-A"})
            ws.send_json({"type": "user_state", "value": "idle", "event_id": "turn-A"})
            # Wait for the first /inbound to land so we know turn-A was
            # processed before barge-in.
            for _ in range(50):
                if len(fake_nanoclaw.inbound_calls) >= 1:
                    break
                _t.sleep(0.05)
            assert len(fake_nanoclaw.inbound_calls) >= 1, "first turn never POSTed /inbound"

            # User barges in on the in-flight agent response.
            ws.send_json({"type": "user_state", "value": "speaking", "event_id": "turn-B-speaking"})
            for _ in range(50):
                if len(fake_nanoclaw.bargein_calls) >= 1:
                    break
                _t.sleep(0.05)
            assert len(fake_nanoclaw.bargein_calls) >= 1, "barge-in never POSTed /barge-in"

            # New turn — event_id B.
            ws.send_json({"type": "message", "content": "actually", "event_id": "turn-B"})
            ws.send_json({"type": "user_state", "value": "idle", "event_id": "turn-B"})
            for _ in range(50):
                if len(fake_nanoclaw.inbound_calls) >= 2:
                    break
                _t.sleep(0.05)
            assert len(fake_nanoclaw.inbound_calls) >= 2, "second turn never POSTed /inbound"

            # Delta on the SSE side now — should be tagged with turn-B.
            fake_nanoclaw.push_sse(
                "utterance-delta",
                {"thread_id": _FIXED_THREAD_ID, "source": "banter-ack", "text_delta": "ok"},
            )
            msg = ws.receive_json()

    assert msg["type"] == "message"
    assert msg["responding_to"] == "turn-B", (
        f"expected fresh turn-B group, got: {msg!r}"
    )


def test_greeting_has_no_responding_to(fake_nanoclaw, nanoclaw_server, monkeypatch):
    """The session-start greeting predates any user turn, so it has
    no responding_to to inherit. Verifies the initial state is None,
    not a stale value from a prior session."""
    main = _import_path_a_fresh(monkeypatch)
    with TestClient(main.app) as client:
        with client.websocket_connect("/v1/calls/ws") as ws:
            ws.send_json(_start_input_frame())
            greeting = ws.receive_json()
    assert greeting["type"] == "message"
    assert greeting.get("responding_to") is None, (
        f"greeting should have no responding_to, got: {greeting!r}"
    )


def test_dtmf_input_does_not_crash_session(fake_nanoclaw, nanoclaw_server, monkeypatch):
    """DTMF input is observability-only; session must not abort.

    Reach back to the greeting receive after sending DTMF to prove
    the session is still alive.
    """
    main = _import_path_a_fresh(monkeypatch)
    with TestClient(main.app) as client:
        with client.websocket_connect("/v1/calls/ws") as ws:
            ws.send_json(_start_input_frame())
            ws.receive_json()
            ws.send_json({"type": "dtmf", "button": "1"})

            # SSE delta arrives after DTMF — proves the session
            # is alive and pumping outbound.
            import time as _t
            _t.sleep(0.3)
            fake_nanoclaw.push_sse(
                "utterance-delta",
                {"thread_id": _FIXED_THREAD_ID, "source": "banter-ack", "text_delta": "ok"},
            )
            msg = ws.receive_json()
            assert msg["type"] == "message"
            assert msg["content"] == "ok"


def _wait_for_log_event(fake_nanoclaw, kind: str, timeout_s: float = 2.5) -> dict:
    """Poll fake_nanoclaw.log_events for the first event of `kind`."""
    import time as _t

    deadline = _t.time() + timeout_s
    while _t.time() < deadline:
        for ev in fake_nanoclaw.log_events:
            if ev.get("kind") == kind:
                return ev
        _t.sleep(0.02)
    raise AssertionError(
        f"no {kind!r} log event; saw: {[e.get('kind') for e in fake_nanoclaw.log_events]}"
    )


def test_agent_state_speaking_emits_turn_boundary(fake_nanoclaw, nanoclaw_server, monkeypatch):
    """PAT: AgentStateInput(value=speaking) → cartesia.agent-turn-boundary
    edge=start. This is the 'Cartesia actually started TTS' signal that
    was missing during the no-audio incident."""
    main = _import_path_a_fresh(monkeypatch)
    with TestClient(main.app) as client:
        with client.websocket_connect("/v1/calls/ws") as ws:
            ws.send_json(_start_input_frame())
            ws.receive_json()  # greeting
            ws.send_json({"type": "agent_state", "value": "speaking"})
            ws.send_json({"type": "agent_state", "value": "idle"})

    starts = [
        e for e in fake_nanoclaw.log_events
        if e.get("kind") == "cartesia.agent-turn-boundary"
        and e["data"].get("edge") == "start"
    ]
    stops = [
        e for e in fake_nanoclaw.log_events
        if e.get("kind") == "cartesia.agent-turn-boundary"
        and e["data"].get("edge") == "stop"
    ]
    assert len(starts) >= 1, "expected edge=start from agent_state speaking"
    assert len(stops) >= 1, "expected edge=stop from agent_state idle"


def test_agent_speech_emits_agent_text_sent(fake_nanoclaw, nanoclaw_server, monkeypatch):
    """PAT: AgentSpeechInput → cartesia.agent-text-sent — confirms the
    text Cartesia reports it is actually speaking."""
    main = _import_path_a_fresh(monkeypatch)
    with TestClient(main.app) as client:
        with client.websocket_connect("/v1/calls/ws") as ws:
            ws.send_json(_start_input_frame())
            ws.receive_json()  # greeting
            ws.send_json({"type": "agent_speech", "content": "hey there"})

    ev = _wait_for_log_event(fake_nanoclaw, "cartesia.agent-text-sent")
    assert ev["data"]["text"] == "hey there"


def test_validation_error_emits_warn_event(fake_nanoclaw, nanoclaw_server, monkeypatch):
    """PAT: ValidationErrorInput → cartesia.validation-error at level=warn.
    THE smoking gun if Cartesia rejects a frame we send."""
    main = _import_path_a_fresh(monkeypatch)
    with TestClient(main.app) as client:
        with client.websocket_connect("/v1/calls/ws") as ws:
            ws.send_json(_start_input_frame())
            ws.receive_json()  # greeting
            ws.send_json(
                {
                    "type": "validation_error",
                    "error_type": "invalid_message",
                    "error_message": "responding_to references unknown event",
                }
            )

    ev = _wait_for_log_event(fake_nanoclaw, "cartesia.validation-error")
    assert ev["level"] == "warn"
    assert ev["data"]["error_type"] == "invalid_message"
    assert ev["data"]["error_message"] == "responding_to references unknown event"
