"""Application configuration using Pydantic Settings."""

import os

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class AppSettings(BaseSettings):
    """Application settings loaded from environment variables."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # Slack configuration
    slack_signing_secret: str = Field(..., alias="SLACK_SIGNING_SECRET")
    slack_bot_token: str = Field(..., alias="SLACK_BOT_TOKEN")

    # OpenRouter configuration (single API for all LLM providers)
    openrouter_api_key: str = Field(..., alias="OPENROUTER_API_KEY")

    # Utility models (for summarization, analysis, and other internal tasks)
    utility_model: str = Field(default="anthropic/claude-sonnet-4", alias="UTILITY_MODEL")
    backup_utility_model: str = Field(default="openai/gpt-5.2", alias="BACKUP_UTILITY_MODEL")
    fast_utility_model: str = Field(
        default="anthropic/claude-3-5-haiku", alias="FAST_UTILITY_MODEL"
    )
    image_generation_model: str = Field(
        default="google/gemini-3-pro-image-preview", alias="IMAGE_GENERATION_MODEL"
    )

    # Application configuration
    timeout_s: float = Field(default=20.0, alias="TIMEOUT_S")
    max_research_tokens: int = Field(default=25_000, alias="MAX_RESEARCH_TOKENS")
    ai_calls_per_second: int = Field(default=5, alias="AI_CALLS_PER_SECOND")
    ai_max_queue: int = Field(default=50, alias="AI_MAX_QUEUE")
    dry_run: bool = Field(default=False, alias="DRY_RUN")
    use_streaming: bool = Field(default=False, alias="USE_STREAMING")
    accept_non_slack_requests: bool = Field(default=False, alias="ACCEPT_NON_SLACK_REQUESTS")

    # Bot persona configuration (icon URLs must be publicly accessible)
    bot_name: str = Field(default="Trailhead", alias="BOT_NAME")
    bot_icon_url: str | None = Field(default=None, alias="BOT_ICON_URL")

    # Runner configuration
    runner_log_dir: str = Field(default="logs", alias="RUNNER_LOG_DIR")
    inspect_bundle_dir: str = Field(default="public/inspect-bundles", alias="INSPECT_BUNDLE_DIR")
    default_experiment_model: str = Field(
        default="openai/gpt-5.1", alias="DEFAULT_EXPERIMENT_MODEL"
    )
    run_timeout_seconds: int = Field(default=600, alias="RUN_TIMEOUT_SECONDS")  # 10 minutes

    # Inspect viewer configuration
    app_base_url: str = Field(default="http://localhost:8000", alias="APP_BASE_URL")

    # Brandfetch for model icons in citations
    brandfetch_client_id: str | None = Field(default=None, alias="BRANDFETCH_CLIENT_ID")

    # MCP authentication (required for HTTP transport, not needed for stdio)
    trailhead_secret: str | None = Field(default=None, alias="TRAILHEAD_SECRET")

    # Ranger configuration (autonomous research agent)
    e2b_api_key: str | None = Field(default=None, alias="E2B_API_KEY")
    anthropic_api_key: str | None = Field(default=None, alias="ANTHROPIC_API_KEY")
    ranger_secret: str | None = Field(default=None, alias="RANGER_SECRET")
    ranger_slack_channel: str | None = Field(default=None, alias="RANGER_SLACK_CHANNEL")
    ranger_trailhead_slack_channel: str | None = Field(
        default=None, alias="RANGER_TRAILHEAD_SLACK_CHANNEL"
    )


# Global settings instance
# Note: This will fail if .env is missing required values
# Use .env.example as a template
settings = AppSettings()  # type: ignore[call-arg]

# Export API key to environment for Inspect AI
os.environ["OPENROUTER_API_KEY"] = settings.openrouter_api_key
