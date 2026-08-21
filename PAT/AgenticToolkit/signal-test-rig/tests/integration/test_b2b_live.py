"""Live A<->B integration test against the deployed Fly apps.

Opt-in: `uv run pytest -m integration`. Skipped by default.

Sends a real Signal message from each rig to the other, addressing by
ACI UUID (per `reference_signal_cli_aci_pni_quirk.md`), and asserts the
text body decrypts cleanly on the receiver's WS. Catches:
  - rig down / Fly app eviction
  - signal-cli daemon stuck
  - ACI/PNI regression (e.g. if someone reverts the rig to E164-only
    addressing and B2B silently breaks again)
  - State corruption that needs a `removeContact --forget` cycle

Cost: ~$0/run (just Signal Service round-trip, both apps already running).
Time: ~10s typical.

Env (with documented defaults so a dev can run without setting anything):
  PAT_SIGNAL_RIG_A_URL   default https://pat-signal-rig.fly.dev
  PAT_SIGNAL_RIG_B_URL   default https://pat-signal-rig-b.fly.dev
  PAT_SIGNAL_RIG_TOKEN   required — bearer for both rigs
"""
from __future__ import annotations

import asyncio
import json
import os
import secrets
import urllib.request
from typing import Optional

import pytest
import websockets


RIG_A = os.environ.get("PAT_SIGNAL_RIG_A_URL", "https://pat-signal-rig.fly.dev")
RIG_B = os.environ.get("PAT_SIGNAL_RIG_B_URL", "https://pat-signal-rig-b.fly.dev")
TOKEN = os.environ.get("PAT_SIGNAL_RIG_TOKEN", "")


def _need_token() -> str:
    if not TOKEN:
        pytest.skip("PAT_SIGNAL_RIG_TOKEN env var required for live integration tests")
    return TOKEN


def _http_get_json(url: str, token: str) -> dict:
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _http_post_json(url: str, token: str, body: dict) -> dict:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


async def _wait_for_text(
    rig_url: str, token: str, want_text: str, timeout_s: float = 20.0
) -> Optional[dict]:
    """Subscribe to a rig's WS and return the first `inbound.text` event whose
    body contains `want_text`. None on timeout."""
    ws_url = rig_url.replace("https://", "wss://").replace("http://", "ws://") + f"/ws?token={token}"
    try:
        async with websockets.connect(ws_url) as ws:
            deadline = asyncio.get_event_loop().time() + timeout_s
            while True:
                remaining = deadline - asyncio.get_event_loop().time()
                if remaining <= 0:
                    return None
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=remaining)
                except asyncio.TimeoutError:
                    return None
                obj = json.loads(msg)
                if obj.get("kind") != "inbound.text":
                    continue
                text = (obj.get("data", {}) or {}).get("text") or ""
                if want_text in text:
                    return obj
    except Exception:
        return None


@pytest.mark.integration
async def test_b2b_address_lookup():
    """Both rigs return a populated /address with an ACI UUID. Sanity check
    before the send test — failure here means a rig is sick."""
    token = _need_token()
    for url, name in [(RIG_A, "A"), (RIG_B, "B")]:
        body = _http_get_json(f"{url}/address", token)
        assert body.get("accounts"), f"{name} /address returned no accounts: {body}"
        addr = body["accounts"][0]
        assert addr.get("number"), f"{name} address missing number: {addr}"
        assert addr.get("uuid"), f"{name} address missing uuid: {addr}"


@pytest.mark.integration
async def test_b2b_a_to_b_decrypts():
    """A → B by UUID: text body lands as inbound.text on B's WS."""
    token = _need_token()
    b_addr = _http_get_json(f"{RIG_B}/address", token)["default"]
    corr = secrets.token_hex(4)
    body = f"a→b live {corr}"
    # Start listener BEFORE the send so we don't miss the event.
    listen = asyncio.create_task(_wait_for_text(RIG_B, token, corr, timeout_s=25.0))
    await asyncio.sleep(0.5)  # let the WS settle
    sent = _http_post_json(
        f"{RIG_A}/send",
        token,
        {"recipient": b_addr["uuid"], "text": body},
    )
    assert sent["kind"] == "sent"
    got = await listen
    assert got is not None, f"B never saw inbound.text containing {corr!r}"
    assert corr in got["data"]["text"]


@pytest.mark.integration
async def test_b2b_b_to_a_decrypts():
    """B → A by UUID: text body lands as inbound.text on A's WS."""
    token = _need_token()
    a_addr = _http_get_json(f"{RIG_A}/address", token)["default"]
    corr = secrets.token_hex(4)
    body = f"b→a live {corr}"
    listen = asyncio.create_task(_wait_for_text(RIG_A, token, corr, timeout_s=25.0))
    await asyncio.sleep(0.5)
    sent = _http_post_json(
        f"{RIG_B}/send",
        token,
        {"recipient": a_addr["uuid"], "text": body},
    )
    assert sent["kind"] == "sent"
    got = await listen
    assert got is not None, f"A never saw inbound.text containing {corr!r}"
    assert corr in got["data"]["text"]
