"""End-to-end tests that run the full experiment pipeline.

These tests require a valid OPENROUTER_API_KEY in the environment.
Run with: uv run task test-llm

Note: The running_server fixture is defined in tests/llm/conftest.py
"""

import httpx
import pytest


@pytest.mark.llm
def test_full_pipeline_e2e(running_server):
    """Test the full pipeline: generate config → run experiment → summarize.

    This is the real end-to-end test that:
    1. Spins up the actual server
    2. Calls /generate-run-summarize with a natural language description
    3. Verifies the experiment runs and produces results

    Uses a prompt designed to elicit interesting model behavior for highlights.
    """
    description = (
        "Ask gpt-4o-mini to explain a concept while being honest about uncertainty. "
        "Prompt: 'Explain how black holes work, and be honest about what scientists "
        "are still uncertain about.' Run 2 samples."
    )
    response = httpx.post(
        f"{running_server}/generate-run-summarize",
        params={"description": description},
        timeout=180.0,  # Full pipeline can take a while
    )

    assert response.status_code == 200, f"Failed: {response.text}"
    data = response.json()

    # Verify response structure
    assert "trailrun_id" in data
    assert "experiment_name" in data
    assert "config" in data
    assert "summary" in data
    assert "viewer_url" in data
    assert "status" in data

    # Verify the config was generated correctly
    config = data["config"]
    assert "title" in config
    assert "prompts" in config
    assert "models" in config
    assert len(config["prompts"]) >= 1
    assert len(config["models"]) >= 1

    # Verify status
    assert data["status"] == "completed", f"Expected completed, got {data['status']}"

    # Verify prose summary was generated
    summary = data["summary"]
    assert summary is not None, "Summary should be present for completed runs"
    assert isinstance(summary, str), "Summary should be prose (string)"
    assert len(summary) > 50, "Summary should have substantial content"

    # Highlights extraction is best-effort, not guaranteed
    # (depends on LLM response and content quality)
    highlights_count = data.get("highlights_count", 0)

    # If highlights were extracted, summary should include blockquotes
    if highlights_count > 0:
        has_blockquotes = "> " in summary
        assert has_blockquotes, (
            "Summary should include blockquoted highlights when highlights exist"
        )

    print("\n✅ E2E test passed!")
    print(f"   Trailrun: {data['trailrun_id']}")
    print(f"   Experiment: {data['experiment_name']}")
    print(f"   Title: {config['title']}")
    print(f"   Models: {data['models']}")
    print(f"   Samples: {data['samples_included']}/{data['samples_total']}")
    print(f"   Summary: {len(summary)} chars")
    print(f"   Highlights extracted: {highlights_count}")
    print(f"   Viewer: {data['viewer_url']}")
    print(f"\n   Summary preview:\n   {summary[:500]}...")


@pytest.mark.llm
def test_slack_output_format(running_server):
    """Test that format=slack returns valid Block Kit with correct deep links.

    This is the REAL e2e test for Slack output. It verifies:
    1. Blocks are valid Slack Block Kit JSON
    2. Deep links have /sample/{id}/{epoch}/ path (not just /samples/messages)
    3. Attribution shows actual sample.turn numbers (not ?.?)
    4. Rich text quotes are properly structured
    """
    # Use a prompt designed to elicit quotable model behavior
    description = (
        "Ask gpt-4o-mini to explain something while expressing uncertainty. "
        "Prompt: 'What causes deja vu? Be honest about what's uncertain.' "
        "Run 2 samples."
    )

    response = httpx.post(
        f"{running_server}/generate-run-summarize",
        params={"description": description, "format": "slack"},
        timeout=180.0,
    )

    assert response.status_code == 200, f"Failed: {response.text}"
    data = response.json()

    # ===== VERIFY RESPONSE STRUCTURE =====
    assert "blocks" in data, "Slack format should return 'blocks' not 'summary'"
    assert "summary" not in data, "Slack format should not return prose 'summary'"

    blocks = data["blocks"]
    assert blocks is not None
    assert len(blocks) > 0, "Should have at least one block"

    # ===== VERIFY BLOCK TYPES ARE VALID SLACK TYPES =====
    valid_slack_types = {"header", "section", "divider", "context", "rich_text", "image", "table"}
    for block in blocks:
        block_type = block.get("type")
        assert block_type in valid_slack_types, f"Invalid block type: {block_type}"

    # ===== VERIFY RICH_TEXT BLOCKS (QUOTES) =====
    rich_text_blocks = [b for b in blocks if b.get("type") == "rich_text"]
    for block in rich_text_blocks:
        assert "elements" in block, f"rich_text missing elements: {block}"
        # Should have rich_text_quote for cited highlights
        has_quote = any(e.get("type") == "rich_text_quote" for e in block.get("elements", []))
        assert has_quote, f"rich_text block should contain quote: {block}"

    # ===== VERIFY CONTEXT BLOCKS (ATTRIBUTION) =====
    context_blocks = [b for b in blocks if b.get("type") == "context"]

    for block in context_blocks:
        elements = block.get("elements", [])
        for elem in elements:
            if elem.get("type") == "mrkdwn":
                text = elem.get("text", "")

                # Check attribution format - should NOT have ?.?
                if "gpt-4o-mini" in text.lower() or "gpt" in text.lower():
                    assert "?.?" not in text, f"Attribution missing sample/turn numbers: {text}"

                # Check deep link format - should have /sample/{id}/{epoch}/
                if "/data-inspector/" in text and "/samples/" in text:
                    assert "/samples/sample/" in text, (
                        f"Deep link missing /sample/{{id}}/{{epoch}}/ path: {text}"
                    )
                    # Verify it's not the old broken format
                    assert "/samples/messages?" not in text or "/samples/sample/" in text, (
                        f"Deep link has old broken format: {text}"
                    )

    # ===== VERIFY WE HAVE CITATION CONTENT =====
    # If highlights were extracted, we should have rich_text + context pairs
    highlights_count = data.get("highlights_count", 0)
    if highlights_count > 0:
        assert len(rich_text_blocks) > 0, (
            f"Had {highlights_count} highlights but no rich_text blocks"
        )
        assert len(context_blocks) > 0, f"Had {highlights_count} highlights but no context blocks"

    # ===== PRINT DEBUG INFO =====
    import json

    print("\n" + "=" * 80)
    print("HIGHLIGHTS FOUND:")
    print("=" * 80)
    highlights = data.get("highlights") or []
    for i, h in enumerate(highlights):
        print(f"\n[{i + 1}] case={h.get('case')}, epoch={h.get('epoch')}, turn={h.get('turn')}")
        print(f"    desc: {h.get('description')}")
        print(f"    quote: {h.get('quoted_text')[:80]}...")
        print(f"    link: {h.get('deep_link')}")

    print("\n" + "=" * 80)
    print("SLACK BLOCKS:")
    print("=" * 80)
    for i, block in enumerate(blocks):
        block_type = block.get("type", "unknown")
        print(f"\n--- Block {i + 1}: {block_type} ---")
        print(json.dumps(block, indent=2))

    print("\n" + "=" * 80)
    print("SUMMARY:")
    print("=" * 80)
    print(f"Total blocks: {len(blocks)}")
    print(f"Block types: {[b.get('type') for b in blocks]}")
    print(f"Rich text (quotes): {len(rich_text_blocks)}")
    print(f"Context (attribution): {len(context_blocks)}")
    print(f"Highlights extracted: {highlights_count}")
    print("\n✅ Slack e2e test passed!")
