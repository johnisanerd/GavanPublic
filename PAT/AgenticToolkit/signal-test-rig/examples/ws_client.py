"""Minimal WS subscriber — prints every event the rig broadcasts.

Run:
    uv run --with websockets python examples/ws_client.py

Env:
    SIGNAL_TEST_RIG_URL    default ws://127.0.0.1:7585/ws
    SIGNAL_TEST_RIG_TOKEN  required (same value as the rig)
"""
from __future__ import annotations

import asyncio
import json
import os
import sys

import websockets


async def main() -> None:
    url = os.environ.get("SIGNAL_TEST_RIG_URL", "ws://127.0.0.1:7585/ws")
    token = os.environ.get("SIGNAL_TEST_RIG_TOKEN", "")
    if not token:
        sys.exit("SIGNAL_TEST_RIG_TOKEN env var is required")

    # Prefer header auth so the token doesn't end up in proxy access logs.
    headers = {"Authorization": f"Bearer {token}"}
    async with websockets.connect(url, additional_headers=headers) as ws:
        print(f"[ws] connected to {url}", flush=True)
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                print(f"[ws] non-json frame: {raw!r}", flush=True)
                continue
            print(json.dumps(msg, indent=2), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
