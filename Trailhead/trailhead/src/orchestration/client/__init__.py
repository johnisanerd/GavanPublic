"""Centralized AI client with rate limiting.

This is the ONLY module that should call LLM APIs directly.
All other code must go through these functions.
Routes all requests through OpenRouter.
"""

from src.config import settings
from src.utils.rate_limiter import RateLimiter

# Shared rate limiter for all OpenRouter API calls (LLM + image generation)
rate_limiter = RateLimiter(
    calls_per_second=settings.ai_calls_per_second,
    max_queue_size=settings.ai_max_queue,
)

from src.orchestration.client.image import generate_image
from src.orchestration.client.llm import call_llm

__all__ = ["call_llm", "generate_image", "rate_limiter"]
