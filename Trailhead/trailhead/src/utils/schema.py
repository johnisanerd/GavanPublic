"""JSON Schema utilities for LLM structured outputs."""

from typing import Any


def conform_schema_for_anthropic(schema: dict[str, Any]) -> dict[str, Any]:
    """Remove JSON Schema properties not supported by Anthropic's structured outputs.

    Anthropic doesn't support:
    - Numeric constraints: minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf
    - Array constraints: minItems, maxItems
    - String constraints: minLength, maxLength, pattern
    - additionalProperties: true (must be false or omitted)

    We keep these constraints in the Pydantic model for validation after LLM response,
    but strip them from the schema sent to the LLM.

    Args:
        schema: JSON Schema dict from Pydantic

    Returns:
        Sanitized schema with unsupported properties removed/fixed
    """
    unsupported_keys = {
        "minimum",
        "maximum",
        "exclusiveMinimum",
        "exclusiveMaximum",
        "minItems",
        "maxItems",
        "minLength",
        "maxLength",
        "pattern",
        "multipleOf",
    }

    def sanitize(obj: Any) -> Any:
        if isinstance(obj, dict):
            result = {}
            for k, v in obj.items():
                # Skip unsupported keys
                if k in unsupported_keys:
                    continue
                # Fix additionalProperties: true -> false
                if k == "additionalProperties" and v is True:
                    result[k] = False
                else:
                    result[k] = sanitize(v)
            return result
        elif isinstance(obj, list):
            return [sanitize(item) for item in obj]
        return obj

    return sanitize(schema)
