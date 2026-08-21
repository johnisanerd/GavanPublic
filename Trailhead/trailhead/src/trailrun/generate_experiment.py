"""Configuration generation and summarization utilities."""

import json
import logging
import re
from typing import Any, Literal

from pydantic import ValidationError

from src.config import settings

logger = logging.getLogger(__name__)


def _strip_code_fences(content: str) -> str:
    """Strip markdown code fences from LLM response if present.

    LLMs sometimes wrap JSON responses in ```json ... ``` even when
    using structured output. This strips those fences to allow parsing.

    Args:
        content: Raw LLM response content

    Returns:
        Content with code fences removed
    """
    # Match ```json or ``` at start, ``` at end
    pattern = r"^```(?:json)?\s*\n?(.*?)\n?```\s*$"
    match = re.match(pattern, content.strip(), re.DOTALL)
    if match:
        return match.group(1).strip()
    return content.strip()


from src.orchestration.analysis.summarizers import SummarizerOptions, get_summarizer
from src.orchestration.client import call_llm
from src.orchestration.parsers import parse_inspect_eval
from src.prompts.experiment.generate import EXPERIMENT_GENERATOR_INSTRUCTIONS
from src.runner.types import ExperimentConfig
from src.slack.progress_constants import ANALYZING, ERROR, SUCCESS
from src.utils.file_utils import fetch_url_content
from src.utils.model_repository import MODEL_SELECTION_GUIDANCE, to_toon
from src.utils.progress_indicator import ProgressIndicator
from src.utils.sanitize import sanitize_block_kit_response
from src.utils.schema import conform_schema_for_anthropic


class ConfigGenerationError(Exception):
    """Error during experiment config generation with user-friendly message."""

    pass


async def _try_generate_config(
    description: str,
    model: str,
    system_prompt: str,
    conformed_schema: dict[str, Any],
) -> ExperimentConfig:
    """Try to generate config with a specific model.

    Args:
        description: User's description of the experiment
        model: Model to use for generation
        system_prompt: System prompt with available models
        conformed_schema: JSON schema for structured output

    Returns:
        ExperimentConfig object

    Raises:
        ConfigGenerationError: If generation fails
    """
    raw_content: str | None = None
    try:
        response = await call_llm(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": description},
            ],
            response_format={
                "type": "json_schema",
                "json_schema": {
                    "name": "experiment_config",
                    "schema": conformed_schema,
                },
            },
            timeout=settings.timeout_s,
        )

        # Check for refusal or empty content
        choice = response.choices[0]
        refusal = getattr(choice.message, "refusal", None)
        raw_content = choice.message.content

        if refusal:
            logger.warning(f"[{model}] LLM refused config generation: {refusal}")
            raise ConfigGenerationError(f"Model refused: {refusal}")

        if not raw_content:
            finish_reason = choice.finish_reason
            logger.warning(f"[{model}] LLM returned empty content (finish_reason={finish_reason})")
            if finish_reason == "content_filter":
                raise ConfigGenerationError("Content was filtered - try rephrasing your request")
            raise ConfigGenerationError("Model returned empty response")

        # Strip code fences if present (LLMs sometimes add them even with structured output)
        clean_content = _strip_code_fences(raw_content)

        # Parse and validate
        config_data = json.loads(clean_content)
        logger.debug(f"[{model}] Generated config: {json.dumps(config_data)}")
        return ExperimentConfig.model_validate(config_data)

    except ConfigGenerationError:
        raise  # Re-raise our custom errors
    except json.JSONDecodeError as e:
        logger.error(f"[{model}] JSON decode error in config generation: {e}")
        if raw_content:
            logger.debug(f"[{model}] Raw LLM response: {raw_content[:500]}")
        raise ConfigGenerationError("Failed to parse model response")
    except ValidationError as e:
        logger.error(f"[{model}] Pydantic validation error in config generation: {e}")
        raise ConfigGenerationError("Invalid config format from model")
    except ValueError as e:
        logger.error(f"[{model}] Value error in config generation: {e}")
        raise ConfigGenerationError(str(e))


async def generate_experiment(description: str) -> ExperimentConfig:
    """Generate experiment config from description using LLM.

    Tries the primary utility model first, falls back to backup model if it fails.

    Args:
        description: User's description of the experiment

    Returns:
        ExperimentConfig object

    Raises:
        ConfigGenerationError: If generation fails on both models, with user-friendly message
    """
    # Build system prompt with available models
    available_models = to_toon()
    default_model = settings.default_experiment_model

    system_prompt = EXPERIMENT_GENERATOR_INSTRUCTIONS(
        available_models, default_model, MODEL_SELECTION_GUIDANCE
    )

    # Get the JSON schema from ExperimentConfig and conform for Anthropic
    schema = ExperimentConfig.model_json_schema(mode="serialization")
    conformed_schema = conform_schema_for_anthropic(schema)

    # Try primary model first
    primary_model = settings.utility_model
    try:
        return await _try_generate_config(
            description, primary_model, system_prompt, conformed_schema
        )
    except ConfigGenerationError:
        # Try backup model
        backup_model = settings.backup_utility_model
        if backup_model and backup_model != primary_model:
            logger.warning(f"Primary model {primary_model} failed, trying backup {backup_model}")
            try:
                return await _try_generate_config(
                    description, backup_model, system_prompt, conformed_schema
                )
            except ConfigGenerationError as backup_error:
                # Both failed - raise the backup error (more recent)
                logger.error(f"Backup model {backup_model} also failed: {backup_error}")
                raise

        # No backup available, raise original error
        raise


async def process_summarization(client: Any, channel_id: str, ts: str, url: str) -> None:
    """Process URL summarization in the background.

    Args:
        client: Slack WebClient
        channel_id: Channel ID where message is posted
        ts: Message timestamp to update
        url: URL to fetch and summarize
    """
    logger.info(f"Starting summarization for URL: {url} (channel={channel_id}, ts={ts})")
    try:
        # Detect file type from URL extension
        is_eval_file = url.endswith(".eval")
        is_json_file = url.endswith(".json")

        # For .eval files, use Inspect AI parser (handles URLs directly)
        if is_eval_file:
            loading_text = f"{ANALYZING} Loading .eval file..."
            logger.debug(f"[Slack] chat_update: {loading_text}")
            await client.chat_update(channel=channel_id, ts=ts, text=loading_text)
            logger.info(f"Parsing .eval file from: {url}")

            # Parse with random sampling to fit context window
            # Use configured token budget (rough estimate: 1 token ~= 4 chars)
            max_chars = settings.max_research_tokens * 4
            parse_result = await parse_inspect_eval(url, max_chars=max_chars)
            content = parse_result.content
            logger.info(f"Parsed .eval from {url}, content length: {len(content)} chars")

            research_type: Literal["inspect_eval", "generic_log"] = "inspect_eval"
            # Store metadata for summarizer
            model_metadata = [parse_result.model_name]
            samples_included = parse_result.included_samples
            samples_total = parse_result.total_samples

        # For other files, download as text
        else:
            downloading_text = f"{ANALYZING} Downloading log file..."
            logger.debug(f"[Slack] chat_update: {downloading_text}")
            await client.chat_update(channel=channel_id, ts=ts, text=downloading_text)
            logger.info(f"Downloading file from: {url}")

            content = await fetch_url_content(url)
            logger.info(f"Downloaded {len(content)} bytes from {url}")

            # Determine research type from extension
            research_type = "inspect_eval" if is_json_file else "generic_log"
            # No metadata for non-.eval files
            model_metadata = None
            samples_included = None
            samples_total = None

        logger.info(f"Research type: {research_type} for URL: {url}")

        # Call summarizer with progress animation
        summarizer = get_summarizer("slack")
        logger.info(f"Starting summarization with model: {settings.utility_model}")

        async with ProgressIndicator(
            client.chat_update,
            text="Analyzing experiment results...",
            channel=channel_id,
            ts=ts,
        ):
            result = await summarizer(
                research_content=content,
                model=settings.utility_model,
                timeout=settings.timeout_s,
                options=SummarizerOptions(
                    research_type=research_type,
                    models=model_metadata,
                    samples_included=samples_included,
                    samples_total=samples_total,
                ),
            )

        # Sanitize and update with final summary
        sanitized = sanitize_block_kit_response(result.model_dump())
        logger.info(f"Summarization complete for URL: {url}")

        summary_text = f"{SUCCESS} Summary complete"
        logger.debug(f"[Slack] chat_update: {summary_text}")
        await client.chat_update(
            channel=channel_id, ts=ts, blocks=sanitized["blocks"], text=summary_text
        )
        logger.info(f"Posted summary to channel={channel_id}")

    except Exception as e:
        error_message = str(e)
        logger.error(f"Error during summarization: {error_message} (url={url})")
        # Handle specific error types
        if "File too large" in error_message:
            error_text = f"{ERROR} {error_message}"
        elif "timeout" in error_message.lower():
            error_text = f"{ERROR} Request timed out while downloading file"
        elif "HTTPStatusError" in str(type(e)):
            status = (
                getattr(e.response, "status_code", "error")  # type: ignore[union-attr]
                if getattr(e, "response", None)
                else "error"
            )
            error_text = f"{ERROR} Could not download file: HTTP {status}"
        else:
            error_text = f"{ERROR} Failed to process log file: {error_message}"

        logger.debug(f"[Slack] chat_update: {error_text}")
        await client.chat_update(channel=channel_id, ts=ts, text=error_text)
