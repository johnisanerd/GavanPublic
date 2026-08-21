"""Shared pytest fixtures for voice-transport real-API integration tests.

Gating: tests under tests/real_cartesia/ are skipped unless
CARTESIA_API_KEY is set in the environment. The default `pnpm test`
should NOT run these — they spend real money. Invoke explicitly via
`scripts/run-cartesia-real-tests.sh` or by pointing pytest at the
specific path.
"""
from __future__ import annotations

import os

import pytest


def pytest_collection_modifyitems(config, items):
    """Auto-skip real-Cartesia tests if no API key present.

    Marker convention: tests that hit a real Cartesia endpoint
    should declare `@pytest.mark.real_cartesia` (or live under the
    `tests/real_cartesia/` subdir). Without CARTESIA_API_KEY we
    skip rather than fail — these are opt-in.
    """
    if os.getenv("CARTESIA_API_KEY"):
        return
    skip_real = pytest.mark.skip(reason="CARTESIA_API_KEY not set; opt-in test")
    for item in items:
        if "real_cartesia" in item.keywords or "/real_cartesia/" in str(item.fspath):
            item.add_marker(skip_real)


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "real_cartesia: marks tests that hit the real Cartesia API "
        "(deselect with '-m \"not real_cartesia\"'; auto-skipped without "
        "CARTESIA_API_KEY).",
    )
