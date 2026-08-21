"""Centralized logging configuration.

Usage:
    # At app startup (main.py)
    from src.logging_config import setup_logging
    setup_logging()

    # In any module
    import logging
    logger = logging.getLogger(__name__)
    logger.info("Message here")

Environment variables:
    LOG_LEVEL: Set root log level (DEBUG, INFO, WARNING, ERROR). Default: INFO
    LOG_FORMAT: "simple" (default) or "detailed"
    LOG_DEBUG: Comma-separated list of loggers to set to DEBUG level.
               Supports exact names or prefixes (e.g., "src.slack" matches "src.slack.hooks")

Examples:
    # Default INFO, but debug Slack messages
    LOG_LEVEL=INFO LOG_DEBUG=src.slack

    # Default INFO, debug multiple categories
    LOG_DEBUG=src.slack.hooks,src.utils.progress_indicator

    # Debug everything
    LOG_LEVEL=DEBUG

Hierarchy:
    src.trailrun.*      - Trailrun lifecycle events
    src.slack.*         - Slack interactions (hooks, actions, events)
    src.orchestration.* - LLM calls, summarization
    src.runner.*        - Experiment execution
    src.utils.*         - Utilities (progress_indicator, etc.)
    src.cli.*           - CLI tools
"""

import logging
import os
import sys


def setup_logging() -> None:
    """Configure logging for the application.

    Call once at startup. Reads LOG_LEVEL and LOG_DEBUG from environment.
    """
    level_name = os.environ.get("LOG_LEVEL", "INFO").upper()
    level = getattr(logging, level_name, logging.INFO)

    log_format = os.environ.get("LOG_FORMAT", "simple")

    if log_format == "detailed":
        fmt = "%(asctime)s [%(name)s] %(levelname)s: %(message)s"
        datefmt = "%Y-%m-%d %H:%M:%S"
    else:
        # Simple format similar to existing [Tag] style
        fmt = "[%(name)s] %(message)s"
        datefmt = None

    # Configure root logger
    logging.basicConfig(
        level=level,
        format=fmt,
        datefmt=datefmt,
        stream=sys.stdout,
        force=True,  # Override any existing config
    )

    # Quiet noisy third-party loggers
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.getLogger("openai").setLevel(logging.WARNING)
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)

    # Apply LOG_DEBUG overrides for specific loggers
    debug_loggers = os.environ.get("LOG_DEBUG", "").strip()
    if debug_loggers:
        for logger_name in debug_loggers.split(","):
            logger_name = logger_name.strip()
            if logger_name:
                logging.getLogger(logger_name).setLevel(logging.DEBUG)

    # Log startup
    root_logger = logging.getLogger()
    if debug_loggers:
        root_logger.info(f"Logging: {level_name} (DEBUG: {debug_loggers})")
    else:
        root_logger.info(f"Logging initialized at {level_name} level")


def get_logger(name: str) -> logging.Logger:
    """Get a logger with the given name.

    Convenience wrapper. Equivalent to logging.getLogger(name).

    Args:
        name: Logger name, typically __name__

    Returns:
        Logger instance
    """
    return logging.getLogger(name)
