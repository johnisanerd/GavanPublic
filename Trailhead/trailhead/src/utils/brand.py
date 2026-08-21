"""Brand image utilities for model provider icons."""

from src.config import settings

# Model prefix to Brandfetch domain mapping
MODEL_PREFIX_TO_DOMAIN: dict[str, str] = {
    # Major Labs - prioritize chatbot URLs
    "anthropic": "claude.ai",
    "openai": "chatgpt.com",
    "google": "gemini.google.com",
    "x-ai": "grok.com",
    "deepseek": "chat.deepseek.com",
    "moonshotai": "kimi.ai",
    "perplexity": "perplexity.ai",
    # Labs without separate chatbot sites
    "meta-llama": "meta.com",
    "mistralai": "mistral.ai",
    "cohere": "cohere.com",
    "ai21": "ai21.com",
    "qwen": "qwen.ai",
    "alibaba": "qwen.ai",
    # Chinese labs
    "baidu": "baidu.com",
    "minimax": "minimax.io",
    "z-ai": "zhipuai.cn",  # GLM models
    "thudm": "zhipuai.cn",  # Tsinghua/Zhipu
    "tencent": "tencent.com",
    "meituan": "meituan.com",
    "bytedance": "bytedance.com",
    "stepfun-ai": "stepfun.com",
    # Cloud providers
    "amazon": "aws.amazon.com",
    "microsoft": "microsoft.com",
    "ibm-granite": "ibm.com",
    # Hardware / Inference
    "nvidia": "nvidia.com",
    # Research labs
    "allenai": "allenai.org",
    "eleutherai": "eleuther.ai",
    # Fine-tuners / Community
    "nousresearch": "nousresearch.com",
    "sao10k": "huggingface.co",
    "neversleep": "huggingface.co",
    "gryphe": "huggingface.co",
    "undi95": "huggingface.co",
    "alpindale": "huggingface.co",
}


def get_brand_icon_url(model: str | None, size: int = 32) -> str | None:
    """Get Brandfetch icon URL for a model's provider.

    Args:
        model: Model ID like "anthropic/claude-3-opus" or "openai/gpt-4o"
        size: Icon size in pixels (default 32)

    Returns:
        Brandfetch CDN URL for the provider's icon, or None if not available
    """
    if not model or not settings.brandfetch_client_id:
        return None

    # Extract provider from model ID (e.g., "anthropic" from "anthropic/claude-3-opus")
    provider = model.split("/")[0].lower() if "/" in model else model.lower()
    domain = MODEL_PREFIX_TO_DOMAIN.get(provider)

    if not domain:
        return None

    return f"https://cdn.brandfetch.io/{domain}/w/{size}/h/{size}/icon.png?c={settings.brandfetch_client_id}"


def get_provider_from_model(model: str | None) -> str | None:
    """Extract provider name from model ID.

    Args:
        model: Model ID like "anthropic/claude-3-opus"

    Returns:
        Provider name like "anthropic", or None
    """
    if not model:
        return None
    return model.split("/")[0].lower() if "/" in model else model.lower()
