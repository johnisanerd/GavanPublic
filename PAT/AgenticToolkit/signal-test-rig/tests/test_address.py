"""Test GET /address — returns the rig's own account address (number + ACI UUID + profile name).

Critical because tests that send between two signal-cli-only rig burners MUST
address by UUID to avoid the silent ACI/PNI decryption failure documented in
`reference_signal_cli_aci_pni_quirk.md`. This endpoint is how a test discovers
the receiving rig's UUID.
"""
from __future__ import annotations

from fastapi.testclient import TestClient


def test_address_returns_accounts_with_uuid(app_module, fake_daemon):
    """GET /address → list of accounts each with number, uuid, profile_name.

    The fake daemon answers `listIdentities` with a self-entry containing the
    account's E164 number and a UUID. The endpoint promotes that to the
    response shape callers depend on.
    """
    fake_daemon.handlers["listIdentities"] = lambda params: [
        {
            "number": params.get("account"),
            "uuid": "00000000-0000-4000-8000-000000000001",
            "fingerprint": "05 aa bb cc dd",
            "name": "Test Rig",
        },
        # Noise — a contact entry, NOT this account. Should be ignored.
        {
            "number": "+14155550000",
            "uuid": "00000000-0000-4000-8000-000000000999",
            "fingerprint": "05 ee ff",
        },
    ]
    with TestClient(app_module.app) as client:
        resp = client.get(
            "/address", headers={"Authorization": "Bearer test-token-abc"}
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert "accounts" in body
        assert len(body["accounts"]) >= 1
        addr = body["accounts"][0]
        assert addr["number"] == "+15551234567"  # the fixture's ACCOUNTS[0]
        assert addr["uuid"] == "00000000-0000-4000-8000-000000000001"
        assert addr["profile_name"] == "Test Rig"
        assert body["default"]["uuid"] == addr["uuid"]


def test_address_requires_token(app_module, fake_daemon):
    with TestClient(app_module.app) as client:
        resp = client.get("/address")
        assert resp.status_code == 401


def test_address_degrades_when_listidentities_errors(app_module, fake_daemon):
    """If signal-cli's listIdentities RPC errors, the endpoint returns the
    account with uuid=null rather than 500-ing — caller can still see what
    accounts exist, just without UUID resolution."""
    fake_daemon.error_for_method["listIdentities"] = "boom"
    with TestClient(app_module.app) as client:
        resp = client.get(
            "/address", headers={"Authorization": "Bearer test-token-abc"}
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["accounts"][0]["number"] == "+15551234567"
        assert body["accounts"][0]["uuid"] is None
