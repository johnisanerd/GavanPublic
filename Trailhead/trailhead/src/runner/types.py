"""Pydantic models for experiment runner."""

from pydantic import BaseModel, Field, model_validator

MAX_COMBINATIONS = 100


class ExperimentConfig(BaseModel):
    """Configuration for running an experiment."""

    title: str = Field(..., description="Short descriptive title (3-8 words)")
    prompts: list[str] = Field(
        ..., min_length=1, description="List of prompts to evaluate (at least 1)"
    )
    models: list[str] = Field(..., min_length=1, description="List of model names (at least 1)")
    n: int = Field(..., ge=1, description="Number of repetitions (at least 1)")

    model_config = {"extra": "forbid"}

    @model_validator(mode="after")
    def validate_combinations(self) -> "ExperimentConfig":
        """Ensure models * prompts * n doesn't exceed MAX_COMBINATIONS."""
        total = len(self.models) * len(self.prompts) * self.n
        if total > MAX_COMBINATIONS:
            raise ValueError(
                f"Experiment too large: {len(self.models)} models x {len(self.prompts)} prompts "
                f"x {self.n} epochs = {total} combinations (max {MAX_COMBINATIONS})"
            )
        return self


class ExperimentResult(BaseModel):
    """Result from running an experiment."""

    experiment_name: str = Field(..., description="Generated experiment name")
    log_dir: str = Field(..., description="Directory where logs are stored")
    success: bool = Field(..., description="Whether the experiment completed successfully")
