"""
signal-test-rig — local FastAPI app fronting signal-cli with a multi-subscriber
WebSocket + REST send endpoint.

Purpose
-------
We have a burner phone registered with signal-cli on this machine. The
agents under test (PAT) live on Fly. To run smoketests where the burner
plays "the other party," we need:

  - Inbound visibility: every Signal envelope the burner receives gets
    broadcast to N connected WS clients (PAT call-monitor, an ad-hoc
    `wscat`, the test harness).
  - Outbound control: a REST POST that sends text from the burner to a
    target E164 (or group). Used by smoketests to reply / interrupt /
    ack as the human-impersonator.

Topology
--------

      ┌──────────────────────────────────────────────────────────┐
      │  signal-cli daemon  (127.0.0.1:7583, JSON-RPC over TCP)  │
      │  -a <burner-E164>   (state at ~/.local/share/signal-cli) │
      └──────────────────────────────────────────────────────────┘
                              ▲
                              │ JSON-RPC (newline-delim)
                              │
                ┌─────────────┴─────────────┐
                │  signal_cli_bridge.py     │
                │  - rpc(method, params)    │
                │  - on_notification cb     │
                └─────────────┬─────────────┘
                              │
                ┌─────────────▼─────────────┐
                │  this file: FastAPI app   │
                │  - GET  /healthz           │
                │  - POST /send              │
                │  - WS   /ws (broadcast)    │
                └─────────────┬─────────────┘
                              │
       ┌───────────┬──────────┼──────────┬───────────┐
       ▼           ▼          ▼          ▼           ▼
   client A    client B    client C    client D    test harness
   (dashboard)  (wscat)     (PAT       (logger)    (pytest)
                            monitor)

Authentication
--------------
Single shared-secret bearer token via env var `SIGNAL_TEST_RIG_TOKEN`.
Required on every request (REST + WS). NO certs, NO OAuth. The rig is
local-only — token exists so a curious neighbour on the same LAN can't
spam the burner. If the env var is unset, the rig refuses to start.

Trace lines
-----------
Every send AND every inbound prints exactly one line to stdout, JSON-shaped,
with a `kind:` discriminator at the top level so:

    uv run python -m signal_test_rig.main | grep '"kind":"inbound"' | jq

Just Works. This matches the rest of the codebase's logging discipline.
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from contextlib import asynccontextmanager
from typing import Any, Optional

from fastapi import (
    Depends,
    FastAPI,
    HTTPException,
    Header,
    Query,
    Request,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from signal_test_rig.signal_cli_bridge import (
    DEFAULT_TCP_HOST,
    DEFAULT_TCP_PORT,
    BridgeConfig,
    SignalCliBridge,
)

# --- config / env ---------------------------------------------------------

PORT = int(os.environ.get("SIGNAL_TEST_RIG_PORT", "7585"))
BIND = os.environ.get("SIGNAL_TEST_RIG_BIND", "127.0.0.1")
TOKEN = os.environ.get("SIGNAL_TEST_RIG_TOKEN", "")
TCP_HOST = os.environ.get("SIGNAL_TEST_RIG_TCP_HOST", DEFAULT_TCP_HOST)
TCP_PORT = int(os.environ.get("SIGNAL_TEST_RIG_TCP_PORT", str(DEFAULT_TCP_PORT)))
MANAGE_DAEMON = os.environ.get("SIGNAL_TEST_RIG_MANAGE_DAEMON", "0") in ("1", "true", "yes")
SIGNAL_CLI_BIN = os.environ.get("SIGNAL_TEST_RIG_SIGNAL_CLI_BIN", "signal-cli")


# Multi-account: `SIGNAL_TEST_RIG_ACCOUNTS=+A,+B` is the preferred form.
# `SIGNAL_TEST_RIG_ACCOUNT=+A` (singular) is kept as a back-compat alias for
# existing single-account callers (smoketest harnesses, ws_client.py docs).
# Order matters — accounts[0] is the implicit default when /send doesn't
# specify a from-account, so a one-account rig that used to set
# SIGNAL_TEST_RIG_ACCOUNT still behaves identically.
def _parse_accounts_env() -> list[str]:
    plural = os.environ.get("SIGNAL_TEST_RIG_ACCOUNTS", "").strip()
    singular = os.environ.get("SIGNAL_TEST_RIG_ACCOUNT", "").strip()
    raw: list[str] = []
    if plural:
        raw = [p.strip() for p in plural.split(",") if p.strip()]
    elif singular:
        raw = [singular]
    # Dedupe-while-preserving-order. signal-cli is fine with dupes but the
    # rig's broadcast frames would also dupe `accounts: [...]` — ugly in logs.
    seen: set[str] = set()
    out: list[str] = []
    for a in raw:
        if a not in seen:
            seen.add(a)
            out.append(a)
    return out


ACCOUNTS: list[str] = _parse_accounts_env()


# --- structured one-liner trace ------------------------------------------

def trace(kind: str, **fields: Any) -> None:
    """Emit one JSON line to stdout with `kind:` discriminator.

    Mirrors the structured-log discipline in AGENTS.md without joining the
    PAT log schema (this is a separate test rig, not a PAT process — adding
    new `kind`s to the global schema would force a drift-test update for
    every change here, which is overkill).
    """
    record = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S.", time.gmtime())
        + f"{int((time.time() % 1) * 1000):03d}Z",
        "source": "signal-test-rig",
        "kind": kind,
        **fields,
    }
    try:
        print(json.dumps(record, default=str), flush=True)
    except Exception:
        # Last-resort fallback: never let logging crash the rig.
        print(f"[signal-test-rig] trace failed for kind={kind}", flush=True)


# --- broadcast hub + subscription filter ---------------------------------

# Parser helper for comma-separated query params. signal-cli identifiers
# (E164, UUID, group ids) don't contain commas, so a literal split is safe.
def _split_csv(s: Optional[str]) -> list[str]:
    """Split comma-separated query value with E164 auto-recovery.

    URL spec: `+` in query strings is space. Consumers who type
    `?from=+15550100000` see it parsed as `from= 15550100000`.
    `%2B`-encoding is the spec-correct answer but a usability footgun
    for curl/scripts — so we auto-recover the obvious case: a leading
    space followed by all digits → prepend `+`. Real callers that just
    want a leading-space string (none exist for our filter axes) lose
    here; that tradeoff is fine.
    """
    if not s:
        return []
    out: list[str] = []
    for p in s.split(","):
        v = p.lstrip()
        if v != p and v.isdigit():
            # Recovered an E164 that got space-mangled by URL parsing.
            v = "+" + v
        else:
            v = p.strip()
        if v:
            out.append(v)
    return out


def _parse_since(s: Optional[str]) -> int:
    """Parse a `since` query value (ISO-8601 UTC, or ms-since-epoch int).

    Returns ms-since-epoch (or 0 = no filter). Best-effort: bad input
    falls back to 0 so a broken `since` doesn't silently drop everything.
    """
    if not s:
        return 0
    s = s.strip()
    if not s:
        return 0
    # Accept "1779397281827" → ms epoch (matches signal-cli's wire format).
    if s.isdigit():
        return int(s)
    # Accept ISO-8601 ("2026-05-21T20:00:00Z" or with subsecond + offset).
    try:
        import datetime as _dt
        # Allow trailing Z by swapping to +00:00 (fromisoformat rejects Z
        # pre-3.11; cheap normalization).
        iso = s.replace("Z", "+00:00")
        dt = _dt.datetime.fromisoformat(iso)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=_dt.timezone.utc)
        return int(dt.timestamp() * 1000)
    except Exception:
        return 0


class Subscription:
    """Per-WS-client filter spec.

    All fields are AND-combined. Empty fields are "no filter on this axis."

    Filter axes:
      kind_prefixes : list[str]  prefix-match — `inbound` matches all
                                 `inbound.*`; `inbound.text` matches only
                                 the exact sub-kind.
      sources       : list[str]  E164 or UUID (matched against the event's
                                 `data.source` or `data.source_uuid`).
      accounts      : list[str]  Burner E164 allowlist — only deliver
                                 events whose `data.account` matches.
                                 Multi-account rigs use this to isolate
                                 one burner's traffic to one subscriber.
      groups        : list[str]  Group V2 id allowlist. Special token `none`
                                 = only events outside any group.
      text_contains : str        Case-insensitive substring against `data.text`.
                                 Tests use this to pin a correlation token in
                                 the message body and ignore unrelated traffic.
      since_ms      : int        Drop events whose `data.timestamp_ms` (or
                                 frame `ts`) is before this. 0 = no filter.
    """

    __slots__ = ("kind_prefixes", "sources", "accounts", "groups", "text_contains", "since_ms")

    def __init__(
        self,
        *,
        kind_prefixes: Optional[list[str]] = None,
        sources: Optional[list[str]] = None,
        accounts: Optional[list[str]] = None,
        groups: Optional[list[str]] = None,
        text_contains: str = "",
        since_ms: int = 0,
    ) -> None:
        self.kind_prefixes = kind_prefixes or []
        self.sources = sources or []
        self.accounts = accounts or []
        self.groups = groups or []
        self.text_contains = text_contains.lower()
        self.since_ms = since_ms

    @classmethod
    def from_query(
        cls,
        *,
        kind: Optional[str] = None,
        from_: Optional[str] = None,
        account: Optional[str] = None,
        group: Optional[str] = None,
        text_contains: Optional[str] = None,
        since: Optional[str] = None,
    ) -> "Subscription":
        return cls(
            kind_prefixes=_split_csv(kind),
            sources=_split_csv(from_),
            accounts=_split_csv(account),
            groups=_split_csv(group),
            text_contains=(text_contains or "").strip(),
            since_ms=_parse_since(since),
        )

    def matches(self, event: dict[str, Any]) -> bool:
        # `ready` frames bypass user filters — they're a connection-state
        # signal, not signal traffic. Same for `signal.notification` and
        # `sent` — those are control-plane confirmations; a test that
        # explicitly wants only `inbound.text` will use `kind=inbound.text`
        # AND those control kinds won't pass the prefix gate anyway.
        kind = event.get("kind", "")

        if self.kind_prefixes:
            if not any(
                kind == p or kind.startswith(p + ".") for p in self.kind_prefixes
            ):
                return False

        data = event.get("data") or {}

        if self.sources:
            src = data.get("source") or ""
            src_uuid = data.get("source_uuid") or ""
            if src not in self.sources and src_uuid not in self.sources:
                return False

        if self.accounts:
            acct = data.get("account") or ""
            if acct not in self.accounts:
                return False

        if self.groups:
            gid = data.get("group_id")
            if "none" in self.groups and gid is None:
                pass  # allowed
            elif gid in self.groups:
                pass  # allowed
            else:
                return False

        if self.text_contains:
            text = (data.get("text") or "").lower()
            if self.text_contains not in text:
                return False

        if self.since_ms:
            ts = data.get("timestamp_ms") or 0
            if not ts:
                # Frame ts is ISO; convert. Cheap because most filters
                # specify since_ms and most events have data.timestamp_ms.
                ts = _parse_since(event.get("ts"))
            if ts < self.since_ms:
                return False

        return True


class WsHub:
    """Tiny asyncio fan-out hub with per-subscriber filters.

    Each registered WS carries a `Subscription`; `broadcast()` evaluates
    every subscriber's filter against the event and sends only when the
    filter accepts. Filter mismatch is silent — no per-client error.

    A slow / dead client doesn't block the others; failed sends drop the
    peer.
    """

    def __init__(self) -> None:
        # Dict-keyed by WebSocket so a peer can carry its filter alongside
        # the socket and we can iterate the pair atomically.
        self._subs: "dict[WebSocket, Subscription]" = {}
        self._lock = asyncio.Lock()

    async def register(self, ws: WebSocket, sub: Subscription) -> None:
        async with self._lock:
            self._subs[ws] = sub
        trace("ws.connected", client_count=len(self._subs))

    async def unregister(self, ws: WebSocket) -> None:
        async with self._lock:
            self._subs.pop(ws, None)
        trace("ws.disconnected", client_count=len(self._subs))

    async def broadcast(self, message: dict[str, Any]) -> None:
        """Send `message` to every connected client whose filter accepts."""
        async with self._lock:
            pairs = list(self._subs.items())

        if not pairs:
            return

        # `ready` frames go to all clients regardless of filter — they're
        # connection lifecycle, not traffic. Filtered out by Subscription.matches
        # for non-`ready` kinds.
        is_ready = message.get("kind") == "ready"

        async def _send_one(peer: WebSocket, sub: Subscription) -> None:
            try:
                if is_ready or sub.matches(message):
                    await peer.send_json(message)
            except Exception:
                await self.unregister(peer)
                try:
                    await peer.close()
                except Exception:
                    pass

        await asyncio.gather(
            *[_send_one(p, s) for (p, s) in pairs], return_exceptions=True
        )

    def client_count(self) -> int:
        return len(self._subs)


# --- bridge bootstrap -----------------------------------------------------

# Wrapped in a class so tests can pass a fake bridge without monkey-patching
# the module-level global.
class AppState:
    def __init__(self) -> None:
        self.hub = WsHub()
        self.bridge: Optional[SignalCliBridge] = None


state = AppState()


async def _on_signal_notification(method: str, params: dict[str, Any]) -> None:
    """Forwarded by SignalCliBridge for every push notification.

    signal-cli emits `receive` for inbound envelopes; other methods exist
    (`syncEnvelopeUpdated`, etc.) but the rig only cares about `receive`.
    Anything else is broadcast as kind=`signal.notification` so a curious
    subscriber can still inspect it.

    In multi-account mode the `receive` notification carries `account`
    in its top-level params (NOT in `envelope.account`) — signal-cli's
    wire shape stamps the destination identity outside the envelope.
    We promote it onto `data.account` so subscribers can filter without
    decoding which burner the message landed on.
    """
    if method == "receive":
        envelope = (params or {}).get("envelope") or {}
        account = (params or {}).get("account") or envelope.get("account")
        msg = _envelope_to_broadcast(envelope, account=account)
        # Rename the envelope's `source` to `from_source` in the trace
        # to avoid colliding with the trace function's top-level
        # `source: "signal-test-rig"` (process identity). **fields would
        # otherwise overwrite the process source with the burner UUID.
        trace(
            msg["kind"],
            account=msg["data"].get("account"),
            from_source=msg["data"].get("source"),
            text_len=len(msg["data"].get("text") or ""),
            has_attachments=bool(msg["data"].get("attachments")),
            group=msg["data"].get("group_id"),
        )
        await state.hub.broadcast(msg)
    else:
        trace("signal.notification", method=method)
        await state.hub.broadcast(
            {
                "kind": "signal.notification",
                "ts": _now_iso(),
                "data": {"method": method, "params": params},
            }
        )


def _classify_envelope(envelope: dict[str, Any]) -> str:
    """Return a fine-grained `kind` for a signal-cli `receive` envelope.

    Kind taxonomy (dotted; prefix-match-friendly so a client can filter
    on `inbound` to get all sub-kinds, or `inbound.receipt` to get all
    receipt variants):

      inbound.text                 dataMessage with non-empty body
      inbound.attachment           dataMessage with attachments (no voice note)
      inbound.voice-memo           dataMessage with a voiceNote-flagged attachment
      inbound.reaction             dataMessage.reaction set
      inbound.edit                 envelope.editMessage present
      inbound.delete               dataMessage.remoteDelete set
      inbound.typing.started       typingMessage action=STARTED
      inbound.typing.stopped       typingMessage action=STOPPED
      inbound.receipt.delivery     receiptMessage type=DELIVERY (or unspecified)
      inbound.receipt.read         receiptMessage type=READ
      inbound.receipt.viewed       receiptMessage type=VIEWED
      inbound.sync.sent            syncMessage.sentMessage (our own send echoed back)
      inbound.sync.read            syncMessage.readMessages
      inbound.sync.viewed          syncMessage.viewedMessages
      inbound.sync.other           any other syncMessage shape
      inbound.story                storyMessage
      inbound.call                 callMessage
      inbound.unknown              none of the above — pure metadata envelope

    Tests that care about real conversation should filter on
    `kind=inbound.text` (plus optionally `inbound.attachment` /
    `inbound.voice-memo`). Tests that want to observe typing-state
    bargein behavior use `inbound.typing.*`. Etc.
    """
    if envelope.get("editMessage"):
        return "inbound.edit"
    if "typingMessage" in envelope:
        action = (envelope.get("typingMessage") or {}).get("action") or ""
        action = str(action).upper()
        if action == "STARTED":
            return "inbound.typing.started"
        if action == "STOPPED":
            return "inbound.typing.stopped"
        return "inbound.typing.started"  # signal-cli default when absent
    if "receiptMessage" in envelope:
        rtype = str((envelope.get("receiptMessage") or {}).get("type") or "DELIVERY").upper()
        if rtype == "READ":
            return "inbound.receipt.read"
        if rtype == "VIEWED":
            return "inbound.receipt.viewed"
        return "inbound.receipt.delivery"
    if "storyMessage" in envelope:
        return "inbound.story"
    if "callMessage" in envelope:
        return "inbound.call"
    sync = envelope.get("syncMessage") or {}
    if sync:
        if sync.get("sentMessage"):
            return "inbound.sync.sent"
        if sync.get("readMessages"):
            return "inbound.sync.read"
        if sync.get("viewedMessages"):
            return "inbound.sync.viewed"
        return "inbound.sync.other"
    data_msg = envelope.get("dataMessage") or {}
    if data_msg:
        if data_msg.get("remoteDelete"):
            return "inbound.delete"
        if data_msg.get("reaction"):
            return "inbound.reaction"
        attachments = data_msg.get("attachments") or []
        has_voice = any((a or {}).get("voiceNote") for a in attachments)
        has_text = bool((data_msg.get("message") or "").strip())
        if has_voice:
            return "inbound.voice-memo"
        if attachments:
            return "inbound.attachment"
        if has_text:
            return "inbound.text"
    return "inbound.unknown"


def _envelope_to_broadcast(
    envelope: dict[str, Any],
    *,
    account: Optional[str] = None,
) -> dict[str, Any]:
    """Project a signal-cli envelope into the rig's broadcast schema.

    Returns a frame `{kind, ts, data}` where `kind` is the fine-grained
    sub-kind from `_classify_envelope`. `data.text` is the user-facing
    body when present (empty string otherwise — see kind to disambiguate
    "no text yet" from "no text by design"). `data.raw_envelope` is the
    full signal-cli wire envelope for consumers that need fields the
    rig doesn't promote (quote, mentions, reaction emoji, edit target,
    storyContext, etc.).

    `data.account` is the burner E164 that received the envelope. For
    rigs with multiple registered accounts this is the only way to
    tell which one was actually addressed.
    """
    kind = _classify_envelope(envelope)

    # User-facing text payload — pull from dataMessage primarily; fall
    # back to syncMessage.sentMessage so own-echoes still surface a body.
    data_msg = envelope.get("dataMessage") or {}
    sync_sent = (envelope.get("syncMessage") or {}).get("sentMessage") or {}
    payload = data_msg if data_msg else sync_sent

    text = (payload.get("message") or "").strip()
    attachments = payload.get("attachments") or []
    timestamp_ms = payload.get("timestamp") or envelope.get("timestamp")
    group_v2 = (payload.get("groupV2") or {}).get("id")
    group_info = (payload.get("groupInfo") or {}).get("groupId")
    group_id = group_v2 or group_info

    # Account: prefer the explicit param (signal-cli stamps this on the
    # outer params in multi-account mode). Fall back to in-envelope copies
    # for forward-compat and so the classifier-only tests can pass a value.
    resolved_account = (
        account
        or envelope.get("account")
        or (ACCOUNTS[0] if ACCOUNTS else None)
    )

    return {
        "kind": kind,
        "ts": _now_iso(),
        "data": {
            "account": resolved_account,
            "source": envelope.get("sourceNumber")
            or envelope.get("sourceUuid")
            or envelope.get("source"),
            "source_name": envelope.get("sourceName"),
            "source_uuid": envelope.get("sourceUuid"),
            "text": text,
            "timestamp_ms": timestamp_ms,
            "group_id": group_id,
            "attachments": [
                {
                    "id": a.get("id"),
                    "content_type": a.get("contentType"),
                    "filename": a.get("filename"),
                    "size": a.get("size"),
                    "voice_note": bool(a.get("voiceNote")),
                }
                for a in attachments
            ]
            if attachments
            else [],
            "raw_envelope": envelope,
        },
    }


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S.", time.gmtime()) + (
        f"{int((time.time() % 1) * 1000):03d}Z"
    )


# --- auth -----------------------------------------------------------------

def _require_token_from_header(authorization: Optional[str]) -> None:
    if not TOKEN:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="SIGNAL_TEST_RIG_TOKEN not configured",
        )
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    presented = authorization[len("Bearer ") :].strip()
    # Constant-time compare to avoid timing-leak parlor tricks. Token is
    # not high-value, but it costs nothing to use compare_digest here.
    import hmac

    if not hmac.compare_digest(presented, TOKEN):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="bad bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )


def require_bearer(authorization: Optional[str] = Header(default=None)) -> None:
    """Dependency: validate Authorization: Bearer <SIGNAL_TEST_RIG_TOKEN>."""
    _require_token_from_header(authorization)


# --- request models -------------------------------------------------------

class SendRequest(BaseModel):
    recipient: Optional[str] = Field(
        default=None,
        description="E164 (e.g. +14155551212). Mutually exclusive with group_id.",
    )
    group_id: Optional[str] = Field(
        default=None,
        description="Signal group V2 id (sans `group:` prefix). Mutually exclusive with recipient.",
    )
    text: str = Field(min_length=1, description="Message body.")
    account: Optional[str] = Field(
        default=None,
        description=(
            "Which configured burner to send FROM. Accepts either an E164 "
            "literal (`+15550100005`) or a positional index in brackets "
            "(`[0]`, `[1]`). Omitting defaults to accounts[0] — preserves "
            "single-account back-compat for callers that don't know multi."
        ),
    )


def _resolve_send_account(requested: Optional[str]) -> str:
    """Resolve a request's `account` field to a concrete E164.

    Accepts:
      - None        → accounts[0] (default; preserves single-account flow)
      - "+E164"     → must match one of ACCOUNTS, else 400
      - "[N]"       → positional index into ACCOUNTS, else 400

    Raises HTTPException 400 on any unresolvable input. Never returns a
    value not in ACCOUNTS — caller is safe to pass straight to the bridge.
    """
    if not ACCOUNTS:
        raise HTTPException(
            status_code=503,
            detail="rig has no accounts configured (set SIGNAL_TEST_RIG_ACCOUNTS)",
        )
    if requested is None or requested == "":
        return ACCOUNTS[0]
    if requested.startswith("[") and requested.endswith("]"):
        try:
            idx = int(requested[1:-1])
        except ValueError as e:
            raise HTTPException(
                status_code=400,
                detail=f"account index '{requested}' is not a valid integer",
            ) from e
        if idx < 0 or idx >= len(ACCOUNTS):
            raise HTTPException(
                status_code=400,
                detail=(
                    f"account index [{idx}] out of range; "
                    f"rig has {len(ACCOUNTS)} configured: {ACCOUNTS}"
                ),
            )
        return ACCOUNTS[idx]
    if requested not in ACCOUNTS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"account '{requested}' is not configured; "
                f"available: {ACCOUNTS}"
            ),
        )
    return requested


# --- app ------------------------------------------------------------------

@asynccontextmanager
async def lifespan(_app: FastAPI):
    if not TOKEN:
        # Refuse to start without auth — the cost of getting this wrong is
        # "any process on the network can puppet the burner."
        raise RuntimeError(
            "SIGNAL_TEST_RIG_TOKEN env var is required. Pick any opaque "
            "string (e.g. `openssl rand -hex 32`)."
        )
    if not ACCOUNTS:
        raise RuntimeError(
            "SIGNAL_TEST_RIG_ACCOUNTS env var is required "
            "(comma-separated E164s, e.g. +15550100005,+15550100006). "
            "Single-account callers can still use SIGNAL_TEST_RIG_ACCOUNT. "
            "Register each burner with `signal-cli -a +1XXX register` first."
        )

    bridge = SignalCliBridge(
        BridgeConfig(
            accounts=list(ACCOUNTS),
            tcp_host=TCP_HOST,
            tcp_port=TCP_PORT,
            manage_daemon=MANAGE_DAEMON,
            signal_cli_bin=SIGNAL_CLI_BIN,
        ),
        on_notification=_on_signal_notification,
    )

    try:
        await bridge.start()
    except Exception as e:
        trace("bridge.start-failed", error=str(e))
        raise

    state.bridge = bridge
    trace(
        "rig.ready",
        accounts=ACCOUNTS,
        default_account=ACCOUNTS[0],
        tcp_host=TCP_HOST,
        tcp_port=TCP_PORT,
        manage_daemon=MANAGE_DAEMON,
        bind=BIND,
        port=PORT,
    )

    # Broadcast a "ready" so newly-connecting WS clients can see we're up.
    # (Sent post-connect; clients connecting AFTER ready get nothing on
    # connect, which is fine — they'll see the next inbound.)
    await state.hub.broadcast(
        {
            "kind": "ready",
            "ts": _now_iso(),
            "data": {
                "accounts": list(ACCOUNTS),
                "default_account": ACCOUNTS[0],
            },
        }
    )

    try:
        yield
    finally:
        if state.bridge:
            await state.bridge.stop()
            state.bridge = None
        trace("rig.stopped")


app = FastAPI(lifespan=lifespan, title="signal-test-rig")


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    """Cheap liveness check. Does NOT touch signal-cli — that's `/status`."""
    return {
        "status": "ok",
        "service": "signal-test-rig",
        "ws_clients": state.hub.client_count(),
    }


@app.get("/status", dependencies=[Depends(require_bearer)])
async def status_endpoint() -> dict[str, Any]:
    """Authenticated status — includes whether the bridge is connected."""
    return {
        "status": "ok",
        "service": "signal-test-rig",
        "accounts": list(ACCOUNTS),
        "default_account": ACCOUNTS[0] if ACCOUNTS else None,
        # Singular `account` kept for back-compat. Older callers that
        # log `body["account"]` keep working; the value is the default.
        "account": ACCOUNTS[0] if ACCOUNTS else None,
        "bridge_connected": state.bridge is not None,
        "ws_clients": state.hub.client_count(),
    }


@app.get("/address", dependencies=[Depends(require_bearer)])
async def address_endpoint() -> dict[str, Any]:
    """Return the rig's own account addresses (number + ACI UUID + profile name).

    Tests that need to send TO this rig from another rig must address by
    ACI UUID, not E164 — see `reference_signal_cli_aci_pni_quirk.md` for
    the full forensic. Sender's signal-cli routes E164 → PNI key path,
    which silently fails to decrypt on a signal-cli-only receiver.

    Shape:
      {
        "accounts": [
          {"number": "+15550100005", "uuid": "00000000-...", "profile_name": "PAT Test A" | null},
          ...
        ],
        "default": {"number": "...", "uuid": "...", "profile_name": "..."}
      }

    Cached for the process lifetime (account identity is stable per boot).
    Tests can fetch once and reuse.
    """
    if not state.bridge:
        raise HTTPException(status_code=503, detail="bridge not connected")

    accounts_out: list[dict[str, Any]] = []
    for acct in ACCOUNTS:
        cached = _ADDRESS_CACHE.get(acct)
        if cached is None:
            cached = await _resolve_self_address(acct)
            if cached is not None:
                _ADDRESS_CACHE[acct] = cached
        if cached is not None:
            accounts_out.append(cached)
        else:
            accounts_out.append({"number": acct, "uuid": None, "profile_name": None})

    return {
        "accounts": accounts_out,
        "default": accounts_out[0] if accounts_out else None,
    }


# Process-local cache of the rig's own account addresses. Populated lazily
# on the first GET /address; never invalidated (account identity is stable
# per process boot — would only change on re-registration which restarts
# the daemon anyway).
_ADDRESS_CACHE: dict[str, dict[str, Any]] = {}


async def _resolve_self_address(account: str) -> Optional[dict[str, Any]]:
    """Resolve a single account's own address via signal-cli JSON-RPC.

    `listIdentities` returns every identity the account knows about,
    including the self entry. We pick the entry whose `number` matches
    the account E164 — that one carries the canonical ACI UUID + the
    locally-set profile name (when one's set; otherwise null).

    Falls back to None on RPC failure so the caller can degrade
    gracefully (returning the account with uuid=null is more useful
    than 500-ing the whole endpoint).
    """
    assert state.bridge is not None
    try:
        result = await state.bridge.rpc("listIdentities", None, account=account)
    except Exception as e:
        trace("address.lookup-failed", account=account, error=str(e))
        return None
    if not isinstance(result, list):
        return None
    for row in result:
        if not isinstance(row, dict):
            continue
        if row.get("number") == account:
            return {
                "number": account,
                "uuid": row.get("uuid"),
                # `name` is what signal-cli stores from updateProfile; not
                # always present. Other fields like fingerprint and
                # safetyNumber are intentionally not surfaced here — the
                # endpoint is for routing, not key-verification.
                "profile_name": row.get("name") or row.get("displayName") or None,
            }
    return {"number": account, "uuid": None, "profile_name": None}


@app.post("/send", dependencies=[Depends(require_bearer)])
async def send(req: SendRequest, request: Request) -> JSONResponse:
    """Send a message from one of the configured burners.

    Exactly one of `recipient` (E164) or `group_id` is required. The
    `account` field picks which burner sends; omitted defaults to
    accounts[0]. On success, the WS broadcast emits a `sent` event so
    test harnesses can confirm the rig actually fired (rather than
    racing against signal-cli's syncMessage echo, which lags by
    100ms-2s depending on network).
    """
    if bool(req.recipient) == bool(req.group_id):
        raise HTTPException(
            status_code=400,
            detail="exactly one of `recipient` or `group_id` is required",
        )
    if not state.bridge:
        raise HTTPException(status_code=503, detail="bridge not connected")

    from_account = _resolve_send_account(req.account)

    try:
        result = await state.bridge.send_text(
            recipient=req.recipient or "",
            text=req.text,
            account=from_account,
            group_id=req.group_id,
        )
    except Exception as e:
        trace(
            "send.failed",
            account=from_account,
            recipient=req.recipient,
            group=req.group_id,
            error=str(e),
        )
        raise HTTPException(status_code=502, detail=f"signal-cli send failed: {e}") from e

    # signal-cli's send response is shaped like:
    #   { "timestamp": 1715000000000, "results": [...] }
    signal_timestamp = None
    if isinstance(result, dict):
        signal_timestamp = result.get("timestamp")

    sent_event = {
        "kind": "sent",
        "ts": _now_iso(),
        "data": {
            "account": from_account,
            "recipient": req.recipient,
            "group_id": req.group_id,
            "text": req.text,
            "signal_timestamp": signal_timestamp,
        },
    }
    trace(
        "sent",
        account=from_account,
        recipient=req.recipient,
        group=req.group_id,
        length=len(req.text),
    )
    await state.hub.broadcast(sent_event)
    return JSONResponse(sent_event)


@app.websocket("/ws")
async def ws_endpoint(
    websocket: WebSocket,
    token: Optional[str] = Query(default=None),
    kind: Optional[str] = Query(default=None, description="Comma-separated kind prefix allowlist (e.g. 'inbound.text' or 'inbound')"),
    from_: Optional[str] = Query(default=None, alias="from", description="Comma-separated source E164/UUID allowlist"),
    account: Optional[str] = Query(default=None, description="Comma-separated burner-account E164 allowlist — only deliver events landing on these burners"),
    group: Optional[str] = Query(default=None, description="Comma-separated group-id allowlist; 'none' = non-group only"),
    text_contains: Optional[str] = Query(default=None, description="Case-insensitive substring match against data.text"),
    since: Optional[str] = Query(default=None, description="ISO-8601 or ms-epoch lower bound for data.timestamp_ms"),
) -> None:
    """Multi-subscriber broadcast WS with per-client filtering.

    Auth: token MUST be presented as either:
      - `Authorization: Bearer <token>` header during handshake (works with
        `websocat -H "Authorization: Bearer X"`), OR
      - `?token=<token>` query param (works with browser-native WebSocket(),
        which can't set arbitrary headers).

    Filters (all optional, AND-combined — see `Subscription`):
      ?kind=inbound.text,inbound.attachment   prefix-match allowlist
      ?from=+15550100000                      source E164/UUID allowlist
      ?account=+15550100005                   burner allowlist (which of our
                                              configured numbers received it)
      ?group=none                             only non-group events
      ?text_contains=<correlation-token>      pin to a test's marker
      ?since=2026-05-21T20:00:00Z             drop older events

    `ready` frames bypass filters — they're connection lifecycle.
    """
    auth_header = websocket.headers.get("authorization")

    # Header path first — preferred; query token is unavoidable for browsers
    # but it lands in proxy access logs which is a small leak surface.
    if auth_header:
        try:
            _require_token_from_header(auth_header)
        except HTTPException as e:
            await websocket.close(code=4401, reason=e.detail)
            return
    elif token:
        if not TOKEN:
            await websocket.close(code=4503, reason="rig token not configured")
            return
        import hmac

        if not hmac.compare_digest(token, TOKEN):
            await websocket.close(code=4401, reason="bad token")
            return
    else:
        await websocket.close(code=4401, reason="missing token")
        return

    sub = Subscription.from_query(
        kind=kind,
        from_=from_,
        account=account,
        group=group,
        text_contains=text_contains,
        since=since,
    )

    await websocket.accept()
    await state.hub.register(websocket, sub)
    # Tell THIS connecting client we're ready (useful so they don't sit
    # confused waiting for traffic). `ready` bypasses the filter.
    try:
        await websocket.send_json(
            {
                "kind": "ready",
                "ts": _now_iso(),
                "data": {
                    "accounts": list(ACCOUNTS),
                    "default_account": ACCOUNTS[0] if ACCOUNTS else None,
                    # Singular `account` kept for back-compat — older
                    # clients that read `ready.data.account` see the default.
                    "account": ACCOUNTS[0] if ACCOUNTS else None,
                },
            }
        )
    except Exception:
        pass

    try:
        # Sink loop: we don't actually expect inbound traffic from clients
        # (the WS is broadcast-only). But we have to await something or the
        # connection drops. receive_text() returns when the peer sends OR
        # disconnects.
        while True:
            # Allow clients to send anything as a no-op keepalive. Useful for
            # browser clients that don't have automatic keepalive control.
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        # Any other exception → drop this peer.
        pass
    finally:
        await state.hub.unregister(websocket)


def main_cli() -> None:
    """Entrypoint when invoked as `python -m signal_test_rig.main`."""
    import uvicorn

    uvicorn.run(
        "signal_test_rig.main:app",
        host=BIND,
        port=PORT,
        log_level="info",
    )


if __name__ == "__main__":
    main_cli()
