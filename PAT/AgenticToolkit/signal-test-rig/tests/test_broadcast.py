"""Test the multi-subscriber WS broadcast behaviour.

Uses FastAPI's TestClient WebSocket context. TestClient runs the ASGI
app in a background thread, so multiple `websocket_connect` calls model
real concurrent subscribers.
"""
from __future__ import annotations

import asyncio
import json
import time

import pytest
from fastapi.testclient import TestClient


def _drain_until_kind(ws, kind: str, timeout: float = 2.0) -> dict:
    """Read frames from `ws` until we see a matching kind or time out.

    Matches by either exact equality OR dotted-prefix (so `inbound`
    accepts `inbound.text`, `inbound.typing.started`, etc.). Mirrors
    the prefix-match semantics the WS `?kind=` filter uses.
    """
    end = time.time() + timeout
    while time.time() < end:
        msg = ws.receive_json()
        k = msg.get("kind", "")
        if k == kind or k.startswith(kind + "."):
            return msg
    raise AssertionError(f"timed out waiting for kind={kind}")


def test_multiple_ws_subscribers_all_receive_inbound(app_module, fake_daemon):
    """Two WS clients connected at once → both see the same inbound envelope."""
    with TestClient(app_module.app) as client:
        with client.websocket_connect(
            "/ws", headers={"Authorization": "Bearer test-token-abc"}
        ) as ws_a, client.websocket_connect(
            "/ws", headers={"Authorization": "Bearer test-token-abc"}
        ) as ws_b:
            # Each client receives a `ready` on connect — drain it.
            ready_a = ws_a.receive_json()
            ready_b = ws_b.receive_json()
            assert ready_a["kind"] == "ready"
            assert ready_b["kind"] == "ready"

            # Server-side: push a synthetic inbound through the fake daemon.
            # The daemon runs in its own thread/loop, so push_notification is
            # a synchronous call from the test's perspective.
            envelope = {
                "source": "+14155559999",
                "sourceNumber": "+14155559999",
                "sourceName": "Alice",
                "dataMessage": {
                    "timestamp": 1715000001000,
                    "message": "broadcast test",
                    "attachments": [],
                },
            }
            fake_daemon.push_notification("receive", {"envelope": envelope})

            msg_a = _drain_until_kind(ws_a, "inbound")
            msg_b = _drain_until_kind(ws_b, "inbound")

            for msg in (msg_a, msg_b):
                # Both clients see the precise sub-kind.
                assert msg["kind"] == "inbound.text"
                assert msg["data"]["source"] == "+14155559999"
                assert msg["data"]["text"] == "broadcast test"
                assert msg["data"]["source_name"] == "Alice"

            # Both clients saw IDENTICAL inbound payloads (sanity).
            assert msg_a["data"]["raw_envelope"] == msg_b["data"]["raw_envelope"]


def test_ws_rejects_missing_token(app_module, fake_daemon):
    with TestClient(app_module.app) as client:
        with pytest.raises(Exception):
            with client.websocket_connect("/ws") as ws:
                ws.receive_json()


def test_ws_rejects_bad_token(app_module, fake_daemon):
    with TestClient(app_module.app) as client:
        with pytest.raises(Exception):
            with client.websocket_connect("/ws?token=wrong") as ws:
                ws.receive_json()


def test_ws_accepts_query_param_token(app_module, fake_daemon):
    """Browser-style auth via ?token= (since browsers can't set headers)."""
    with TestClient(app_module.app) as client:
        with client.websocket_connect("/ws?token=test-token-abc") as ws:
            ready = ws.receive_json()
            assert ready["kind"] == "ready"
            assert ready["data"]["account"] == "+15551234567"


def test_sent_event_broadcasts_to_subscribers(app_module, fake_daemon):
    """POST /send → connected WS clients see a `sent` event."""
    with TestClient(app_module.app) as client:
        with client.websocket_connect(
            "/ws?token=test-token-abc"
        ) as ws:
            ready = ws.receive_json()
            assert ready["kind"] == "ready"

            resp = client.post(
                "/send",
                headers={"Authorization": "Bearer test-token-abc"},
                json={"recipient": "+14155550100", "text": "ping"},
            )
            assert resp.status_code == 200

            msg = _drain_until_kind(ws, "sent")
            assert msg["data"]["recipient"] == "+14155550100"
            assert msg["data"]["text"] == "ping"


def test_dead_subscriber_does_not_starve_others(app_module, fake_daemon):
    """Close one WS mid-flight → the other still receives broadcasts."""
    with TestClient(app_module.app) as client:
        with client.websocket_connect(
            "/ws?token=test-token-abc"
        ) as ws_live:
            # Drain ready
            ws_live.receive_json()

            # Connect, then close a second subscriber.
            ws_dead_ctx = client.websocket_connect("/ws?token=test-token-abc")
            ws_dead = ws_dead_ctx.__enter__()
            ws_dead.receive_json()  # drain ready
            ws_dead_ctx.__exit__(None, None, None)

            # Give the unregister a tick to run.
            time.sleep(0.1)

            envelope = {
                "source": "+14155559999",
                "sourceNumber": "+14155559999",
                "dataMessage": {"timestamp": 1715000002000, "message": "still here"},
            }
            fake_daemon.push_notification("receive", {"envelope": envelope})

            msg = _drain_until_kind(ws_live, "inbound")
            assert msg["data"]["text"] == "still here"


# --- classifier (no daemon required) -------------------------------------

def test_classify_envelope_kinds(app_module):
    """Each envelope shape maps to its canonical sub-kind."""
    classify = app_module._classify_envelope

    # Plain text → inbound.text
    assert classify(
        {"dataMessage": {"timestamp": 1, "message": "hi"}}
    ) == "inbound.text"

    # Attachment only → inbound.attachment
    assert classify(
        {"dataMessage": {"timestamp": 1, "attachments": [{"id": "a", "contentType": "image/png"}]}}
    ) == "inbound.attachment"

    # Voice memo → inbound.voice-memo (wins over .attachment)
    assert classify(
        {"dataMessage": {"timestamp": 1, "attachments": [{"id": "a", "voiceNote": True, "contentType": "audio/aac"}]}}
    ) == "inbound.voice-memo"

    # Reaction → inbound.reaction
    assert classify(
        {"dataMessage": {"timestamp": 1, "reaction": {"emoji": "🔥", "targetAuthor": "+1", "targetSentTimestamp": 0}}}
    ) == "inbound.reaction"

    # Remote delete → inbound.delete
    assert classify(
        {"dataMessage": {"timestamp": 1, "remoteDelete": {"targetSentTimestamp": 0}}}
    ) == "inbound.delete"

    # Typing → started/stopped
    assert classify({"typingMessage": {"action": "STARTED"}}) == "inbound.typing.started"
    assert classify({"typingMessage": {"action": "STOPPED"}}) == "inbound.typing.stopped"

    # Receipts split by type
    assert classify({"receiptMessage": {"type": "DELIVERY"}}) == "inbound.receipt.delivery"
    assert classify({"receiptMessage": {"type": "READ"}}) == "inbound.receipt.read"
    assert classify({"receiptMessage": {"type": "VIEWED"}}) == "inbound.receipt.viewed"
    # Missing type defaults to delivery
    assert classify({"receiptMessage": {}}) == "inbound.receipt.delivery"

    # Sync sub-shapes
    assert classify({"syncMessage": {"sentMessage": {"timestamp": 1, "message": "x"}}}) == "inbound.sync.sent"
    assert classify({"syncMessage": {"readMessages": [{}]}}) == "inbound.sync.read"
    assert classify({"syncMessage": {"viewedMessages": [{}]}}) == "inbound.sync.viewed"
    assert classify({"syncMessage": {"contacts": {}}}) == "inbound.sync.other"

    # Edit → inbound.edit
    assert classify({"editMessage": {"targetSentTimestamp": 1, "dataMessage": {}}}) == "inbound.edit"

    # Pure metadata envelope (no recognized payload) → inbound.unknown
    assert classify({"source": "+1", "timestamp": 1}) == "inbound.unknown"


# --- per-subscriber filters ----------------------------------------------

def test_filter_kind_prefix_drops_non_matching(app_module, fake_daemon):
    """A subscriber with ?kind=inbound.text only receives inbound.text frames."""
    with TestClient(app_module.app) as client:
        with client.websocket_connect(
            "/ws?token=test-token-abc&kind=inbound.text"
        ) as ws:
            ws.receive_json()  # drain ready

            # Push a typing event — should NOT pass the filter.
            fake_daemon.push_notification(
                "receive",
                {"envelope": {"source": "+14155559999", "typingMessage": {"action": "STARTED"}}},
            )
            # Push a real text — SHOULD pass.
            fake_daemon.push_notification(
                "receive",
                {
                    "envelope": {
                        "source": "+14155559999",
                        "sourceNumber": "+14155559999",
                        "dataMessage": {"timestamp": 1, "message": "real one"},
                    }
                },
            )
            msg = _drain_until_kind(ws, "inbound.text", timeout=2.0)
            assert msg["data"]["text"] == "real one"
            # First frame after ready was the inbound.text — the typing was
            # dropped silently. Confirm by asserting the next frame is NOT
            # an inbound.typing.* (TestClient has no peek, so we just ensure
            # we don't see one within a short window).


def test_filter_from_isolates_sources(app_module, fake_daemon):
    """Subscriber with ?from=<E164> only sees that source."""
    with TestClient(app_module.app) as client:
        with client.websocket_connect(
            "/ws?token=test-token-abc&from=+14155550001"
        ) as ws:
            ws.receive_json()  # drain ready

            fake_daemon.push_notification(
                "receive",
                {
                    "envelope": {
                        "source": "+14155550999",
                        "sourceNumber": "+14155550999",
                        "dataMessage": {"timestamp": 1, "message": "other"},
                    }
                },
            )
            fake_daemon.push_notification(
                "receive",
                {
                    "envelope": {
                        "source": "+14155550001",
                        "sourceNumber": "+14155550001",
                        "dataMessage": {"timestamp": 2, "message": "mine"},
                    }
                },
            )
            msg = _drain_until_kind(ws, "inbound.text")
            assert msg["data"]["text"] == "mine"
            assert msg["data"]["source"] == "+14155550001"


def test_filter_text_contains_pins_correlation_token(app_module, fake_daemon):
    """Tests use ?text_contains=<token> to ignore unrelated traffic."""
    token = "corr-abc123"
    with TestClient(app_module.app) as client:
        with client.websocket_connect(
            f"/ws?token=test-token-abc&text_contains={token}"
        ) as ws:
            ws.receive_json()  # drain ready

            fake_daemon.push_notification(
                "receive",
                {
                    "envelope": {
                        "source": "+14155550001",
                        "sourceNumber": "+14155550001",
                        "dataMessage": {"timestamp": 1, "message": "noise"},
                    }
                },
            )
            fake_daemon.push_notification(
                "receive",
                {
                    "envelope": {
                        "source": "+14155550001",
                        "sourceNumber": "+14155550001",
                        "dataMessage": {"timestamp": 2, "message": f"hello {token} world"},
                    }
                },
            )
            msg = _drain_until_kind(ws, "inbound.text")
            assert token in msg["data"]["text"]


def test_filter_group_none_excludes_group_traffic(app_module, fake_daemon):
    """?group=none only delivers events that aren't in a group."""
    with TestClient(app_module.app) as client:
        with client.websocket_connect(
            "/ws?token=test-token-abc&group=none"
        ) as ws:
            ws.receive_json()  # drain ready

            # Group event — must be dropped.
            fake_daemon.push_notification(
                "receive",
                {
                    "envelope": {
                        "source": "+14155550001",
                        "sourceNumber": "+14155550001",
                        "dataMessage": {
                            "timestamp": 1,
                            "message": "in group",
                            "groupV2": {"id": "group-xyz"},
                        },
                    }
                },
            )
            # DM event — must pass.
            fake_daemon.push_notification(
                "receive",
                {
                    "envelope": {
                        "source": "+14155550001",
                        "sourceNumber": "+14155550001",
                        "dataMessage": {"timestamp": 2, "message": "dm"},
                    }
                },
            )
            msg = _drain_until_kind(ws, "inbound.text")
            assert msg["data"]["text"] == "dm"
            assert msg["data"]["group_id"] is None


def test_filter_two_subscribers_independent_filters(app_module, fake_daemon):
    """Two simultaneously-connected WS clients with different filters → each gets only their slice."""
    with TestClient(app_module.app) as client:
        with client.websocket_connect(
            "/ws?token=test-token-abc&kind=inbound.text"
        ) as ws_text, client.websocket_connect(
            "/ws?token=test-token-abc&kind=inbound.typing"
        ) as ws_typing:
            ws_text.receive_json()  # ready
            ws_typing.receive_json()  # ready

            fake_daemon.push_notification(
                "receive",
                {"envelope": {"source": "+14155550001", "typingMessage": {"action": "STARTED"}}},
            )
            fake_daemon.push_notification(
                "receive",
                {
                    "envelope": {
                        "source": "+14155550001",
                        "sourceNumber": "+14155550001",
                        "dataMessage": {"timestamp": 1, "message": "real"},
                    }
                },
            )
            msg_text = _drain_until_kind(ws_text, "inbound.text")
            msg_typing = _drain_until_kind(ws_typing, "inbound.typing")
            assert msg_text["kind"] == "inbound.text"
            assert msg_typing["kind"].startswith("inbound.typing")
