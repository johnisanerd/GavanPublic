"""Image generation via OpenRouter."""

import base64
import logging
import re

from openai import AsyncOpenAI

from src.config import settings

logger = logging.getLogger(__name__)

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"


def _create_client(timeout: float) -> AsyncOpenAI:
    """Create OpenRouter client."""
    return AsyncOpenAI(
        api_key=settings.openrouter_api_key,
        base_url=OPENROUTER_BASE_URL,
        timeout=timeout,
    )


def _extract_image_from_images_array(images: list) -> bytes:
    """Extract image bytes from OpenRouter images array format."""
    # Format: {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}}
    image_url = images[0].get("image_url", {}).get("url", "")
    if not image_url:
        raise ValueError(f"Image object missing url: {images[0]}")

    match = re.search(r"data:image/[^;]+;base64,([A-Za-z0-9+/=]+)", image_url)
    if not match:
        raise ValueError(f"Could not extract base64 from image URL: {image_url[:100]}...")

    return base64.b64decode(match.group(1))


def _extract_image_from_content(content: str) -> bytes:
    """Extract image bytes from message content (fallback format)."""
    if not content:
        raise ValueError("Empty content, cannot extract image")

    # Try data URL format first
    match = re.search(r"data:image/[^;]+;base64,([A-Za-z0-9+/=]+)", content)
    if match:
        return base64.b64decode(match.group(1))

    # Try raw base64
    if re.match(r"^[A-Za-z0-9+/=]+$", content.strip()):
        return base64.b64decode(content.strip())

    raise ValueError(f"Could not extract image from content: {content[:200]}...")


async def generate_image(
    prompt: str,
    model: str = "google/gemini-3-pro-image-preview",
    timeout: float = 60.0,
) -> bytes:
    """Generate an image via OpenRouter.

    Uses Gemini 3 Pro Image or other image-capable models.

    Args:
        prompt: Description of the image to generate
        model: Model name (default: google/gemini-3-pro-image-preview)
        timeout: Request timeout in seconds (default: 60s for image gen)

    Returns:
        Image bytes (PNG format)

    Raises:
        ValueError: If image generation fails
    """
    logger.info(f"Generating image with {model}...")

    client = _create_client(timeout)

    async def make_call() -> bytes:
        try:
            response = await client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": prompt}],
                extra_body={
                    "modalities": ["image", "text"],
                    "image_config": {"aspect_ratio": "1:1"},
                },
            )

            msg = response.choices[0].message
            msg_dict = msg.model_dump()
            logger.debug(f"Message keys: {list(msg_dict.keys())}")

            # Check for images array (OpenRouter format)
            images = msg_dict.get("images")
            if images and len(images) > 0:
                image_data = _extract_image_from_images_array(images)
            else:
                # Fallback: check content for inline base64 (older format)
                image_data = _extract_image_from_content(msg.content or "")

            logger.info(f"Generated image: {len(image_data)} bytes")
            return image_data

        except Exception as e:
            logger.error(f"Image generation error: {e}")
            raise ValueError(f"Image generation failed: {e}") from e

    from src.orchestration.client import rate_limiter

    return await rate_limiter.execute(make_call)
