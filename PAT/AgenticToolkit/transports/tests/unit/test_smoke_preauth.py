"""Smoke-caller pre-auth gate (CallSession token → caller mapping).

The mapping must be:
  - inert unless BOTH SMOKE_PREAUTH_TOKEN and SMOKE_CALLER_E164 are set,
  - granted only on an exact token match in start metadata,
  - the mapped number always the server-side env value, never client input.

Pure __init__ logic — no WS, no nanoclaw, no Cartesia.
"""
from __future__ import annotations

import main


TOKEN = "test-secret-token"
E164 = "+15005550006"


def _session(monkeypatch, start: dict, *, token: str = TOKEN, e164: str = E164):
    monkeypatch.setattr(main, "SMOKE_PREAUTH_TOKEN", token)
    monkeypatch.setattr(main, "SMOKE_CALLER_E164", e164)
    return main.CallSession(websocket=None, call_request=start)  # type: ignore[arg-type]


def test_valid_token_maps_to_server_side_e164(monkeypatch):
    s = _session(monkeypatch, {"from": "websocket", "metadata": {"smoke_preauth": TOKEN}})
    assert s.smoke_preauth is True
    assert s.caller_number == E164


def test_valid_token_ignores_client_supplied_from(monkeypatch):
    # Even if the client smuggles a from through metadata relay, the mapped
    # identity is the env value, not the claim.
    s = _session(monkeypatch, {"from": "+19998887777", "metadata": {"smoke_preauth": TOKEN}})
    assert s.caller_number == E164


def test_wrong_token_leaves_caller_untouched(monkeypatch):
    s = _session(monkeypatch, {"from": "websocket", "metadata": {"smoke_preauth": "wrong"}})
    assert s.smoke_preauth is False
    assert s.caller_number == "websocket"


def test_no_metadata_leaves_caller_untouched(monkeypatch):
    s = _session(monkeypatch, {"from": "websocket"})
    assert s.smoke_preauth is False
    assert s.caller_number == "websocket"


def test_feature_inert_without_env(monkeypatch):
    for token, e164 in (("", E164), (TOKEN, ""), ("", "")):
        s = _session(
            monkeypatch,
            {"from": "websocket", "metadata": {"smoke_preauth": TOKEN}},
            token=token,
            e164=e164,
        )
        assert s.smoke_preauth is False
        assert s.caller_number == "websocket"


def test_non_string_token_rejected(monkeypatch):
    s = _session(monkeypatch, {"from": "websocket", "metadata": {"smoke_preauth": 12345}})
    assert s.smoke_preauth is False
    assert s.caller_number == "websocket"


def test_pstn_caller_unaffected(monkeypatch):
    # Real PSTN start: Cartesia sets from itself; no smoke metadata.
    s = _session(monkeypatch, {"from": "+15550100008", "metadata": None})
    assert s.smoke_preauth is False
    assert s.caller_number == "+15550100008"
