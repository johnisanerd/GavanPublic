"""Design phase: Generate experiment config from description."""

from src.runner.types import ExperimentConfig
from src.trailrun.generate_experiment import generate_experiment
from src.trailrun.state import emit_progress, get_trailrun, update_trailrun
from src.trailrun.types import Phase


async def design_trailrun(trailrun_id: str, description: str) -> ExperimentConfig:
    """Generate experiment config from description.

    Can be called multiple times to iterate on the config. Each call
    replaces the previous config and emits CONFIG_READY.

    Args:
        trailrun_id: ID of the trailrun to design
        description: Natural language description of the experiment

    Returns:
        Generated ExperimentConfig

    Raises:
        KeyError: If trailrun not found
        ConfigGenerationError: If config generation fails (with user-friendly message)
    """
    trailrun = get_trailrun(trailrun_id)
    if not trailrun:
        raise KeyError(f"Trailrun not found: {trailrun_id}")

    await emit_progress(trailrun_id, "Generating experiment config...")

    # generate_experiment raises ConfigGenerationError on failure
    config = await generate_experiment(description)

    # Update state - this emits CONFIG_READY
    await update_trailrun(trailrun_id, config=config, phase=Phase.DESIGN)

    return config
