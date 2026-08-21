"""
signal_cli_bridge — thin async JSON-RPC client for signal-cli's `--tcp` daemon.

Mirrors the pattern used in nanoclaw/src/channels/signal.ts (SignalTcpClient),
but Python and minimal — no echo cache, no destination provisioning, no
attachment fetch fluff. Just:

  - spawn `signal-cli daemon --tcp <bind> --receive-mode on-start` in
    multi-account mode (no `-a` flag) so the daemon serves every locally
    registered account on one socket (optional; daemon can be started
    externally and the bridge attached)
  - connect to that daemon over newline-delimited JSON-RPC
  - subscribeReceive per-account so push notifications arrive on our socket
  - rpc(method, params) → awaitable result, auto-injects `account` when given
  - on_notification(method, params) callback for inbound `receive` events;
    `params.account` identifies which burner the envelope landed on

Multi-account vs single-account
-------------------------------
signal-cli's daemon supports two modes (asamk/signal-cli wiki):

  - Single-account: `signal-cli -a +E164 daemon --tcp …`. JSON-RPC
    methods take no `account` param; `subscribeReceive` likewise.
  - Multi-account:  `signal-cli daemon --tcp …` (no `-a`). EVERY
    JSON-RPC method must include `{"account": "+E164"}` in its params
    to scope the call. `subscribeReceive` also takes `account` and
    must be called once per account to get pushes for that one.

This rig always runs the multi-account shape, even when only one burner
is configured. Reasons:
  - Identical wire shape regardless of `len(accounts) == 1`.
  - No fork in the daemon supervisor branch.
  - signal-cli's multi-account mode also exposes registration / linking
    commands (we don't use them — registration is human-side — but the
    surface is harmless).

The rig DOES NOT register / link / verify. The user runs `signal-cli -a
+1XXX register` (and `verify`) manually before starting the rig. Multi-
account just means "every account already in `accounts.json` becomes
addressable through one daemon."

Design notes:
  - One bridge = one signal-cli daemon = N burner identities.
  - `manage_daemon=True` spawns the child process; `manage_daemon=False`
    just connects to a pre-existing daemon (useful when the user runs
    signal-cli under launchd / systemd separately).
"""
from __future__ import annotations

import asyncio
import json
import os
import shlex
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

# Default RPC timeout — signal-cli send / sendTyping / subscribeReceive
# typically reply within a few hundred ms. Bump for slow ops (getAttachment
# over the JSON-RPC pipe).
DEFAULT_RPC_TIMEOUT_S = 15.0

# Default daemon bind (matches transports/signal-cli/entrypoint.sh).
# Loopback-only by default — the rig is local-first; cross-machine access
# is the WS layer's job, not signal-cli's.
DEFAULT_TCP_HOST = "127.0.0.1"
DEFAULT_TCP_PORT = 7583


NotificationCallback = Callable[[str, dict[str, Any]], Awaitable[None]]


@dataclass
class BridgeConfig:
    """Bridge config.

    `accounts` is the load-bearing field: it's the list of burner E164s
    the rig is fronting. Order matters — `accounts[0]` is the implicit
    default when a `POST /send` doesn't specify which account to use, so
    a one-account rig behaves exactly like the pre-multi-account rig
    did. Index addressing (`[0]`, `[1]`) is the documented escape hatch
    for callers that want positional reference instead of E164 literals.
    """

    accounts: list[str]
    tcp_host: str = DEFAULT_TCP_HOST
    tcp_port: int = DEFAULT_TCP_PORT
    manage_daemon: bool = False
    signal_cli_bin: str = "signal-cli"
    # Extra signal-cli daemon flags. Used in tests to override
    # --receive-mode, etc. Power-user knob; the default flag set works.
    daemon_extra_args: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.accounts:
            raise ValueError("BridgeConfig.accounts must be non-empty")
        # Defensive dedupe-while-preserving-order. signal-cli won't object
        # to duplicate subscribeReceive calls per account but it's noise.
        seen: set[str] = set()
        uniq: list[str] = []
        for a in self.accounts:
            if a not in seen:
                seen.add(a)
                uniq.append(a)
        self.accounts = uniq

    @property
    def default_account(self) -> str:
        """Implicit account when a request doesn't name one. `accounts[0]`."""
        return self.accounts[0]


class SignalCliBridge:
    """Async JSON-RPC client + (optional) signal-cli multi-account daemon supervisor."""

    def __init__(self, config: BridgeConfig, on_notification: Optional[NotificationCallback] = None) -> None:
        self.config = config
        self._on_notification = on_notification

        self._reader: Optional[asyncio.StreamReader] = None
        self._writer: Optional[asyncio.StreamWriter] = None
        self._daemon_proc: Optional[asyncio.subprocess.Process] = None
        self._reader_task: Optional[asyncio.Task[None]] = None
        self._pending: dict[str, asyncio.Future[Any]] = {}
        self._rpc_id_counter = 0
        self._closed = False

    # -- lifecycle --

    async def start(self) -> None:
        if self.config.manage_daemon:
            await self._spawn_daemon()
            await self._await_daemon_listening()
        else:
            # External daemon (entrypoint.sh launches it separately on
            # Fly). signal-cli JAR + JRE warmup + Signal Service
            # handshake routinely takes 30-60s on a cold boot — far
            # longer than the rig process itself. Poll the daemon TCP
            # port instead of fast-failing on the first connect.
            await self._await_daemon_listening(deadline_s=120.0)

        await self._connect_tcp()
        # Reader pumps lines forever; nothing to await beyond start.
        self._reader_task = asyncio.create_task(self._read_loop(), name="signal-cli-bridge-reader")

        # subscribeReceive is the load-bearing call — without it, signal-cli
        # collects envelopes daemon-side but never pushes them to us.
        # See nanoclaw/src/channels/signal.ts:1571 for the long-form comment.
        # In multi-account mode the call MUST be repeated per account, with
        # the account in params; the daemon's wiki is explicit about this.
        for account in self.config.accounts:
            try:
                await self.rpc("subscribeReceive", account=account)
            except Exception as e:  # pragma: no cover — surfaced via stderr
                raise RuntimeError(
                    f"signal-cli subscribeReceive failed for {account}: {e}"
                ) from e

    async def stop(self) -> None:
        self._closed = True
        if self._reader_task and not self._reader_task.done():
            self._reader_task.cancel()
            try:
                await self._reader_task
            except (asyncio.CancelledError, Exception):
                pass
        if self._writer:
            try:
                self._writer.close()
                await self._writer.wait_closed()
            except Exception:
                pass
            self._writer = None
        if self._daemon_proc and self._daemon_proc.returncode is None:
            self._daemon_proc.terminate()
            try:
                await asyncio.wait_for(self._daemon_proc.wait(), timeout=5)
            except asyncio.TimeoutError:
                self._daemon_proc.kill()
                await self._daemon_proc.wait()
        self._daemon_proc = None

        # Fail any in-flight requests.
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(RuntimeError("signal-cli bridge stopped"))
        self._pending.clear()

    # -- rpc --

    async def rpc(
        self,
        method: str,
        params: Optional[dict[str, Any]] = None,
        *,
        account: Optional[str] = None,
        timeout: float = DEFAULT_RPC_TIMEOUT_S,
    ) -> Any:
        """Send a JSON-RPC method.

        `account` is auto-merged into `params` when provided. Required by
        signal-cli's multi-account mode for every method that targets a
        specific identity (send, subscribeReceive, updateProfile,
        listGroups, …). Methods that aren't account-scoped (registration
        flow, version) ignore it harmlessly when it's None.
        """
        if not self._writer:
            raise RuntimeError("signal-cli bridge not connected")
        self._rpc_id_counter += 1
        rpc_id = f"r{self._rpc_id_counter}"
        msg: dict[str, Any] = {"jsonrpc": "2.0", "method": method, "id": rpc_id}
        merged: Optional[dict[str, Any]] = None
        if params is not None or account is not None:
            merged = dict(params) if params else {}
            if account is not None:
                merged["account"] = account
        if merged is not None:
            msg["params"] = merged

        loop = asyncio.get_running_loop()
        fut: asyncio.Future[Any] = loop.create_future()
        self._pending[rpc_id] = fut

        line = (json.dumps(msg) + "\n").encode("utf-8")
        try:
            self._writer.write(line)
            await self._writer.drain()
        except Exception as e:
            self._pending.pop(rpc_id, None)
            raise RuntimeError(f"signal-cli write failed: {e}") from e

        try:
            return await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError as e:
            self._pending.pop(rpc_id, None)
            raise TimeoutError(f"signal-cli RPC timeout: {method}") from e

    # -- convenience helpers (thin wrappers over rpc) --

    async def send_text(
        self,
        recipient: str,
        text: str,
        *,
        account: Optional[str] = None,
        group_id: Optional[str] = None,
    ) -> Any:
        """Send a plain text message from `account` (default: accounts[0]).

        Matches the nanoclaw/src/channels/signal.ts:1273 shape: `recipient`
        is an array of E164s for DMs; `groupId` replaces it for groups.
        The `account` param is required by signal-cli's multi-account
        mode; falls back to `default_account` when omitted so single-
        account callers don't have to think about it.
        """
        from_account = account or self.config.default_account
        params: dict[str, Any] = {"message": text}
        if group_id:
            params["groupId"] = group_id
        else:
            params["recipient"] = [recipient]
        return await self.rpc("send", params, account=from_account)

    # -- internals --

    async def _spawn_daemon(self) -> None:
        """Spawn signal-cli in multi-account daemon mode.

        Notably absent: the `-a <account>` flag. Per signal-cli's wiki,
        omitting `-a` puts the daemon in multi-account mode where every
        RPC needs `{"account": "+E164"}` in params. This is the wire
        shape the rig always uses, regardless of len(accounts) == 1.
        """
        bind = f"{self.config.tcp_host}:{self.config.tcp_port}"
        cmd = [
            self.config.signal_cli_bin,
            "daemon",
            "--tcp",
            bind,
            "--no-receive-stdout",
            "--receive-mode",
            "on-start",
            *self.config.daemon_extra_args,
        ]
        # Pipe stderr so a failed daemon doesn't silently disappear into /dev/null.
        # Stdout is mostly noise; route it the same.
        self._daemon_proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env={**os.environ},
        )
        # Launch background drainer tasks so the pipes don't fill up and block.
        asyncio.create_task(self._drain_pipe("signal-cli stdout", self._daemon_proc.stdout))
        asyncio.create_task(self._drain_pipe("signal-cli stderr", self._daemon_proc.stderr))

    async def _drain_pipe(self, label: str, pipe: Optional[asyncio.StreamReader]) -> None:
        if not pipe:
            return
        while True:
            line = await pipe.readline()
            if not line:
                return
            # Print to our own stderr so the rig's log stream stays clean.
            try:
                print(f"[{label}] {line.decode('utf-8', errors='replace').rstrip()}", flush=True)
            except Exception:
                pass

    async def _await_daemon_listening(self, deadline_s: float = 15.0) -> None:
        """Poll the TCP port until the daemon accepts connections (or we time out)."""
        host = self.config.tcp_host
        port = self.config.tcp_port
        loop = asyncio.get_running_loop()
        end = loop.time() + deadline_s
        last_err: Optional[BaseException] = None
        while loop.time() < end:
            # Bail out early if the daemon process died.
            if self._daemon_proc and self._daemon_proc.returncode is not None:
                raise RuntimeError(
                    f"signal-cli daemon exited early with code {self._daemon_proc.returncode}"
                )
            try:
                reader, writer = await asyncio.open_connection(host, port)
                writer.close()
                try:
                    await writer.wait_closed()
                except Exception:
                    pass
                return
            except Exception as e:
                last_err = e
                await asyncio.sleep(0.25)
        cmd_str = shlex.join(
            [self.config.signal_cli_bin, "daemon", "--tcp", f"{host}:{port}"]
        )
        raise TimeoutError(
            f"signal-cli daemon never started listening on {host}:{port}: {last_err!r} "
            f"(cmd: {cmd_str})"
        )

    async def _connect_tcp(self) -> None:
        self._reader, self._writer = await asyncio.open_connection(
            self.config.tcp_host, self.config.tcp_port
        )

    async def _read_loop(self) -> None:
        assert self._reader is not None
        while not self._closed:
            try:
                raw = await self._reader.readline()
            except asyncio.CancelledError:
                raise
            except Exception:
                # Connection lost. Surface to in-flight requests.
                for fut in self._pending.values():
                    if not fut.done():
                        fut.set_exception(RuntimeError("signal-cli TCP read failed"))
                self._pending.clear()
                return
            if not raw:
                # EOF.
                for fut in self._pending.values():
                    if not fut.done():
                        fut.set_exception(RuntimeError("signal-cli TCP closed"))
                self._pending.clear()
                return
            line = raw.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            await self._handle_line(line)

    async def _handle_line(self, line: str) -> None:
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            print(f"[signal-cli bridge] unparseable line: {line[:200]!r}", flush=True)
            return

        rpc_id = parsed.get("id")
        if rpc_id and rpc_id in self._pending:
            fut = self._pending.pop(rpc_id)
            if "error" in parsed:
                err = parsed["error"]
                err_msg = err.get("message") if isinstance(err, dict) else str(err)
                if not fut.done():
                    fut.set_exception(RuntimeError(f"signal-cli RPC error: {err_msg}"))
            else:
                if not fut.done():
                    fut.set_result(parsed.get("result"))
            return

        method = parsed.get("method")
        params = parsed.get("params")
        if method and self._on_notification:
            try:
                await self._on_notification(method, params if isinstance(params, dict) else {})
            except Exception as e:
                # Never let a misbehaving callback kill the reader.
                print(f"[signal-cli bridge] notification handler raised: {e!r}", flush=True)


__all__ = ["BridgeConfig", "SignalCliBridge", "DEFAULT_TCP_HOST", "DEFAULT_TCP_PORT"]
