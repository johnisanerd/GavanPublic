"""Test the REST /send endpoint end-to-end through the real bridge,
against the fake signal-cli daemon."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


def test_send_to_recipient_hits_signal_cli(app_module, fake_daemon):
    """POST /send with E164 recipient → bridge → fake daemon sees `send`."""
    with TestClient(app_module.app) as client:
        resp = client.post(
            "/send",
            headers={"Authorization": "Bearer test-token-abc"},
            json={"recipient": "+14155550100", "text": "hello world"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["kind"] == "sent"
        assert body["data"]["recipient"] == "+14155550100"
        assert body["data"]["text"] == "hello world"
        assert body["data"]["signal_timestamp"] == 1715000000000

    # Fake daemon saw subscribeReceive (during start) + send (the test).
    methods = [m for m, _ in fake_daemon.received_calls]
    assert "subscribeReceive" in methods
    assert "send" in methods

    # Validate the params shape: recipient as array, account, message text.
    send_params = next(p for m, p in fake_daemon.received_calls if m == "send")
    assert send_params["account"] == "+15551234567"
    assert send_params["message"] == "hello world"
    assert send_params["recipient"] == ["+14155550100"]
    assert "groupId" not in send_params


def test_send_to_group_uses_groupid(app_module, fake_daemon):
    """POST /send with group_id → bridge sends `groupId`, no `recipient`."""
    with TestClient(app_module.app) as client:
        resp = client.post(
            "/send",
            headers={"Authorization": "Bearer test-token-abc"},
            json={"group_id": "abc123groupid", "text": "group hi"},
        )
        assert resp.status_code == 200, resp.text

    send_params = next(p for m, p in fake_daemon.received_calls if m == "send")
    assert send_params["groupId"] == "abc123groupid"
    assert "recipient" not in send_params
    assert send_params["message"] == "group hi"


def test_send_rejects_missing_token(app_module, fake_daemon):
    """No Authorization header → 401."""
    with TestClient(app_module.app) as client:
        resp = client.post(
            "/send",
            json={"recipient": "+14155550100", "text": "x"},
        )
        assert resp.status_code == 401


def test_send_rejects_bad_token(app_module, fake_daemon):
    """Wrong bearer → 401."""
    with TestClient(app_module.app) as client:
        resp = client.post(
            "/send",
            headers={"Authorization": "Bearer wrong"},
            json={"recipient": "+14155550100", "text": "x"},
        )
        assert resp.status_code == 401


def test_send_rejects_neither_recipient_nor_group(app_module, fake_daemon):
    with TestClient(app_module.app) as client:
        resp = client.post(
            "/send",
            headers={"Authorization": "Bearer test-token-abc"},
            json={"text": "x"},
        )
        assert resp.status_code == 400


def test_send_rejects_both_recipient_and_group(app_module, fake_daemon):
    with TestClient(app_module.app) as client:
        resp = client.post(
            "/send",
            headers={"Authorization": "Bearer test-token-abc"},
            json={"recipient": "+14155550100", "group_id": "g", "text": "x"},
        )
        assert resp.status_code == 400


def test_healthz_does_not_require_auth(app_module, fake_daemon):
    """`/healthz` is intentionally unauthenticated (liveness probe)."""
    with TestClient(app_module.app) as client:
        resp = client.get("/healthz")
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"


def test_status_requires_auth(app_module, fake_daemon):
    with TestClient(app_module.app) as client:
        # No token → 401
        assert client.get("/status").status_code == 401
        # With token → 200
        resp = client.get(
            "/status", headers={"Authorization": "Bearer test-token-abc"}
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["account"] == "+15551234567"
        assert body["bridge_connected"] is True


def test_send_surfaces_signal_cli_error(app_module, fake_daemon):
    """If signal-cli returns a JSON-RPC error, the rig returns 502."""
    fake_daemon.error_for_method["send"] = "RecipientNotFoundException"
    with TestClient(app_module.app) as client:
        resp = client.post(
            "/send",
            headers={"Authorization": "Bearer test-token-abc"},
            json={"recipient": "+14155550100", "text": "x"},
        )
        assert resp.status_code == 502
        assert "RecipientNotFoundException" in resp.text
