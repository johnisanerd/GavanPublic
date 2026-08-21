"""Pytest configuration and fixtures.

pytest-dotenv loads .env automatically before tests run.
"""

import os

import pytest


def pytest_configure(config):
    """Set up environment variables and markers before test collection."""
    # Register custom markers
    config.addinivalue_line(
        "markers", "llm: marks tests that call real LLM APIs (deselect with '-m \"not llm\"')"
    )

    # Set up fake credentials for unit tests, but don't override real keys from .env
    _setdefault("SLACK_SIGNING_SECRET", "test_signing_secret")
    _setdefault("SLACK_BOT_TOKEN", "xoxb-test-token")
    _setdefault("OPENROUTER_API_KEY", "sk-or-test-key")
    _setdefault("TIMEOUT_S", "30.0")
    _setdefault("AI_CALLS_PER_SECOND", "5")
    _setdefault("AI_MAX_QUEUE", "50")
    _setdefault("ACCEPT_NON_SLACK_REQUESTS", "true")


def _setdefault(key: str, value: str) -> None:
    """Set env var only if not already set."""
    if key not in os.environ:
        os.environ[key] = value


@pytest.fixture(scope="session")
def real_api_key():
    """Fixture that provides real API key from environment.

    Use this in LLM tests that need actual API access.
    Skips test if OPENROUTER_API_KEY is not set or is a test key.

    Session-scoped since the API key doesn't change during tests.
    """
    key = os.environ.get("OPENROUTER_API_KEY", "")
    if not key or key.startswith("sk-or-test"):
        pytest.skip("Real OPENROUTER_API_KEY required for this test")
    return key
