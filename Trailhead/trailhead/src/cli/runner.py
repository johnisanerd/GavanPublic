"""CLI entry point for experiment runner."""

import asyncio
import logging
import sys
from pathlib import Path

import yaml

from src.logging_config import setup_logging
from src.runner import ExperimentConfig, run_experiment_from_config

setup_logging()
logger = logging.getLogger(__name__)


def main():
    """Run experiment from YAML config file."""
    if len(sys.argv) != 2:
        print("Usage: uv run task run <config.yaml>")
        print("\nExample config.yaml:")
        print("  prompts:")
        print("    - What is 2+2?")
        print("    - Explain gravity")
        print("  models:")
        print("    - openai/gpt-4")
        print("  n: 3")
        sys.exit(1)

    config_path = Path(sys.argv[1])
    if not config_path.exists():
        logger.error(f"Config file not found: {config_path}")
        sys.exit(1)

    # Load and validate config
    try:
        with open(config_path) as f:
            config_dict = yaml.safe_load(f)
        config = ExperimentConfig(**config_dict)
    except Exception as e:
        logger.error(f"Invalid config file: {e}")
        sys.exit(1)

    # Run experiment
    try:
        result = asyncio.run(run_experiment_from_config(config))
        print(f"\n{'=' * 80}")
        if result.success:
            print("✓ Experiment completed successfully")
        else:
            print("✗ Experiment failed")
        print(f"Experiment: {result.experiment_name}")
        print(f"Log directory: {result.log_dir}")
        print(f"{'=' * 80}\n")
        sys.exit(0 if result.success else 1)
    except Exception as e:
        logger.error(f"Error running experiment: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
