"""Shared fixtures for LLM integration tests."""

import subprocess
import time

import httpx
import pytest


@pytest.fixture(scope="session")
def running_server(real_api_key):
    """Start the server as a subprocess and wait for it to be ready.

    This fixture is session-scoped to reuse the same server across all
    LLM tests, avoiding the overhead of starting/stopping for each test.
    """
    port = 18765
    proc = subprocess.Popen(
        ["uvicorn", "src.main:app", "--host", "127.0.0.1", "--port", str(port)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    base_url = f"http://127.0.0.1:{port}"
    for _ in range(30):
        try:
            resp = httpx.get(f"{base_url}/health", timeout=1.0)
            if resp.status_code == 200:
                break
        except httpx.ConnectError:
            time.sleep(1)
    else:
        proc.terminate()
        raise RuntimeError("Server failed to start")

    yield base_url

    proc.terminate()
    proc.wait(timeout=5)
