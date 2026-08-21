# Model Configuration Support (Temperature, Thinking, etc.)

## Goal

Add per-model configuration to experiments, allowing model-specific settings like temperature, thinking budget, max_tokens, and future provider-specific parameters. Design for extensibility since different models have different capabilities.

## Current State

- `ExperimentConfig` has: `title`, `prompts`, `models: list[str]`, `n`
- `runner.py` creates an Inspect AI `Task` with `generate()` solver
- `eval_set()` is called without any `GenerateConfig` - uses model defaults
- No model-specific configuration exists

## Options Analysis

### Option 1: Single Global Temperature

```python
temperature: float | None = Field(default=None)
```

**Verdict:** Too limited. Can't handle model-specific settings.

### Option 2: Temperature as a Variable Dimension

```python
temperatures: list[float] = Field(default=[1.0])
```

**Verdict:** Good for comparing temps, but doesn't handle other settings like thinking.

### Option 3: Per-Model Configuration (Recommended)

```python
class ModelSpec(BaseModel):
    name: str
    temperature: float | None = None
    thinking: int | None = None  # Extended thinking budget (Claude)
    max_tokens: int | None = None

models: list[str | ModelSpec]
```

**Verdict:** Extensible foundation for all model-specific settings.

## Recommended Approach: ModelSpec

### Why Option 3?

1. **Different models have different capabilities**
   - Claude: `thinking` budget for extended reasoning
   - OpenAI: `reasoning_effort` for o1/o3 models
   - All: `temperature`, `max_tokens`, `top_p`

2. **Backward compatible**
   - `models: ["gpt-4", "claude-3"]` still works (strings)
   - `models: [{"name": "gpt-4", "temperature": 0.7}]` for config
   - Mix and match: `["gpt-4", {"name": "claude-3", "thinking": 10000}]`

3. **Future-proof**
   - Add new fields without breaking existing configs
   - Provider-specific params can be added later

## Implementation Plan

### 1. Create ModelSpec

```python
# src/runner/types.py

class ModelSpec(BaseModel):
    """Per-model configuration for experiments.

    Maps to Inspect AI's GenerateConfig fields.
    See: https://github.com/UKGovernmentBEIS/inspect_ai/blob/main/src/inspect_ai/model/_generate_config.py
    """
    name: str = Field(..., description="Model identifier (e.g., 'gpt-4o', 'claude-sonnet-4')")

    # Common settings
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    max_tokens: int | None = Field(default=None, ge=1)
    top_p: float | None = Field(default=None, ge=0.0, le=1.0)

    # Reasoning/thinking settings (maps to GenerateConfig)
    reasoning_tokens: int | None = Field(
        default=None,
        ge=1024,  # Anthropic minimum
        description="Max tokens for extended thinking (Claude models)"
    )
    reasoning_effort: Literal["none", "minimal", "low", "medium", "high", "xhigh"] | None = Field(
        default=None,
        description="Reasoning effort level (provider-dependent)"
    )

    model_config = {"extra": "forbid"}


class ExperimentConfig(BaseModel):
    title: str = Field(...)
    prompts: list[str] = Field(...)
    models: list[str | ModelSpec] = Field(
        ...,
        min_length=1,
        description="Models to test. Can be strings or ModelSpec objects with config."
    )
    n: int = Field(...)

    def get_model_specs(self) -> list[ModelSpec]:
        """Normalize all models to ModelSpec objects."""
        return [
            m if isinstance(m, ModelSpec) else ModelSpec(name=m)
            for m in self.models
        ]

    def get_model_names(self) -> list[str]:
        """Get just the model names for display/identification."""
        return [
            m.name if isinstance(m, ModelSpec) else m
            for m in self.models
        ]
```

### 2. Update Runner

```python
# src/runner/runner.py

from inspect_ai.model import GenerateConfig

def build_generate_config(spec: ModelSpec) -> GenerateConfig:
    """Build Inspect AI GenerateConfig from ModelSpec.

    ModelSpec fields map directly to GenerateConfig fields.
    """
    kwargs = {}
    if spec.temperature is not None:
        kwargs["temperature"] = spec.temperature
    if spec.max_tokens is not None:
        kwargs["max_tokens"] = spec.max_tokens
    if spec.top_p is not None:
        kwargs["top_p"] = spec.top_p
    if spec.reasoning_tokens is not None:
        kwargs["reasoning_tokens"] = spec.reasoning_tokens
    if spec.reasoning_effort is not None:
        kwargs["reasoning_effort"] = spec.reasoning_effort
    return GenerateConfig(**kwargs) if kwargs else GenerateConfig()


async def run_experiment_from_config(config: ExperimentConfig) -> ExperimentResult:
    # ... existing setup ...

    task_instance = create_experiment_task(config.prompts, config.n)

    # Build per-model configs
    model_specs = config.get_model_specs()

    # Run eval_set per model to apply individual configs
    # (Inspect AI applies config at task level, not per-model in multi-model runs)
    all_logs = []
    for spec in model_specs:
        inspect_model = f"openrouter/{spec.name}"
        gen_config = build_generate_config(spec)

        # Create task with this model's config
        task_with_config = Task(
            dataset=task_instance.dataset,
            solver=task_instance.solver,
            epochs=config.n,
            config=gen_config,
        )

        success, logs = await asyncio.to_thread(
            eval_set,
            tasks=[task_with_config],
            model=inspect_model,
            log_dir=log_dir,
        )
        all_logs.extend(logs)

    # ... rest unchanged ...
```

### 3. Update Experiment Generation Prompt

```python
# src/prompts/experiment/generate.py

EXPERIMENT_SCHEMA_DESCRIPTION = """
...
- models: List of models to test. Each can be:
  - A string: "gpt-4o", "claude-sonnet-4"
  - An object with config: {"name": "claude-sonnet-4", "temperature": 0.7, "reasoning_tokens": 10000}

  Available model config options:
  - name (required): Model identifier
  - temperature: 0-2, controls randomness. Lower = deterministic, higher = creative.
  - max_tokens: Maximum response length
  - top_p: 0-1, nucleus sampling threshold
  - reasoning_tokens: Extended thinking budget in tokens (Claude models, min 1024)
  - reasoning_effort: "none", "minimal", "low", "medium", "high", "xhigh" (provider-dependent)
...
"""
```

### 4. Update Config Display

```python
# src/slack/utils/blocks.py

def format_model_display(models: list[str | ModelSpec]) -> str:
    """Format models for Slack display."""
    parts = []
    for m in models:
        if isinstance(m, str):
            parts.append(f"`{m}`")
        else:
            config_parts = [f"`{m.name}`"]
            if m.temperature is not None:
                config_parts.append(f"temp={m.temperature}")
            if m.max_tokens is not None:
                config_parts.append(f"max={m.max_tokens}")
            if m.reasoning_tokens is not None:
                config_parts.append(f"thinking={m.reasoning_tokens}")
            if m.reasoning_effort is not None:
                config_parts.append(f"effort={m.reasoning_effort}")
            parts.append(" ".join(config_parts))
    return ", ".join(parts)
```

### 5. Extended Thinking (Claude) - Native Support

Inspect AI has **native support** for extended thinking via `GenerateConfig`:

```python
from inspect_ai.model import GenerateConfig

# Extended thinking with token budget (Claude models)
config = GenerateConfig(reasoning_tokens=10000)

# Or use effort levels (works across providers)
config = GenerateConfig(reasoning_effort="high")
```

No special `model_args` handling needed - our `ModelSpec.reasoning_tokens` maps directly.

### 6. Add Tests

```python
# tests/unit/test_model_spec.py

def test_model_spec_validation():
    # Valid specs
    spec = ModelSpec(name="gpt-4o", temperature=0.7)
    assert spec.temperature == 0.7

    # Temperature bounds
    with pytest.raises(ValidationError):
        ModelSpec(name="gpt-4o", temperature=3.0)

def test_experiment_config_mixed_models():
    config = ExperimentConfig(
        title="Test",
        prompts=["hi"],
        models=[
            "gpt-4o",  # Simple string
            ModelSpec(name="claude-sonnet-4", temperature=0.5),  # With config
            {"name": "gemini-2.0-flash", "thinking": 5000},  # Dict form
        ],
        n=1,
    )
    specs = config.get_model_specs()
    assert len(specs) == 3
    assert specs[0].name == "gpt-4o"
    assert specs[0].temperature is None  # Default
    assert specs[1].temperature == 0.5
```

## File Changes Summary

| File | Action | Description |
|------|--------|-------------|
| `src/runner/types.py` | Modify | Add `ModelSpec`, update `models` field type |
| `src/runner/runner.py` | Modify | Build per-model GenerateConfig, run per-model |
| `src/prompts/experiment/generate.py` | Modify | Document ModelSpec in schema |
| `src/slack/utils/blocks.py` | Modify | Format ModelSpec for display |
| `tests/unit/test_model_spec.py` | Create | ModelSpec and mixed models tests |

## Critical Files to Read Before Implementation

1. `src/runner/types.py` - ExperimentConfig definition
2. `src/runner/runner.py` - How tasks are created and run
3. `src/prompts/experiment/generate.py` - LLM prompt for config generation
4. `src/slack/utils/blocks.py` - Config display formatting

## Inspect AI Reference

`GenerateConfig` fields we use (from [source](https://github.com/UKGovernmentBEIS/inspect_ai/blob/main/src/inspect_ai/model/_generate_config.py)):

| Field | Type | Notes |
|-------|------|-------|
| `temperature` | `float \| None` | 0-2, controls randomness |
| `max_tokens` | `int \| None` | Max response length |
| `top_p` | `float \| None` | Nucleus sampling |
| `reasoning_tokens` | `int \| None` | Extended thinking budget (Claude, min 1024) |
| `reasoning_effort` | `Literal[...]` | Effort level (provider-dependent) |

Sources:
- [Inspect AI Models Documentation](https://inspect.aisi.org.uk/models.html)
- [Anthropic Provider Docs](https://inspect.aisi.org.uk/providers.html)

## Open Questions

1. **Should we run all models in one eval_set or separate calls?**
   - One call: simpler, but can't apply per-model config
   - Separate calls: more control, slightly more complex
   - **Recommendation:** Separate calls since we need per-model GenerateConfig

2. **How to handle provider-specific params that don't map to GenerateConfig?**
   - Could add `extra_args: dict[str, Any]` to ModelSpec for passthrough
   - For now, stick to standard GenerateConfig fields

## Future Extensions

- `system_prompt: str` per model (test same prompt with different system contexts)
- `stop_sequences: list[str]` per model
- `seed: int` for reproducibility
- `effort: Literal["low", "medium", "high"]` for Claude 4.5 Opus token efficiency
- `extra_args: dict[str, Any]` for provider-specific passthrough
