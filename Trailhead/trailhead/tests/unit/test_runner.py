"""Tests for experiment runner."""

import pytest
from pydantic import ValidationError

from src.runner.types import ExperimentConfig, ExperimentResult


def test_experiment_config_valid():
    """Test valid experiment config."""
    config = ExperimentConfig(
        title="Test experiment",
        prompts=["What is 2+2?", "Explain gravity"],
        models=["openai/gpt-4"],
        n=3,
    )
    assert len(config.prompts) == 2
    assert len(config.models) == 1
    assert config.n == 3
    assert config.title == "Test experiment"


def test_experiment_config_empty_prompts():
    """Test that empty prompts list is rejected."""
    with pytest.raises(ValidationError):
        ExperimentConfig(prompts=[], models=["openai/gpt-4"], n=1)


def test_experiment_config_empty_models():
    """Test that empty models list is rejected."""
    with pytest.raises(ValidationError):
        ExperimentConfig(prompts=["test"], models=[], n=1)


def test_experiment_config_zero_epochs():
    """Test that zero epochs is rejected."""
    with pytest.raises(ValidationError):
        ExperimentConfig(prompts=["test"], models=["openai/gpt-4"], n=0)


def test_experiment_config_negative_epochs():
    """Test that negative epochs is rejected."""
    with pytest.raises(ValidationError):
        ExperimentConfig(prompts=["test"], models=["openai/gpt-4"], n=-1)


def test_experiment_config_extra_fields():
    """Test that extra fields are forbidden."""
    with pytest.raises(ValidationError):
        ExperimentConfig(prompts=["test"], models=["openai/gpt-4"], n=1, extra_field="not allowed")


def test_experiment_result():
    """Test experiment result model."""
    result = ExperimentResult(
        experiment_name="test-experiment",
        log_dir="logs/test-experiment",
        success=True,
    )
    assert result.experiment_name == "test-experiment"
    assert result.log_dir == "logs/test-experiment"
    assert result.success is True
