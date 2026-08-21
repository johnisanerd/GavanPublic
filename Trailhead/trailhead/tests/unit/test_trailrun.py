"""Test script for trailrun system."""

import pytest

from src.runner.types import ExperimentConfig
from src.trailrun import (
    Phase,
    create_trailrun,
    get_trailrun,
    update_trailrun,
)


@pytest.mark.asyncio
async def test_trailrun_lifecycle():
    """Test basic trailrun lifecycle."""
    print("Testing trailrun lifecycle...")

    # Create a new trailrun
    print("\n1. Creating trailrun...")
    trailrun = create_trailrun(
        channel_id="C123456",
        user_id="U123456",
    )
    print(f"   ✓ Created trailrun: {trailrun.id}")
    print(f"   - Phase: {trailrun.phase.value}")
    print(f"   - Status: {trailrun.status}")

    # Verify it's in DESIGN phase
    assert trailrun.phase == Phase.DESIGN
    assert trailrun.status == "pending"
    print("   ✓ Trailrun in DESIGN phase")

    # Add config (simulate modal submission)
    print("\n2. Adding experiment config...")
    config = ExperimentConfig(
        title="Test trailrun experiment",
        prompts=["Test prompt 1", "Test prompt 2"],
        models=["gpt-5-nano"],
        n=1,
    )
    updated = await update_trailrun(trailrun.id, config=config)
    print(f"   ✓ Config added: {len(config.prompts)} prompts, {len(config.models)} models")
    assert updated.config is not None

    # Retrieve trailrun
    print("\n3. Retrieving trailrun...")
    retrieved = get_trailrun(trailrun.id)
    assert retrieved is not None
    assert retrieved.id == trailrun.id
    assert retrieved.config is not None
    print(f"   ✓ Retrieved trailrun: {retrieved.id}")

    # Update to RUN phase
    print("\n4. Moving to RUN phase...")
    updated = await update_trailrun(trailrun.id, phase=Phase.RUN, status="running")
    assert updated.phase == Phase.RUN
    assert updated.status == "running"
    print(f"   ✓ Phase: {updated.phase.value}, Status: {updated.status}")

    # Update to REPORT phase
    print("\n5. Moving to REPORT phase...")
    updated = await update_trailrun(trailrun.id, phase=Phase.REPORT, status="reporting")
    assert updated.phase == Phase.REPORT
    print(f"   ✓ Phase: {updated.phase.value}")

    # Mark as completed
    print("\n6. Marking as completed...")
    updated = await update_trailrun(trailrun.id, status="completed")
    assert updated.status == "completed"
    print(f"   ✓ Status: {updated.status}")

    print("\n✅ All trailrun lifecycle tests passed!")


if __name__ == "__main__":
    import asyncio

    asyncio.run(test_trailrun_lifecycle())
