"""Tests that call real LLM APIs.

These tests require a valid OPENROUTER_API_KEY in the environment.
Run with: uv run task test-llm
"""

import pytest

from src.orchestration.client import call_llm


@pytest.mark.llm
@pytest.mark.asyncio
async def test_call_llm_simple(real_api_key):
    """Test that call_llm can make a real API call."""
    response = await call_llm(
        model="openai/gpt-4o-mini",
        messages=[
            {
                "role": "system",
                "content": "You are a helpful assistant. Respond with exactly one word.",
            },
            {"role": "user", "content": "What is 1+1? Reply with just the number."},
        ],
    )

    assert response is not None
    assert response.choices[0].message.content is not None
    # Should contain "2" somewhere in the response
    assert "2" in response.choices[0].message.content


@pytest.mark.llm
@pytest.mark.asyncio
async def test_call_llm_with_response_format(real_api_key):
    """Test that call_llm works with response_format."""
    response = await call_llm(
        model="openai/gpt-4o-mini",
        messages=[
            {"role": "system", "content": "You are a math tutor. Answer math questions."},
            {"role": "user", "content": 'What is 2+2? Reply with JSON: {"result": <number>}'},
        ],
        response_format={"type": "json_object"},
    )

    assert response is not None
    content = response.choices[0].message.content
    assert content is not None
    assert "4" in content


@pytest.mark.llm
@pytest.mark.asyncio
async def test_anthropic_structured_output_schema_compatibility(real_api_key):
    """Test that our schemas work with Anthropic's structured output constraints.

    Anthropic requires additionalProperties: false (not {"type": "object"}).
    This test catches schema incompatibilities like dict[str, bool] fields.

    If schema is invalid, the API call itself will fail (like it did before the
    TextStyle fix). Otherwise, we validate the response against our model.
    """
    import json
    import re

    from src.types import SummarizerResponse

    # Get the actual schema we use in production
    schema = SummarizerResponse.model_json_schema(mode="serialization")

    # This call will fail with schema validation error if types are invalid
    # (e.g., "additionalProperties: object" not supported)
    response = await call_llm(
        model="anthropic/claude-sonnet-4",  # Same as production utility_model
        messages=[
            {
                "role": "system",
                "content": "Generate a minimal valid Slack Block Kit summary response.",
            },
            {
                "role": "user",
                "content": "Create a simple summary with one header block saying 'Test'.",
            },
        ],
        response_format={
            "type": "json_schema",
            "json_schema": {
                "name": "summarizer_response",
                "strict": True,
                "schema": schema,
            },
        },
        timeout=60.0,
    )

    assert response is not None
    content = response.choices[0].message.content
    assert content is not None

    # Extract JSON from response (OpenRouter doesn't always enforce format)
    content = content.strip()
    # Try to extract from markdown code block first
    code_block = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", content)
    if code_block:
        content = code_block.group(1)

    # Parse JSON
    data = json.loads(content)

    # Unwrap if wrapped in schema name
    if isinstance(data, dict) and "summarizer_response" in data:
        data = data["summarizer_response"]

    # Handle case where LLM returns just a list of blocks instead of full object
    # (OpenRouter doesn't always enforce strict schema adherence)
    if isinstance(data, list):
        data = {"blocks": data}

    # Validate against our model
    result = SummarizerResponse.model_validate(data)
    assert len(result.blocks) >= 1
