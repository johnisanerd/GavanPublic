"""Utilities for fetching file content from external URLs."""

import httpx

from src.config import settings


async def fetch_url_content(url: str, max_size_mb: int = 10) -> str:
    """Fetch content from URL with timeout and size limits.

    Args:
        url: The URL to fetch content from
        max_size_mb: Maximum file size in megabytes (default: 10)

    Returns:
        File content as a string

    Raises:
        ValueError: If file is too large
        httpx.HTTPError: If request fails
    """
    timeout = httpx.Timeout(settings.timeout_s, connect=10.0)

    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        async with client.stream("GET", url) as response:
            response.raise_for_status()

            # Check content length if provided
            content_length = response.headers.get("content-length")
            if content_length:
                size_mb = int(content_length) / (1024 * 1024)
                if size_mb > max_size_mb:
                    raise ValueError(f"File too large ({size_mb:.1f}MB, max {max_size_mb}MB)")

            # Stream download with size check
            chunks = []
            total_size = 0
            async for chunk in response.aiter_bytes():
                chunks.append(chunk)
                total_size += len(chunk)
                if total_size > max_size_mb * 1024 * 1024:
                    raise ValueError(f"File too large (max {max_size_mb}MB)")

            content = b"".join(chunks)
            return content.decode("utf-8")
