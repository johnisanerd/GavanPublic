"""Multi-account tests for signal-test-rig.

These exercise the multi-account refactor (PART A of TaskList #10):

  - `SIGNAL_TEST_RIG_ACCOUNTS=+A,+B` is honored; accounts[0] is the
    implicit default.
  - The singular `SIGNAL_TEST_RIG_ACCOUNT` alias still works (back-compat).
  - `POST /send` picks the right burner based on `account` (E164 or
    `[N]` index), and the fake daemon's `send` RPC gets the correct
    `account` param.
  - WS broadcasts include `data.account`, and the `?account=` filter
    isolates one burner's inbound traffic.
  - `/status` and `ready` report the multi-account shape.

Each test uses its own `multi_app_module` fixture below so envs are
reset between cases. The fake daemon stays the same — multi-account in
signal-cli's wire shape is "omit `-a`, send `account` per-RPC" which
the fake daemon happily echoes back.
"""
from __future__ import annotations

import importlib
import socket

import pytest
from fastapi.testclient import TestClient

# Reuse conftest's FakeDaemon — we just need a multi-account env layer
# on top.
from .conftest import FakeDaemon


def _pick_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def fake_daemon_multi():
    port = _pick_free_port()
    d = FakeDaemon(host="127.0.0.1", port=port)
    d.start()
    try:
        yield d
    finally:
        d.stop()


@pytest.fixture
def multi_app_module(monkeypatch, fake_daemon_multi):
    """Like `app_module` but configures TWO accounts."""
    monkeypatch.setenv("SIGNAL_TEST_RIG_TOKEN", "test-token-abc")
    # Use the plural form — the singular `SIGNAL_TEST_RIG_ACCOUNT` is
    # the alias case, covered by the back-compat test below.
    monkeypatch.setenv(
        "SIGNAL_TEST_RIG_ACCOUNTS", "+15550100005,+15550100006"
    )
    # Clear singular so the alias path isn't masking the plural.
    monkeypatch.delenv("SIGNAL_TEST_RIG_ACCOUNT", raising=False)
    monkeypatch.setenv("SIGNAL_TEST_RIG_TCP_HOST", fake_daemon_multi.host)
    monkeypatch.setenv("SIGNAL_TEST_RIG_TCP_PORT", str(fake_daemon_multi.port))
    monkeypatch.setenv("SIGNAL_TEST_RIG_MANAGE_DAEMON", "0")
    import signal_test_rig.main as m

    importlib.reload(m)
    return m


# --- env parsing + config -------------------------------------------------

def test_accounts_env_parses_csv(multi_app_module):
    """SIGNAL_TEST_RIG_ACCOUNTS=+A,+B → ACCOUNTS = [+A, +B] in declared order."""
    assert multi_app_module.ACCOUNTS == ["+15550100005", "+15550100006"]


def test_singular_account_env_still_works_as_alias(monkeypatch, fake_daemon_multi):
    """Existing single-account callers using SIGNAL_TEST_RIG_ACCOUNT still boot."""
    monkeypatch.setenv("SIGNAL_TEST_RIG_TOKEN", "test-token-abc")
    monkeypatch.setenv("SIGNAL_TEST_RIG_ACCOUNT", "+15551234567")
    monkeypatch.delenv("SIGNAL_TEST_RIG_ACCOUNTS", raising=False)
    monkeypatch.setenv("SIGNAL_TEST_RIG_TCP_HOST", fake_daemon_multi.host)
    monkeypatch.setenv("SIGNAL_TEST_RIG_TCP_PORT", str(fake_daemon_multi.port))
    monkeypatch.setenv("SIGNAL_TEST_RIG_MANAGE_DAEMON", "0")
    import signal_test_rig.main as m

    importlib.reload(m)
    assert m.ACCOUNTS == ["+15551234567"]
    with TestClient(m.app) as client:
        resp = client.get(
            "/status", headers={"Authorization": "Bearer test-token-abc"}
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["accounts"] == ["+15551234567"]
        assert body["default_account"] == "+15551234567"
        # back-compat: singular `account` field still present and == default
        assert body["account"] == "+15551234567"


def test_plural_wins_over_singular_when_both_set(monkeypatch, fake_daemon_multi):
    """If both env vars are set, plural form is authoritative."""
    monkeypatch.setenv("SIGNAL_TEST_RIG_TOKEN", "test-token-abc")
    monkeypatch.setenv("SIGNAL_TEST_RIG_ACCOUNTS", "+15550100005,+15550100006")
    monkeypatch.setenv("SIGNAL_TEST_RIG_ACCOUNT", "+19999999999")
    monkeypatch.setenv("SIGNAL_TEST_RIG_TCP_HOST", fake_daemon_multi.host)
    monkeypatch.setenv("SIGNAL_TEST_RIG_TCP_PORT", str(fake_daemon_multi.port))
    monkeypatch.setenv("SIGNAL_TEST_RIG_MANAGE_DAEMON", "0")
    import signal_test_rig.main as m

    importlib.reload(m)
    assert m.ACCOUNTS == ["+15550100005", "+15550100006"]
    assert "+19999999999" not in m.ACCOUNTS


def test_accounts_dedupe_preserves_order(monkeypatch, fake_daemon_multi):
    """Duplicate entries are collapsed; first occurrence wins for ordering."""
    monkeypatch.setenv("SIGNAL_TEST_RIG_TOKEN", "test-token-abc")
    monkeypatch.setenv(
        "SIGNAL_TEST_RIG_ACCOUNTS",
        "+15550100005, +15550100006 ,+15550100005",
    )
    monkeypatch.setenv("SIGNAL_TEST_RIG_TCP_HOST", fake_daemon_multi.host)
    monkeypatch.setenv("SIGNAL_TEST_RIG_TCP_PORT", str(fake_daemon_multi.port))
    monkeypatch.setenv("SIGNAL_TEST_RIG_MANAGE_DAEMON", "0")
    import signal_test_rig.main as m

    importlib.reload(m)
    assert m.ACCOUNTS == ["+15550100005", "+15550100006"]


# --- bridge subscribeReceive per-account ---------------------------------

def test_bridge_subscribes_each_account(multi_app_module, fake_daemon_multi):
    """Two accounts → two `subscribeReceive` RPCs, each with its account in params."""
    with TestClient(multi_app_module.app):
        pass  # startup happens inside the context

    subscribes = [
        params for method, params in fake_daemon_multi.received_calls
        if method == "subscribeReceive"
    ]
    accounts_subscribed = [p.get("account") for p in subscribes]
    assert sorted(accounts_subscribed) == sorted(
        ["+15550100005", "+15550100006"]
    ), f"expected one subscribeReceive per account, got {subscribes}"


# --- /send routing --------------------------------------------------------

def test_send_defaults_to_first_account(multi_app_module, fake_daemon_multi):
    """No `account` field → uses accounts[0]; daemon sees `account: +A`."""
    with TestClient(multi_app_module.app) as client:
        resp = client.post(
            "/send",
            headers={"Authorization": "Bearer test-token-abc"},
            json={"recipient": "+14155550100", "text": "from default"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["data"]["account"] == "+15550100005"

    send_params = next(
        p for m, p in fake_daemon_multi.received_calls if m == "send"
    )
    assert send_params["account"] == "+15550100005"
    assert send_params["recipient"] == ["+14155550100"]
    assert send_params["message"] == "from default"


def test_send_picks_named_account(multi_app_module, fake_daemon_multi):
    """`account=+B` → daemon sees `account: +B`, NOT the default."""
    with TestClient(multi_app_module.app) as client:
        resp = client.post(
            "/send",
            headers={"Authorization": "Bearer test-token-abc"},
            json={
                "recipient": "+14155550100",
                "text": "from B",
                "account": "+15550100006",
            },
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["data"]["account"] == "+15550100006"

    send_params = next(
        p for m, p in fake_daemon_multi.received_calls if m == "send"
    )
    assert send_params["account"] == "+15550100006"


def test_send_accepts_index_addressing(multi_app_module, fake_daemon_multi):
    """`account=[1]` resolves positionally → second configured burner."""
    with TestClient(multi_app_module.app) as client:
        resp = client.post(
            "/send",
            headers={"Authorization": "Bearer test-token-abc"},
            json={
                "recipient": "+14155550100",
                "text": "from index 1",
                "account": "[1]",
            },
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["data"]["account"] == "+15550100006"


def test_send_rejects_unknown_account(multi_app_module, fake_daemon_multi):
    """Unconfigured E164 → 400, NOT a silent fall-through to the default."""
    with TestClient(multi_app_module.app) as client:
        resp = client.post(
            "/send",
            headers={"Authorization": "Bearer test-token-abc"},
            json={
                "recipient": "+14155550100",
                "text": "x",
                "account": "+19999999999",
            },
        )
        assert resp.status_code == 400
        assert "not configured" in resp.text


def test_send_rejects_out_of_range_index(multi_app_module, fake_daemon_multi):
    """`[5]` when only 2 accounts → 400."""
    with TestClient(multi_app_module.app) as client:
        resp = client.post(
            "/send",
            headers={"Authorization": "Bearer test-token-abc"},
            json={
                "recipient": "+14155550100",
                "text": "x",
                "account": "[5]",
            },
        )
        assert resp.status_code == 400
        assert "out of range" in resp.text


# --- status + ready frame multi-account shape ----------------------------

def test_status_reports_all_accounts(multi_app_module, fake_daemon_multi):
    """`/status` exposes the full `accounts` list + `default_account`."""
    with TestClient(multi_app_module.app) as client:
        resp = client.get(
            "/status", headers={"Authorization": "Bearer test-token-abc"}
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["accounts"] == ["+15550100005", "+15550100006"]
        assert body["default_account"] == "+15550100005"
        # back-compat: singular `account` field still present and == default
        assert body["account"] == "+15550100005"


def test_ws_ready_frame_includes_accounts(multi_app_module, fake_daemon_multi):
    """Connecting WS clients see the multi-account shape in the `ready` frame."""
    with TestClient(multi_app_module.app) as client:
        with client.websocket_connect(
            "/ws?token=test-token-abc"
        ) as ws:
            ready = ws.receive_json()
            assert ready["kind"] == "ready"
            assert ready["data"]["accounts"] == [
                "+15550100005", "+15550100006"
            ]
            assert ready["data"]["default_account"] == "+15550100005"
            # back-compat: singular `account` field still present
            assert ready["data"]["account"] == "+15550100005"


# --- inbound `data.account` + WS account filter --------------------------

def _push_inbound(daemon, *, account: str, source: str, text: str, ts: int = 1) -> None:
    """Helper: synthesize a multi-account `receive` push."""
    daemon.push_notification(
        "receive",
        {
            "account": account,  # signal-cli stamps this in outer params
            "envelope": {
                "source": source,
                "sourceNumber": source,
                "dataMessage": {"timestamp": ts, "message": text},
            },
        },
    )


def test_inbound_carries_account(multi_app_module, fake_daemon_multi):
    """data.account on every broadcast frame names the receiving burner."""
    with TestClient(multi_app_module.app) as client:
        with client.websocket_connect(
            "/ws?token=test-token-abc"
        ) as ws:
            ws.receive_json()  # drain ready
            _push_inbound(
                fake_daemon_multi,
                account="+15550100006",
                source="+14155559999",
                text="hello B",
            )
            msg = ws.receive_json()
            assert msg["kind"] == "inbound.text"
            assert msg["data"]["account"] == "+15550100006"
            assert msg["data"]["source"] == "+14155559999"


def test_ws_account_filter_isolates_one_burner(multi_app_module, fake_daemon_multi):
    """?account=+B → subscriber only sees envelopes that landed on +B."""
    import time

    with TestClient(multi_app_module.app) as client:
        with client.websocket_connect(
            "/ws?token=test-token-abc&account=+15550100006"
        ) as ws:
            ws.receive_json()  # drain ready

            # Two pushes — one on +A, one on +B. Only the +B push should
            # reach this subscriber.
            _push_inbound(
                fake_daemon_multi,
                account="+15550100005",
                source="+14155551111",
                text="to A — should be dropped",
            )
            _push_inbound(
                fake_daemon_multi,
                account="+15550100006",
                source="+14155552222",
                text="to B — should be delivered",
            )

            # Read until we see a B message, with a short timeout to avoid
            # hanging if the filter is broken.
            end = time.time() + 2.0
            got: list[dict] = []
            while time.time() < end:
                try:
                    got.append(ws.receive_json())
                except Exception:
                    break
                if got[-1]["data"].get("account") == "+15550100006":
                    break

            assert any(
                m["data"].get("account") == "+15550100006"
                for m in got
            ), f"never saw +B frame: {got}"
            # And no +A frame leaked through.
            assert not any(
                m["data"].get("account") == "+15550100005"
                for m in got
            ), f"+A frame leaked past filter: {got}"


def test_ws_two_subscribers_split_by_account(multi_app_module, fake_daemon_multi):
    """Two subscribers, each filtered to one burner — independent slices."""
    with TestClient(multi_app_module.app) as client:
        with client.websocket_connect(
            "/ws?token=test-token-abc&account=+15550100005"
        ) as ws_a, client.websocket_connect(
            "/ws?token=test-token-abc&account=+15550100006"
        ) as ws_b:
            ws_a.receive_json()  # ready
            ws_b.receive_json()  # ready

            _push_inbound(
                fake_daemon_multi,
                account="+15550100005",
                source="+14155551111",
                text="for A",
            )
            _push_inbound(
                fake_daemon_multi,
                account="+15550100006",
                source="+14155552222",
                text="for B",
            )

            msg_a = ws_a.receive_json()
            msg_b = ws_b.receive_json()

            assert msg_a["data"]["account"] == "+15550100005"
            assert msg_a["data"]["text"] == "for A"
            assert msg_b["data"]["account"] == "+15550100006"
            assert msg_b["data"]["text"] == "for B"


# --- bridge unit: config validation -------------------------------------

def test_bridge_config_rejects_empty_accounts():
    from signal_test_rig.signal_cli_bridge import BridgeConfig

    with pytest.raises(ValueError, match="non-empty"):
        BridgeConfig(accounts=[])


def test_bridge_config_dedupes_accounts():
    from signal_test_rig.signal_cli_bridge import BridgeConfig

    cfg = BridgeConfig(accounts=["+A", "+B", "+A"])
    assert cfg.accounts == ["+A", "+B"]
    assert cfg.default_account == "+A"
