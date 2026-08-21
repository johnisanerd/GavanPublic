"""signal-test-rig — local WS+REST wrapper around signal-cli for PAT smoketests.

See `signal_test_rig.main` for the FastAPI app and `signal_test_rig.signal_cli_bridge`
for the JSON-RPC client that talks to a `signal-cli daemon --tcp` process.
"""

__all__ = ["main", "signal_cli_bridge"]
