"""Model repository for fetching and caching available models from OpenRouter."""

from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
from cachetools import TTLCache, cached
from toon_format import encode as toon_encode

OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"

# Supported model providers (prefix matches on model id)
SUPPORTED_PROVIDERS = [
    "openai",
    "anthropic",
    "google",
    "meta-llama",
    "deepseek",
    "mistralai",
    "x-ai",
]

# Default filter: 18 months
DEFAULT_MAX_AGE_MONTHS = 18

# Variant suffixes to filter out (hosting/pricing variants that don't matter)
REMOVE_VARIANTS = [":free", ":exacto", ":extended"]

# Guidance for LLM model selection (used in config generator prompts)
MODEL_SELECTION_GUIDANCE = """
## Model Selection Guidelines

IMPORTANT: Always prefer the newest models from the available models list. The list is sorted
with newest models first. If a user doesn't specify a version (e.g., "use GPT" not "use GPT-4o"),
pick the latest model in that family. Don't anchor on older models from your training data.

When selecting models, follow these conventions:

### Speed/Size Keywords
- "fast" or "quick" → prefer smaller/faster models:
  - Anthropic: "haiku" (e.g., claude-haiku-4.5)
  - OpenAI: "mini" suffix (e.g., gpt-5-mini, o4-mini)
  - Google: "flash" (e.g., gemini-2.5-flash)
  - Mistral: "small" (e.g., mistral-small-3.1)
  - xAI: "fast" suffix (e.g., grok-4-fast)
  - Meta: smaller sizes (e.g., llama-3.1-8b-instruct)
- "super fast" or "tiny" → prefer smallest models:
  - OpenAI: "nano" suffix (e.g., gpt-5-nano)
  - Google: "flash-lite" (e.g., gemini-2.5-flash-lite)
- "cheap" or "budget" → same as fast/super fast tiers

### Quality Keywords
- "best", "top of the line", or "flagship" → prefer flagship-tier models:
  - Anthropic: "opus" (e.g., claude-opus-4.5)
  - OpenAI: base flagship (e.g., gpt-5.1) - NOT pro (see reasoning models below)
  - Google: "pro" (e.g., gemini-2.5-pro)
  - Mistral: "large" (e.g., mistral-large-2411)
  - xAI: base model (e.g., grok-4)
  - Meta: largest size (e.g., llama-3.1-405b-instruct)

### Preview Models
- Models with "-preview" suffix are the latest versions of that model line
- Prefer preview models when user wants "latest" or "newest"

### Reasoning/Extended Thinking Models (SPECIAL - only use when explicitly requested)
- OpenAI "pro" models (gpt-5-pro, o3-pro, o4-pro) are specialized reasoning models
- These use extended thinking/chain-of-thought and behave VERY differently from regular models
- ONLY use "-pro" OpenAI models when user explicitly asks for:
  - "extended thinking", "long reasoning", "chain of thought", "reasoning model"
  - Or explicitly mentions "pro" model by name
- For general "flagship" or "best" requests, use opus/large models instead, NOT pro
- Similarly: DeepSeek r1 is a reasoning model, only use for reasoning tasks

### Default Behavior
- If no speed/quality guidance is given, use solid daily-driver models:
  - Anthropic: "sonnet" (e.g., claude-sonnet-4.5)
  - OpenAI: base model without suffix (e.g., gpt-5.1)
  - Google: "flash" (e.g., gemini-2.5-flash)
  - Mistral: "medium" (e.g., mistral-medium-3)
  - DeepSeek: "chat" or "v3" (e.g., deepseek-chat)
  - xAI: base model (e.g., grok-4)
  - Meta: 70B size (e.g., llama-3.3-70b-instruct)
- If comparing providers with no other guidance, compare daily-driver models

### Provider Comparison
- When user asks to "compare OpenAI and Anthropic" without specifics,
  use comparable tiers (recent daily-drivers vs recent daily-drivers, not nano vs opus)
""".strip()

# Cache: 1 entry, 6 hour TTL
_models_cache: TTLCache[str, list[dict[str, Any]]] = TTLCache(maxsize=1, ttl=6 * 60 * 60)


@cached(cache=_models_cache)
def fetch_models() -> list[dict[str, Any]]:
    """Fetch models from OpenRouter API with 6-hour caching.

    Returns filtered list of models from supported providers.
    """
    response = httpx.get(OPENROUTER_MODELS_URL, timeout=30)
    response.raise_for_status()
    data = response.json()

    models = data.get("data", [])

    # Filter to supported providers
    filtered = [m for m in models if any(m["id"].startswith(f"{p}/") for p in SUPPORTED_PROVIDERS)]

    return filtered


def get_models() -> list[dict[str, Any]]:
    """Get cached models from OpenRouter.

    Returns list of model dicts with fields like:
    - id: "openai/gpt-4o"
    - name: "OpenAI: GPT-4o"
    - created: 1715367600 (unix timestamp)
    - context_length: 128000
    - pricing: {"prompt": "0.000005", "completion": "0.000015", ...}
    """
    return fetch_models()


def get_model_name(model_id: str) -> str:
    """Get display name for a model ID.

    Args:
        model_id: Model ID like "anthropic/claude-3-opus" or "openrouter/anthropic/claude-3-opus"

    Returns:
        Display name like "Claude 3 Opus", or the model ID if not found.
        Strips provider prefix from name (e.g., "Anthropic: Claude 3 Opus" -> "Claude 3 Opus")
    """
    # Strip "openrouter/" prefix if present (our runner adds this)
    lookup_id = model_id.removeprefix("openrouter/")

    models = fetch_models()
    for m in models:
        if m["id"] == lookup_id:
            name = m.get("name", lookup_id)
            # Strip "Provider: " prefix if present
            if ": " in name:
                return name.split(": ", 1)[1]
            return name
    # Fallback: extract name from ID (e.g., "anthropic/claude-3-opus" -> "claude-3-opus")
    return lookup_id.split("/")[-1] if "/" in lookup_id else lookup_id


def get_experiment_models(max_age_months: int = DEFAULT_MAX_AGE_MONTHS) -> list[dict[str, Any]]:
    """Get models suitable for experiments.

    Filters to models that:
    - Are from supported providers
    - Were released within max_age_months
    - Support text output
    - Support tool calling

    Sorted by provider name (alphabetically), then by release date (newest first).

    Args:
        max_age_months: Maximum age in months (default: 18)

    Returns:
        Filtered list of model dicts.
    """
    models = fetch_models()

    cutoff = datetime.now(UTC) - timedelta(days=max_age_months * 30)
    cutoff_ts = cutoff.timestamp()

    def should_remove(model_id: str) -> bool:
        return any(model_id.endswith(suffix) for suffix in REMOVE_VARIANTS)

    def is_variant(model_id: str) -> bool:
        return ":" in model_id

    filtered = [
        m
        for m in models
        if m["created"] >= cutoff_ts
        and "text" in m.get("architecture", {}).get("output_modalities", [])
        and "tools" in m.get("supported_parameters", [])
        and not should_remove(m["id"])
    ]

    # Sort by provider (alpha), then variants to bottom, then by created date (newest first)
    def sort_key(m: dict[str, Any]) -> tuple[str, int, int]:
        provider = m["id"].split("/")[0]
        variant_order = 1 if is_variant(m["id"]) else 0
        return (provider, variant_order, -m["created"])

    return sorted(filtered, key=sort_key)


def format_created_date(timestamp: int) -> str:
    """Convert unix timestamp to YYYY-MM-DD format."""
    return datetime.fromtimestamp(timestamp, tz=UTC).strftime("%Y-%m-%d")


def to_toon(
    models: list[dict[str, Any]] | None = None,
    keys: list[str] | None = None,
) -> str:
    """Convert models to TOON format for LLM consumption.

    Args:
        models: List of model dicts. If None, uses get_experiment_models().
        keys: List of keys to include. Defaults to ["id", "created"].
              Special handling: "created" is formatted as a date string.

    Returns:
        TOON-formatted string of models.
    """
    if models is None:
        models = get_experiment_models()

    if keys is None:
        keys = ["id", "created"]

    # Build simplified records with only requested keys
    records = []
    for m in models:
        record = {}
        for key in keys:
            if key == "created":
                # Format timestamp as readable date
                record["created"] = format_created_date(m.get("created", 0))
            elif key in m:
                record[key] = m[key]
        records.append(record)

    return toon_encode(records)
