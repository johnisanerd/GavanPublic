"""Pytest fixtures for signal-test-rig.

The strategy: stub the signal-cli daemon by running a tiny in-process TCP
server that speaks newline-delimited JSON-RPC. The fake server replies
to `subscribeReceive`, `send`, and `updateConfiguration` with sane values,
and lets the test push synthetic inbound notifications by exposing a
`push_notification(method, params)` helper.

This way every test exercises the REAL `SignalCliBridge` (no monkey-patch
of the rpc layer), the REAL FastAPI app (via TestClient), and only the
network-facing endpoint is faked. The bridge can't tell the difference.

Threading note: the fake daemon runs in its OWN dedicated thread with its
OWN asyncio loop. Why? FastAPI's TestClient runs the ASGI app on a worker
thread via anyio's blocking portal, and the bridge's `start()` (inside
FastAPI's lifespan handler) blocks the pytest-asyncio test loop until the
daemon replies. If the daemon were on the pytest-asyncio loop too, that
loop is suspended while waiting on the lifespan → daemon never accepts the
connection → deadlock.
"""
from __future__ import annotations

import asyncio
import contextlib
import importlib
import json
import socket
import threading
from dataclasses import dataclass, field
from typing import Any, Optional

import pytest


def _pick_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@dataclass
class FakeDaemon:
    """Threaded in-process JSON-RPC stub for signal-cli daemon.

    Owns its own event loop in a background thread. Synchronous control
    methods (`start`, `stop`, `push_notification`) schedule work onto that
    loop via `asyncio.run_coroutine_threadsafe`.
    """

    host: str
    port: int
    # Public assertion surface
    received_calls: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    error_for_method: dict[str, str] = field(default_factory=dict)
    handlers: dict[str, Any] = field(default_factory=dict)

    # Internals
    _loop: Optional[asyncio.AbstractEventLoop] = None
    _server: Optional[asyncio.base_events.Server] = None
    _thread: Optional[threading.Thread] = None
    _clients: list[asyncio.StreamWriter] = field(default_factory=list)
    _ready: threading.Event = field(default_factory=threading.Event)

    def start(self) -> None:
        def _runner() -> None:
            loop = asyncio.new_event_loop()
            self._loop = loop
            asyncio.set_event_loop(loop)

            async def _serve() -> None:
                self._server = await asyncio.start_server(
                    self._on_client, self.host, self.port
                )
                self._ready.set()
                async with self._server:
                    await self._server.serve_forever()

            try:
                loop.run_until_complete(_serve())
            except (asyncio.CancelledError, RuntimeError):
                pass
            finally:
                pending = asyncio.all_tasks(loop)
                for t in pending:
                    t.cancel()
                loop.run_until_complete(asyncio.sleep(0))
                loop.close()

        self._thread = threading.Thread(target=_runner, name="fake-signal-cli", daemon=True)
        self._thread.start()
        if not self._ready.wait(timeout=5):
            raise RuntimeError("FakeDaemon failed to start within 5s")

    def stop(self) -> None:
        if not self._loop:
            return
        loop = self._loop

        async def _shutdown() -> None:
            for w in list(self._clients):
                with contextlib.suppress(Exception):
                    w.close()
                    await w.wait_closed()
            self._clients.clear()
            if self._server:
                self._server.close()
                with contextlib.suppress(Exception):
                    await self._server.wait_closed()

        fut = asyncio.run_coroutine_threadsafe(_shutdown(), loop)
        with contextlib.suppress(Exception):
            fut.result(timeout=5)
        loop.call_soon_threadsafe(loop.stop)
        if self._thread:
            self._thread.join(timeout=5)
        self._loop = None
        self._thread = None
        self._server = None

    async def _on_client(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        self._clients.append(writer)
        try:
            while True:
                raw = await reader.readline()
                if not raw:
                    break
                try:
                    msg = json.loads(raw.decode("utf-8").strip())
                except json.JSONDecodeError:
                    continue
                method = msg.get("method")
                params = msg.get("params") or {}
                rpc_id = msg.get("id")
                self.received_calls.append((method, params))

                if method in self.error_for_method:
                    response = {
                        "jsonrpc": "2.0",
                        "id": rpc_id,
                        "error": {"code": -1, "message": self.error_for_method[method]},
                    }
                elif method in self.handlers:
                    result = self.handlers[method](params)
                    response = {"jsonrpc": "2.0", "id": rpc_id, "result": result}
                else:
                    if method == "subscribeReceive":
                        result: Any = 1
                    elif method == "send":
                        result = {"timestamp": 1715000000000, "results": []}
                    else:
                        result = {"ok": True}
                    response = {"jsonrpc": "2.0", "id": rpc_id, "result": result}

                writer.write((json.dumps(response) + "\n").encode("utf-8"))
                with contextlib.suppress(Exception):
                    await writer.drain()
        finally:
            if writer in self._clients:
                self._clients.remove(writer)
            with contextlib.suppress(Exception):
                writer.close()
                await writer.wait_closed()

    def push_notification(self, method: str, params: dict[str, Any]) -> None:
        """Synthesize a JSON-RPC push notification to every connected client.

        Synchronous from the caller's perspective — schedules the actual
        write onto the daemon's loop and waits for it.
        """
        if not self._loop:
            raise RuntimeError("FakeDaemon not running")
        line = (
            json.dumps({"jsonrpc": "2.0", "method": method, "params": params})
            + "\n"
        ).encode("utf-8")

        async def _push() -> None:
            for w in list(self._clients):
                try:
                    w.write(line)
                    await w.drain()
                except Exception:
                    pass

        fut = asyncio.run_coroutine_threadsafe(_push(), self._loop)
        fut.result(timeout=5)


@pytest.fixture
def fake_daemon():
    port = _pick_free_port()
    daemon = FakeDaemon(host="127.0.0.1", port=port)
    daemon.start()
    try:
        yield daemon
    finally:
        daemon.stop()


@pytest.fixture
def rig_env(monkeypatch, fake_daemon):
    """Set the env vars the FastAPI app reads at import + lifespan time."""
    monkeypatch.setenv("SIGNAL_TEST_RIG_TOKEN", "test-token-abc")
    monkeypatch.setenv("SIGNAL_TEST_RIG_ACCOUNT", "+15551234567")
    monkeypatch.setenv("SIGNAL_TEST_RIG_TCP_HOST", fake_daemon.host)
    monkeypatch.setenv("SIGNAL_TEST_RIG_TCP_PORT", str(fake_daemon.port))
    monkeypatch.setenv("SIGNAL_TEST_RIG_MANAGE_DAEMON", "0")
    return None


@pytest.fixture
def app_module(rig_env):
    """Fresh import of the FastAPI app module with the env vars in scope."""
    import signal_test_rig.main as m

    importlib.reload(m)
    return m
