"""Worker process for running Inspect evaluations.

This runs in a separate process so it can be killed on cancellation.
"""

import logging
import sys
from pathlib import Path

from inspect_ai import eval_set

from src.runner.runner import create_experiment_task
from src.runner.types import ExperimentConfig

# Set up logging for this subprocess
logging.basicConfig(
    level=logging.INFO,
    format="[%(name)s] %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger(__name__)


def main():
    """Run Inspect evaluation from config file."""
    if len(sys.argv) != 3:
        logger.error("Usage: subprocess_worker.py <config_json_path> <log_dir>")
        sys.exit(1)

    config_path = sys.argv[1]
    log_dir = sys.argv[2]

    try:
        # Load config
        logger.info(f"Loading config from {config_path}")
        config_json = Path(config_path).read_text()
        config = ExperimentConfig.model_validate_json(config_json)

        # Create task
        task_instance = create_experiment_task(config.prompts, config.n)

        # Prefix model names with openrouter/ for Inspect AI to route through OpenRouter
        inspect_models = [f"openrouter/{m}" for m in config.models]
        logger.info(f"Running eval with models: {inspect_models}")

        # Run evaluation (this is a blocking call)
        success, _logs = eval_set(tasks=[task_instance], model=inspect_models, log_dir=log_dir)

        logger.info(f"Eval completed, success={success}")
        sys.exit(0 if success else 1)

    except Exception as e:
        logger.error(f"ERROR: {e}")
        import traceback

        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
